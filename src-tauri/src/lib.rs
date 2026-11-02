use tauri::Manager;

mod ai;
mod backup;
mod db;
mod dbfile;
mod export;
mod plugin;
mod plugin_host;
mod plugin_store;
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

            // 账号功能之前的插件数据（飞书队列等）归默认账号。幂等，每次启动都跑也无妨
            if let Ok(accounts) = gantt_core::account::list_accounts(&conn) {
                if let Some(first) = accounts.iter().min_by_key(|a| a.id) {
                    if let Err(err) = gantt_core::locate::migrate_legacy_plugin_data(&dir, &first.uuid) {
                        eprintln!("[plugin] 迁移旧插件数据失败：{err}");
                    }
                }
            }

            let db = db::Db::new(conn);
            {
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                // 上次的账号没设密码就直接进入；失败只是停在登录页，不挡启动
                if let Err(err) = db::auto_login(&db, &conn) {
                    eprintln!("[session] 自动登录失败：{err}");
                }
            }
            app.manage(db);
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
            db::session_state,
            db::login,
            db::logout,
            db::create_account,
            db::update_account,
            db::set_password,
            db::delete_account_plan,
            db::delete_account,
            db::list_members,
            db::share_preview,
            db::share_project,
            db::unshare_project,
            db::leave_project,
            db::transfer_ownership,
            db::list_people,
            db::create_person,
            db::list_visible_people,
            db::import_people,
            db::bind_person,
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
            ai::ai_available,
            ai::ai_ask,
            plugin::list_plugins,
            plugin::plugins_dir,
            plugin::reveal_plugins_dir,
            plugin::dev_plugin_dirs,
            plugin::dev_plugin_add,
            plugin::dev_plugin_remove,
            plugin_store::store_fetch_index,
            plugin_store::store_install,
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
