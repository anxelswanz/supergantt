//! 在线插件：从 GitHub 上的 supergantt-plugins 仓库拉 index.json、下载 zip、校验、安装。
//!
//! 应用安装包里不带插件。index 的解析、版本比较、兼容性判断都在 TS 侧
//! （src/plugins/store.ts），这里只做三件 WebView 做不了或不该做的事：
//!
//! - **联网**：GitHub Release 的下载会 302 到 objects.githubusercontent.com，
//!   那边不给 CORS 头，WebView 的 fetch 拿不到字节
//! - **校验**：sha256 对不上就不落盘。镜像（下载加速前缀）因此可以随便填 ——
//!   它能让下载变快，但改不了装进来的内容
//! - **原子安装**：先解压到临时目录、检查 manifest，再整体换掉旧代码，`data/` 原样带过去。
//!   中途任何一步失败，旧版本都还在

use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::plugin::ensure_dir;
use crate::plugin_host::{check_id, skip_on_install};

type Result<T> = std::result::Result<T, String>;

/// 插件仓库。index 地址和下载地址前缀都从它拼
const REPO: &str = "anxelswanz/supergantt-plugins";

fn index_url() -> String {
    format!("https://raw.githubusercontent.com/{REPO}/main/index.json")
}

/// 只从这个前缀下载。index 是从网上读的，不能让它把人引到任意地址去
fn download_prefix() -> String {
    format!("https://github.com/{REPO}/releases/download/")
}

const MAX_INDEX_BYTES: usize = 1024 * 1024;
const MAX_ZIP_BYTES: usize = 20 * 1024 * 1024;
/// 解压后的总大小上限：挡 zip 炸弹
const MAX_UNPACKED_BYTES: u64 = 64 * 1024 * 1024;

/// 上一次成功拉到的 index，离线时拿它顶着
const CACHE_FILE: &str = "plugin-index-cache.json";

/* ------------------------------------------------------------------ */
/* 网络                                                                */
/* ------------------------------------------------------------------ */

/// 拼上下载加速前缀。前缀是 ghproxy 一类「前缀 + 原地址」的镜像；空的就直连
fn with_mirror(mirror: Option<&str>, url: &str) -> Result<String> {
    let m = mirror.map(str::trim).unwrap_or("");
    if m.is_empty() {
        return Ok(url.to_string());
    }
    if !m.starts_with("https://") {
        return Err(format!("下载加速前缀要以 https:// 开头：{m}"));
    }
    Ok(if m.ends_with('/') { format!("{m}{url}") } else { format!("{m}/{url}") })
}

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("SuperGantt/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("网络组件初始化失败：{e}"))
}

/// GET 一个地址，超过 `max` 字节就放弃。错误信息要让人知道是网的问题还是地址的问题
async fn get_bytes(url: &str, max: usize) -> Result<Vec<u8>> {
    let mut resp = client()?.get(url).send().await.map_err(|e| {
        if e.is_timeout() {
            "连接 GitHub 超时。网络不通的话，可以在下面填一个下载加速前缀".to_string()
        } else if e.is_connect() {
            "连不上 GitHub。检查网络，或者在下面填一个下载加速前缀".to_string()
        } else {
            format!("下载失败：{e}")
        }
    })?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("下载失败：服务器返回 {status}（{url}）"));
    }
    if resp.content_length().is_some_and(|n| n as usize > max) {
        return Err(format!("文件太大（超过 {} MB），没有下载", max / 1024 / 1024));
    }
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("下载中断：{e}"))? {
        out.extend_from_slice(&chunk);
        if out.len() > max {
            return Err(format!("文件太大（超过 {} MB），没有下载", max / 1024 / 1024));
        }
    }
    Ok(out)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/* ------------------------------------------------------------------ */
/* index                                                               */
/* ------------------------------------------------------------------ */

#[derive(Serialize)]
pub struct IndexFetch {
    /// index.json 原文。网上的和缓存的都拿不到时为 None
    pub raw: Option<String>,
    /// 这份 index 是什么时候拉到的（unix 秒）
    pub fetched_at: Option<i64>,
    /// 这次没连上，给的是上一次的缓存
    pub from_cache: bool,
    /// 没连上的原因。连上了为 None
    pub error: Option<String>,
}

#[derive(serde::Deserialize, Serialize)]
struct Cache {
    fetched_at: i64,
    raw: String,
}

fn cache_file(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| format!("拿不到配置目录：{e}"))?
        .join(CACHE_FILE))
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 拉 index.json。失败不报错，而是退回缓存并带上原因 —— 离线时插件页照样能管理已装的
#[tauri::command]
pub async fn store_fetch_index(app: tauri::AppHandle, mirror: Option<String>) -> Result<IndexFetch> {
    let fetched = async {
        let bytes = get_bytes(&with_mirror(mirror.as_deref(), &index_url())?, MAX_INDEX_BYTES).await?;
        let raw = String::from_utf8(bytes).map_err(|_| "插件列表不是 UTF-8 文本".to_string())?;
        // 镜像出错时常常返回一个 200 的 HTML 页面。不是 JSON 就当没连上，别覆盖好的缓存
        serde_json::from_str::<serde_json::Value>(&raw)
            .map_err(|_| "拿到的插件列表不是 JSON —— 下载加速前缀可能不对".to_string())?;
        Ok::<String, String>(raw)
    }
    .await;

    let file = cache_file(&app)?;
    match fetched {
        Ok(raw) => {
            let fetched_at = now();
            if let Ok(text) = serde_json::to_string(&Cache { fetched_at, raw: raw.clone() }) {
                // 缓存写不进去不影响这一次
                let _ = std::fs::write(&file, text);
            }
            Ok(IndexFetch { raw: Some(raw), fetched_at: Some(fetched_at), from_cache: false, error: None })
        }
        Err(error) => {
            let cache = std::fs::read_to_string(&file)
                .ok()
                .and_then(|s| serde_json::from_str::<Cache>(&s).ok());
            Ok(IndexFetch {
                fetched_at: cache.as_ref().map(|c| c.fetched_at),
                raw: cache.map(|c| c.raw),
                from_cache: true,
                error: Some(error),
            })
        }
    }
}

/* ------------------------------------------------------------------ */
/* 安装                                                                */
/* ------------------------------------------------------------------ */

/// 下载地址必须是插件仓库的 Release，而且 tag 是这个插件的
fn check_url(id: &str, url: &str) -> Result<()> {
    let ok = url
        .strip_prefix(&download_prefix())
        .is_some_and(|rest| rest.starts_with(&format!("{id}-v")) && !rest.contains("..") && !rest.contains('?'));
    if ok {
        Ok(())
    } else {
        Err(format!("插件「{id}」的下载地址不在插件仓库里，没有下载：{url}"))
    }
}

/// 下载、校验、安装一个插件。返回装上的 manifest 原文，校验交给 TS 侧（和扫描时同一个校验器）
#[tauri::command]
pub async fn store_install(
    app: tauri::AppHandle,
    id: String,
    url: String,
    sha256: String,
    mirror: Option<String>,
) -> Result<String> {
    check_id(&id)?;
    check_url(&id, &url)?;
    let want = sha256.trim().to_ascii_lowercase();
    if want.len() != 64 || !want.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("插件列表里的 sha256 格式不对".into());
    }

    let bytes = get_bytes(&with_mirror(mirror.as_deref(), &url)?, MAX_ZIP_BYTES).await?;
    let got = sha256_hex(&bytes);
    if got != want {
        return Err(if mirror.as_deref().is_some_and(|m| !m.trim().is_empty()) {
            "下载的文件和插件列表对不上（sha256 不一致），没有安装。可能是下载加速前缀返回了别的内容，换一个或清空再试".into()
        } else {
            "下载的文件和插件列表对不上（sha256 不一致），没有安装。可能是下载不完整，再试一次".into()
        });
    }

    let root = ensure_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || install_zip(&root, &id, &bytes))
        .await
        .map_err(|e| format!("安装中断：{e}"))?
}

/// zip 里的一条路径 → 相对路径。拒绝绝对路径、`..`、以及应该跳过的文件（测试、data/、隐藏文件）
fn entry_path(name: &str) -> Result<Option<PathBuf>> {
    let path = Path::new(name);
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::Normal(part) => {
                let part = part.to_str().ok_or("插件包里有读不出来的文件名")?;
                if skip_on_install(part) {
                    return Ok(None);
                }
                out.push(part);
            }
            Component::CurDir => {}
            _ => return Err(format!("插件包里有不安全的路径：{name}")),
        }
    }
    Ok((!out.as_os_str().is_empty()).then_some(out))
}

/// 解压到 `<root>/.staging-<id>/`，检查 manifest，再换掉 `<root>/<id>/` 的代码。
///
/// 临时目录以点开头，扫描时会被跳过 —— 装到一半崩了也不会被当成插件加载
pub(crate) fn install_zip(root: &Path, id: &str, bytes: &[u8]) -> Result<String> {
    let staging = root.join(format!(".staging-{id}"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("建不了临时目录：{e}"))?;

    let result = unpack(&staging, bytes).and_then(|()| read_manifest(&staging, id));
    let manifest = match result {
        Ok(m) => m,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
    };

    swap_in(root, id, &staging).inspect_err(|_| {
        let _ = std::fs::remove_dir_all(&staging);
    })?;
    Ok(manifest)
}

fn unpack(staging: &Path, bytes: &[u8]) -> Result<()> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("插件包打不开：{e}"))?;
    let mut total: u64 = 0;
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(|e| format!("插件包读不了：{e}"))?;
        let Some(rel) = entry_path(file.name())? else { continue };
        let dst = staging.join(&rel);
        if file.is_dir() {
            std::fs::create_dir_all(&dst).map_err(|e| format!("建不了目录：{e}"))?;
            continue;
        }
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("建不了目录：{e}"))?;
        }
        // 不信 zip 头里写的大小，按实际读出来的算
        let mut buf = Vec::new();
        (&mut file)
            .take(MAX_UNPACKED_BYTES - total + 1)
            .read_to_end(&mut buf)
            .map_err(|e| format!("插件包解压失败：{e}"))?;
        total += buf.len() as u64;
        if total > MAX_UNPACKED_BYTES {
            return Err("插件包解压后太大，没有安装".into());
        }
        std::fs::write(&dst, buf).map_err(|e| format!("写不了 {}：{e}", rel.display()))?;
    }
    Ok(())
}

/// manifest 要在，而且 id 要和要装的那个一致。其余字段的校验在 TS 侧
fn read_manifest(staging: &Path, id: &str) -> Result<String> {
    let raw = std::fs::read_to_string(staging.join("manifest.json"))
        .map_err(|_| "插件包里没有 manifest.json".to_string())?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("插件包里的 manifest.json 不是合法 JSON：{e}"))?;
    match v.get("id").and_then(|x| x.as_str()) {
        Some(got) if got == id => Ok(raw),
        got => Err(format!("插件包里的 id 是「{}」，不是「{id}」", got.unwrap_or("（没有）"))),
    }
}

/// 换代码，`data/` 跟过去。同一文件系统内全是 rename：
///
/// 1. 旧目录的 `data/` 挪进临时目录
/// 2. 旧目录整个挪到 `.old-<id>`
/// 3. 临时目录挪成 `<id>`
/// 4. 删 `.old-<id>`
///
/// 第 3 步失败时把 1、2 倒回去，旧版本原样还在
fn swap_in(root: &Path, id: &str, staging: &Path) -> Result<()> {
    let dst = root.join(id);
    let old = root.join(format!(".old-{id}"));
    let _ = std::fs::remove_dir_all(&old);

    let had_data = dst.join("data").is_dir();
    if had_data {
        std::fs::rename(dst.join("data"), staging.join("data"))
            .map_err(|e| format!("挪不动插件数据：{e}"))?;
    }
    let had_dst = dst.exists();
    if had_dst {
        if let Err(e) = std::fs::rename(&dst, &old) {
            if had_data {
                let _ = std::fs::rename(staging.join("data"), dst.join("data"));
            }
            return Err(format!("挪不动旧版本：{e}"));
        }
    }
    if let Err(e) = std::fs::rename(staging, &dst) {
        if had_dst {
            let _ = std::fs::rename(&old, &dst);
        }
        if had_data {
            let _ = std::fs::rename(staging.join("data"), dst.join("data"));
        }
        return Err(format!("装不进插件目录：{e}"));
    }
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_of(files: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            for (name, body) in files {
                w.start_file(*name, opts).unwrap();
                w.write_all(body.as_bytes()).unwrap();
            }
            w.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn mirror_prefix() {
        let u = "https://github.com/a/b/releases/download/x-v1/x-1.zip";
        assert_eq!(with_mirror(None, u).unwrap(), u);
        assert_eq!(with_mirror(Some("  "), u).unwrap(), u);
        assert_eq!(with_mirror(Some("https://m.example/"), u).unwrap(), format!("https://m.example/{u}"));
        assert_eq!(with_mirror(Some("https://m.example"), u).unwrap(), format!("https://m.example/{u}"));
        assert!(with_mirror(Some("http://m.example/"), u).is_err());
    }

    #[test]
    fn only_downloads_from_the_plugin_repo() {
        let ok = format!("{}feishu-sync-v1.6.0/feishu-sync-1.6.0.zip", download_prefix());
        assert!(check_url("feishu-sync", &ok).is_ok());
        // 别人的 tag、别的仓库、路径穿越
        assert!(check_url("fault-tree", &ok).is_err());
        assert!(check_url("x", "https://evil.example/x-v1/x.zip").is_err());
        assert!(check_url("feishu-sync", &format!("{}feishu-sync-v1/../../x.zip", download_prefix())).is_err());
    }

    #[test]
    fn unsafe_paths_are_refused() {
        assert!(entry_path("../x.js").is_err());
        assert!(entry_path("/etc/passwd").is_err());
        assert_eq!(entry_path("skill/SKILL.md").unwrap(), Some(PathBuf::from("skill/SKILL.md")));
        assert_eq!(entry_path("main.test.ts").unwrap(), None);
        assert_eq!(entry_path("data/queue.json").unwrap(), None);
        assert_eq!(entry_path(".DS_Store").unwrap(), None);
    }

    #[test]
    fn install_replaces_code_and_keeps_data() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("demo");
        std::fs::create_dir_all(dir.join("data")).unwrap();
        std::fs::write(dir.join("main.js"), "old").unwrap();
        std::fs::write(dir.join("gone.js"), "old").unwrap();
        std::fs::write(dir.join("data/trees.json"), "{\"keep\":1}").unwrap();

        let zip = zip_of(&[
            ("manifest.json", r#"{"id":"demo","version":"2.0.0"}"#),
            ("main.js", "new"),
            ("skill/SKILL.md", "# s"),
            ("data/trees.json", "{\"overwritten\":1}"),
        ]);
        let manifest = install_zip(root.path(), "demo", &zip).unwrap();
        assert!(manifest.contains("2.0.0"));

        assert_eq!(std::fs::read_to_string(dir.join("main.js")).unwrap(), "new");
        assert!(dir.join("skill/SKILL.md").is_file());
        // 旧版本有、新版本没有的文件不会留下来
        assert!(!dir.join("gone.js").exists());
        // 包里的 data/ 被跳过，用户的数据原样保留
        assert_eq!(std::fs::read_to_string(dir.join("data/trees.json")).unwrap(), "{\"keep\":1}");
        // 临时目录都清干净了
        let leftovers: Vec<_> = std::fs::read_dir(root.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(leftovers, vec!["demo"]);
    }

    #[test]
    fn bad_package_leaves_old_version_alone() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("demo");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("main.js"), "old").unwrap();

        // id 不对
        let wrong = zip_of(&[("manifest.json", r#"{"id":"other"}"#), ("main.js", "new")]);
        assert!(install_zip(root.path(), "demo", &wrong).unwrap_err().contains("other"));
        // 没有 manifest
        let none = zip_of(&[("main.js", "new")]);
        assert!(install_zip(root.path(), "demo", &none).is_err());
        // 路径穿越
        let evil = zip_of(&[("manifest.json", r#"{"id":"demo"}"#), ("../escape.js", "x")]);
        assert!(install_zip(root.path(), "demo", &evil).is_err());
        assert!(!root.path().join("escape.js").exists());

        assert_eq!(std::fs::read_to_string(dir.join("main.js")).unwrap(), "old");
        assert!(!root.path().join(".staging-demo").exists());
    }

    #[test]
    fn fresh_install() {
        let root = tempfile::tempdir().unwrap();
        let zip = zip_of(&[("manifest.json", r#"{"id":"demo"}"#), ("main.js", "x")]);
        install_zip(root.path(), "demo", &zip).unwrap();
        assert!(root.path().join("demo/main.js").is_file());
    }

    /// 真联网，默认不跑：`cargo test --lib real_github -- --ignored`
    /// Release 下载会 302 到 objects.githubusercontent.com，这条确认重定向和 TLS 都通
    #[test]
    #[ignore]
    fn real_github() {
        let bytes = tauri::async_runtime::block_on(get_bytes(
                "https://github.com/cli/cli/releases/download/v2.40.0/gh_2.40.0_checksums.txt",
                MAX_INDEX_BYTES,
            ))
        .unwrap();
        assert!(String::from_utf8(bytes).unwrap().contains("gh_2.40.0_macOS"));
    }
}
