//! 自动滚动备份（DESIGN.md §4.2）。
//!
//! 单机本地存储没有云端兜底，唯一的保险就是多留几份副本。
//! 每次启动把当前数据库复制到 `backups/gantt-YYYY-MM-DD.db`，只保留最近 KEEP 份。
//!
//! ⚠️ 这里**不能**用 `fs::copy` 复制 gantt.db。
//!
//! 数据库跑在 WAL 模式下：事务先落到 `gantt.db-wal`，要等 checkpoint 才合并回主文件。
//! 只复制主文件，拿到的是一个缺失了最近全部提交的残缺库 —— 极端情况下（进程被强杀、
//! 从未 checkpoint 过）复制出来的甚至是一张表都没有的空壳。
//! 一个静默产出空备份的备份功能比没有备份更危险，因为它给的是虚假的安全感。
//!
//! 所以走 SQLite 的在线备份 API：它从活动连接读取，天然把 WAL 里的内容算进去，
//! 且对并发写入是安全的。

use rusqlite::{backup::Backup, Connection};
use std::fs;
use std::path::{Path, PathBuf};

pub const KEEP: usize = 10;

#[derive(Debug)]
pub enum BackupError {
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
}

impl std::fmt::Display for BackupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BackupError::Io(e) => write!(f, "{e}"),
            BackupError::Sqlite(e) => write!(f, "{e}"),
        }
    }
}

impl From<std::io::Error> for BackupError {
    fn from(e: std::io::Error) -> Self {
        BackupError::Io(e)
    }
}

impl From<rusqlite::Error> for BackupError {
    fn from(e: rusqlite::Error) -> Self {
        BackupError::Sqlite(e)
    }
}

/// 备份一次并清理旧文件。同一天重复启动只覆盖当天那一份，不刷掉历史。
pub fn rotate(
    conn: &Connection,
    config_dir: &Path,
    stem: &str,
    keep: usize,
) -> Result<PathBuf, BackupError> {
    let backup_dir = config_dir.join("backups");
    fs::create_dir_all(&backup_dir)?;

    let dest = backup_dir.join(format!("{stem}-{}.db", today_stamp()));

    // 当天已经有备份就不再覆盖。
    //
    // 备份的价值在于「出事之前的那一份」。按天命名 + 每次启动都覆盖，等于
    // 一天里反复重启就会把当天最早那份干净数据冲掉 —— 真出问题时能回退的
    // 只剩已经被污染的状态。保留当天第一次启动的快照，才是能救命的那份。
    if dest.exists() {
        prune(&backup_dir, stem, keep)?;
        return Ok(dest);
    }

    snapshot(conn, &dest)?;
    prune(&backup_dir, stem, keep)?;
    Ok(dest)
}

/// 把活动连接整份拷成 dest 这一个文件。
///
/// 滚动备份、「导出数据库」、整库导入前的保险都走这里 —— 三处要的是同一个
/// 东西：一个包含 WAL 里全部提交、自己就是完整数据的单文件。
///
/// 先写到同目录的 `.part` 再改名：目标可能在云盘或 U 盘上，写到一半失败
/// 留下一个大小像样、内容残缺的 .db，比没有文件危险得多。
pub fn snapshot(conn: &Connection, dest: &Path) -> Result<(), BackupError> {
    let part = dest.with_file_name(format!(
        "{}.part",
        dest.file_name().and_then(|n| n.to_str()).unwrap_or("gantt.db")
    ));
    let _ = fs::remove_file(&part);

    let mut target = Connection::open(&part)?;
    {
        let backup = Backup::new(conn, &mut target)?;
        // step(-1) = 一次拷完所有页
        backup.step(-1)?;
    }
    // 备份库本身也别留 WAL 副产物，让它就是一个干净的单文件 ——
    // 拷到另一台电脑时只需要带这一个文件
    target.pragma_update(None, "journal_mode", "DELETE")?;
    drop(target);

    // Windows 上 rename 覆盖已有文件是可以的（MoveFileEx + REPLACE_EXISTING），
    // 但目标被别的程序占着时会失败 —— 那就如实报错，不留 .part 垃圾
    fs::rename(&part, dest).inspect_err(|_| {
        let _ = fs::remove_file(&part);
    })?;
    Ok(())
}

/// 按文件名倒序（日期串本身可比较），保留最新的 keep 份。
fn prune(backup_dir: &Path, stem: &str, keep: usize) -> std::io::Result<()> {
    let mut files: Vec<PathBuf> = fs::read_dir(backup_dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(stem) && n.ends_with(".db"))
        })
        .collect();

    if files.len() <= keep {
        return Ok(());
    }

    files.sort();
    for old in &files[..files.len() - keep] {
        let _ = fs::remove_file(old);
    }
    Ok(())
}

/// 本地日期 YYYY-MM-DD。避开引入 chrono，直接用 std 的时间加上民用历换算。
fn today_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

/// Howard Hinnant 的 civil_from_days 算法：天数（自 1970-01-01）→ 年月日。
pub(crate) fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 供设置页显示「数据文件在哪」。
#[tauri::command]
pub fn data_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

/// 「在访达中显示」。
#[tauri::command]
pub fn reveal_data_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = data_dir(app.clone())?;
    app.opener()
        .open_path(dir, None::<&str>)
        .map_err(|e| e.to_string())
}

/// 手动立即备份一次，供设置页的「立即备份」按钮调用。
#[tauri::command]
pub fn backup_now(db: tauri::State<crate::db::Db>, app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    rotate(&conn, &dir, "gantt", KEEP)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_from_days_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1)); // 闰年边界
        assert_eq!(civil_from_days(20_666), (2026, 8, 1));
    }

    /// 这条测试就是为了挡住那个把备份写成空壳的 bug：
    /// 数据在 WAL 里、主文件还没 checkpoint 时，备份必须依然完整。
    #[test]
    fn backup_captures_data_still_sitting_in_wal() {
        let dir = std::env::temp_dir().join("gantt-backup-wal-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let db_path = dir.join("gantt.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (id INTEGER PRIMARY KEY, name TEXT);
             INSERT INTO tasks (id, name) VALUES (1, 'A'), (2, 'B'), (3, 'C');",
        )
        .unwrap();

        // 刻意不 checkpoint —— 此时主文件里几乎什么都没有
        let dest = rotate(&conn, &dir, "gantt", 10).unwrap();

        let restored = Connection::open(&dest).unwrap();
        let count: i64 = restored
            .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 3, "备份没有包含仍在 WAL 中的数据");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 备份按天命名。一天里反复重启不能把当天最早那份干净数据冲掉 ——
    /// 备份的价值恰恰在于「出事之前的那一份」。
    #[test]
    fn same_day_restart_must_not_overwrite_the_morning_snapshot() {
        let dir = std::env::temp_dir().join("gantt-backup-noclobber-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (id INTEGER PRIMARY KEY, name TEXT);
             INSERT INTO tasks VALUES (1, '早上的干净数据');",
        )
        .unwrap();
        let first = rotate(&conn, &dir, "gantt", 10).unwrap();

        // 数据被污染之后再启动一次
        conn.execute("UPDATE tasks SET name = '被覆盖的脏数据' WHERE id = 1", [])
            .unwrap();
        let second = rotate(&conn, &dir, "gantt", 10).unwrap();
        assert_eq!(first, second, "同一天应该指向同一个文件");

        let restored = Connection::open(&first).unwrap();
        let name: String = restored
            .query_row("SELECT name FROM tasks WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "早上的干净数据", "当天最早的快照被覆盖了");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_keeps_newest_only() {
        let dir = std::env::temp_dir().join("gantt-backup-prune-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        for day in 1..=5 {
            fs::write(dir.join(format!("gantt-2026-08-{day:02}.db")), b"x").unwrap();
        }
        prune(&dir, "gantt", 3).unwrap();

        let mut left: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            vec![
                "gantt-2026-08-03.db",
                "gantt-2026-08-04.db",
                "gantt-2026-08-05.db"
            ]
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
