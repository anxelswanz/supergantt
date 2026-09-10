//! 数据访问层。
//!
//! 前端拿到的是一组类型化的 Tauri 命令，而不是一个能执行任意 SQL 的连接。
//! 这样 schema 只有一处知情方（本文件），渲染层不可能写出跟不上迁移的 SQL。
//!
//! 写入一律走 `save_project` 的整项目事务替换。理由见该函数的注释。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

pub struct Db(pub Mutex<Connection>);

/* ------------------------------------------------------------------ */
/* 迁移                                                                */
/* ------------------------------------------------------------------ */

pub(crate) const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_init.sql"),
    include_str!("../migrations/002_people.sql"),
    include_str!("../migrations/003_notes.sql"),
    include_str!("../migrations/004_blocked.sql"),
    include_str!("../migrations/005_actual_dates.sql"),
    include_str!("../migrations/006_daily_notes.sql"),
    include_str!("../migrations/007_project_identity.sql"),
    include_str!("../migrations/008_risk_resolution.sql"),
];

/// 用 SQLite 自带的 user_version 记录已应用的迁移数，不额外建表。
pub fn open(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // WAL：崩溃后能恢复到最后一次提交，且读写不互相阻塞
    conn.pragma_update(None, "journal_mode", "WAL")?;
    migrate(&conn)?;
    Ok(conn)
}

/// 把库补到当前 schema，再自愈一遍已知损坏。
///
/// 单独拆出来是因为整库导入（dbfile.rs）要对**别人的库**做同一件事：
/// 另一台电脑上的 Gantt 可能比本机旧几个版本，它的库得先迁到和本机一样，
/// 读取的 SQL 才对得上。两处共用一份迁移逻辑，就不会有「本机能开、导入读不懂」。
pub(crate) fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        conn.execute_batch(sql)?;
        conn.pragma_update(None, "user_version", (i + 1) as i64)?;
    }
    repair(conn)
}

/**
 * 打开时自愈已知的结构性损坏。
 *
 * 历史上有一个 bug：前端按「当前项目最大 id + 1」分配任务 id，而 tasks.id 是
 * 全局主键，于是一个项目里新建的任务会改写另一个项目的行，并留下
 * **跨项目的父子引用**。那种引用是真正危险的 —— parent_id 上挂着
 * ON DELETE CASCADE，删掉 A 项目的一个任务会连带删掉 B 项目的子树。
 *
 * 这里把这类引用降级成「顶层任务」而不是删掉它们：数据宁可结构变浅，
 * 也不能凭空消失。
 */
fn repair(conn: &Connection) -> rusqlite::Result<()> {
    let fixed = conn.execute(
        "UPDATE tasks SET parent_id = NULL
         WHERE parent_id IS NOT NULL
           AND parent_id NOT IN (
                 SELECT p.id FROM tasks p WHERE p.project_id = tasks.project_id
               )",
        [],
    )?;
    if fixed > 0 {
        eprintln!("[repair] 清理了 {fixed} 条跨项目的父子引用（降级为顶层任务）");
    }

    // 自己当自己的父节点会让展平逻辑陷入死循环
    let selfref = conn.execute("UPDATE tasks SET parent_id = NULL WHERE parent_id = id", [])?;
    if selfref > 0 {
        eprintln!("[repair] 清理了 {selfref} 条自引用");
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* 模型                                                                */
/* ------------------------------------------------------------------ */

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: i64,
    /**
     * 跨机器的项目身份，见 migrations/007_project_identity.sql。
     *
     * 和 `id` 的分工：`id` 只在本机这一个库里有意义，导出到文件、
     * 在另一台机器上导入之后就换了一个值；`uuid` 跟着项目本身走，
     * 无论传几台电脑都不变，导入时靠它认出「这是同一个项目」。
     */
    pub uuid: String,
    pub name: String,
    pub color: String,
    /// JSON 数组字符串，如 "[1,2,3,4,5]"
    pub work_days: String,
    pub holidays: String,
    pub sort_order: f64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskRow {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    /// ISO 'YYYY-MM-DD'，见 migrations/001_init.sql 顶部关于日期存储的说明
    pub start_date: String,
    pub end_date: String,
    /// 实施起止。两端要么都为 None（还没动过），要么都有值
    pub actual_start: Option<String>,
    pub actual_end: Option<String>,
    pub progress: f64,
    pub priority: i64,
    /// 指向 people 表；为 None 表示无负责人
    pub person_id: Option<i64>,
    pub milestone: bool,
    pub weight: Option<f64>,
    pub collapsed: bool,
    pub pinned: bool,
    pub note: String,
    pub sort_order: f64,
    /// 受阻时段的 JSON 数组，见 migrations/004_blocked.sql
    pub blocked: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DependencyRow {
    pub id: i64,
    pub from_task_id: i64,
    pub to_task_id: i64,
    /// 'FS' | 'SS' | 'FF' | 'SF'。第一版只产生 FS（DESIGN.md §2.1）
    pub kind: String,
    pub lag_days: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BaselineRow {
    pub id: i64,
    pub name: String,
    pub created_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BaselineTaskRow {
    pub task_id: i64,
    pub name: String,
    pub start_date: String,
    pub end_date: String,
    pub duration: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: i64,
    pub name: String,
    /// 头像底色，同时也是「按负责人着色」时甘特条的颜色
    pub color: String,
    /// base64 data URI；为 None 时前端回退到首字母头像
    pub avatar: Option<String>,
    pub sort_order: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectData {
    pub project: Project,
    pub tasks: Vec<TaskRow>,
    pub dependencies: Vec<DependencyRow>,
    pub baselines: Vec<BaselineRow>,
    pub people: Vec<Person>,
    /**
     * 全局下一个可用的任务 id。
     *
     * 前端自己分配 id，但 tasks.id 是**全局**主键 —— 只看当前项目的最大 id 去 +1，
     * 在项目 B 里造出的 id 会撞上项目 A 已有的行。所以这个值必须由库来给。
     */
    pub next_task_id: i64,
}

/// 项目列表卡片需要的汇总值，全部在 SQL 里算，不用把任务捞到前端再统计。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub project: Project,
    pub task_count: i64,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    /// 只统计叶子任务，父任务的 progress 列不可信（DESIGN.md §1.2）
    pub leaf_count: i64,
    pub overdue_count: i64,
    pub progress: f64,
}

type Result<T> = std::result::Result<T, String>;

fn now() -> String {
    // 只用于 created_at / updated_at 的展示，秒级精度足够
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

/**
 * 把项目名唯一索引的报错翻译成人话。
 *
 * 名字是用户每天都在看的东西，撞名是最常见的一种失败 —— 甩一句
 * `UNIQUE constraint failed: projects.name` 出去等于让用户自己去猜。
 * 唯一性本身的理由见 migrations/007_project_identity.sql。
 */
pub(crate) fn name_taken(e: rusqlite::Error, name: &str) -> String {
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
    })
}

/* ------------------------------------------------------------------ */
/* 项目                                                                */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn list_projects(db: tauri::State<Db>) -> Result<Vec<ProjectSummary>> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
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

#[tauri::command]
pub fn create_project(db: tauri::State<Db>, name: String, color: String) -> Result<Project> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
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

#[tauri::command]
pub fn rename_project(db: tauri::State<Db>, id: i64, name: String, color: String) -> Result<()> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE projects SET name = ?2, color = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, name, color, now()],
    )
    .map_err(|e| name_taken(e, &name))?;
    Ok(())
}

/// 更新项目的工作日历（DESIGN.md §1.5）。
/// work_days 是 "[1,2,3,4,5]" 这样的星期序号数组，holidays 是 ISO 日期数组。
#[tauri::command]
pub fn update_project_calendar(
    db: tauri::State<Db>,
    id: i64,
    work_days: String,
    holidays: String,
) -> Result<()> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE projects SET work_days = ?2, holidays = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, work_days, holidays, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_project(db: tauri::State<Db>, id: i64) -> Result<()> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // 任务、依赖、基线都靠 ON DELETE CASCADE 跟着走
    conn.execute("DELETE FROM projects WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_project(db: tauri::State<Db>, id: i64) -> Result<ProjectData> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

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

    let people = read_people(&conn).map_err(|e| e.to_string())?;

    // 取全库最大 id，而不是本项目的 —— 见 next_task_id 的说明
    let next_task_id: i64 = conn
        .query_row("SELECT COALESCE(MAX(id), 0) + 1 FROM tasks", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    Ok(ProjectData { project, tasks, dependencies, baselines, people, next_task_id })
}

/* ------------------------------------------------------------------ */
/* 负责人                                                              */
/* ------------------------------------------------------------------ */

fn read_people(conn: &Connection) -> rusqlite::Result<Vec<Person>> {
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

#[tauri::command]
pub fn list_people(db: tauri::State<Db>) -> Result<Vec<Person>> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    read_people(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_person(db: tauri::State<Db>, name: String, color: String) -> Result<Person> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("负责人名字不能为空".into());
    }

    let conn = db.0.lock().map_err(|e| e.to_string())?;
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
#[tauri::command]
pub fn update_person(
    db: tauri::State<Db>,
    id: i64,
    name: String,
    color: String,
    avatar: Option<String>,
) -> Result<()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("负责人名字不能为空".into());
    }

    let conn = db.0.lock().map_err(|e| e.to_string())?;
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
#[tauri::command]
pub fn delete_person(db: tauri::State<Db>, id: i64) -> Result<()> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM people WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/* ------------------------------------------------------------------ */
/* 风险点与评论                                                        */
/* ------------------------------------------------------------------ */

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Risk {
    pub id: i64,
    pub task_id: i64,
    pub content: String,
    /// 0 高 / 1 中 / 2 低
    pub level: i64,
    pub resolved: bool,
    /// Unix 秒，格式化交给前端
    pub created_at: i64,
    /// 关闭的时刻。None = 还开着，或者是没有这一列的历史记录
    pub resolved_at: Option<i64>,
    /// 怎么关掉的。复盘时真正有价值的是这一句，不是那个勾
    pub resolution: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: i64,
    pub task_id: i64,
    pub content: String,
    pub created_at: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskNotes {
    pub risks: Vec<Risk>,
    pub comments: Vec<Comment>,
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn load_task_notes(db: tauri::State<Db>, task_id: i64) -> Result<TaskNotes> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let risks = {
        let mut stmt = conn
            .prepare(
                "SELECT id, task_id, content, level, resolved, created_at,
                        resolved_at, resolution
                 FROM risks WHERE task_id = ?1
                 ORDER BY resolved, level, created_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
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
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        rows
    };

    let comments = {
        let mut stmt = conn
            .prepare(
                "SELECT id, task_id, content, created_at
                 FROM comments WHERE task_id = ?1 ORDER BY created_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
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
        rows
    };

    Ok(TaskNotes { risks, comments })
}

/// 每个任务有几条**未解决**的风险 —— 左侧网格靠它显示角标。
/// 看不见的风险等于没记，所以这个计数必须一次性随项目加载。
#[tauri::command]
pub fn count_open_risks(db: tauri::State<Db>, project_id: i64) -> Result<Vec<(i64, i64)>> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
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
#[tauri::command]
pub fn load_project_risks(db: tauri::State<Db>, project_id: i64) -> Result<Vec<Risk>> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT r.id, r.task_id, r.content, r.level, r.resolved, r.created_at,
                    r.resolved_at, r.resolution
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
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn add_risk(db: tauri::State<Db>, task_id: i64, content: String, level: i64) -> Result<Risk> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("风险内容不能为空".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
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
    })
}

/// 改一条风险的措辞或等级。**不碰开关状态** —— 关闭要走 resolve_risk，
/// 那条路强制留下处置说明；从这里顺手把 resolved 一起改掉，等于给自己
/// 留了一个绕过记录的后门。
#[tauri::command]
pub fn update_risk(db: tauri::State<Db>, id: i64, content: String, level: i64) -> Result<()> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("风险内容不能为空".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
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
#[tauri::command]
pub fn resolve_risk(db: tauri::State<Db>, id: i64, resolution: String) -> Result<i64> {
    let resolution = resolution.trim().to_string();
    if resolution.is_empty() {
        return Err("关闭风险要写清楚是怎么解决的".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
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
#[tauri::command]
pub fn reopen_risk(db: tauri::State<Db>, id: i64) -> Result<()> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE risks SET resolved = 0, resolved_at = NULL, resolution = NULL WHERE id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_risk(db: tauri::State<Db>, id: i64) -> Result<()> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM risks WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn add_comment(db: tauri::State<Db>, task_id: i64, content: String) -> Result<Comment> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("评论内容不能为空".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
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

#[tauri::command]
pub fn delete_comment(db: tauri::State<Db>, id: i64) -> Result<()> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM comments WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/* ------------------------------------------------------------------ */
/* 逐日记录（时间线）                                                   */
/* ------------------------------------------------------------------ */

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DailyNote {
    pub id: i64,
    pub project_id: i64,
    /// null = 项目级的当天记录，不挂在任何一条任务上
    pub task_id: Option<i64>,
    /// 说的是哪一天。ISO 'YYYY-MM-DD'
    pub day: String,
    pub content: String,
    /// 什么时候写的。和 day 不是一回事 —— 周五补记周三的事，两者相差两天
    pub created_at: i64,
    pub updated_at: i64,
}

/// 一个项目的全部逐日记录，按天正序、同一天内按写入顺序。
///
/// 排序放在库里而不是前端：时间线、任务详情、将来的导出都要用同一个顺序，
/// 三处各排一次迟早有一处不一样。
#[tauri::command]
pub fn load_daily_notes(db: tauri::State<Db>, project_id: i64) -> Result<Vec<DailyNote>> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
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

#[tauri::command]
pub fn add_daily_note(
    db: tauri::State<Db>,
    project_id: i64,
    task_id: Option<i64>,
    day: String,
    content: String,
) -> Result<DailyNote> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("记录内容不能为空".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
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
#[tauri::command]
pub fn update_daily_note(
    db: tauri::State<Db>,
    id: i64,
    day: String,
    content: String,
) -> Result<()> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("记录内容不能为空".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE daily_notes SET day = ?2, content = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, day, content, unix_now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_daily_note(db: tauri::State<Db>, id: i64) -> Result<()> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM daily_notes WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 某个人身上挂了多少任务 —— 删除前提示用，避免误删掉一个还在被大量引用的人。
#[tauri::command]
pub fn count_person_tasks(db: tauri::State<Db>, id: i64) -> Result<i64> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT COUNT(*) FROM tasks WHERE person_id = ?1",
        params![id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/* ------------------------------------------------------------------ */
/* 写入                                                                */
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
#[tauri::command]
pub fn save_project(
    db: tauri::State<Db>,
    id: i64,
    tasks: Vec<TaskRow>,
    dependencies: Vec<DependencyRow>,
) -> Result<()> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
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
        let own: std::collections::HashSet<i64> = tasks.iter().map(|t| t.id).collect();
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
                    sort_order, blocked, actual_start, actual_end, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?19)
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
                t.actual_start, t.actual_end, ts,
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
/* 基线                                                                */
/* ------------------------------------------------------------------ */

/// 冻结当前所有任务的日期。只存日期不存进度（DESIGN.md §3.1）。
#[tauri::command]
pub fn create_baseline(db: tauri::State<Db>, project_id: i64, name: String) -> Result<BaselineRow> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
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

#[tauri::command]
pub fn load_baseline(db: tauri::State<Db>, baseline_id: i64) -> Result<Vec<BaselineTaskRow>> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
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

#[tauri::command]
pub fn delete_baseline(db: tauri::State<Db>, baseline_id: i64) -> Result<()> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
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
#[tauri::command]
pub fn check_integrity(db: tauri::State<Db>) -> Result<Vec<String>> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
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

#[tauri::command]
pub fn get_setting(db: tauri::State<Db>, key: String) -> Result<Option<String>> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_setting(db: tauri::State<Db>, key: String, value: String) -> Result<()> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn today_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, m, d) = crate::backup::civil_from_days(secs.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        for sql in MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    #[test]
    fn migrations_apply_cleanly() {
        let conn = mem();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // projects / tasks / dependencies / baselines / baseline_tasks / settings + sqlite_sequence
        assert!(count >= 6, "建表数量不对：{count}");
    }

    /// daily_notes 的两条关键约束：task_id 可空（项目级记录），
    /// 以及挂在任务上的记录随任务删除一起走 —— 否则时间线上会出现
    /// 一条没有落点的孤儿记录，而用户根本不知道它属于谁。
    #[test]
    fn daily_notes_allow_null_task_and_cascade() {
        let conn = mem();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (1, 'P', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, name, start_date, end_date, created_at, updated_at)
             VALUES (1, 1, 'A', '2026-08-03', '2026-08-07', '0', '0')",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO daily_notes (project_id, task_id, day, content, created_at, updated_at)
             VALUES (1, 1, '2026-08-05', '等料', 0, 0),
                    (1, NULL, '2026-08-05', '今天全场停工', 0, 0)",
            [],
        )
        .unwrap();

        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM daily_notes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 2, "项目级记录（task_id 为空）必须存得进去");

        conn.execute("DELETE FROM tasks WHERE id = 1", []).unwrap();

        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM daily_notes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 1, "任务删了，挂它的记录要跟着走；项目级那条要留下");

        let orphan: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM daily_notes WHERE task_id IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphan, 0);
    }

    /// 002 迁移要把已有的 assignee 文本拆成 people 表并回填外键。
    /// 这是整次改动里唯一会碰用户既有数据的地方，必须逐条验证。
    #[test]
    fn migration_002_backfills_people_from_assignee_text() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();

        // 只跑到 001，模拟升级前的库
        conn.execute_batch(MIGRATIONS[0]).unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (1, 'P', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, name, start_date, end_date, assignee, created_at, updated_at)
             VALUES (1, 1, 'A', '2026-08-03', '2026-08-07', '张三', '0', '0'),
                    (2, 1, 'B', '2026-08-03', '2026-08-07', '李四', '0', '0'),
                    (3, 1, 'C', '2026-08-03', '2026-08-07', '张三', '0', '0'),
                    (4, 1, 'D', '2026-08-03', '2026-08-07', '',     '0', '0')",
            [],
        )
        .unwrap();

        conn.execute_batch(MIGRATIONS[1]).unwrap();

        // 去重：两条张三只产生一个人
        let people: i64 = conn
            .query_row("SELECT COUNT(*) FROM people", [], |r| r.get(0))
            .unwrap();
        assert_eq!(people, 2, "应该只有张三和李四两个人");

        // 空 assignee 不该造出一个空名字的人
        let blank: i64 = conn
            .query_row("SELECT COUNT(*) FROM people WHERE TRIM(name) = ''", [], |r| r.get(0))
            .unwrap();
        assert_eq!(blank, 0);

        // 外键回填正确：任务 1 和 3 指向同一个人
        let (p1, p3): (i64, i64) = conn
            .query_row(
                "SELECT (SELECT person_id FROM tasks WHERE id = 1),
                        (SELECT person_id FROM tasks WHERE id = 3)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(p1, p3);

        // 原来没有负责人的任务保持为空
        let p4: Option<i64> = conn
            .query_row("SELECT person_id FROM tasks WHERE id = 4", [], |r| r.get(0))
            .unwrap();
        assert_eq!(p4, None);

        // 迁移出来的人颜色不能全一样，否则「按负责人着色」失去意义
        let distinct_colors: i64 = conn
            .query_row("SELECT COUNT(DISTINCT color) FROM people", [], |r| r.get(0))
            .unwrap();
        assert_eq!(distinct_colors, 2);

        // 冗余的名字列已经拿掉，不会和 people.name 分叉
        assert!(conn.prepare("SELECT assignee FROM tasks").is_err());
    }

    /// save_project 用的是 upsert 而不是「删光再插入」。
    /// 如果哪天有人改回 DELETE + INSERT，风险点和评论会被外键级联静默清空 ——
    /// 这条测试就是那道闸门。
    #[test]
    fn saving_a_project_must_not_wipe_risks_and_comments() {
        let conn = mem();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (1, 'P', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, name, start_date, end_date, created_at, updated_at)
             VALUES (1, 1, 'A', '2026-08-03', '2026-08-07', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO risks (task_id, content, level, created_at) VALUES (1, '接口没定', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO comments (task_id, content, created_at) VALUES (1, '和后端约了周三', 0)",
            [],
        )
        .unwrap();

        // 模拟一次保存：同一个 id 用 upsert 写回，改了名字和日期
        conn.execute(
            "INSERT INTO tasks
               (id, project_id, name, start_date, end_date, created_at, updated_at)
             VALUES (1, 1, 'A 改名了', '2026-08-05', '2026-08-09', '0', '1')
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               start_date = excluded.start_date,
               end_date = excluded.end_date,
               updated_at = excluded.updated_at",
            [],
        )
        .unwrap();

        let (risks, comments): (i64, i64) = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM risks), (SELECT COUNT(*) FROM comments)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(risks, 1, "保存把风险点冲掉了");
        assert_eq!(comments, 1, "保存把评论冲掉了");

        // 但任务真的被删除时，附注应该跟着走，不留孤儿
        conn.execute("DELETE FROM tasks WHERE id = 1", []).unwrap();
        let leftover: i64 = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM risks) + (SELECT COUNT(*) FROM comments)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(leftover, 0);
    }

    /// 曾经的真实数据损坏事故：
    ///
    /// 前端按「当前项目最大 id + 1」分配 id，而 tasks.id 是全局主键。
    /// 在项目 B 里新建任务拿到的 id 撞上项目 A 已有的行时，upsert 的
    /// ON CONFLICT 分支不改 project_id，于是**项目 A 的那条任务被整个改写**，
    /// 而且改完还留在项目 A —— 用户在项目 B 什么都没看到，项目 A 的数据没了。
    ///
    /// 现在跨项目撞车必须让整次保存失败，一个字节都不许写。
    #[test]
    fn cross_project_id_clash_must_abort_the_whole_save() {
        let conn = mem();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at)
             VALUES (1, 'A', '0', '0'), (2, 'B', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, name, start_date, end_date, created_at, updated_at)
             VALUES (7, 1, '项目A的重要任务', '2026-08-02', '2026-08-17', '0', '0')",
            [],
        )
        .unwrap();

        // 模拟 save_project 的前置检查：项目 2 想写一个 id=7 的任务
        let ids = "7";
        let clash: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM tasks WHERE project_id <> ?1 AND id IN ({ids})"),
                params![2],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(clash, 1, "没有检出跨项目撞车");

        // 检出之后必须中止，项目 A 的那一行原封不动
        let (name, project): (String, i64) = conn
            .query_row("SELECT name, project_id FROM tasks WHERE id = 7", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(name, "项目A的重要任务");
        assert_eq!(project, 1);
    }

    /// 同项目内的 id 不算撞车 —— 那是正常的「更新已有任务」
    /// 跨项目的 parent_id 是最危险的一种脏数据：parent_id 上挂着
    /// ON DELETE CASCADE，删 A 项目的一个任务会把 B 项目的子树一起带走。
    #[test]
    fn opening_the_db_downgrades_cross_project_parents() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        for sql in MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at)
             VALUES (1, 'A', '0', '0'), (2, 'B', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, parent_id, name, start_date, end_date, created_at, updated_at)
             VALUES (6, 1, NULL, 'A的父任务', '2026-08-02', '2026-08-17', '0', '0'),
                    (1, 2, 6,    'B的子任务', '2026-08-03', '2026-08-21', '0', '0'),
                    (2, 2, 2,    '自引用',   '2026-08-03', '2026-08-21', '0', '0')",
            [],
        )
        .unwrap();

        repair(&conn).unwrap();

        // 降级成顶层任务，但**数据本身一条都不能少**
        let (parent, total): (Option<i64>, i64) = conn
            .query_row(
                "SELECT (SELECT parent_id FROM tasks WHERE id = 1), (SELECT COUNT(*) FROM tasks)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(parent, None, "跨项目父引用没有被清掉");
        assert_eq!(total, 3, "修复过程中丢了数据");

        let selfref: Option<i64> = conn
            .query_row("SELECT parent_id FROM tasks WHERE id = 2", [], |r| r.get(0))
            .unwrap();
        assert_eq!(selfref, None, "自引用没有被清掉");
    }

    /// 删一个项目的任务，绝不能连带删掉另一个项目的东西
    #[test]
    fn cascade_never_crosses_project_boundary_after_repair() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        for sql in MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at)
             VALUES (1, 'A', '0', '0'), (2, 'B', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, parent_id, name, start_date, end_date, created_at, updated_at)
             VALUES (6, 1, NULL, 'A', '2026-08-02', '2026-08-17', '0', '0'),
                    (1, 2, 6,    'B', '2026-08-03', '2026-08-21', '0', '0')",
            [],
        )
        .unwrap();

        repair(&conn).unwrap();
        conn.execute("DELETE FROM tasks WHERE id = 6", []).unwrap();

        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM tasks WHERE project_id = 2", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 1, "级联删除跨越了项目边界");
    }

    #[test]
    fn same_project_id_is_not_a_clash() {
        let conn = mem();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (1, 'A', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, name, start_date, end_date, created_at, updated_at)
             VALUES (7, 1, 'X', '2026-08-02', '2026-08-17', '0', '0')",
            [],
        )
        .unwrap();

        let clash: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE project_id <> ?1 AND id IN (7)",
                params![1],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(clash, 0);
    }

    /// 新任务的 id 基准必须来自全库，不是当前项目
    #[test]
    fn next_task_id_is_global_not_per_project() {
        let conn = mem();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at)
             VALUES (1, 'A', '0', '0'), (2, 'B', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, name, start_date, end_date, created_at, updated_at)
             VALUES (7, 1, 'A的任务', '2026-08-02', '2026-08-17', '0', '0'),
                    (8, 1, 'A的任务2', '2026-08-02', '2026-08-17', '0', '0')",
            [],
        )
        .unwrap();

        // 项目 2 一条任务都没有，但下一个 id 必须是 9 而不是 1
        let next: i64 = conn
            .query_row("SELECT COALESCE(MAX(id), 0) + 1 FROM tasks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(next, 9);
    }

    #[test]
    fn deleting_a_person_keeps_their_tasks() {
        let conn = mem();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (1, 'P', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO people (id, name, color, created_at) VALUES (1, '张三', '#4f46e5', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, name, start_date, end_date, person_id, created_at, updated_at)
             VALUES (1, 1, 'A', '2026-08-03', '2026-08-07', 1, '0', '0')",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM people WHERE id = 1", []).unwrap();

        // 任务还在，只是没了负责人 —— 删人不该连带毁掉排期
        let (count, person): (i64, Option<i64>) = conn
            .query_row(
                "SELECT COUNT(*), MAX(person_id) FROM tasks",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(person, None);
    }

    #[test]
    fn people_names_must_be_unique() {
        let conn = mem();
        conn.execute(
            "INSERT INTO people (name, color, created_at) VALUES ('张三', '#000000', '0')",
            [],
        )
        .unwrap();
        assert!(conn
            .execute(
                "INSERT INTO people (name, color, created_at) VALUES ('张三', '#111111', '0')",
                [],
            )
            .is_err());
    }

    #[test]
    fn deleting_project_cascades_to_tasks_and_deps() {
        let conn = mem();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (1, 'P', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, name, start_date, end_date, created_at, updated_at)
             VALUES (1, 1, 'A', '2026-08-03', '2026-08-07', '0', '0'),
                    (2, 1, 'B', '2026-08-08', '2026-08-10', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO dependencies (project_id, from_task_id, to_task_id) VALUES (1, 1, 2)",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM projects WHERE id = 1", []).unwrap();

        for table in ["tasks", "dependencies"] {
            let n: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "{table} 没有被级联删除");
        }
    }

    #[test]
    fn schema_rejects_corrupt_data() {
        let conn = mem();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (1, 'P', '0', '0')",
            [],
        )
        .unwrap();

        // 结束日期早于开始日期
        assert!(conn
            .execute(
                "INSERT INTO tasks (project_id, name, start_date, end_date, created_at, updated_at)
                 VALUES (1, 'X', '2026-08-10', '2026-08-01', '0', '0')",
                [],
            )
            .is_err());

        // 进度超出 0–1
        assert!(conn
            .execute(
                "INSERT INTO tasks (project_id, name, start_date, end_date, progress, created_at, updated_at)
                 VALUES (1, 'X', '2026-08-01', '2026-08-10', 1.5, '0', '0')",
                [],
            )
            .is_err());

        conn.execute(
            "INSERT INTO tasks (id, project_id, name, start_date, end_date, created_at, updated_at)
             VALUES (1, 1, 'A', '2026-08-01', '2026-08-02', '0', '0')",
            [],
        )
        .unwrap();

        // 自依赖
        assert!(conn
            .execute(
                "INSERT INTO dependencies (project_id, from_task_id, to_task_id) VALUES (1, 1, 1)",
                [],
            )
            .is_err());

        // 未知依赖类型
        assert!(conn
            .execute(
                "INSERT INTO dependencies (project_id, from_task_id, to_task_id, type)
                 VALUES (1, 1, 1, 'XX')",
                [],
            )
            .is_err());
    }

    #[test]
    fn baseline_rows_survive_task_deletion() {
        // 基线里的任务被删掉后，快照必须留着 —— 对比模式要显示「原计划存在，现已删除」
        let conn = mem();
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (1, 'P', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, name, start_date, end_date, created_at, updated_at)
             VALUES (7, 1, 'A', '2026-08-01', '2026-08-05', '0', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO baselines (id, project_id, name, created_at) VALUES (1, 1, '初始计划', '0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO baseline_tasks (baseline_id, task_id, name, start_date, end_date, duration)
             SELECT 1, id, name, start_date, end_date, 5 FROM tasks WHERE id = 7",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM tasks WHERE id = 7", []).unwrap();

        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM baseline_tasks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "基线快照不该跟着任务一起被删");
    }
}
