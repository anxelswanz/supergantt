//! 读取与 CRUD。
//!
//! 从 `src-tauri/src/db.rs` 平移。唯一的形变是签名：原先每个 `#[tauri::command]`
//! 拿的是 `tauri::State<Db>`，这里一律改成 `&Connection` —— 这样 CLI（没有 Tauri）
//! 也能调，桌面应用那层只需锁一下 Mutex 再转调进来。SQL、校验、中文错误一字未改。

use crate::calendar::today_iso;
use crate::model::*;
use rusqlite::{params, Connection, OptionalExtension};

/// created_at / updated_at 用的 Unix 秒字符串。展示精度，秒级足够。
pub fn now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

/// 风险、评论、逐日记录用的 Unix 秒（整数）。
fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/**
 * 把项目名唯一索引的报错翻译成人话。
 *
 * 名字是用户每天都在看的东西，撞名是最常见的一种失败 —— 甩一句
 * `UNIQUE constraint failed: projects.name` 出去等于让用户自己去猜。
 * 唯一性本身的理由见 migrations/007_project_identity.sql。
 */
pub fn name_taken(e: rusqlite::Error, name: &str) -> String {
    let msg = e.to_string();
    if msg.contains("projects.name") {
        format!("已有名为「{name}」的项目")
    } else {
        msg
    }
}

fn map_project(row: &rusqlite::Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get("id")?,
        uuid: row.get("uuid")?,
        name: row.get("name")?,
        color: row.get("color")?,
        work_days: row.get("work_days")?,
        holidays: row.get("holidays")?,
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn map_task(row: &rusqlite::Row) -> rusqlite::Result<TaskRow> {
    Ok(TaskRow {
        id: row.get("id")?,
        parent_id: row.get("parent_id")?,
        name: row.get("name")?,
        start_date: row.get("start_date")?,
        end_date: row.get("end_date")?,
        actual_start: row.get("actual_start")?,
        actual_end: row.get("actual_end")?,
        progress: row.get("progress")?,
        priority: row.get("priority")?,
        person_id: row.get("person_id")?,
        milestone: row.get::<_, i64>("milestone")? != 0,
        weight: row.get("weight")?,
        collapsed: row.get::<_, i64>("collapsed")? != 0,
        pinned: row.get::<_, i64>("pinned")? != 0,
        note: row.get("note")?,
        sort_order: row.get("sort_order")?,
        blocked: row.get("blocked")?,
        auto_rollover: row.get::<_, i64>("auto_rollover")? != 0,
    })
}

/* ------------------------------------------------------------------ */
/* 项目                                                                */
/* ------------------------------------------------------------------ */

pub fn list_projects(conn: &Connection) -> Result<Vec<ProjectSummary>> {
    let mut stmt = conn
        .prepare("SELECT * FROM projects ORDER BY sort_order, id")
        .map_err(|e| e.to_string())?;
    let projects: Vec<Project> = stmt
        .query_map([], map_project)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;

    let today = today_iso();
    let mut out = Vec::with_capacity(projects.len());

    for project in projects {
        // 叶子任务 = 没有任何任务把它当父节点的任务
        let leaf_filter = "t.id NOT IN (SELECT parent_id FROM tasks WHERE parent_id IS NOT NULL)";

        let (task_count, start_date, end_date): (i64, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT COUNT(*), MIN(start_date), MAX(end_date) FROM tasks WHERE project_id = ?1",
                params![project.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| e.to_string())?;

        let (leaf_count, progress_sum, weight_sum): (i64, f64, f64) = conn
            .query_row(
                &format!(
                    "SELECT COUNT(*),
                            COALESCE(SUM(t.progress * (julianday(t.end_date) - julianday(t.start_date) + 1)), 0),
                            COALESCE(SUM(julianday(t.end_date) - julianday(t.start_date) + 1), 0)
                     FROM tasks t
                     WHERE t.project_id = ?1 AND {leaf_filter}"
                ),
                params![project.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| e.to_string())?;

        let overdue_count: i64 = conn
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM tasks t
                     WHERE t.project_id = ?1 AND {leaf_filter}
                       AND t.end_date < ?2 AND t.progress < 1.0"
                ),
                params![project.id, today],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;

        out.push(ProjectSummary {
            project,
            task_count,
            start_date,
            end_date,
            leaf_count,
            overdue_count,
            progress: if weight_sum > 0.0 { progress_sum / weight_sum } else { 0.0 },
        });
    }

    Ok(out)
}

pub fn create_project(conn: &Connection, name: String, color: String) -> Result<Project> {
    let ts = now();
    // uuid 不在这里给：schema 上挂了触发器，任何插入路径都会自动拿到一个
    // （见 migrations/007_project_identity.sql）。两处生成同一个事实，
    // 迟早会有一处忘了
    conn.execute(
        "INSERT INTO projects (name, color, sort_order, created_at, updated_at)
         VALUES (?1, ?2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM projects), ?3, ?3)",
        params![name, color, ts],
    )
    .map_err(|e| name_taken(e, &name))?;

    conn.query_row(
        "SELECT * FROM projects WHERE id = ?1",
        params![conn.last_insert_rowid()],
        map_project,
    )
    .map_err(|e| e.to_string())
}

pub fn rename_project(conn: &Connection, id: i64, name: String, color: String) -> Result<()> {
    conn.execute(
        "UPDATE projects SET name = ?2, color = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, name, color, now()],
    )
    .map_err(|e| name_taken(e, &name))?;
    Ok(())
}

/// 更新项目的工作日历（DESIGN.md §1.5）。
/// work_days 是 "[1,2,3,4,5]" 这样的星期序号数组，holidays 是 ISO 日期数组。
pub fn update_project_calendar(
    conn: &Connection,
    id: i64,
    work_days: String,
    holidays: String,
) -> Result<()> {
    conn.execute(
        "UPDATE projects SET work_days = ?2, holidays = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, work_days, holidays, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_project(conn: &Connection, id: i64) -> Result<()> {
    // 任务、依赖、基线都靠 ON DELETE CASCADE 跟着走
    conn.execute("DELETE FROM projects WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 全库下一个可用的任务 id。CLI 新建任务时的 id 基准，和 `load_project`
/// 返回的 `next_task_id` 同源 —— 见坑 3。
pub fn max_task_id(conn: &Connection) -> Result<i64> {
    conn.query_row("SELECT COALESCE(MAX(id), 0) + 1 FROM tasks", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

pub fn load_project(conn: &Connection, id: i64) -> Result<ProjectData> {
    let project = conn
        .query_row("SELECT * FROM projects WHERE id = ?1", params![id], map_project)
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT * FROM tasks WHERE project_id = ?1 ORDER BY sort_order, id")
        .map_err(|e| e.to_string())?;
    let tasks = stmt
        .query_map(params![id], map_task)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, from_task_id, to_task_id, type, lag_days FROM dependencies WHERE project_id = ?1")
        .map_err(|e| e.to_string())?;
    let dependencies = stmt
        .query_map(params![id], |r| {
            Ok(DependencyRow {
                id: r.get(0)?,
                from_task_id: r.get(1)?,
                to_task_id: r.get(2)?,
                kind: r.get(3)?,
                lag_days: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, name, created_at FROM baselines WHERE project_id = ?1 ORDER BY id DESC")
        .map_err(|e| e.to_string())?;
    let baselines = stmt
        .query_map(params![id], |r| {
            Ok(BaselineRow { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)? })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    let people = read_people(conn).map_err(|e| e.to_string())?;

    // 取全库最大 id，而不是本项目的 —— 见 next_task_id 的说明
    let next_task_id = max_task_id(conn)?;

    Ok(ProjectData { project, tasks, dependencies, baselines, people, next_task_id })
}

/* ------------------------------------------------------------------ */
/* 负责人                                                              */
/* ------------------------------------------------------------------ */

pub fn read_people(conn: &Connection) -> rusqlite::Result<Vec<Person>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, color, avatar, sort_order FROM people ORDER BY sort_order, id",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Person {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                avatar: r.get(3)?,
                sort_order: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn list_people(conn: &Connection) -> Result<Vec<Person>> {
    read_people(conn).map_err(|e| e.to_string())
}

pub fn create_person(conn: &Connection, name: String, color: String) -> Result<Person> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("负责人名字不能为空".into());
    }

    conn.execute(
        "INSERT INTO people (name, color, sort_order, created_at)
         VALUES (?1, ?2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM people), ?3)",
        params![name, color, now()],
    )
    // 唯一索引挡住重名，这里把库层错误翻译成人话
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            format!("已经有叫「{name}」的负责人了")
        } else {
            e.to_string()
        }
    })?;

    let id = conn.last_insert_rowid();
    conn.query_row(
        "SELECT id, name, color, avatar, sort_order FROM people WHERE id = ?1",
        params![id],
        |r| {
            Ok(Person {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                avatar: r.get(3)?,
                sort_order: r.get(4)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

/// avatar 传 None 表示不改动，传 Some("") 表示清除。
/// 用 Option 区分「不改」和「改成空」—— 少了这个区分，
/// 改个名字就会把头像顺手抹掉。
pub fn update_person(
    conn: &Connection,
    id: i64,
    name: String,
    color: String,
    avatar: Option<String>,
) -> Result<()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("负责人名字不能为空".into());
    }

    match avatar {
        Some(data) => {
            let value = if data.is_empty() { None } else { Some(data) };
            conn.execute(
                "UPDATE people SET name = ?2, color = ?3, avatar = ?4 WHERE id = ?1",
                params![id, name, color, value],
            )
        }
        None => conn.execute(
            "UPDATE people SET name = ?2, color = ?3 WHERE id = ?1",
            params![id, name, color],
        ),
    }
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            format!("已经有叫「{name}」的负责人了")
        } else {
            e.to_string()
        }
    })?;
    Ok(())
}

/// 删人不删任务 —— 外键是 ON DELETE SET NULL，相关任务只是变成「无负责人」。
pub fn delete_person(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM people WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 某个人身上挂了多少任务 —— 删除前提示用，避免误删掉一个还在被大量引用的人。
pub fn count_person_tasks(conn: &Connection, id: i64) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM tasks WHERE person_id = ?1",
        params![id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/* ------------------------------------------------------------------ */
/* 风险点与评论                                                        */
/* ------------------------------------------------------------------ */

pub fn load_task_notes(conn: &Connection, task_id: i64) -> Result<TaskNotes> {
    let risks = {
        let mut stmt = conn
            .prepare(
                "SELECT id, task_id, content, level, resolved, created_at,
                        resolved_at, resolution, priority
                 FROM risks WHERE task_id = ?1
                 ORDER BY resolved, level, created_at DESC",
            )
            .map_err(|e| e.to_string())?;
        // ⚠️ 必须在同一个 let 里 collect，不能拆成两步。
        // `params![]` 造出来的 Params 是个临时值，而返回的 MappedRows 借着它；
        // 一旦把 `stmt.query_map(...)` 的结果先存进变量、下一句再 collect，
        // 那个临时值已经在这一句结束时销毁了 —— 编译器会报
        // "stmt does not live long enough"，但真正短命的是 params。
        let risks = stmt
            .query_map(params![task_id], |r| {
                Ok(Risk {
                    id: r.get(0)?,
                    task_id: r.get(1)?,
                    content: r.get(2)?,
                    level: r.get(3)?,
                    resolved: r.get::<_, i64>(4)? != 0,
                    created_at: r.get(5)?,
                    resolved_at: r.get(6)?,
                    resolution: r.get(7)?,
                    priority: r.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        risks
    };

    let comments = {
        let mut stmt = conn
            .prepare(
                "SELECT id, task_id, content, created_at
                 FROM comments WHERE task_id = ?1 ORDER BY created_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let comments = stmt
            .query_map(params![task_id], |r| {
                Ok(Comment {
                    id: r.get(0)?,
                    task_id: r.get(1)?,
                    content: r.get(2)?,
                    created_at: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        comments
    };

    Ok(TaskNotes { risks, comments })
}

/// 每个任务有几条**未解决**的风险 —— 左侧网格靠它显示角标。
/// 看不见的风险等于没记，所以这个计数必须一次性随项目加载。
pub fn count_open_risks(conn: &Connection, project_id: i64) -> Result<Vec<(i64, i64)>> {
    let mut stmt = conn
        .prepare(
            "SELECT r.task_id, COUNT(*)
             FROM risks r JOIN tasks t ON t.id = r.task_id
             WHERE t.project_id = ?1 AND r.resolved = 0
             GROUP BY r.task_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// 整个项目的风险点，一次查完 —— 导出用。
///
/// 不复用 `load_task_notes` 逐任务查：一个项目几百个任务就是几百次 IPC + 几百条
/// SQL，而导出只需要一次全表 JOIN。排序在库里定死（未解决在前 → 等级高在前 →
/// 记录早在前），前端不必再排一遍，也保证了导出件的行序是可重复的。
pub fn load_project_risks(conn: &Connection, project_id: i64) -> Result<Vec<Risk>> {
    let mut stmt = conn
        .prepare(
            "SELECT r.id, r.task_id, r.content, r.level, r.resolved, r.created_at,
                    r.resolved_at, r.resolution, r.priority
             FROM risks r JOIN tasks t ON t.id = r.task_id
             WHERE t.project_id = ?1
             ORDER BY r.resolved, r.level, r.created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project_id], |r| {
            Ok(Risk {
                id: r.get(0)?,
                task_id: r.get(1)?,
                content: r.get(2)?,
                level: r.get(3)?,
                resolved: r.get::<_, i64>(4)? != 0,
                created_at: r.get(5)?,
                resolved_at: r.get(6)?,
                resolution: r.get(7)?,
                priority: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn add_risk(conn: &Connection, task_id: i64, content: String, level: i64) -> Result<Risk> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("风险内容不能为空".into());
    }
    let ts = unix_now();
    conn.execute(
        "INSERT INTO risks (task_id, content, level, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![task_id, content, level, ts],
    )
    .map_err(|e| e.to_string())?;

    Ok(Risk {
        id: conn.last_insert_rowid(),
        task_id,
        content,
        level,
        resolved: false,
        created_at: ts,
        resolved_at: None,
        resolution: None,
        // 从这个入口建的风险没有优先级 —— 只有「从事项分拣过来」那条路
        // 才有一个用户刚刚做过的优先级判断需要带过来（promote_note_to_risk）
        priority: None,
    })
}

/// 改一条风险的措辞或等级。**不碰开关状态** —— 关闭要走 resolve_risk，
/// 那条路强制留下处置说明；从这里顺手把 resolved 一起改掉，等于给自己
/// 留了一个绕过记录的后门。
pub fn update_risk(conn: &Connection, id: i64, content: String, level: i64) -> Result<()> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("风险内容不能为空".into());
    }
    conn.execute(
        "UPDATE risks SET content = ?2, level = ?3 WHERE id = ?1",
        params![id, content, level],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 关闭一条风险：记下**什么时候**关的、**怎么**关的。
///
/// 处置说明是必填的，库层也拦一道。UI 里那个输入框可以被绕过（将来多一个
/// 入口、或者有人直接调命令），而一旦允许空说明，它就会变成默认路径 ——
/// 大家都按最省事的那条走，三个月后复盘时这张表又变回了一排勾。
pub fn resolve_risk(conn: &Connection, id: i64, resolution: String) -> Result<i64> {
    let resolution = resolution.trim().to_string();
    if resolution.is_empty() {
        return Err("关闭风险要写清楚是怎么解决的".into());
    }
    let ts = unix_now();
    let n = conn
        .execute(
            "UPDATE risks SET resolved = 1, resolved_at = ?2, resolution = ?3 WHERE id = ?1",
            params![id, ts, resolution],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("风险不存在".into());
    }
    Ok(ts)
}

/// 重新打开：问题又回来了，或者上次那个「已解决」下早了。
///
/// 关闭时间和处置说明一并清掉。留着的话，界面上会出现一条「未关闭」却
/// 挂着「已于 3 月 2 日解决：换了供应商」的风险 —— 两个互相矛盾的说法，
/// 用户从此不再相信其中任何一个。真要留痕，那是审计日志该做的事，
/// 不是在同一行里塞两份状态。
pub fn reopen_risk(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        "UPDATE risks SET resolved = 0, resolved_at = NULL, resolution = NULL WHERE id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_risk(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM risks WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn add_comment(conn: &Connection, task_id: i64, content: String) -> Result<Comment> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("评论内容不能为空".into());
    }
    let ts = unix_now();
    conn.execute(
        "INSERT INTO comments (task_id, content, created_at) VALUES (?1, ?2, ?3)",
        params![task_id, content, ts],
    )
    .map_err(|e| e.to_string())?;

    Ok(Comment {
        id: conn.last_insert_rowid(),
        task_id,
        content,
        created_at: ts,
    })
}

pub fn delete_comment(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM comments WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/* ------------------------------------------------------------------ */
/* 逐日记录（时间线）                                                   */
/* ------------------------------------------------------------------ */

/// 一个项目的全部逐日记录，按天正序、同一天内按写入顺序。
///
/// 排序放在库里而不是前端：时间线、任务详情、将来的导出都要用同一个顺序，
/// 三处各排一次迟早有一处不一样。
pub fn load_daily_notes(conn: &Connection, project_id: i64) -> Result<Vec<DailyNote>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, task_id, day, content, created_at, updated_at
               FROM daily_notes WHERE project_id = ?1
              ORDER BY day ASC, id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project_id], |r| {
            Ok(DailyNote {
                id: r.get(0)?,
                project_id: r.get(1)?,
                task_id: r.get(2)?,
                day: r.get(3)?,
                content: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn add_daily_note(
    conn: &Connection,
    project_id: i64,
    task_id: Option<i64>,
    day: String,
    content: String,
) -> Result<DailyNote> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("记录内容不能为空".into());
    }
    let ts = unix_now();
    conn.execute(
        "INSERT INTO daily_notes (project_id, task_id, day, content, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![project_id, task_id, day, content, ts],
    )
    .map_err(|e| e.to_string())?;

    Ok(DailyNote {
        id: conn.last_insert_rowid(),
        project_id,
        task_id,
        day,
        content,
        created_at: ts,
        updated_at: ts,
    })
}

/// 改内容或改归属的那一天。
///
/// day 也可改，因为记错日子是常事（周一早上补记周五的事，很容易点成今天）；
/// created_at 不动 —— 它记的是「这句话是什么时候说的」，是历史事实。
pub fn update_daily_note(conn: &Connection, id: i64, day: String, content: String) -> Result<()> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("记录内容不能为空".into());
    }
    conn.execute(
        "UPDATE daily_notes SET day = ?2, content = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, day, content, unix_now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_daily_note(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM daily_notes WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/* ------------------------------------------------------------------ */
/* 基线                                                                */
/* ------------------------------------------------------------------ */

/// 冻结当前所有任务的日期。只存日期不存进度（DESIGN.md §3.1）。
pub fn create_baseline(conn: &mut Connection, project_id: i64, name: String) -> Result<BaselineRow> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let ts = now();

    tx.execute(
        "INSERT INTO baselines (project_id, name, created_at) VALUES (?1, ?2, ?3)",
        params![project_id, name, ts],
    )
    .map_err(|e| e.to_string())?;
    let baseline_id = tx.last_insert_rowid();

    tx.execute(
        "INSERT INTO baseline_tasks (baseline_id, task_id, name, start_date, end_date, duration)
         SELECT ?1, id, name, start_date, end_date,
                CAST(julianday(end_date) - julianday(start_date) + 1 AS INTEGER)
         FROM tasks WHERE project_id = ?2",
        params![baseline_id, project_id],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(BaselineRow { id: baseline_id, name, created_at: ts })
}

pub fn load_baseline(conn: &Connection, baseline_id: i64) -> Result<Vec<BaselineTaskRow>> {
    let mut stmt = conn
        .prepare(
            "SELECT task_id, name, start_date, end_date, duration
             FROM baseline_tasks WHERE baseline_id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![baseline_id], |r| {
            Ok(BaselineTaskRow {
                task_id: r.get(0)?,
                name: r.get(1)?,
                start_date: r.get(2)?,
                end_date: r.get(3)?,
                duration: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn delete_baseline(conn: &Connection, baseline_id: i64) -> Result<()> {
    conn.execute("DELETE FROM baselines WHERE id = ?1", params![baseline_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/* ------------------------------------------------------------------ */
/* 完整性体检                                                          */
/* ------------------------------------------------------------------ */

/**
 * 主动扫一遍已知的结构性风险，把结果讲给用户听。
 *
 * 出过一次静默的跨项目数据损坏之后，「我怎么知道现在是好的」这个问题
 * 必须有一个能自己按的按钮来回答，而不是只能等下次出事。
 */
pub fn check_integrity(conn: &Connection) -> Result<Vec<String>> {
    let mut issues = Vec::new();

    let count = |sql: &str| -> Result<i64> {
        conn.query_row(sql, [], |r| r.get(0)).map_err(|e| e.to_string())
    };

    let orphan_parent = count(
        "SELECT COUNT(*) FROM tasks WHERE parent_id IS NOT NULL
           AND parent_id NOT IN (SELECT id FROM tasks)",
    )?;
    if orphan_parent > 0 {
        issues.push(format!("{orphan_parent} 个任务的父任务已不存在"));
    }

    let cross_project = count(
        "SELECT COUNT(*) FROM tasks c JOIN tasks p ON p.id = c.parent_id
         WHERE c.project_id <> p.project_id",
    )?;
    if cross_project > 0 {
        issues.push(format!("{cross_project} 个任务的父任务属于别的项目"));
    }

    let self_ref = count("SELECT COUNT(*) FROM tasks WHERE parent_id = id")?;
    if self_ref > 0 {
        issues.push(format!("{self_ref} 个任务把自己当成了父任务"));
    }

    let bad_dates = count("SELECT COUNT(*) FROM tasks WHERE end_date < start_date")?;
    if bad_dates > 0 {
        issues.push(format!("{bad_dates} 个任务的结束日期早于开始日期"));
    }

    let orphan_task = count(
        "SELECT COUNT(*) FROM tasks WHERE project_id NOT IN (SELECT id FROM projects)",
    )?;
    if orphan_task > 0 {
        issues.push(format!("{orphan_task} 个任务不属于任何现存项目"));
    }

    let cross_dep = count(
        "SELECT COUNT(*) FROM dependencies d
         JOIN tasks a ON a.id = d.from_task_id
         JOIN tasks b ON b.id = d.to_task_id
         WHERE a.project_id <> b.project_id OR a.project_id <> d.project_id",
    )?;
    if cross_dep > 0 {
        issues.push(format!("{cross_dep} 条依赖跨越了项目边界"));
    }

    // SQLite 自己的一致性检查，能发现文件级损坏
    let fk: i64 = count("SELECT COUNT(*) FROM pragma_foreign_key_check")?;
    if fk > 0 {
        issues.push(format!("{fk} 处外键约束被破坏"));
    }

    Ok(issues)
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

pub fn get_setting(conn: &Connection, key: String) -> Result<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

pub fn set_setting(conn: &Connection, key: String, value: String) -> Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 按前缀列设置项，给插件系统用（`plugin.*`）。
///
/// 前缀里的 `%` `_` `\` 必须转义再拼 LIKE —— 它们是 LIKE 的通配符，
/// 不转义的话一个叫 `plugin.%.x` 的键会匹配到一大片无关设置。
pub fn list_settings_with_prefix(conn: &Connection, prefix: String) -> Result<Vec<(String, String)>> {
    let escaped = prefix
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings WHERE key LIKE ?1 ESCAPE '\\' ORDER BY key")
        .map_err(|e| e.to_string())?;
    // ⚠️ 必须 collect 进一个具名变量再返回，不能让它当块尾表达式。
    // query_map 借着 stmt，`?` 造出的临时值会活到块尾、比 stmt 还晚析构，
    // 编译器会报「stmt does not live long enough」—— 真正短命的是那个临时值。
    let rows = stmt
        .query_map(params![format!("{escaped}%")], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/* ------------------------------------------------------------------ */
/* 事项（QuickNote）                                                    */
/* ------------------------------------------------------------------ */

fn map_item_note(r: &rusqlite::Row) -> rusqlite::Result<ItemNote> {
    Ok(ItemNote {
        id: r.get(0)?,
        project_id: r.get(1)?,
        name: r.get(2)?,
        kind: r.get(3)?,
        priority: r.get(4)?,
        person_id: r.get(5)?,
        task_id: r.get(6)?,
        promoted_kind: r.get(7)?,
        promoted_ref: r.get(8)?,
        closed_at: r.get(9)?,
        resolution: r.get(10)?,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
    })
}

const ITEM_NOTE_COLS: &str = "id, project_id, name, kind, priority, person_id, task_id, \
                              promoted_kind, promoted_ref, closed_at, resolution, \
                              created_at, updated_at";

/// 一个项目的全部事项，**按创建时间倒序**。
///
/// 排序定在库里而不是前端：事项视图、将来的导出都要用同一个顺序。
/// 倒序是产品决定 —— 刚记下的那条必须在最上面，否则「快」这个唯一的
/// 核心指标在第二条就丢了。`id DESC` 兜住同一秒内连记两条的情况。
pub fn load_item_notes(conn: &Connection, project_id: i64) -> Result<Vec<ItemNote>> {
    let sql =
        format!("SELECT {ITEM_NOTE_COLS} FROM item_notes WHERE project_id = ?1 ORDER BY created_at DESC, id DESC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project_id], map_item_note)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn read_item_note(conn: &Connection, id: i64) -> Result<ItemNote> {
    let sql = format!("SELECT {ITEM_NOTE_COLS} FROM item_notes WHERE id = ?1");
    conn.query_row(&sql, params![id], map_item_note)
        .map_err(|_| "事项不存在".to_string())
}

/// 记一条事项。
///
/// **不收类型。** 分拣是分开的动作（设计稿 §4.2）：录入界面每多一个字段，
/// 记下来的概率就低一分，而「这是什么」往往要等记完才想清楚。
pub fn add_item_note(
    conn: &Connection,
    project_id: i64,
    name: String,
    priority: i64,
    person_id: Option<i64>,
    task_id: Option<i64>,
) -> Result<ItemNote> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("事项内容不能为空".into());
    }
    let priority = priority.clamp(0, 3);
    let ts = unix_now();
    conn.execute(
        "INSERT INTO item_notes (project_id, name, priority, person_id, task_id,
                                 created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![project_id, name, priority, person_id, task_id, ts],
    )
    .map_err(|e| e.to_string())?;

    Ok(ItemNote {
        id: conn.last_insert_rowid(),
        project_id,
        name,
        kind: None,
        priority,
        person_id,
        task_id,
        promoted_kind: None,
        promoted_ref: None,
        closed_at: None,
        resolution: None,
        created_at: ts,
        updated_at: ts,
    })
}

/// 改一条事项的字段：标题、类型、优先级、负责人、关联任务。
///
/// **不碰关闭状态，也不碰晋升去向。** 关闭要走 `close_item_note`（那条路强制
/// 按类型检查结论），分拣要走 `promote_*`（那条路要创建实体）。从这里顺手
/// 把 closed_at 一起改掉，等于给自己留了一个绕过记录的后门 —— 和
/// `update_risk` 有意不碰 `resolved` 是同一条规矩。
///
/// `kind` 传 None 就是改回「未分拣」。那是一个合法的目标状态，不是清空操作。
pub fn update_item_note(
    conn: &Connection,
    id: i64,
    name: String,
    kind: Option<String>,
    priority: i64,
    person_id: Option<i64>,
    task_id: Option<i64>,
) -> Result<()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("事项内容不能为空".into());
    }
    // 认不出来的类型一律拒绝。允许写进一个不存在的 key，列表里那一行会
    // 既不是「未分拣」也显示不出标签 —— 一个无法从界面上修好的状态
    if let Some(k) = &kind {
        let known: i64 = conn
            .query_row("SELECT COUNT(*) FROM item_kinds WHERE key = ?1", params![k], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if known == 0 {
            return Err(format!("没有名为「{k}」的事项类型"));
        }
    }
    let n = conn
        .execute(
            "UPDATE item_notes
                SET name = ?2, kind = ?3, priority = ?4, person_id = ?5, task_id = ?6,
                    updated_at = ?7
              WHERE id = ?1",
            params![id, name, kind, priority.clamp(0, 3), person_id, task_id, unix_now()],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("事项不存在".into());
    }
    Ok(())
}

/**
 * 关闭一条事项。返回关闭时刻（Unix 秒）。
 *
 * 关闭规则**按类型区分**，而且在库层强制（设计稿 §5.4）：
 *
 *   · 未分拣        —— 不能关。还没决定它是什么，谈不上完成
 *   · 已晋升成实体  —— 不能从这里关。阻碍要收区间、风险要写处置说明，
 *                      两者各有自己的关闭路径，从这里关会留下
 *                      「事项已关、实体还开着」的两份真相
 *   · requires_note —— 必须带结论
 *   · 其余（代办）  —— 单击即关
 *
 * UI 里也会拦一道，但规则只写在界面上等于没写：命令会多出入口，而一旦
 * 允许空结论，它就会变成默认路径，三个月后这张表又变回一排勾。
 */
pub fn close_item_note(conn: &Connection, id: i64, resolution: Option<String>) -> Result<i64> {
    let note = read_item_note(conn, id)?;
    if note.promoted_kind.is_some() {
        return Err("这条事项已经分拣成实体了，请到阻碍或风险那边关闭它".into());
    }
    let kind = note.kind.ok_or("还没分拣的事项不能关闭 —— 先决定它是什么")?;

    let requires_note: bool = conn
        .query_row(
            "SELECT requires_note FROM item_kinds WHERE key = ?1",
            params![kind],
            |r| Ok(r.get::<_, i64>(0)? != 0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(false);

    let resolution = resolution.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if requires_note && resolution.is_none() {
        return Err("关闭这一类事项要写清楚是怎么解决的".into());
    }

    let ts = unix_now();
    conn.execute(
        "UPDATE item_notes SET closed_at = ?2, resolution = ?3, updated_at = ?2 WHERE id = ?1",
        params![id, ts, resolution],
    )
    .map_err(|e| e.to_string())?;
    Ok(ts)
}

/// 重新打开。关闭时刻和结论一并清掉 —— 留着的话界面上会出现一条「未关闭」
/// 却挂着「已于某日解决」的事项，两个互相矛盾的说法。和 `reopen_risk` 同款。
pub fn reopen_item_note(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        "UPDATE item_notes SET closed_at = NULL, resolution = NULL, updated_at = ?2 WHERE id = ?1",
        params![id, unix_now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_item_note(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM item_notes WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/**
 * 分拣成风险：**一个事务里**建风险行 + 写回事项的晋升去向。
 *
 * 原子性是这条路和阻碍那条路的区别所在。风险是独立的表，所以创建实体和
 * 写回引用可以放进同一个事务 —— 要么两件事都成了，要么一件都没发生，
 * 不可能留下「风险建好了但事项还显示未分拣」。
 *
 * 阻碍做不到同样的事：它住在 `tasks.blocked` 这个 JSON 列里，由防抖的
 * 整项目保存写出，不在这个连接的事务边界内。那边的取舍见前端的
 * `promoteToBlocker` 注释。
 *
 * 优先级跟着事项过去（migrations/012_risk_priority.sql）：用户刚刚做的那个
 * 判断不该在分拣这一步被扔掉。
 */
pub fn promote_note_to_risk(
    conn: &mut Connection,
    note_id: i64,
    task_id: i64,
    content: String,
    level: i64,
    priority: Option<i64>,
) -> Result<Risk> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("风险内容不能为空".into());
    }
    let note = read_item_note(conn, note_id)?;
    if note.promoted_kind.is_some() {
        return Err("这条事项已经分拣过了".into());
    }

    let ts = unix_now();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO risks (task_id, content, level, created_at, priority)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![task_id, content, level, ts, priority],
    )
    .map_err(|e| e.to_string())?;
    let risk_id = tx.last_insert_rowid();
    tx.execute(
        "UPDATE item_notes
            SET promoted_kind = 'risk', promoted_ref = ?2, updated_at = ?3
          WHERE id = ?1",
        params![note_id, risk_id.to_string(), ts],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    Ok(Risk {
        id: risk_id,
        task_id,
        content,
        level,
        resolved: false,
        created_at: ts,
        resolved_at: None,
        resolution: None,
        priority,
    })
}

/**
 * 分拣成阻碍：只记下引用。阻碍实体本身由前端经命令栈写进 `tasks.blocked`。
 *
 * `promoted_ref` 的形态是 `'<taskId>/<periodId>'`。两段都要：periodId 在
 * 一个任务内唯一，但事项这边不知道它属于谁 —— 而列表要显示「卡在哪条活上」。
 */
pub fn promote_note_to_blocker(conn: &Connection, note_id: i64, promoted_ref: String) -> Result<()> {
    let note = read_item_note(conn, note_id)?;
    if note.promoted_kind.is_some() {
        return Err("这条事项已经分拣过了".into());
    }
    conn.execute(
        "UPDATE item_notes
            SET promoted_kind = 'blocker', promoted_ref = ?2, updated_at = ?3
          WHERE id = ?1",
        params![note_id, promoted_ref, unix_now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/**
 * 撤销分拣：把事项退回「未分拣」，并顺手删掉它当初创建的那个实体。
 *
 * 返回原来的 `promoted_ref`，调用方据此知道要从哪条任务上摘掉哪一段阻碍 ——
 * 风险这边在同一个事务里就删掉了，阻碍那边必须由前端走命令栈。
 *
 * 为什么要有这个出口：实体可以被单独删掉（阻碍能删、风险能删），此时事项上
 * 留着一个指向空处的引用。不给「改回未分拣」的话，用户唯一能做的就是把这条
 * 事项也删掉重记一遍 —— 而它记录的原始信息（谁在什么时候说的）就此丢失。
 * 所以**悬挂引用是预期状态，而不是损坏**（设计稿 §6.2 规则三）。
 */
pub fn unpromote_note(conn: &mut Connection, note_id: i64) -> Result<Option<String>> {
    let note = read_item_note(conn, note_id)?;
    let Some(kind) = note.promoted_kind.clone() else {
        return Ok(None);
    };

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // 风险在同一个事务里删掉。引用已经悬挂（风险被单独删过）时 DELETE
    // 影响 0 行，那不是错误 —— 目标状态本来就是「这条风险不存在」
    if kind == "risk" {
        if let Some(id) = note.promoted_ref.as_deref().and_then(|s| s.parse::<i64>().ok()) {
            tx.execute("DELETE FROM risks WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.execute(
        "UPDATE item_notes
            SET promoted_kind = NULL, promoted_ref = NULL, updated_at = ?2
          WHERE id = ?1",
        params![note_id, unix_now()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    Ok(note.promoted_ref)
}

/* ------------------------------------------------------------------ */
/* 事项类型                                                            */
/* ------------------------------------------------------------------ */

/// 全部类型，内置的在前（sort_order 已经这么排了）。
///
/// 内置的两行由打开库时的 `schema::ensure_builtin_kinds` 保证存在，
/// 所以这里查出来一定至少有两条 —— 但前端仍然有一份常量兜底，
/// 一个读不出类型的库不该让事项视图整个白掉。
pub fn list_item_kinds(conn: &Connection) -> Result<Vec<ItemKind>> {
    let mut stmt = conn
        .prepare(
            "SELECT key, label, color, requires_note, builtin, sort_order
               FROM item_kinds ORDER BY sort_order, key",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ItemKind {
                key: r.get(0)?,
                label: r.get(1)?,
                color: r.get(2)?,
                requires_note: r.get::<_, i64>(3)? != 0,
                builtin: r.get::<_, i64>(4)? != 0,
                sort_order: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// 新建或改一个类型。`builtin` 一列由库决定，调用方改不了 ——
/// 否则「内置不可删」这条规矩可以被一次改名绕过去。
pub fn save_item_kind(
    conn: &Connection,
    key: String,
    label: String,
    color: String,
    requires_note: bool,
) -> Result<()> {
    let label = label.trim().to_string();
    if label.is_empty() {
        return Err("类型名称不能为空".into());
    }
    conn.execute(
        "INSERT INTO item_kinds (key, label, color, requires_note, builtin, sort_order)
         VALUES (?1, ?2, ?3, ?4, 0,
                 (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM item_kinds))
         ON CONFLICT (key) DO UPDATE
            SET label = excluded.label,
                color = excluded.color,
                requires_note = excluded.requires_note",
        params![key, label, color, requires_note as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/**
 * 删一个自定义类型。内置的拒绝。
 *
 * 用着这个类型的事项**退回「未分拣」**，不是跟着删掉。理由是那条事项记录的
 * 内容和它被分到哪一类是两件事：类型没了之后「我还没决定这是什么」重新成立，
 * 而那句话本身必须留着。连带删除会让「整理一下类型清单」变成一次静默的数据
 * 丢失 —— 用户完全看不出自己刚刚删了什么。
 *
 * 返回被退回的条数，界面据此提示。
 */
pub fn delete_item_kind(conn: &mut Connection, key: String) -> Result<i64> {
    let builtin: Option<i64> = conn
        .query_row(
            "SELECT builtin FROM item_kinds WHERE key = ?1",
            params![key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match builtin {
        None => return Err("没有这个事项类型".into()),
        Some(1) => return Err("内置类型不能删除 —— 可以改名字和颜色".into()),
        _ => {}
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let reverted = tx
        .execute(
            "UPDATE item_notes SET kind = NULL, updated_at = ?2 WHERE kind = ?1",
            params![key, unix_now()],
        )
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM item_kinds WHERE key = ?1", params![key])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(reverted as i64)
}

/// 改一条风险的优先级。
///
/// 单独一个命令而不是塞进 `update_risk`：事项视图里改优先级是点一下标签就
/// 立刻生效的行内操作，而 update_risk 要带上正文和等级 —— 为了改一个小整数
/// 把整条正文回传一遍，中间任何一次并发编辑都会被这次回传盖掉。
pub fn set_risk_priority(conn: &Connection, id: i64, priority: Option<i64>) -> Result<()> {
    let n = conn
        .execute(
            "UPDATE risks SET priority = ?2 WHERE id = ?1",
            params![id, priority.map(|p| p.clamp(0, 3))],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("风险不存在".into());
    }
    Ok(())
}
