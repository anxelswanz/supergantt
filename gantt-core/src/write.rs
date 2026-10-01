//! 写入。
//!
//! 两条路径，服务的对象不同：
//!
//! 1. `save_project` —— 桌面应用的整项目事务替换，从 `db.rs` 平移，逻辑一字未改。
//!    前端内存里握着完整的任务表和命令栈，一次撤销可能同时动几十行；把真相整份发过来
//!    是最省心的契约。
//!
//! 2. `upsert_tasks` / `insert_tasks` / `delete_task` —— CLI 的行级写入。
//!    **CLI 绝不能调 `save_project`**：它手里只有一个陈旧快照，整项目替换会把用户
//!    在应用里的其他改动一并抹掉。CLI 只动它确实碰过的那几行。

use crate::model::*;
use crate::query::{max_task_id, now};
use rusqlite::{params, Connection};
use std::collections::HashSet;

/* ------------------------------------------------------------------ */
/* 桌面应用：整项目事务替换                                            */
/* ------------------------------------------------------------------ */

/// 整项目事务性替换。
///
/// 为什么不做逐条 INSERT/UPDATE/DELETE 的增量写入：
///
/// 前端的真相是内存里那份任务表 + 命令栈。一次撤销可能同时改回 20 行、
/// 恢复 3 行被删的、再撤掉 1 行新增的 —— 把这些精确翻译成增量 SQL，
/// 等于在前端和数据库之间再维护一套同步状态机，而它一旦有 bug
/// 就是静默的数据损坏，且不可恢复。
///
/// 500 个任务的全量替换在本地 SQLite 上是几毫秒的事（DESIGN.md §6.5 的规模假设）。
/// 用一个数量级的性能余量换掉一整类同步 bug，这笔交易在单机单人场景下毫无悬念。
/// 前端按防抖节流调用，并在窗口失焦/关闭时强制冲刷。
///
/// ⚠️ 「替换」是语义，不是实现手段。
///
/// 具体做法是 upsert + 删除本次没出现的行，**不能**用「DELETE 全部再 INSERT」。
/// 风险点、评论这些附注表用外键挂在 tasks 上并带 ON DELETE CASCADE，
/// 一旦每次保存都真的把任务行删掉，级联会把它们一起清空 —— 而且是静默清空，
/// 用户下次打开才发现全没了。对前端来说契约不变：仍然是「把完整期望状态发过来」。
pub fn save_project(
    conn: &mut Connection,
    id: i64,
    tasks: Vec<TaskRow>,
    dependencies: Vec<DependencyRow>,
) -> Result<()> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // —— 先挡住跨项目的 id 撞车 ——
    //
    // upsert 的 ON CONFLICT 分支不会改 project_id，所以一个撞上别的项目的 id
    // 会**改写那个项目的行**，而且改完还留在原项目里 —— 静默的跨项目数据损坏。
    // 这里宁可整次保存失败（界面会显示「● 未保存」），也绝不能动别人的数据。
    if !tasks.is_empty() {
        let ids: Vec<String> = tasks.iter().map(|t| t.id.to_string()).collect();
        let clash: i64 = tx
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM tasks WHERE project_id <> ?1 AND id IN ({})",
                    ids.join(",")
                ),
                params![id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if clash > 0 {
            return Err(format!(
                "保存中止：有 {clash} 个任务 ID 和其他项目冲突。\
                 没有写入任何数据，你的编辑仍在内存中。请重启应用后重试。"
            ));
        }

        // 父任务必须也在这一批里。跨项目的 parent_id 是最危险的一种脏数据 ——
        // parent_id 上挂着 ON DELETE CASCADE，删本项目的一个任务会把
        // 另一个项目的子树一起带走
        let own: HashSet<i64> = tasks.iter().map(|t| t.id).collect();
        if let Some(bad) = tasks
            .iter()
            .find(|t| t.parent_id.is_some_and(|pid| !own.contains(&pid)))
        {
            return Err(format!(
                "保存中止：任务「{}」的父任务不在本项目内。没有写入任何数据。",
                if bad.name.is_empty() { "未命名" } else { &bad.name }
            ));
        }

        // 依赖的两端同理
        if let Some(bad) = dependencies
            .iter()
            .find(|d| !own.contains(&d.from_task_id) || !own.contains(&d.to_task_id))
        {
            return Err(format!(
                "保存中止：依赖 {} → {} 的两端不都在本项目内。没有写入任何数据。",
                bad.from_task_id, bad.to_task_id
            ));
        }
    }

    // 依赖没有别的表引用它，删光重建最省事
    tx.execute("DELETE FROM dependencies WHERE project_id = ?1", params![id])
        .map_err(|e| e.to_string())?;

    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO tasks
                   (id, project_id, parent_id, name, start_date, end_date, progress,
                    priority, person_id, milestone, weight, collapsed, pinned, note,
                    sort_order, blocked, auto_rollover, actual_start, actual_end,
                    created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?20)
                 ON CONFLICT(id) DO UPDATE SET
                   parent_id  = excluded.parent_id,
                   name       = excluded.name,
                   start_date = excluded.start_date,
                   end_date   = excluded.end_date,
                   progress   = excluded.progress,
                   priority   = excluded.priority,
                   person_id  = excluded.person_id,
                   milestone  = excluded.milestone,
                   weight     = excluded.weight,
                   collapsed  = excluded.collapsed,
                   pinned     = excluded.pinned,
                   note       = excluded.note,
                   sort_order = excluded.sort_order,
                   blocked      = excluded.blocked,
                   actual_start = excluded.actual_start,
                   actual_end   = excluded.actual_end,
                   auto_rollover = excluded.auto_rollover,
                   updated_at   = excluded.updated_at",
            )
            .map_err(|e| e.to_string())?;

        let ts = now();
        // 父任务必须先于子任务写入，否则 parent_id 的外键约束会失败。
        // 前端已经按层级序发送，这里做一次防御性排序：没有父的排前面。
        let mut ordered = tasks.clone();
        ordered.sort_by_key(|t| depth_of(t, &tasks));

        for t in &ordered {
            stmt.execute(params![
                t.id, id, t.parent_id, t.name, t.start_date, t.end_date, t.progress,
                t.priority, t.person_id, t.milestone as i64, t.weight,
                t.collapsed as i64, t.pinned as i64, t.note, t.sort_order, t.blocked,
                t.auto_rollover as i64, t.actual_start, t.actual_end, ts,
            ])
            .map_err(|e| e.to_string())?;
        }
    }

    {
        // 本次没发过来的任务视为已删除。子任务先删，避免删父时级联把
        // 本该保留的孙子任务一并带走的顺序问题。
        let keep: Vec<String> = tasks.iter().map(|t| t.id.to_string()).collect();
        let sql = if keep.is_empty() {
            "DELETE FROM tasks WHERE project_id = ?1".to_string()
        } else {
            format!(
                "DELETE FROM tasks WHERE project_id = ?1 AND id NOT IN ({})",
                keep.join(",")
            )
        };
        tx.execute(&sql, params![id]).map_err(|e| e.to_string())?;
    }

    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO dependencies (project_id, from_task_id, to_task_id, type, lag_days)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .map_err(|e| e.to_string())?;
        for d in &dependencies {
            stmt.execute(params![id, d.from_task_id, d.to_task_id, d.kind, d.lag_days])
                .map_err(|e| e.to_string())?;
        }
    }

    tx.execute(
        "UPDATE projects SET updated_at = ?2 WHERE id = ?1",
        params![id, now()],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 层级深度，用于插入排序。环形 parent 关系会被截断在 64 层，不会死循环。
fn depth_of(task: &TaskRow, all: &[TaskRow]) -> usize {
    let mut depth = 0;
    let mut current = task.parent_id;
    while let Some(pid) = current {
        depth += 1;
        if depth > 64 {
            break;
        }
        current = all.iter().find(|t| t.id == pid).and_then(|t| t.parent_id);
    }
    depth
}

/* ------------------------------------------------------------------ */
/* CLI：行级写入                                                       */
/* ------------------------------------------------------------------ */

/// 新建任务时分配 id。**必须**走全库最大 id，不是当前项目的 —— 见 `max_task_id`。
///
/// 这不是一个「顺手写的 +1」：历史上真出过事故，前端按项目内序号分配，
/// 撞上别的项目的行之后把人家整条任务改写了（`cross_project_id_clash_must_abort_the_whole_save`
/// 那条测试就是它留下的疤）。CLI 是第二个分配者，必须和第一个用同一把尺子。
pub fn allocate_task_id(conn: &Connection) -> Result<i64> {
    max_task_id(conn)
}

/// 一条新任务的完整行。字段和 `TaskRow` 一一对应，但 `id` 由库分配、
/// `created_at`/`updated_at` 由这里盖，所以单独一个结构体，
/// 免得调用方误以为传进来的 id 会被采纳。
pub struct NewTask {
    pub parent_id: Option<i64>,
    pub name: String,
    pub start_date: String,
    pub end_date: String,
    pub actual_start: Option<String>,
    pub actual_end: Option<String>,
    pub progress: f64,
    pub priority: i64,
    pub person_id: Option<i64>,
    pub milestone: bool,
    pub weight: Option<f64>,
    pub note: String,
    pub sort_order: f64,
    pub blocked: String,
    pub auto_rollover: bool,
}

impl NewTask {
    /// 以某条已有任务为模板铺默认值，再逐个字段覆盖。
    /// 让 CLI 的 `task create` 不必给每个字段都想一遍默认。
    pub fn blank(name: String, start_date: String, end_date: String) -> Self {
        NewTask {
            parent_id: None,
            name,
            start_date,
            end_date,
            actual_start: None,
            actual_end: None,
            progress: 0.0,
            // 和前端 `draftTask` 一致：默认 P2
            priority: 2,
            person_id: None,
            milestone: false,
            weight: None,
            note: String::new(),
            sort_order: 0.0,
            blocked: "[]".to_string(),
            auto_rollover: false,
        }
    }
}

/// 插入若干新任务，单事务。父任务先插（否则外键失败），调用方保证 id 已分配。
pub fn insert_tasks(conn: &mut Connection, project_id: i64, tasks: Vec<(i64, NewTask)>) -> Result<()> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let ts = now();

    // 防御性排序：父任务先于子任务插入。
    //
    // 这批任务里若有 A 是 B 的父，A 必须先落库，否则 B 的 parent_id
    // 外键约束会失败（SQLite 的外键在语句级检查，同事务内也救不了顺序）。
    //
    // 深度在排序**之前**一次算好：比较函数会被调用 O(n log n) 次，
    // 在里面现走父链是白费；而且闭包要借着 `tasks`，下面还要用它。
    let depths: Vec<usize> = tasks
        .iter()
        .map(|(_id, task)| {
            let mut depth = 0;
            let mut cur = task.parent_id;
            // 环会被截断在 64 层。CLI 已经拦了环，这里只是不让它死循环。
            while let Some(pid) = cur {
                depth += 1;
                if depth > 64 {
                    break;
                }
                match tasks.iter().find(|(i, _)| *i == pid) {
                    Some((_, t)) => cur = t.parent_id,
                    None => break, // 父不在这一批里，说明它是已存在的任务，无需排序
                }
            }
            depth
        })
        .collect();

    let mut ordered: Vec<(usize, i64, NewTask)> = depths
        .into_iter()
        .zip(tasks)
        .map(|(depth, (id, task))| (depth, id, task))
        .collect();
    ordered.sort_by_key(|(depth, _, _)| *depth);

    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO tasks
                   (id, project_id, parent_id, name, start_date, end_date, progress,
                    priority, person_id, milestone, weight, collapsed, pinned, note,
                    sort_order, blocked, auto_rollover, actual_start, actual_end,
                    created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, 0, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18)",
            )
            .map_err(|e| e.to_string())?;

        for (_, id, t) in &ordered {
            stmt.execute(params![
                id, project_id, t.parent_id, t.name, t.start_date, t.end_date, t.progress,
                t.priority, t.person_id, t.milestone as i64, t.weight, t.note,
                t.sort_order, t.blocked, t.auto_rollover as i64, t.actual_start, t.actual_end, ts,
            ])
            .map_err(|e| e.to_string())?;
        }
    }

    tx.execute(
        "UPDATE projects SET updated_at = ?2 WHERE id = ?1",
        params![project_id, ts],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// CLI 更新用的补丁。`None` = 这一列别动。
///
/// 用 Option 而不是「传当前值回来」：后者要求调用方先读一遍再写，
/// 中间隔着一次用户编辑就会把用户的改动吞掉（读改写丢更新）。
/// 只发真正要改的列，是行级写入能安全并存的全部理由。
#[derive(Default)]
pub struct TaskPatch {
    pub name: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub progress: Option<f64>,
    pub priority: Option<i64>,
    pub person_id: Option<Option<i64>>,
    pub parent_id: Option<Option<i64>>,
    pub milestone: Option<bool>,
    pub weight: Option<Option<f64>>,
    pub note: Option<String>,
    pub sort_order: Option<f64>,
    pub blocked: Option<String>,
    pub auto_rollover: Option<bool>,
    pub actual_start: Option<Option<String>>,
    pub actual_end: Option<Option<String>>,
}

impl TaskPatch {
    pub fn is_empty(&self) -> bool {
        self.name.is_none()
            && self.start_date.is_none()
            && self.end_date.is_none()
            && self.progress.is_none()
            && self.priority.is_none()
            && self.person_id.is_none()
            && self.parent_id.is_none()
            && self.milestone.is_none()
            && self.weight.is_none()
            && self.note.is_none()
            && self.sort_order.is_none()
            && self.blocked.is_none()
            && self.auto_rollover.is_none()
            && self.actual_start.is_none()
            && self.actual_end.is_none()
    }
}

/// 只 UPDATE 传进来的列。空补丁直接返回，不产生一次无谓的写库。
pub fn update_task(conn: &Connection, id: i64, patch: &TaskPatch) -> Result<()> {
    if patch.is_empty() {
        return Ok(());
    }

    let mut sets: Vec<&str> = Vec::new();
    let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    macro_rules! push {
        ($col:literal, $field:expr, $conv:expr) => {
            if let Some(v) = $field {
                sets.push(concat!($col, " = ?"));
                values.push(Box::new($conv(v)));
            }
        };
    }

    push!("name", patch.name.as_ref(), |v: &String| v.clone());
    push!("start_date", patch.start_date.as_ref(), |v: &String| v.clone());
    push!("end_date", patch.end_date.as_ref(), |v: &String| v.clone());
    push!("progress", patch.progress, |v: f64| v);
    push!("priority", patch.priority, |v: i64| v);
    push!("person_id", patch.person_id, |v: Option<i64>| v);
    push!("parent_id", patch.parent_id, |v: Option<i64>| v);
    push!("milestone", patch.milestone, |v: bool| v as i64);
    push!("weight", patch.weight, |v: Option<f64>| v);
    push!("note", patch.note.as_ref(), |v: &String| v.clone());
    push!("sort_order", patch.sort_order, |v: f64| v);
    push!("blocked", patch.blocked.as_ref(), |v: &String| v.clone());
    push!("auto_rollover", patch.auto_rollover, |v: bool| v as i64);
    push!("actual_start", patch.actual_start.clone(), |v: Option<String>| v);
    push!("actual_end", patch.actual_end.clone(), |v: Option<String>| v);

    // 更新时总要盖 updated_at
    sets.push("updated_at = ?");
    values.push(Box::new(now()));

    // id 放最后，对应 WHERE 的 ?N
    let sql = format!(
        "UPDATE tasks SET {} WHERE id = ?{}",
        sets.join(", "),
        values.len() + 1
    );
    values.push(Box::new(id));

    let refs: Vec<&dyn rusqlite::ToSql> = values.iter().map(|b| b.as_ref()).collect();
    conn.execute(&sql, refs.as_slice()).map_err(|e| e.to_string())?;
    Ok(())
}

/// 删一条任务。子任务、风险、评论、逐日记录靠 schema 的 ON DELETE CASCADE 跟着走。
pub fn delete_task(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
