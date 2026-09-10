use std::sync::Mutex;
use tauri::Manager;

mod backup;
mod db;
mod dbfile;
mod export;
mod transfer;


pub(crate) const DB_FILE: &str = "gantt.db";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&dir)?;

            let conn = db::open(&dir.join(DB_FILE))?;

            // 备份走 SQLite 在线备份 API，所以必须在连接建立之后 ——
            // 直接复制文件会漏掉还留在 WAL 里的提交（见 backup.rs 顶部说明）。
            // 迁移已经跑完，这份备份即包含上次会话的全部数据。
            // 失败只记日志，不能挡住应用启动。
            if let Err(err) = backup::rotate(&conn, &dir, "gantt", backup::KEEP) {
                eprintln!("[backup] 备份失败：{err}");
            }

            app.manage(db::Db(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::list_projects,
            db::create_project,
            db::rename_project,
            db::update_project_calendar,
            db::delete_project,
            db::load_project,
            db::save_project,
            db::create_baseline,
            db::load_baseline,
            db::delete_baseline,
            db::list_people,
            db::create_person,
            db::update_person,
            db::delete_person,
            db::count_person_tasks,
            db::load_task_notes,
            db::count_open_risks,
            db::load_project_risks,
            db::add_risk,
            db::update_risk,
            db::resolve_risk,
            db::reopen_risk,
            db::delete_risk,
            db::add_comment,
            db::delete_comment,
            db::load_daily_notes,
            db::add_daily_note,
            db::update_daily_note,
            db::delete_daily_note,
            db::check_integrity,
            db::get_setting,
            db::set_setting,
            backup::data_dir,
            backup::reveal_data_dir,
            backup::backup_now,
            export::write_export,
            export::reveal_path,
            transfer::export_project,
            transfer::inspect_import,
            transfer::commit_import,
            dbfile::export_database,
            dbfile::inspect_db_import,
            dbfile::commit_db_import,
            dbfile::undo_db_import,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
