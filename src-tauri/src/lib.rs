use std::sync::Mutex;
use tauri::Manager;

mod ai_review;
mod backup;
mod db;
mod dbfile;
mod export;
mod plugin;
mod plugin_host;
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

            // 备份必须走在线备份 API 且在连接建立后：直接拷文件会漏掉 WAL 里的提交。
            // 失败只记日志，不能挡住启动。
            if let Err(err) = backup::rotate(&conn, &dir, "gantt", backup::KEEP) {
                eprintln!("[backup] 备份失败：{err}");
            }

            app.manage(db::Db(Mutex::new(conn)));
            app.manage(plugin_host::Procs::default());

            // 留 PID 锁文件，告诉离线 CLI「应用正开着，别写」（gantt-core/src/locate.rs）。
            // 两边同时写会静默互相覆盖：前端是整项目防抖全量替换，
            // CLI 插入的任务会被下一帧的陈旧快照抹掉。失败只记日志，不挡启动。
            if let Err(err) = gantt_core::locate::write_lock(&dir) {
                eprintln!("[lock] 写入 gantt.lock 失败：{err}");
            }

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
            db::list_settings_with_prefix,
            db::load_item_notes,
            db::add_item_note,
            db::update_item_note,
            db::close_item_note,
            db::reopen_item_note,
            db::delete_item_note,
            db::promote_note_to_risk,
            db::promote_note_to_blocker,
            db::unpromote_note,
            db::set_risk_priority,
            db::list_item_kinds,
            db::save_item_kind,
            db::delete_item_kind,
            db::list_ai_reviews,
            db::create_ai_review,
            db::save_ai_review,
            db::delete_ai_review,
            db::load_milestones,
            db::add_milestone,
            db::update_milestone,
            db::reorder_milestones,
            db::delete_milestone,
            ai_review::ai_review_available,
            ai_review::ai_review_run,
            plugin::list_plugins,
            plugin::plugins_dir,
            plugin::reveal_plugins_dir,
            plugin_host::list_bundled_plugins,
            plugin_host::install_bundled_plugin,
            plugin_host::uninstall_plugin,
            plugin_host::plugin_storage_read,
            plugin_host::plugin_storage_write,
            plugin_host::plugin_which,
            plugin_host::plugin_spawn,
            plugin_host::plugin_kill,
            plugin_host::plugin_link_skill,
            plugin_host::plugin_unlink_skill,
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 退出时摘锁。用 RunEvent::Exit 而非窗口关闭：关窗口只是隐藏（托盘常驻），
            // 那时应用还活着，仍该挡着 CLI。
            if let tauri::RunEvent::Exit = event {
                if let Ok(dir) = app.path().app_config_dir() {
                    gantt_core::locate::clear_lock(&dir);
                }
            }
        });
}
