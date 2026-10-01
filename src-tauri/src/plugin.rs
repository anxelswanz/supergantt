//! 插件目录的发现与读取。
//!
//! 这里**只负责让前端看得见插件目录里的文件**，不解析 manifest、不判断
//! 谁该加载 —— 那是渲染层的事（src/plugins/*.ts）。分成两半是有理由的：
//! manifest 的字段校验、版本比较、依赖顺序全是纯逻辑，放在 TS 侧能用
//! vitest 直接跑；塞进 Rust 就得为每一条规则写一遍测试脚手架。
//!
//! 插件目录固定在 app_config_dir()/plugins，和 gantt.db、backups/ 同一个
//! 地方 —— 用户点设置里的「打开插件目录」就能看到全部，备份时也不会漏。

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

type Result<T> = std::result::Result<T, String>;

/// 插件目录名。出现在 app_config_dir() 下面，和 gantt.db 并列。
pub(crate) const PLUGINS_DIR: &str = "plugins";

/// 单个插件最多能有多大。
///
/// 插件是开发者自己写的代码，不是下载来的资源包，正常也就几十 KB。
/// 给一个上限是为了挡住「把 200MB 的 node_modules 整个丢进去然后问为什么
/// 启动要 10 秒」这种情况 —— 让它在扫描阶段就说清楚，而不是等到内存里。
const MAX_ENTRY_BYTES: u64 = 8 * 1024 * 1024;

/// 一个插件目录的原始内容。**未校验** —— 字段是不是齐全、id 合不合法
/// 由 TS 侧的 validateManifest 判断。
#[derive(Serialize)]
pub struct RawPlugin {
    /// 目录名。目录名就是插件身份，manifest 里的 id 必须和它一致 ——
    /// 否则用户看到的文件夹名和插件的自称是两回事，出问题没法对账。
    pub dir_name: String,
    /// 目录的绝对路径，方便前端提示和「在访达中显示」
    pub path: String,
    /// manifest.json 的原文；文件不存在或读不出来时为 None。
    /// 不在这里解析成结构体：TS 侧要拿到原始 JSON 才能报告「第几个字段错了」
    pub manifest_raw: Option<String>,
    /// 入口文件的原文。默认 main.js，读不出来时为 None
    pub entry_raw: Option<String>,
    /// 和 manifest 同级的 styles.css，有就自动注入
    pub css_raw: Option<String>,
}

/// 把插件目录建出来并返回。首次调用会创建目录。
///
/// 不在这里塞任何「内置插件」的骨架 —— 空目录就是空目录，设置面板里
/// 会显示「把插件放进这个目录」，比放一个用户不认识的示例目录清楚。
pub(crate) fn ensure_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("拿不到配置目录：{e}"))?
        .join(PLUGINS_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("建不了插件目录：{e}"))?;
    Ok(dir)
}

/// 读一个文件的文本。超过 MAX_ENTRY_BYTES 就拒绝 —— 见那个常量的说明。
fn read_text(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_ENTRY_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// 扫描插件目录。
///
/// 只看**一层**子目录，不递归：插件的入口就摆在 plugins/<id>/main.js，
/// 允许嵌套等于允许路径穿越和无穷多的歧义。隐藏目录（以 . 开头）跳过 ——
/// macOS 的 .DS_Store、编辑器临时目录都在这一层。
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

        let manifest_path = path.join("manifest.json");
        let manifest_raw = read_text(&manifest_path);

        // 入口文件名从 manifest 里取；manifest 读不出来或没写 main，
        // 就退回约定俗成的 main.js。这一步是刻意的宽松：一个只有
        // main.js 没有 manifest.json 的目录，TS 侧会给出一条明确的
        // 「缺少 manifest.json」而不是在这里静默跳过 —— 用户需要知道
        // 自己漏了哪个文件，而不是看着一个空列表猜。
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

/// 在资源管理器 / 访达里打开插件目录。没装插件的人也要能找到这个入口 ——
/// 「把插件放哪」这个问题的答案只能是一条路径，不能是一段说明。
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
