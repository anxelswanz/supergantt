//! 数据目录定位与「应用是否在跑」的探测。
//!
//! 两件事放在一起，因为它们说的是同一个目录。
//!
//! ## 为什么要找对目录
//!
//! CLI 必须打开**桌面应用正在用的那个** `gantt.db`。找错了就是两个库各写各的，
//! 用户建完任务回应用里看不到 —— 比报错难查得多。所以这里的路径推算要和
//! `app_config_dir()`（Tauri 的 API）逐字对齐，也就是 README「数据文件在哪」那一节。
//!
//! ## 为什么需要锁文件
//!
//! 前端是「整项目 400ms 防抖全量替换」：用户在界面上的任何一次编辑，都会在
//! 400ms 后把内存里那份完整任务表写回库。CLI 在应用开着时插入的任务，
//! 下一帧就被这份陈旧快照抹掉 —— 而且是**静默**抹掉。
//!
//! WAL 解决不了这个：它保证读写不互相阻塞，不保证两个写入者不互相覆盖。
//! 单机单人场景下正确的做法不是搞一套冲突合并，而是**根本不让两边同时写**：
//! 应用在数据目录里留一个 PID 文件，CLI 写之前看一眼那个进程还在不在。

use std::path::{Path, PathBuf};

/// 锁文件名。和 `gantt.db` 同目录。
pub const LOCK_FILE: &str = "gantt.lock";

/// 数据目录里主数据库的文件名。和 `src-tauri/src/lib.rs` 的 `DB_FILE` 是同一个值
/// —— 那边是 Tauri 侧的常量，这边是 CLI 侧的，两处不能分叉。
pub const DB_FILE: &str = "gantt.db";

/// 应用标识符，决定数据目录名。和 `src-tauri/tauri.conf.json` 的 `identifier` 一致。
const APP_IDENTIFIER: &str = "com.ronghuizhong.gantt";

/// 定位数据目录。优先级：显式参数 > `GANTT_DATA_DIR` > 平台默认。
///
/// 显式参数排在环境变量前面：命令行上敲的那个是这一次调用最具体的意图，
/// 环境变量是这一整台机器的默认。
pub fn data_dir(explicit: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(p) = explicit {
        return Ok(p.to_path_buf());
    }
    if let Some(env) = std::env::var_os("GANTT_DATA_DIR") {
        if !env.is_empty() {
            return Ok(PathBuf::from(env));
        }
    }
    platform_data_dir()
}

/// 按平台推默认数据目录，等价于 Tauri 在 `app_config_dir()` 上做的事。
#[cfg(target_os = "windows")]
fn platform_data_dir() -> Result<PathBuf, String> {
    let appdata = std::env::var_os("APPDATA")
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            "找不到 %APPDATA%，无法定位 Gantt 数据目录。请用 --data-dir 指定，\
             或设置 GANTT_DATA_DIR 环境变量。"
                .to_string()
        })?;
    Ok(PathBuf::from(appdata).join(APP_IDENTIFIER))
}

#[cfg(target_os = "macos")]
fn platform_data_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            "找不到 $HOME，无法定位 Gantt 数据目录。请用 --data-dir 指定，\
             或设置 GANTT_DATA_DIR 环境变量。"
                .to_string()
        })?;
    Ok(PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join(APP_IDENTIFIER))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn platform_data_dir() -> Result<PathBuf, String> {
    // Linux 上 Tauri 取的是 $XDG_CONFIG_HOME（默认 ~/.config）+ identifier
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .ok_or_else(|| {
            "找不到配置目录，无法定位 Gantt 数据目录。请用 --data-dir 指定，\
             或设置 GANTT_DATA_DIR 环境变量。"
                .to_string()
        })?;
    Ok(base.join(APP_IDENTIFIER))
}

/// 数据目录里的主数据库路径。
pub fn db_path(dir: &Path) -> PathBuf {
    dir.join(DB_FILE)
}

/* ------------------------------------------------------------------ */
/* 锁文件                                                              */
/* ------------------------------------------------------------------ */

/// 谁占着库。`pid` 用来判断那个进程是不是还活着 —— 应用被强杀时锁文件会留下，
/// 只看文件在不在会把用户永久挡在门外。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppLock {
    pub pid: u32,
}

/// 读锁文件。没有文件、内容不是数字（被截断的写入）、进程已死，都返回 None。
pub fn read_lock(dir: &Path) -> Option<AppLock> {
    let text = std::fs::read_to_string(dir.join(LOCK_FILE)).ok()?;
    let pid: u32 = text.trim().parse().ok()?;
    if pid == 0 {
        return None;
    }
    Some(AppLock { pid })
}

/// 桌面应用启动时留痕。写在 `setup()` 里。
pub fn write_lock(dir: &Path) -> std::io::Result<()> {
    std::fs::write(dir.join(LOCK_FILE), std::process::id().to_string())
}

/// 桌面应用退出时清掉。`RunEvent::Exit` 里调。
///
/// 只在锁文件确实属于自己时才删：如果用户开了第二个实例（或 CLI 用了 `--force`
/// 之后又起了个应用），删掉别人的锁会让那个应用在 CLI 眼里"不存在"。
pub fn clear_lock(dir: &Path) {
    if read_lock(dir).is_some_and(|l| l.pid == std::process::id()) {
        let _ = std::fs::remove_file(dir.join(LOCK_FILE));
    }
}

/// 桌面应用是否正在跑。
///
/// 文件存在**且**那个 PID 仍活着才算。PID 文件是崩溃后不清理的典型例子，
/// 只凭文件存在就拒绝写入，用户强杀一次应用就永远用不了 CLI 了。
pub fn running_app(dir: &Path) -> Option<AppLock> {
    let lock = read_lock(dir)?;
    if process_alive(lock.pid) {
        Some(lock)
    } else {
        None
    }
}

/// 这个 PID 还活着吗。
///
/// 不引 crate：两个平台各一个系统调用就够。
///
/// - unix：`kill(pid, 0)` —— 信号 0 不递送任何信号，只做权限和存在性检查。
///   返回 0 表示进程在；EPERM 也表示在（只是不属于我），所以要看 errno 而不是
///   只看返回值。std 的 `Command` 不方便拿到 errno，直接 extern 声明。
/// - Windows：`OpenProcess` 拿一个句柄，拿到就说明进程存在。注意**不要**用
///   `GetExitCodeProcess` + `STILL_ACTIVE` 判断 —— `STILL_ACTIVE` 是 259，
///   一个恰好返回 259 的正常退出进程会被误判为存活。
#[cfg(unix)]
pub fn process_alive(pid: u32) -> bool {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    if pid == 0 {
        return false;
    }
    // SAFETY: kill 是异步信号安全的，传 0 号信号不产生任何副作用。
    let rc = unsafe { kill(pid as i32, 0) };
    if rc == 0 {
        return true;
    }
    // errno == EPERM(1)：进程在，只是不归我管 —— 仍然是"活着"
    std::io::Error::last_os_error().raw_os_error() == Some(1)
}

#[cfg(windows)]
pub fn process_alive(pid: u32) -> bool {
    // PROCESS_QUERY_LIMITED_INFORMATION = 0x1000。
    // 用 LIMITED 而不是 QUERY_INFORMATION：前者对提权进程也能拿到句柄，
    // 而我们要的只是"存在吗"这一个比特。
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    }
    if pid == 0 {
        return false;
    }
    // SAFETY: 只传一个 PID，不碰任何内存。
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return false;
    }
    unsafe { CloseHandle(handle) };
    true
}

#[cfg(not(any(unix, windows)))]
pub fn process_alive(_pid: u32) -> bool {
    // 未知平台：保守地当作"活着"，宁可挡一次写入也不要静默丢数据
    true
}

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gantt-locate-test-{tag}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn missing_lock_file_means_nobody_is_running() {
        let dir = temp_dir("missing");
        let _ = std::fs::remove_file(dir.join(LOCK_FILE));
        assert_eq!(running_app(&dir), None);
    }

    #[test]
    fn garbage_lock_file_is_ignored_not_fatal() {
        // 应用写锁文件的瞬间被强杀，文件可能是空的或半截数字。
        // 这时应该当作"没有应用在跑"，而不是解析失败。
        let dir = temp_dir("garbage");
        std::fs::write(dir.join(LOCK_FILE), "").unwrap();
        assert_eq!(read_lock(&dir), None);
        std::fs::write(dir.join(LOCK_FILE), "not-a-pid").unwrap();
        assert_eq!(read_lock(&dir), None);
        std::fs::write(dir.join(LOCK_FILE), "0").unwrap();
        assert_eq!(read_lock(&dir), None);
    }

    #[test]
    fn a_dead_pid_does_not_block_writes() {
        // 这是整个机制里最容易写错的一条：只判断"文件在不在"，
        // 用户强杀一次应用就永远用不了 CLI 了。
        let dir = temp_dir("dead");
        std::fs::write(dir.join(LOCK_FILE), "999999999").unwrap();
        assert!(read_lock(&dir).is_some(), "文件本身是可读的");
        assert_eq!(running_app(&dir), None, "但进程不在，所以不算应用在跑");
    }

    #[test]
    fn our_own_pid_counts_as_alive() {
        let dir = temp_dir("self");
        write_lock(&dir).unwrap();
        assert_eq!(running_app(&dir), Some(AppLock { pid: std::process::id() }));
        clear_lock(&dir);
        assert_eq!(running_app(&dir), None);
    }

    #[test]
    fn clear_lock_leaves_someone_elses_lock_alone() {
        // 第二个实例退出时不能把第一个实例的锁删掉
        let dir = temp_dir("foreign");
        std::fs::write(dir.join(LOCK_FILE), "999999999").unwrap();
        clear_lock(&dir);
        assert!(dir.join(LOCK_FILE).exists(), "不属于自己的锁不许动");
    }

    #[test]
    fn explicit_data_dir_beats_everything() {
        let explicit = PathBuf::from("/tmp/somewhere-else");
        assert_eq!(data_dir(Some(&explicit)).unwrap(), explicit);
    }

    #[test]
    fn db_path_is_db_file_in_that_dir() {
        let dir = PathBuf::from("/tmp/x");
        assert!(db_path(&dir).ends_with(DB_FILE));
    }
}
