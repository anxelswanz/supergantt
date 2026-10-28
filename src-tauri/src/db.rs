//! Tauri 命令薄层：只锁 Mutex、保持命令签名、把错误收成 `Result<T, String>`，逻辑在 `gantt-core`。
//! `pub use` 不能删：dbfile/transfer/backup 走的是 `crate::db::open` 这些路径。

use gantt_core::model::*;
use gantt_core::query;
use rusqlite::Connection;
use std::sync::Mutex;

pub use gantt_core::model::Result;
pub use gantt_core::query::name_taken;
// `repair` 由 `migrate` 内部调用，不导出
pub use gantt_core::schema::{migrate, open, MIGRATIONS};

/// 一个连接 + 一把锁。单用户单窗口，不需要连接池。
pub struct Db(pub Mutex<Connection>);

/// 锁住连接并执行。Mutex 中毒不当作致命错误：库文件完好，重建连接即可。
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
/* 事项（QuickNote）                                                    */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn load_item_notes(db: tauri::State<Db>, project_id: i64) -> Result<Vec<ItemNote>> {
    with_conn!(db, conn => query::load_item_notes(&conn, project_id))
}

#[tauri::command]
pub fn add_item_note(
    db: tauri::State<Db>,
    project_id: i64,
    name: String,
    priority: i64,
    person_id: Option<i64>,
    task_id: Option<i64>,
) -> Result<ItemNote> {
    with_conn!(db, conn => query::add_item_note(&conn, project_id, name, priority, person_id, task_id))
}

#[tauri::command]
pub fn update_item_note(
    db: tauri::State<Db>,
    id: i64,
    name: String,
    kind: Option<String>,
    priority: i64,
    person_id: Option<i64>,
    task_id: Option<i64>,
) -> Result<()> {
    with_conn!(db, conn => query::update_item_note(&conn, id, name, kind, priority, person_id, task_id))
}

#[tauri::command]
pub fn close_item_note(
    db: tauri::State<Db>,
    id: i64,
    resolution: Option<String>,
) -> Result<i64> {
    with_conn!(db, conn => query::close_item_note(&conn, id, resolution))
}

#[tauri::command]
pub fn reopen_item_note(db: tauri::State<Db>, id: i64) -> Result<()> {
    with_conn!(db, conn => query::reopen_item_note(&conn, id))
}

#[tauri::command]
pub fn delete_item_note(db: tauri::State<Db>, id: i64) -> Result<()> {
    with_conn!(db, conn => query::delete_item_note(&conn, id))
}

/// 分拣成风险。要开事务，需 `&mut Connection`，不走宏。
#[tauri::command]
pub fn promote_note_to_risk(
    db: tauri::State<Db>,
    note_id: i64,
    task_id: i64,
    content: String,
    level: i64,
    priority: Option<i64>,
) -> Result<Risk> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    query::promote_note_to_risk(&mut conn, note_id, task_id, content, level, priority)
}

#[tauri::command]
pub fn promote_note_to_blocker(
    db: tauri::State<Db>,
    note_id: i64,
    promoted_ref: String,
) -> Result<()> {
    with_conn!(db, conn => query::promote_note_to_blocker(&conn, note_id, promoted_ref))
}

/// 撤销分拣。返回原引用，前端据此摘掉对应阻碍区间。
#[tauri::command]
pub fn unpromote_note(db: tauri::State<Db>, note_id: i64) -> Result<Option<String>> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    query::unpromote_note(&mut conn, note_id)
}

#[tauri::command]
pub fn set_risk_priority(
    db: tauri::State<Db>,
    id: i64,
    priority: Option<i64>,
) -> Result<()> {
    with_conn!(db, conn => query::set_risk_priority(&conn, id, priority))
}

/* ------------------------------------------------------------------ */
/* 事项类型                                                            */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn list_item_kinds(db: tauri::State<Db>) -> Result<Vec<ItemKind>> {
    with_conn!(db, conn => query::list_item_kinds(&conn))
}

#[tauri::command]
pub fn save_item_kind(
    db: tauri::State<Db>,
    key: String,
    label: String,
    color: String,
    requires_note: bool,
) -> Result<()> {
    with_conn!(db, conn => query::save_item_kind(&conn, key, label, color, requires_note))
}

/// 删自定义类型。返回被退回「未分拣」的事项条数。
#[tauri::command]
pub fn delete_item_kind(db: tauri::State<Db>, key: String) -> Result<i64> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    query::delete_item_kind(&mut conn, key)
}

/* ------------------------------------------------------------------ */
/* 整项目保存                                                          */
/* ------------------------------------------------------------------ */

/// 全项目保存，前端防抖 400ms 发来完整任务表。要开事务，需 `&mut Connection`，不走宏。
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

/* ------------------------------------------------------------------ */
/* AI 复盘                                                             */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn list_ai_reviews(db: tauri::State<Db>, project_id: i64) -> Result<Vec<AiReview>> {
    with_conn!(db, conn => query::list_ai_reviews(&conn, project_id))
}

#[tauri::command]
pub fn create_ai_review(
    db: tauri::State<Db>,
    project_id: i64,
    title: String,
    background: String,
    snapshot: String,
) -> Result<AiReview> {
    with_conn!(db, conn => query::create_ai_review(&conn, project_id, title, background, snapshot))
}

/// 存进度。返回新的 updated_at（Unix 秒）。
#[tauri::command]
pub fn save_ai_review(
    db: tauri::State<Db>,
    id: i64,
    title: String,
    stage: String,
    questions: String,
    document: String,
) -> Result<i64> {
    with_conn!(db, conn => query::save_ai_review(&conn, id, title, stage, questions, document))
}

#[tauri::command]
pub fn delete_ai_review(db: tauri::State<Db>, id: i64) -> Result<()> {
    with_conn!(db, conn => query::delete_ai_review(&conn, id))
}

/* ------------------------------------------------------------------ */
/* 里程碑                                                              */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn load_milestones(db: tauri::State<Db>, project_id: i64) -> Result<Vec<gantt_core::model::Milestone>> {
    with_conn!(db, conn => gantt_core::query::load_milestones(&conn, project_id))
}

#[tauri::command]
pub fn add_milestone(
    db: tauri::State<Db>,
    project_id: i64,
    name: String,
    date: String,
    color: String,
    description: String,
    task_ids: Vec<i64>,
) -> Result<gantt_core::model::Milestone> {
    with_conn!(db, conn => gantt_core::query::add_milestone(&conn, project_id, name, date, color, description, task_ids))
}

#[tauri::command]
pub fn update_milestone(
    db: tauri::State<Db>,
    id: i64,
    name: String,
    date: String,
    color: String,
    description: String,
    task_ids: Vec<i64>,
) -> Result<()> {
    with_conn!(db, conn => gantt_core::query::update_milestone(&conn, id, name, date, color, description, task_ids))
}

#[tauri::command]
pub fn reorder_milestones(
    db: tauri::State<Db>,
    project_id: i64,
    ids: Vec<i64>,
) -> Result<()> {
    with_conn!(db, conn => gantt_core::query::reorder_milestones(&conn, project_id, ids))
}

#[tauri::command]
pub fn delete_milestone(db: tauri::State<Db>, id: i64) -> Result<()> {
    with_conn!(db, conn => gantt_core::query::delete_milestone(&conn, id))
}
