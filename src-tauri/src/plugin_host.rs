//! 插件能用到的宿主能力：安装随应用附带的插件、私有存储、受限的子进程、
//! 把插件自带的 Claude Skill 链接进 `~/.claude/skills`。
//!
//! 和 plugin.rs 分开放：那边只负责「看得见插件目录里有什么」，这边是插件
//! **能做什么**。后者每多一项都是在扩大插件的权限面，集中在一个文件里，
//! 审的时候一眼能看全。
//!
//! ## 权限边界在哪
//!
//! 插件代码和宿主跑在同一个 WebView 里，理论上能直接 invoke 任何命令 ——
//! 所以这里的检查**不是**安全沙箱，挡的是「写错了」而不是「存心作恶」：
//!
//! - 存储只能落在 `plugins/<id>/data/` 下，文件名不许带路径分隔符；
//!   卸载插件不删它，重新安装后数据还在；
//! - 子进程只认裸程序名（不许带 `/`），也不许是 shell —— 插件要跑
//!   `lark-cli`，不该顺手拿到一个能执行任意命令的 `sh -c`；
//! - 插件 manifest 里声明的 `permissions.exec` 白名单在 TS 侧（registry.ts）
//!   检查，那里知道是哪个插件在调用。
//!
//! 「插件跑在本程序里，看得到全部数据。装之前先确认来源」—— 设置页那句话
//! 依然是真正的边界。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::plugin::ensure_dir;

type Result<T> = std::result::Result<T, String>;

/// 插件 id 的形状，和 TS 侧 manifest.ts 的 ID_PATTERN 一致。
/// 这里再查一遍是因为它会被拼进路径 —— 一个 "../x" 的 id 就是路径穿越。
fn check_id(id: &str) -> Result<()> {
    let ok = (2..=64).contains(&id.len())
        && id.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(format!("插件 id「{id}」不合法"))
    }
}

/// 单段文件名：字母、数字、点、下划线、连字符，不许以点开头。
fn check_name(name: &str, what: &str) -> Result<()> {
    let ok = !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if ok {
        Ok(())
    } else {
        Err(format!("{what}「{name}」不合法：只能用字母、数字和 . _ -"))
    }
}

fn plugin_dir(app: &tauri::AppHandle, id: &str) -> Result<PathBuf> {
    check_id(id)?;
    Ok(ensure_dir(app)?.join(id))
}

/* ------------------------------------------------------------------ */
/* 随应用附带的插件                                                     */
/* ------------------------------------------------------------------ */

/// 附带插件在资源目录里的位置。见 tauri.conf.json 的 bundle.resources。
const BUNDLED_DIR: &str = "bundled-plugins";

/// 找附带插件目录。
///
/// 打包后在资源目录里；`tauri dev` 时资源也会被拷到 target 下，但改了
/// 仓库里的插件源码之后要重新构建才会同步 —— 开发时直接读仓库里的
/// `plugins/` 更顺手，所以 debug 构建优先走它。
fn bundled_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("plugins");
        if repo.is_dir() {
            return Some(repo);
        }
    }
    let dir = app.path().resource_dir().ok()?.join(BUNDLED_DIR);
    dir.is_dir().then_some(dir)
}

#[derive(Serialize)]
pub struct BundledPlugin {
    pub dir_name: String,
    /// 附带版本的 manifest 原文。校验在 TS 侧做，和已安装插件同一套
    pub manifest_raw: Option<String>,
    /// 已安装版本的 manifest 原文；没装为 None
    pub installed_manifest_raw: Option<String>,
}

#[tauri::command]
pub fn list_bundled_plugins(app: tauri::AppHandle) -> Result<Vec<BundledPlugin>> {
    let Some(root) = bundled_root(&app) else {
        return Ok(Vec::new());
    };
    let installed = ensure_dir(&app)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&root).map_err(|e| format!("读不了附带插件目录：{e}"))?.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_string) else {
            continue;
        };
        if !path.is_dir() || name.starts_with('.') || check_id(&name).is_err() {
            continue;
        }
        out.push(BundledPlugin {
            manifest_raw: std::fs::read_to_string(path.join("manifest.json")).ok(),
            installed_manifest_raw: std::fs::read_to_string(installed.join(&name).join("manifest.json")).ok(),
            dir_name: name,
        });
    }
    out.sort_by(|a, b| a.dir_name.cmp(&b.dir_name));
    Ok(out)
}

/// 安装文件时跳过的东西：测试、隐藏文件、插件运行时自己写的数据。
fn skip_on_install(name: &str) -> bool {
    name.starts_with('.') || name.contains(".test.") || name == "data" || name == "node_modules"
}

fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to).map_err(|e| format!("建不了目录 {}：{e}", to.display()))?;
    for entry in std::fs::read_dir(from).map_err(|e| format!("读不了 {}：{e}", from.display()))?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if skip_on_install(&name) {
            continue;
        }
        let src = entry.path();
        let dst = to.join(&name);
        if src.is_dir() {
            copy_tree(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst).map_err(|e| format!("拷不了 {name}：{e}"))?;
        }
    }
    Ok(())
}

/// 安装或更新一个附带插件。
///
/// 更新 = 删掉旧的代码文件再拷新的，**但 `data/` 留着** —— 那里是插件
/// 攒下的同步状态，升级一次插件就把它清空是不能接受的。
#[tauri::command]
pub fn install_bundled_plugin(app: tauri::AppHandle, id: String) -> Result<()> {
    let root = bundled_root(&app).ok_or("这个版本的应用没有附带插件")?;
    check_id(&id)?;
    let src = root.join(&id);
    if !src.join("manifest.json").is_file() {
        return Err(format!("附带插件里没有「{id}」"));
    }
    let dst = plugin_dir(&app, &id)?;
    remove_code(&dst)?;
    copy_tree(&src, &dst)
}

/// 删掉插件目录里除 `data/` 以外的一切。目录不存在不算错。
fn remove_code(dir: &Path) -> Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir).map_err(|e| format!("读不了插件目录：{e}"))?.flatten() {
        if entry.file_name() == "data" {
            continue;
        }
        let p = entry.path();
        let res = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
        res.map_err(|e| format!("删除插件文件失败：{e}"))?;
    }
    Ok(())
}

/// 这个目录是不是只剩卸载后留下的 `data/`（隐藏文件不算）。
/// 扫描插件时跳过它 —— 它不是一个坏掉的插件，只是在等重新安装。
pub(crate) fn only_data(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    let names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| !n.starts_with('.'))
        .collect();
    names.iter().any(|n| n == "data") && names.iter().all(|n| n == "data")
}

/// 卸载：删掉代码，**`data/` 留着**。
///
/// 插件攒下的东西（故障树、同步记录）是用户的数据，不是插件的一部分 ——
/// 卸了再装回来，应该什么都还在。没有数据的插件整个目录删干净。
/// 调用方（设置页）负责先停用、先确认。
#[tauri::command]
pub fn uninstall_plugin(app: tauri::AppHandle, id: String) -> Result<()> {
    let dir = plugin_dir(&app, &id)?;
    remove_code(&dir)?;
    if dir.is_dir() && !only_data(&dir) {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("删除插件目录失败：{e}"))?;
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* 私有存储                                                            */
/* ------------------------------------------------------------------ */

fn data_file(app: &tauri::AppHandle, id: &str, name: &str) -> Result<PathBuf> {
    check_name(name, "文件名")?;
    Ok(plugin_dir(app, id)?.join("data").join(name))
}

#[tauri::command]
pub fn plugin_storage_read(app: tauri::AppHandle, id: String, name: String) -> Result<Option<String>> {
    let path = data_file(&app, &id, &name)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读不了 {name}：{e}")),
    }
}

/// 写入走「临时文件 + rename」。
///
/// 这个文件会被别的进程同时读（gantt CLI 读同步队列），半截写入的 JSON
/// 被读到就是一次解析失败。rename 在同一文件系统上是原子的。
#[tauri::command]
pub fn plugin_storage_write(app: tauri::AppHandle, id: String, name: String, content: String) -> Result<()> {
    let path = data_file(&app, &id, &name)?;
    let dir = path.parent().ok_or("路径不对")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("建不了 data 目录：{e}"))?;
    let tmp = dir.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, content).map_err(|e| format!("写不了 {name}：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("写不了 {name}：{e}"))
}

/* ------------------------------------------------------------------ */
/* 子进程                                                              */
/* ------------------------------------------------------------------ */

/// 不许作为程序名的东西。插件要的是具体的工具，不是一个通用的命令解释器。
const FORBIDDEN_PROGRAMS: &[&str] = &[
    "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "env", "sudo", "osascript",
    "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh",
];

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

/// 子进程用的 PATH。
///
/// 从访达/程序坞启动的 macOS 应用拿到的 PATH 只有 `/usr/bin:/bin:...`，
/// 用户在终端里装的 `claude`、`lark-cli`（npm 全局）、`node` 一个都找不到。
/// 这里问一次登录 shell 要它的 PATH，再补上几个常见的安装位置 ——
/// npm 全局目录不一定在用户的 shell 配置里（本机就是这样）。
fn child_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let mut dirs: Vec<String> = Vec::new();
        let mut push = |d: String| {
            if !d.is_empty() && !dirs.contains(&d) {
                dirs.push(d);
            }
        };

        #[cfg(unix)]
        {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            if let Ok(out) = Command::new(shell)
                .args(["-l", "-c", "printf %s \"$PATH\""])
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
            {
                for d in String::from_utf8_lossy(&out.stdout).split(':') {
                    push(d.to_string());
                }
            }
        }
        if let Some(cur) = std::env::var_os("PATH") {
            for d in std::env::split_paths(&cur) {
                push(d.to_string_lossy().to_string());
            }
        }
        if let Some(h) = home() {
            for sub in [".npm-global/bin", ".local/bin", ".bun/bin", ".cargo/bin", ".volta/bin", "bin"] {
                push(h.join(sub).to_string_lossy().to_string());
            }
        }
        for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
            push(d.to_string());
        }
        let sep = if cfg!(windows) { ";" } else { ":" };
        dirs.join(sep)
    })
}

/// 在子进程 PATH 里找程序。找不到返回 None —— 插件页据此提示「没装 xx」。
pub(crate) fn which(program: &str) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(windows) { &["", ".exe", ".cmd", ".bat"] } else { &[""] };
    for dir in std::env::split_paths(child_path()) {
        for ext in exts {
            let p = dir.join(format!("{program}{ext}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn check_program(program: &str) -> Result<()> {
    check_name(program, "程序名")?;
    if FORBIDDEN_PROGRAMS.contains(&program.to_ascii_lowercase().as_str()) {
        return Err(format!("插件不能直接运行「{program}」"));
    }
    Ok(())
}

#[tauri::command]
pub fn plugin_which(program: String) -> Result<Option<String>> {
    check_program(&program)?;
    Ok(which(&program).map(|p| p.to_string_lossy().to_string()))
}

/// 正在跑的子进程。key 是 run id
#[derive(Default)]
pub struct Procs(Mutex<HashMap<u64, Arc<Mutex<Child>>>>);

static NEXT_RUN: AtomicU64 = AtomicU64::new(1);

/// 推给前端的一条事件。前端按 run_id 分发到对应插件的回调
#[derive(Serialize, Clone)]
struct ProcEvent {
    run_id: u64,
    /// "stdout" | "stderr" | "exit" | "error"
    kind: &'static str,
    /// stdout/stderr 是一行（不带换行符）；exit 时为退出码；error 时为说明
    data: String,
}

const PROC_EVENT: &str = "plugin-proc";

/// 起一个子进程，返回 run id。输出按行通过 `plugin-proc` 事件推回。
///
/// 工作目录固定是插件自己的目录 —— 插件附带的 Skill、提示词文件都在那里，
/// 而且不让它在别处起进程，出了事也知道去哪找现场。
#[tauri::command]
pub fn plugin_spawn(
    app: tauri::AppHandle,
    procs: tauri::State<'_, Procs>,
    id: String,
    program: String,
    args: Vec<String>,
    stdin: Option<String>,
) -> Result<u64> {
    check_program(&program)?;
    let cwd = plugin_dir(&app, &id)?;
    let exe = which(&program).ok_or_else(|| format!("找不到「{program}」—— 它装了吗？（已在 PATH 和常见安装目录里找过）"))?;
    spawn_piped(&app, &procs, &exe, &args, &cwd, stdin)
}

/// 起进程、接管它的输入输出、登记进进程表。`plugin_spawn` 的后半段。
///
/// 拆出来是因为内置的 AI 复盘（ai_review.rs）也要起 `claude`，而它不是插件：
/// 没有 manifest、没有插件目录。两边共用这一段，输出就走同一个 `plugin-proc`
/// 事件、同一张进程表，`plugin_kill` 也照样杀得掉 —— 前端只需要一套监听。
///
/// **「能跑什么」不在这里判断**，那是两个调用方各自的事：插件走程序名检查 +
/// manifest 白名单，AI 复盘把程序和参数都写死在 Rust 里。
pub(crate) fn spawn_piped(
    app: &tauri::AppHandle,
    procs: &Procs,
    exe: &Path,
    args: &[String],
    cwd: &Path,
    stdin: Option<String>,
) -> Result<u64> {
    let program = exe.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let mut child = Command::new(exe)
        .args(args)
        .current_dir(cwd)
        .env("PATH", child_path())
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动「{program}」失败：{e}"))?;

    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        // 写完就关掉 —— 不关的话读 stdin 的程序会一直等下去
        std::thread::spawn(move || {
            let _ = pipe.write_all(input.as_bytes());
        });
    }

    let run_id = NEXT_RUN.fetch_add(1, Ordering::Relaxed);
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    procs.0.lock().map_err(|_| "进程表坏了")?.insert(run_id, child.clone());

    let pump = |reader: Option<Box<dyn std::io::Read + Send>>, kind: &'static str| {
        let app = app.clone();
        std::thread::spawn(move || {
            let Some(r) = reader else { return };
            for line in BufReader::new(r).lines() {
                let Ok(data) = line else { break };
                let _ = app.emit(PROC_EVENT, ProcEvent { run_id, kind, data });
            }
        })
    };
    let out_t = pump(stdout.map(|s| Box::new(s) as _), "stdout");
    let err_t = pump(stderr.map(|s| Box::new(s) as _), "stderr");

    // 等待线程：轮询而不是阻塞 wait()，否则它会一直攥着锁，kill 进不来
    let app2 = app.clone();
    std::thread::spawn(move || {
        let status = loop {
            let done = child.lock().ok().and_then(|mut c| c.try_wait().transpose());
            match done {
                Some(Ok(s)) => break s.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into()),
                Some(Err(e)) => {
                    let _ = app2.emit(PROC_EVENT, ProcEvent { run_id, kind: "error", data: e.to_string() });
                    break "error".into();
                }
                None => std::thread::sleep(Duration::from_millis(100)),
            }
        };
        // 输出读完再报退出，否则前端可能先收到 exit 再收到最后几行
        let _ = out_t.join();
        let _ = err_t.join();
        if let Some(procs) = app2.try_state::<Procs>() {
            if let Ok(mut map) = procs.0.lock() {
                map.remove(&run_id);
            }
        }
        let _ = app2.emit(PROC_EVENT, ProcEvent { run_id, kind: "exit", data: status });
    });

    Ok(run_id)
}

#[tauri::command]
pub fn plugin_kill(procs: tauri::State<'_, Procs>, run_id: u64) -> Result<()> {
    let child = procs.0.lock().map_err(|_| "进程表坏了")?.get(&run_id).cloned();
    if let Some(child) = child {
        if let Ok(mut c) = child.lock() {
            let _ = c.kill();
        }
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* Claude Skill 链接                                                    */
/* ------------------------------------------------------------------ */

fn skills_dir() -> Result<PathBuf> {
    Ok(home().ok_or("找不到用户主目录")?.join(".claude").join("skills"))
}

/// 把插件里的一个 Skill 目录软链接到 `~/.claude/skills/<name>`。
///
/// 链接而不是拷贝：插件更新之后 Skill 自动跟着变，后台同步和用户自己开的
/// Claude Code 永远用的是同一份。
///
/// 那个位置上已经有一个**真目录**（用户自己写的同名 Skill）时拒绝，
/// 不覆盖 —— 那不是我们的东西。已有的软链接直接换掉。
#[tauri::command]
pub fn plugin_link_skill(app: tauri::AppHandle, id: String, dir: String, name: String) -> Result<String> {
    check_name(&dir, "Skill 目录")?;
    check_name(&name, "Skill 名")?;
    let src = plugin_dir(&app, &id)?.join(&dir);
    if !src.join("SKILL.md").is_file() {
        return Err(format!("插件里没有 {dir}/SKILL.md"));
    }
    let skills = skills_dir()?;
    std::fs::create_dir_all(&skills).map_err(|e| format!("建不了 {}：{e}", skills.display()))?;
    let dst = skills.join(&name);

    if let Ok(meta) = std::fs::symlink_metadata(&dst) {
        if meta.file_type().is_symlink() {
            std::fs::remove_file(&dst).map_err(|e| format!("替换旧链接失败：{e}"))?;
        } else {
            return Err(format!("{} 已经存在且不是链接，没有覆盖它", dst.display()));
        }
    }

    #[cfg(unix)]
    std::os::unix::fs::symlink(&src, &dst).map_err(|e| format!("建链接失败：{e}"))?;
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(&src, &dst).map_err(|e| format!("建链接失败：{e}"))?;

    Ok(dst.to_string_lossy().to_string())
}

/// 移除链接。只删**指向这个插件目录**的软链接，别的一概不碰。
#[tauri::command]
pub fn plugin_unlink_skill(app: tauri::AppHandle, id: String, name: String) -> Result<()> {
    check_name(&name, "Skill 名")?;
    let dst = skills_dir()?.join(&name);
    let Ok(meta) = std::fs::symlink_metadata(&dst) else { return Ok(()) };
    if !meta.file_type().is_symlink() {
        return Ok(());
    }
    let mine = plugin_dir(&app, &id)?;
    let target = std::fs::read_link(&dst).unwrap_or_default();
    if target.starts_with(&mine) {
        std::fs::remove_file(&dst).map_err(|e| format!("移除链接失败：{e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_names() {
        assert!(check_id("feishu-sync").is_ok());
        assert!(check_id("../x").is_err());
        assert!(check_id("A").is_err());
        assert!(check_name("queue.json", "x").is_ok());
        assert!(check_name("../queue.json", "x").is_err());
        assert!(check_name(".hidden", "x").is_err());
        assert!(check_name("a/b", "x").is_err());
    }

    #[test]
    fn shells_are_refused() {
        assert!(check_program("lark-cli").is_ok());
        assert!(check_program("bash").is_err());
        assert!(check_program("ZSH").is_err());
        assert!(check_program("/bin/ls").is_err());
    }

    #[test]
    fn install_skips_tests_and_data() {
        assert!(skip_on_install("main.test.ts"));
        assert!(skip_on_install("data"));
        assert!(skip_on_install(".DS_Store"));
        assert!(!skip_on_install("main.js"));
    }

    #[test]
    fn uninstall_keeps_data() {
        let root = std::env::temp_dir().join(format!("gantt-plugin-uninstall-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        // 有数据：代码删掉，data/ 留着，扫描时被当成「只剩数据」跳过
        let a = root.join("a");
        std::fs::create_dir_all(a.join("data")).unwrap();
        std::fs::create_dir_all(a.join("assets")).unwrap();
        std::fs::write(a.join("main.js"), "x").unwrap();
        std::fs::write(a.join("data/trees.json"), "{}").unwrap();
        assert!(!only_data(&a));
        remove_code(&a).unwrap();
        assert!(only_data(&a));
        assert_eq!(std::fs::read_to_string(a.join("data/trees.json")).unwrap(), "{}");

        // 没数据：删完是空目录，不算「只剩数据」，调用方会整个删掉
        let b = root.join("b");
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join("main.js"), "x").unwrap();
        remove_code(&b).unwrap();
        assert!(!only_data(&b));

        let _ = std::fs::remove_dir_all(&root);
    }
}
