//! 插件目录的发现与读取。这里只负责让前端看得见文件，不解析 manifest ——
//! 字段校验、版本比较、依赖顺序全是纯逻辑，放 TS 侧能用 vitest 直接跑。
//!
//! 插件目录固定在 app_config_dir()/plugins，和 gantt.db、backups/ 在一起。

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

type Result<T> = std::result::Result<T, String>;

/// 插件目录名。
pub(crate) const PLUGINS_DIR: &str = "plugins";

/// 单个插件文件上限。插件是开发者自己写的几十 KB 代码，
/// 上限是为了在扫描阶段挡掉误丢进来的 node_modules。
const MAX_ENTRY_BYTES: u64 = 8 * 1024 * 1024;

/// 一个插件目录的原始内容。**未校验** —— 合法性由 TS 侧 validateManifest 判断。
#[derive(Serialize)]
pub struct RawPlugin {
    /// 目录名。目录名就是插件身份，manifest 里的 id 必须与它一致。
    pub dir_name: String,
    /// 目录的绝对路径
    pub path: String,
    /// manifest.json 的原文，读不出来时为 None。
    /// 不在这里解析：TS 侧要拿原始 JSON 才能报告「第几个字段错了」
    pub manifest_raw: Option<String>,
    /// 入口文件的原文，默认 main.js
    pub entry_raw: Option<String>,
    /// 和 manifest 同级的 styles.css，有就自动注入
    pub css_raw: Option<String>,
}

/// 把插件目录建出来并返回。首次调用会创建目录。
pub(crate) fn ensure_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("拿不到配置目录：{e}"))?
        .join(PLUGINS_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("建不了插件目录：{e}"))?;
    Ok(dir)
}

/// 读一个文件的文本。超过 MAX_ENTRY_BYTES 就拒绝。
fn read_text(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_ENTRY_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// 扫描插件目录。
///
/// 只看一层子目录，不递归：允许嵌套等于允许路径穿越和无穷歧义。
/// 隐藏目录跳过（macOS 的 .DS_Store、编辑器临时文件）。
fn scan(app: &tauri::AppHandle) -> Result<Vec<RawPlugin>> {
    let dir = ensure_dir(app)?;
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("读不了插件目录：{e}"))?;

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let dir_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) if !n.starts_with('.') => n.to_string(),
            _ => continue,
        };
        // 卸载后只剩 data/ 的目录：在等重新安装，不是坏插件
        if crate::plugin_host::only_data(&path) {
            continue;
        }

        let manifest_path = path.join("manifest.json");
        let manifest_raw = read_text(&manifest_path);

        // 入口名从 manifest 取，取不到退回 main.js。刻意宽松：只有 main.js
        // 没 manifest 的目录交给 TS 侧报「缺少 manifest.json」，而不是静默跳过
        let entry_name = manifest_raw
            .as_deref()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
            .and_then(|v| v.get("main")?.as_str().map(str::to_string))
            .unwrap_or_else(|| "main.js".to_string());

        out.push(RawPlugin {
            path: path.to_string_lossy().to_string(),
            entry_raw: read_text(&path.join(&entry_name)),
            css_raw: read_text(&path.join("styles.css")),
            manifest_raw,
            dir_name,
        });
    }

    // 顺序稳定，否则每次启动视图顺序都在跳。按目录名排。
    out.sort_by(|a, b| a.dir_name.cmp(&b.dir_name));
    Ok(out)
}

#[tauri::command]
pub fn list_plugins(app: tauri::AppHandle) -> Result<Vec<RawPlugin>> {
    scan(&app)
}

#[tauri::command]
pub fn plugins_dir(app: tauri::AppHandle) -> Result<String> {
    Ok(ensure_dir(&app)?.to_string_lossy().to_string())
}

/// 在资源管理器 / 访达里打开插件目录。
#[tauri::command]
pub fn reveal_plugins_dir(app: tauri::AppHandle) -> Result<()> {
    let dir = ensure_dir(&app)?;

    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";

    std::process::Command::new(program)
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("打不开插件目录：{e}"))?;
    Ok(())
}
