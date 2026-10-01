//! Tauri 命令薄层。
//!
//! 真正的逻辑全在 `gantt-core` 里 —— schema、查询、写入、日期助手。
//! 这里只剩下三件 Tauri 侧才有意义的事：
//!
//! 1. **把 `State<Db>` 里的 Mutex 锁起来**（core 只知道 `&Connection`）
//! 2. **保持前端看到的命令签名一字不变**（前端一行都不用改）
//! 3. **把错误收成 `Result<T, String>`**（core 已经是这个约定）
//!
//! 为什么值得这层包装而不是让前端直接调 core：core 不该知道 Tauri 的存在。
//! 它同时被 CLI 和桌面应用链接，一旦 import 了 `tauri::State`，
//! 「离线 CLI」就再也编不出来了。
//!
//! ⚠️ 下面的 `pub use` 不是装饰。`dbfile.rs` / `transfer.rs` / `backup.rs`
//! 里写的是 `crate::db::open`、`crate::db::Project`、`use crate::db::{Db, MIGRATIONS}`，
//! 靠这几行重导出才继续有效 —— 所以它们搬去 core 之后，那些文件一个字都不用改。

use gantt_core::model::*;
use gantt_core::query;
use rusqlite::Connection;
use std::sync::Mutex;

// —— 把 core 的公开面按原路径再导出一遍 ——
pub use gantt_core::model::Result;
pub use gantt_core::query::name_taken;
// `repair` 不在这里露出来：它由 `migrate` 内部调用，crate 里没人单独点名它。
pub use gantt_core::schema::{migrate, open, MIGRATIONS};

/// 前端拿到的是「一个连接 + 一把锁」，不是任意 SQL 的能力。
///
/// 用 Mutex 而不是连接池：桌面应用是单用户单窗口，所有写都从命令线程来，
/// 争用为零；而 SQLite 的单写者模型本来就串行，多开连接只是把排队挪个地方。
pub struct Db(pub Mutex<Connection>);

// —— 命令实现的公共前缀 ——
//
// 每个命令的第一句都是「拿到锁」。写成一个宏，省得 33 个函数里
// 复制 33 遍同样的 `.map_err(|e| e.to_string())`，也让「锁中毒怎么办」
// 只有一处需要想。

/// 锁住连接并执行。Mutex 中毒（某个命令 panic 时发生）不当作致命错误：
/// 数据库文件本身是完好的，重建连接即可，没必要让整个应用报废。
macro_rules! with_conn {
    ($db:expr, $conn:ident => $body:expr) => {{
        let $conn = $db.0.lock().map_err(|e| e.to_string())?;
        $body
    }};
}

/* ------------------------------------------------------------------ */
/* 项目                                                                */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn list_projects(db: tauri::State<Db>) -> Result<Vec<ProjectSummary>> {
    with_conn!(db, conn => query::list_projects(&conn))
}

#[tauri::command]
pub fn create_project(db: tauri::State<Db>, name: String, color: String) -> Result<Project> {
    with_conn!(db, conn => query::create_project(&conn, name, color))
}

#[tauri::command]
pub fn rename_project(db: tauri::State<Db>, id: i64, name: String, color: String) -> Result<()> {
    with_conn!(db, conn => query::rename_project(&conn, id, name, color))
}

#[tauri::command]
pub fn update_project_calendar(
    db: tauri::State<Db>,
    id: i64,
    work_days: String,
    holidays: String,
) -> Result<()> {
    with_conn!(db, conn => query::update_project_calendar(&conn, id, work_days, holidays))
}

#[tauri::command]
pub fn delete_project(db: tauri::State<Db>, id: i64) -> Result<()> {
    with_conn!(db, conn => query::delete_project(&conn, id))
}

#[tauri::command]
pub fn load_project(db: tauri::State<Db>, id: i64) -> Result<ProjectData> {
    with_conn!(db, conn => query::load_project(&conn, id))
}

/* ------------------------------------------------------------------ */
/* 负责人                                                              */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn list_people(db: tauri::State<Db>) -> Result<Vec<Person>> {
    with_conn!(db, conn => query::list_people(&conn))
}

#[tauri::command]
pub fn create_person(db: tauri::State<Db>, name: String, color: String) -> Result<Person> {
    with_conn!(db, conn => query::create_person(&conn, name, color))
}

#[tauri::command]
pub fn update_person(
    db: tauri::State<Db>,
    id: i64,
    name: String,
    color: String,
    avatar: Option<String>,
) -> Result<()> {
    with_conn!(db, conn => query::update_person(&conn, id, name, color, avatar))
}

#[tauri::command]
pub fn delete_person(db: tauri::State<Db>, id: i64) -> Result<()> {
    with_conn!(db, conn => query::delete_person(&conn, id))
}

#[tauri::command]
pub fn count_person_tasks(db: tauri::State<Db>, id: i64) -> Result<i64> {
    with_conn!(db, conn => query::count_person_tasks(&conn, id))
}

/* ------------------------------------------------------------------ */
/* 风险 / 评论 / 逐日记录                                              */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn load_task_notes(db: tauri::State<Db>, task_id: i64) -> Result<TaskNotes> {
    with_conn!(db, conn => query::load_task_notes(&conn, task_id))
}

#[tauri::command]
pub fn count_open_risks(db: tauri::State<Db>, project_id: i64) -> Result<Vec<(i64, i64)>> {
    with_conn!(db, conn => query::count_open_risks(&conn, project_id))
}

#[tauri::command]
pub fn load_project_risks(db: tauri::State<Db>, project_id: i64) -> Result<Vec<Risk>> {
    with_conn!(db, conn => query::load_project_risks(&conn, project_id))
}

#[tauri::command]
pub fn add_risk(db: tauri::State<Db>, task_id: i64, content: String, level: i64) -> Result<Risk> {
    with_conn!(db, conn => query::add_risk(&conn, task_id, content, level))
}

#[tauri::command]
pub fn update_risk(db: tauri::State<Db>, id: i64, content: String, level: i64) -> Result<()> {
    with_conn!(db, conn => query::update_risk(&conn, id, content, level))
}

#[tauri::command]
pub fn resolve_risk(db: tauri::State<Db>, id: i64, resolution: String) -> Result<i64> {
    with_conn!(db, conn => query::resolve_risk(&conn, id, resolution))
}

#[tauri::command]
pub fn reopen_risk(db: tauri::State<Db>, id: i64) -> Result<()> {
    with_conn!(db, conn => query::reopen_risk(&conn, id))
}

#[tauri::command]
pub fn delete_risk(db: tauri::State<Db>, id: i64) -> Result<()> {
    with_conn!(db, conn => query::delete_risk(&conn, id))
}

#[tauri::command]
pub fn add_comment(db: tauri::State<Db>, task_id: i64, content: String) -> Result<Comment> {
    with_conn!(db, conn => query::add_comment(&conn, task_id, content))
}

#[tauri::command]
pub fn delete_comment(db: tauri::State<Db>, id: i64) -> Result<()> {
    with_conn!(db, conn => query::delete_comment(&conn, id))
}

#[tauri::command]
pub fn load_daily_notes(db: tauri::State<Db>, project_id: i64) -> Result<Vec<DailyNote>> {
    with_conn!(db, conn => query::load_daily_notes(&conn, project_id))
}

#[tauri::command]
pub fn add_daily_note(
    db: tauri::State<Db>,
    project_id: i64,
    task_id: Option<i64>,
    day: String,
    content: String,
) -> Result<DailyNote> {
    with_conn!(db, conn => query::add_daily_note(&conn, project_id, task_id, day, content))
}

#[tauri::command]
pub fn update_daily_note(
    db: tauri::State<Db>,
    id: i64,
    day: String,
    content: String,
) -> Result<()> {
    with_conn!(db, conn => query::update_daily_note(&conn, id, day, content))
}

#[tauri::command]
pub fn delete_daily_note(db: tauri::State<Db>, id: i64) -> Result<()> {
    with_conn!(db, conn => query::delete_daily_note(&conn, id))
}

/* ------------------------------------------------------------------ */
/* 整项目保存                                                          */
/* ------------------------------------------------------------------ */

/// 前端唯一的重活。防抖 400ms 一次，把内存里那份完整任务表发过来。
///
/// 这里是全项目唯一需要 `&mut Connection` 的写路径（core 里要开事务），
/// 所以宏的 `$conn` 得是 mut 绑定 —— 见下面的显式写法，不用宏。
#[tauri::command]
pub fn save_project(
    db: tauri::State<Db>,
    id: i64,
    tasks: Vec<TaskRow>,
    dependencies: Vec<DependencyRow>,
) -> Result<()> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    gantt_core::write::save_project(&mut conn, id, tasks, dependencies)
}

/* ------------------------------------------------------------------ */
/* 基线                                                                */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn create_baseline(db: tauri::State<Db>, project_id: i64, name: String) -> Result<BaselineRow> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    query::create_baseline(&mut conn, project_id, name)
}

#[tauri::command]
pub fn load_baseline(db: tauri::State<Db>, baseline_id: i64) -> Result<Vec<BaselineTaskRow>> {
    with_conn!(db, conn => query::load_baseline(&conn, baseline_id))
}

#[tauri::command]
pub fn delete_baseline(db: tauri::State<Db>, baseline_id: i64) -> Result<()> {
    with_conn!(db, conn => query::delete_baseline(&conn, baseline_id))
}

/* ------------------------------------------------------------------ */
/* 自检 / 设置                                                         */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn check_integrity(db: tauri::State<Db>) -> Result<Vec<String>> {
    with_conn!(db, conn => query::check_integrity(&conn))
}

#[tauri::command]
pub fn get_setting(db: tauri::State<Db>, key: String) -> Result<Option<String>> {
    with_conn!(db, conn => query::get_setting(&conn, key))
}

#[tauri::command]
pub fn set_setting(db: tauri::State<Db>, key: String, value: String) -> Result<()> {
    with_conn!(db, conn => query::set_setting(&conn, key, value))
}

#[tauri::command]
pub fn list_settings_with_prefix(
    db: tauri::State<Db>,
    prefix: String,
) -> Result<Vec<(String, String)>> {
    with_conn!(db, conn => query::list_settings_with_prefix(&conn, prefix))
}
