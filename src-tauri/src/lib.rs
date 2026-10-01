use std::sync::Mutex;
use tauri::Manager;

mod backup;
mod db;
mod dbfile;
mod export;
mod plugin;
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

            // 留一个 PID 文件，告诉离线 CLI「应用正开着，别写」。见 gantt-core/src/locate.rs。
            //
            // 为什么必须有：前端是「整项目 400ms 防抖全量替换」，CLI 这会儿插进去的任务，
            // 下一帧就被界面上那份陈旧快照抹掉 —— 而且是静默抹掉。WAL 只保证读写不互相
            // 阻塞，不保证两个写入者不互相覆盖。单机单人场景下正确的做法不是搞冲突合并，
            // 而是根本不让两边同时写。
            //
            // 失败只记日志：拿不到锁文件顶多是 CLI 少了一道保护，
            // 不该因此让应用起不来。
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
            plugin::list_plugins,
            plugin::plugins_dir,
            plugin::reveal_plugins_dir,
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
            // 退出时把锁摘掉。不摘也「能用」—— CLI 会去问那个 PID 还活着没，
            // 死了照样放行 —— 但让用户看见一个 gantt.lock 躺在数据目录里总归是噪声。
            //
            // 走 RunEvent::Exit 而不是窗口关闭事件：关窗口只是隐藏（托盘常驻），
            // 那时应用还活着、还该继续挡着 CLI。
            if let tauri::RunEvent::Exit = event {
                if let Ok(dir) = app.path().app_config_dir() {
                    gantt_core::locate::clear_lock(&dir);
                }
            }
        });
}
