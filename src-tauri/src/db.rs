//! Tauri 命令薄层：只锁 Mutex、保持命令签名、把错误收成 `Result<T, String>`，逻辑在 `gantt-core`。
//! `pub use` 不能删：dbfile/transfer/backup 走的是 `crate::db::open` 这些路径。

use gantt_core::model::*;
use gantt_core::{account, query};
use rusqlite::Connection;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;

pub use gantt_core::model::Result;
pub use gantt_core::query::name_taken;
// `repair` 由 `migrate` 内部调用，不导出
pub use gantt_core::schema::{migrate, open, MIGRATIONS};

/// 一个连接 + 一把锁 + 当前登录的账号（0 = 没登录）。单窗口，不需要连接池。
///
/// 当前账号放在 Rust 侧而不是让前端每次传：前端传的账号 id 就是前端说了算，
/// 那「A 看不到 B 的项目」只剩界面上的一层皮。放在这里，每个命令都从同一处取身份。
pub struct Db(pub Mutex<Connection>, pub AtomicI64);

impl Db {
    pub fn new(conn: Connection) -> Db {
        Db(Mutex::new(conn), AtomicI64::new(0))
    }

    /// 当前账号。没登录时所有项目级命令都拒绝 —— 前端在登录页时本来就不会调它们。
    pub fn me(&self) -> Result<i64> {
        match self.1.load(Ordering::SeqCst) {
            0 => Err("还没有登录账号".into()),
            id => Ok(id),
        }
    }

    pub fn set_me(&self, id: Option<i64>) {
        self.1.store(id.unwrap_or(0), Ordering::SeqCst);
    }
}

/// 锁住连接并执行。Mutex 中毒不当作致命错误：库文件完好，重建连接即可。
macro_rules! with_conn {
    ($db:expr, $conn:ident => $body:expr) => {{
        let $conn = $db.0.lock().map_err(|e| e.to_string())?;
        $body
    }};
    ($db:expr, $conn:ident, $me:ident => $body:expr) => {{
        let $me = $db.me()?;
        let $conn = $db.0.lock().map_err(|e| e.to_string())?;
        $body
    }};
}

/* ------------------------------------------------------------------ */
/* 项目                                                                */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn list_projects(db: tauri::State<Db>) -> Result<Vec<ProjectSummary>> {
    with_conn!(db, conn, me => query::list_projects(&conn, me))
}

#[tauri::command]
pub fn create_project(db: tauri::State<Db>, name: String, color: String) -> Result<Project> {
    with_conn!(db, conn, me => query::create_project(&conn, me, name, color))
}

#[tauri::command]
pub fn rename_project(db: tauri::State<Db>, id: i64, name: String, color: String) -> Result<()> {
    with_conn!(db, conn, me => query::rename_project(&conn, me, id, name, color))
}

#[tauri::command]
pub fn update_project_calendar(
    db: tauri::State<Db>,
    id: i64,
    work_days: String,
    holidays: String,
) -> Result<()> {
    with_conn!(db, conn, me => query::update_project_calendar(&conn, me, id, work_days, holidays))
}

#[tauri::command]
pub fn delete_project(db: tauri::State<Db>, id: i64) -> Result<()> {
    with_conn!(db, conn, me => query::delete_project(&conn, me, id))
}

#[tauri::command]
pub fn load_project(db: tauri::State<Db>, id: i64) -> Result<ProjectData> {
    with_conn!(db, conn, me => query::load_project(&conn, me, id))
}

/* ------------------------------------------------------------------ */
/* 负责人                                                              */
/* ------------------------------------------------------------------ */

/// 一个项目的人员名册（人员从 015 起归项目）。
#[tauri::command]
pub fn list_people(db: tauri::State<Db>, project_id: i64) -> Result<Vec<Person>> {
    with_conn!(db, conn, me => {
        account::require_member(&conn, project_id, me)?;
        query::list_people(&conn, project_id)
    })
}

#[tauri::command]
pub fn create_person(db: tauri::State<Db>, project_id: i64, name: String, color: String) -> Result<Person> {
    with_conn!(db, conn, me => query::create_person(&conn, me, project_id, name, color))
}

/// 自己看得见的所有项目里的人员 —— 「从其他项目导入」的候选。
#[tauri::command]
pub fn list_visible_people(db: tauri::State<Db>) -> Result<Vec<Person>> {
    with_conn!(db, conn, me => query::list_visible_people(&conn, me))
}

#[tauri::command]
pub fn import_people(db: tauri::State<Db>, project_id: i64, person_ids: Vec<i64>) -> Result<i64> {
    with_conn!(db, conn, me => query::import_people(&conn, me, project_id, person_ids))
}

/// 绑定到账号 / 解绑（account_id 为 null）。
#[tauri::command]
pub fn bind_person(db: tauri::State<Db>, person_id: i64, account_id: Option<i64>) -> Result<()> {
    let me = db.me()?;
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    account::bind_person(&mut conn, person_id, account_id, me)
}

#[tauri::command]
pub fn update_person(
    db: tauri::State<Db>,
    id: i64,
    name: String,
    color: String,
    avatar: Option<String>,
) -> Result<()> {
    with_conn!(db, conn, me => query::update_person(&conn, me, id, name, color, avatar))
}

#[tauri::command]
pub fn delete_person(db: tauri::State<Db>, id: i64) -> Result<()> {
    with_conn!(db, conn, me => query::delete_person(&conn, me, id))
}

#[tauri::command]
pub fn count_person_tasks(db: tauri::State<Db>, id: i64) -> Result<i64> {
    with_conn!(db, conn, me => query::count_person_tasks(&conn, me, id))
}

/* ------------------------------------------------------------------ */
/* 风险 / 评论 / 逐日记录                                              */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn load_task_notes(db: tauri::State<Db>, task_id: i64) -> Result<TaskNotes> {
    with_conn!(db, conn, me => query::load_task_notes(&conn, me, task_id))
}

#[tauri::command]
pub fn count_open_risks(db: tauri::State<Db>, project_id: i64) -> Result<Vec<(i64, i64)>> {
    with_conn!(db, conn, me => query::count_open_risks(&conn, me, project_id))
}

#[tauri::command]
pub fn load_project_risks(db: tauri::State<Db>, project_id: i64) -> Result<Vec<Risk>> {
    with_conn!(db, conn, me => query::load_project_risks(&conn, me, project_id))
}

#[tauri::command]
pub fn add_risk(db: tauri::State<Db>, task_id: i64, content: String, level: i64) -> Result<Risk> {
    with_conn!(db, conn, me => query::add_risk(&conn, me, task_id, content, level))
}

#[tauri::command]
pub fn update_risk(db: tauri::State<Db>, id: i64, content: String, level: i64) -> Result<()> {
    with_conn!(db, conn, me => query::update_risk(&conn, me, id, content, level))
}

#[tauri::command]
pub fn resolve_risk(db: tauri::State<Db>, id: i64, resolution: String) -> Result<i64> {
    with_conn!(db, conn, me => query::resolve_risk(&conn, me, id, resolution))
}

#[tauri::command]
pub fn reopen_risk(db: tauri::State<Db>, id: i64) -> Result<()> {
    with_conn!(db, conn, me => query::reopen_risk(&conn, me, id))
}

#[tauri::command]
pub fn delete_risk(db: tauri::State<Db>, id: i64) -> Result<()> {
    with_conn!(db, conn, me => query::delete_risk(&conn, me, id))
}

#[tauri::command]
pub fn add_comment(db: tauri::State<Db>, task_id: i64, content: String) -> Result<Comment> {
    with_conn!(db, conn, me => query::add_comment(&conn, me, task_id, content))
}

#[tauri::command]
pub fn delete_comment(db: tauri::State<Db>, id: i64) -> Result<()> {
    with_conn!(db, conn, me => query::delete_comment(&conn, me, id))
}

#[tauri::command]
pub fn load_daily_notes(db: tauri::State<Db>, project_id: i64) -> Result<Vec<DailyNote>> {
    with_conn!(db, conn, me => query::load_daily_notes(&conn, me, project_id))
}

#[tauri::command]
pub fn add_daily_note(
    db: tauri::State<Db>,
    project_id: i64,
    task_id: Option<i64>,
    day: String,
    content: String,
) -> Result<DailyNote> {
    with_conn!(db, conn, me => query::add_daily_note(&conn, me, project_id, task_id, day, content))
}

#[tauri::command]
pub fn update_daily_note(
    db: tauri::State<Db>,
    id: i64,
    day: String,
    content: String,
) -> Result<()> {
    with_conn!(db, conn, me => query::update_daily_note(&conn, me, id, day, content))
}

#[tauri::command]
pub fn delete_daily_note(db: tauri::State<Db>, id: i64) -> Result<()> {
    with_conn!(db, conn, me => query::delete_daily_note(&conn, me, id))
}

/* ------------------------------------------------------------------ */
/* 事项（QuickNote）                                                    */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn load_item_notes(db: tauri::State<Db>, project_id: i64) -> Result<Vec<ItemNote>> {
    with_conn!(db, conn, me => query::load_item_notes(&conn, me, project_id))
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
    with_conn!(db, conn, me => query::add_item_note(&conn, me, project_id, name, priority, person_id, task_id))
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
    with_conn!(db, conn, me => query::update_item_note(&conn, me, id, name, kind, priority, person_id, task_id))
}

#[tauri::command]
pub fn close_item_note(
    db: tauri::State<Db>,
    id: i64,
    resolution: Option<String>,
) -> Result<i64> {
    with_conn!(db, conn, me => query::close_item_note(&conn, me, id, resolution))
}

#[tauri::command]
pub fn reopen_item_note(db: tauri::State<Db>, id: i64) -> Result<()> {
    with_conn!(db, conn, me => query::reopen_item_note(&conn, me, id))
}

#[tauri::command]
pub fn delete_item_note(db: tauri::State<Db>, id: i64) -> Result<()> {
    with_conn!(db, conn, me => query::delete_item_note(&conn, me, id))
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
    let me = db.me()?;
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    query::promote_note_to_risk(&mut conn, me, note_id, task_id, content, level, priority)
}

#[tauri::command]
pub fn promote_note_to_blocker(
    db: tauri::State<Db>,
    note_id: i64,
    promoted_ref: String,
) -> Result<()> {
    with_conn!(db, conn, me => query::promote_note_to_blocker(&conn, me, note_id, promoted_ref))
}

/// 撤销分拣。返回原引用，前端据此摘掉对应阻碍区间。
#[tauri::command]
pub fn unpromote_note(db: tauri::State<Db>, note_id: i64) -> Result<Option<String>> {
    let me = db.me()?;
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    query::unpromote_note(&mut conn, me, note_id)
}

#[tauri::command]
pub fn set_risk_priority(
    db: tauri::State<Db>,
    id: i64,
    priority: Option<i64>,
) -> Result<()> {
    with_conn!(db, conn, me => query::set_risk_priority(&conn, me, id, priority))
}

/* ------------------------------------------------------------------ */
/* 事项类型                                                            */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn list_item_kinds(db: tauri::State<Db>) -> Result<Vec<ItemKind>> {
    with_conn!(db, conn, me => query::list_item_kinds(&conn, me))
}

#[tauri::command]
pub fn save_item_kind(
    db: tauri::State<Db>,
    key: String,
    label: String,
    color: String,
    requires_note: bool,
) -> Result<()> {
    with_conn!(db, conn, me => query::save_item_kind(&conn, me, key, label, color, requires_note))
}

/// 删自定义类型。返回被退回「未分拣」的事项条数。
#[tauri::command]
pub fn delete_item_kind(db: tauri::State<Db>, key: String) -> Result<i64> {
    let me = db.me()?;
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    query::delete_item_kind(&mut conn, me, key)
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
    let me = db.me()?;
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    gantt_core::write::save_project(&mut conn, me, id, tasks, dependencies)
}

/* ------------------------------------------------------------------ */
/* 基线                                                                */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn create_baseline(db: tauri::State<Db>, project_id: i64, name: String) -> Result<BaselineRow> {
    let me = db.me()?;
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    query::create_baseline(&mut conn, me, project_id, name)
}

#[tauri::command]
pub fn load_baseline(db: tauri::State<Db>, baseline_id: i64) -> Result<Vec<BaselineTaskRow>> {
    with_conn!(db, conn, me => query::load_baseline(&conn, me, baseline_id))
}

#[tauri::command]
pub fn delete_baseline(db: tauri::State<Db>, baseline_id: i64) -> Result<()> {
    with_conn!(db, conn, me => query::delete_baseline(&conn, me, baseline_id))
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
    with_conn!(db, conn, me => query::get_setting(&conn, me, key))
}

#[tauri::command]
pub fn set_setting(db: tauri::State<Db>, key: String, value: String) -> Result<()> {
    with_conn!(db, conn, me => query::set_setting(&conn, me, key, value))
}

#[tauri::command]
pub fn list_settings_with_prefix(
    db: tauri::State<Db>,
    prefix: String,
) -> Result<Vec<(String, String)>> {
    with_conn!(db, conn, me => query::list_settings_with_prefix(&conn, me, prefix))
}

/* ------------------------------------------------------------------ */
/* AI 复盘                                                             */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn list_ai_reviews(db: tauri::State<Db>, project_id: i64) -> Result<Vec<AiReview>> {
    with_conn!(db, conn, me => query::list_ai_reviews(&conn, me, project_id))
}

#[tauri::command]
pub fn create_ai_review(
    db: tauri::State<Db>,
    project_id: i64,
    title: String,
    background: String,
    snapshot: String,
) -> Result<AiReview> {
    with_conn!(db, conn, me => query::create_ai_review(&conn, me, project_id, title, background, snapshot))
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
    with_conn!(db, conn, me => query::save_ai_review(&conn, me, id, title, stage, questions, document))
}

#[tauri::command]
pub fn delete_ai_review(db: tauri::State<Db>, id: i64) -> Result<()> {
    with_conn!(db, conn, me => query::delete_ai_review(&conn, me, id))
}

/* ------------------------------------------------------------------ */
/* 里程碑                                                              */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn load_milestones(db: tauri::State<Db>, project_id: i64) -> Result<Vec<gantt_core::model::Milestone>> {
    with_conn!(db, conn, me => gantt_core::query::load_milestones(&conn, me, project_id))
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
    with_conn!(db, conn, me => gantt_core::query::add_milestone(&conn, me, project_id, name, date, color, description, task_ids))
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
    with_conn!(db, conn, me => gantt_core::query::update_milestone(&conn, me, id, name, date, color, description, task_ids))
}

#[tauri::command]
pub fn reorder_milestones(
    db: tauri::State<Db>,
    project_id: i64,
    ids: Vec<i64>,
) -> Result<()> {
    with_conn!(db, conn, me => gantt_core::query::reorder_milestones(&conn, me, project_id, ids))
}

#[tauri::command]
pub fn delete_milestone(db: tauri::State<Db>, id: i64) -> Result<()> {
    with_conn!(db, conn, me => gantt_core::query::delete_milestone(&conn, me, id))
}

/* ------------------------------------------------------------------ */
/* 账号与会话                                                          */
/* ------------------------------------------------------------------ */

/// 启动时前端要知道的一切：有哪些账号、现在是谁（可能没人）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub accounts: Vec<Account>,
    pub current: Option<Account>,
    /// 上次登录的账号。设了密码时不会自动进入，但登录页要把它排在最前、预选上
    pub last_account_id: Option<i64>,
}

fn session_state_of(db: &Db, conn: &Connection) -> Result<SessionState> {
    let current = match db.me() {
        Ok(id) => account::get_account(conn, id).ok(),
        Err(_) => None,
    };
    Ok(SessionState {
        accounts: account::list_accounts(conn)?,
        current,
        last_account_id: account::last_account(conn)?,
    })
}

/**
 * 启动时自动进入上次的账号（Q14）：没设密码就直接进，设了就停在登录页。
 * 由 lib.rs 的 setup 调一次。从没登录过、只有一个无密码账号时（单人用户升级上来）
 * 也直接进 —— 对他们来说这次升级应该是无感的。
 */
pub fn auto_login(db: &Db, conn: &Connection) -> Result<()> {
    let candidate = match account::last_account(conn)? {
        Some(id) => Some(id),
        None => match account::list_accounts(conn)?.as_slice() {
            [only] => Some(only.id),
            _ => None,
        },
    };
    if let Some(id) = candidate {
        if !account::get_account(conn, id)?.has_password {
            db.set_me(Some(id));
            account::set_last_account(conn, Some(id))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn session_state(db: tauri::State<Db>) -> Result<SessionState> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    session_state_of(&db, &conn)
}

/// 登录 / 切换账号。前端负责在调用前把未落库的编辑冲刷掉、清空撤销栈。
#[tauri::command]
pub fn login(db: tauri::State<Db>, account_id: i64, password: Option<String>) -> Result<SessionState> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    if !account::verify_password(&conn, account_id, password.as_deref().unwrap_or(""))? {
        return Err("密码不对".into());
    }
    db.set_me(Some(account_id));
    account::set_last_account(&conn, Some(account_id))?;
    session_state_of(&db, &conn)
}

/// 退出登录。同时清掉「上次登录的账号」：否则无密码账号退出后一重启又自己进去了，
/// 「退出」形同虚设。（只剩一个无密码账号时启动仍会直接进入，见 auto_login。）
#[tauri::command]
pub fn logout(db: tauri::State<Db>) -> Result<SessionState> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db.set_me(None);
    account::set_last_account(&conn, None)?;
    session_state_of(&db, &conn)
}

#[tauri::command]
pub fn create_account(
    db: tauri::State<Db>,
    name: String,
    color: String,
    password: Option<String>,
) -> Result<Account> {
    with_conn!(db, conn => account::create_account(&conn, name, color, password))
}

/// 只能改自己的资料。
#[tauri::command]
pub fn update_account(
    db: tauri::State<Db>,
    name: String,
    color: String,
    avatar: Option<String>,
) -> Result<()> {
    with_conn!(db, conn, me => account::update_account(&conn, me, name, color, avatar))
}

#[tauri::command]
pub fn set_password(db: tauri::State<Db>, current: Option<String>, next: Option<String>) -> Result<()> {
    with_conn!(db, conn, me => account::set_password(&conn, me, current, next))
}

#[tauri::command]
pub fn delete_account_plan(db: tauri::State<Db>) -> Result<DeleteAccountPlan> {
    with_conn!(db, conn, me => account::delete_account_plan(&conn, me))
}

/**
 * 删除**自己的**账号。要验密码（设过的话），并且删之前做一次整库备份 ——
 * 只属于自己的项目会一起消失，这是全软件最重的一个操作。
 * 成功后会话清空，前端回到登录页。
 */
#[tauri::command]
pub fn delete_account(
    app: tauri::AppHandle,
    db: tauri::State<Db>,
    password: Option<String>,
    transfers: Vec<(i64, i64)>,
) -> Result<SessionState> {
    use tauri::Manager;
    let me = db.me()?;
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    if !account::verify_password(&conn, me, password.as_deref().unwrap_or(""))? {
        return Err("密码不对".into());
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let backups = dir.join("backups");
    std::fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
    let stamp = query::now();
    crate::backup::snapshot(&conn, &backups.join(format!("删除账号前-{stamp}.db")))
        .map_err(|e| format!("删除前备份失败，已中止：{e}"))?;
    account::delete_account(&mut conn, me, transfers)?;
    db.set_me(None);
    session_state_of(&db, &conn)
}

#[tauri::command]
pub fn list_members(db: tauri::State<Db>, project_id: i64) -> Result<Vec<Member>> {
    with_conn!(db, conn, me => {
        account::require_member(&conn, project_id, me)?;
        account::list_members(&conn, project_id)
    })
}

#[tauri::command]
pub fn share_preview(db: tauri::State<Db>, project_id: i64, account_id: i64) -> Result<SharePreview> {
    with_conn!(db, conn, me => account::share_preview(&conn, project_id, me, account_id))
}

#[tauri::command]
pub fn share_project(
    db: tauri::State<Db>,
    project_id: i64,
    account_id: i64,
    bind_person: Option<i64>,
) -> Result<()> {
    let me = db.me()?;
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    account::share_project(&mut conn, project_id, me, account_id, bind_person)
}

#[tauri::command]
pub fn unshare_project(db: tauri::State<Db>, project_id: i64, account_id: i64) -> Result<()> {
    let me = db.me()?;
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    account::unshare_project(&mut conn, project_id, me, account_id)
}

#[tauri::command]
pub fn leave_project(db: tauri::State<Db>, project_id: i64) -> Result<()> {
    let me = db.me()?;
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    account::leave_project(&mut conn, project_id, me)
}

#[tauri::command]
pub fn transfer_ownership(db: tauri::State<Db>, project_id: i64, account_id: i64) -> Result<()> {
    let me = db.me()?;
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    account::transfer_ownership(&mut conn, project_id, me, account_id)
}
