//! 飞书同步插件（`plugins/feishu-sync`）的同步队列。
//!
//! 队列不在 gantt.db 里，而在插件自己的数据目录：
//! `<数据目录>/plugins/feishu-sync/data/queue.json`。插件在应用里维护它
//! （加入/移出、事项改了就刷新快照），这里给 CLI 读和回写同步结果 ——
//! 用户自己开的 Claude Code 和应用里的后台同步走的是同一份状态。
//!
//! ## 为什么快照由插件写，而不是 CLI 从库里现算
//!
//! 「一条事项」在界面上是三张表合并出来的（事项、阻碍、风险，见
//! `src/core/items.ts` 的 mergeItems）：分拣过的事项由实体行代表，阻碍的
//! 关闭状态取决于区间的 open 标志……这套规则只有 TS 侧有。CLI 再实现一遍，
//! 两边迟早算出两个不同的「状态」。所以插件把投影好的结果写进队列，CLI 只
//! 补插件拿不到的东西（任务备注、项目名）。
//!
//! ## 文件格式（camelCase，和插件的 main.js 是同一个契约）
//!
//! ```json
//! {
//!   "version": 1,
//!   "entries": [{
//!     "key": "note:12",          // 稳定身份：有 noteId 用 note:<id>，否则用行 key
//!     "projectId": 1,
//!     "addedAt": "2026-10-12T09:00:00Z",
//!     "missing": false,          // 源事项已被删除
//!     "item": { ...ItemView },   // 插件维护的最新快照
//!     "syncs": {
//!       "<baseToken>:<tableId>": {
//!         "recordId": "rec…", "syncedAt": "…", "snapshot": { ...ItemView }, "error": null
//!       }
//!     }
//!   }]
//! }
//! ```
//!
//! 状态按「目标表」算：同一条事项可以同步到两张表，各有各的记录。

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

/// 插件 id。和 plugins/feishu-sync/manifest.json 一致
pub const PLUGIN_ID: &str = "feishu-sync";

pub fn data_dir(app_data: &Path) -> PathBuf {
    app_data.join("plugins").join(PLUGIN_ID).join("data")
}

pub fn queue_path(app_data: &Path) -> PathBuf {
    data_dir(app_data).join("queue.json")
}

pub fn config_path(app_data: &Path) -> PathBuf {
    data_dir(app_data).join("config.json")
}

/// 读一个 JSON 文件。不存在当作空对象 —— 插件还没写过队列是正常状态。
pub fn load(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("{} 不是合法的 JSON：{e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(format!("读不了 {}：{e}", path.display())),
    }
}

/// 原子写回（临时文件 + rename）。应用里的插件可能正在读它。
pub fn save(path: &Path, value: &Value) -> Result<(), String> {
    let dir = path.parent().ok_or("路径不对")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("建不了 {}：{e}", dir.display()))?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("queue.json");
    let tmp = dir.join(format!(".{name}.tmp"));
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("写不了 {}：{e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("写不了 {}：{e}", path.display()))
}

/// 比较「有没有改过」时看的字段。
///
/// ⚠️ 和 plugins/feishu-sync/main.js 的 SNAPSHOT_FIELDS 必须一字不差 ——
/// 两边算出不同的状态，界面上就是「已同步」而 CLI 说「有变更」。
pub const SNAPSHOT_FIELDS: &[&str] = &[
    "title", "kind", "kindLabel", "priority", "personId", "personName", "taskId", "taskName", "day",
    "closed", "closedDay", "resolution", "riskLevel",
];

fn same_snapshot(a: &Value, b: &Value) -> bool {
    SNAPSHOT_FIELDS
        .iter()
        .all(|f| a.get(*f).unwrap_or(&Value::Null) == b.get(*f).unwrap_or(&Value::Null))
}

/// 一条队列项相对某个目标表的状态。
///
/// - `pending`：还没往这张表写过
/// - `failed`：上次写失败了
/// - `changed`：写过，但事项后来改了
/// - `synced`：写过，之后没改
pub fn status_of(entry: &Value, target: &str) -> &'static str {
    let Some(sync) = entry.pointer(&format!("/syncs/{}", escape_pointer(target))) else {
        return "pending";
    };
    if sync.get("error").is_some_and(|e| !e.is_null()) {
        return "failed";
    }
    if sync.get("recordId").and_then(Value::as_str).unwrap_or("").is_empty() {
        return "pending";
    }
    let item = entry.get("item").unwrap_or(&Value::Null);
    let snap = sync.get("snapshot").unwrap_or(&Value::Null);
    if same_snapshot(item, snap) {
        "synced"
    } else {
        "changed"
    }
}

/// JSON Pointer 里 `~` 和 `/` 要转义。目标 key 里没有它们，但别赌
fn escape_pointer(s: &str) -> String {
    s.replace('~', "~0").replace('/', "~1")
}

/// 目标 key 的形状：`<baseToken>:<tableId>`
pub fn parse_target(s: &str) -> Result<(String, String), String> {
    match s.split_once(':') {
        Some((b, t)) if !b.is_empty() && !t.is_empty() => Ok((b.to_string(), t.to_string())),
        _ => Err(format!("目标「{s}」看不懂，要写成 <base-token>:<table-id>，例如 bascnXXX:tblYYY")),
    }
}

pub fn entries(queue: &Value) -> Vec<&Value> {
    queue.get("entries").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default()
}

fn entry_mut<'a>(queue: &'a mut Value, key: &str) -> Result<&'a mut Map<String, Value>, String> {
    queue
        .get_mut("entries")
        .and_then(Value::as_array_mut)
        .and_then(|arr| arr.iter_mut().find(|e| e.get("key").and_then(Value::as_str) == Some(key)))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("同步队列里没有「{key}」。先用 `gantt feishu queue` 看看有哪些"))
}

fn sync_slot<'a>(entry: &'a mut Map<String, Value>, target: &str) -> &'a mut Map<String, Value> {
    let syncs = entry.entry("syncs").or_insert_with(|| json!({}));
    if !syncs.is_object() {
        *syncs = json!({});
    }
    let slot = syncs.as_object_mut().unwrap().entry(target.to_string()).or_insert_with(|| json!({}));
    if !slot.is_object() {
        *slot = json!({});
    }
    slot.as_object_mut().unwrap()
}

/// 记下一次成功的写入：记录 id + 当时的快照。
pub fn mark_synced(queue: &mut Value, key: &str, target: &str, record_id: &str, now: &str) -> Result<(), String> {
    if !valid_record_id(record_id) {
        return Err(format!("「{record_id}」不像飞书记录 id（应该是 rec 开头的字母数字）"));
    }
    let entry = entry_mut(queue, key)?;
    let item = entry.get("item").cloned().unwrap_or(Value::Null);
    let slot = sync_slot(entry, target);
    slot.insert("recordId".into(), json!(record_id));
    slot.insert("syncedAt".into(), json!(now));
    slot.insert("snapshot".into(), item);
    slot.insert("error".into(), Value::Null);
    Ok(())
}

/// 记下一次失败。之前写成功过的 recordId 留着 —— 下次重试仍然是更新那一条
pub fn mark_failed(queue: &mut Value, key: &str, target: &str, error: &str, now: &str) -> Result<(), String> {
    let entry = entry_mut(queue, key)?;
    let slot = sync_slot(entry, target);
    slot.insert("error".into(), json!(error));
    slot.insert("failedAt".into(), json!(now));
    Ok(())
}

/* ------------------------------------------------------------------ */
/* 安全写入的几道关（gantt feishu write 用）                             */
/* ------------------------------------------------------------------ */

/// 飞书记录 id 的形状。mark-synced / write 都只认这个 ——
/// 一个随手写错的 id 存进队列，以后的「更新」就会改到别人的记录上。
pub fn valid_record_id(id: &str) -> bool {
    id.len() > 3 && id.starts_with("rec") && id.chars().all(|c| c.is_ascii_alphanumeric())
}

/// 去掉「空」的字段值：null、空字符串、空数组、空对象。
///
/// 更新时传一个空值等于把飞书上那一格清空 —— 而那一格可能是别人手工补的。
/// 规则是「对不上的字段忽略」，忽略就是不传，所以空值一律不往飞书送。
/// 返回（清理后的字段, 被拿掉的字段名）。
pub fn strip_empty(fields: &Map<String, Value>) -> (Map<String, Value>, Vec<String>) {
    let mut kept = Map::new();
    let mut dropped = Vec::new();
    for (k, v) in fields {
        let empty = match v {
            Value::Null => true,
            Value::String(s) => s.trim().is_empty(),
            Value::Array(a) => a.is_empty(),
            Value::Object(o) => o.is_empty(),
            _ => false,
        };
        if empty {
            dropped.push(k.clone());
        } else {
            kept.insert(k.clone(), v.clone());
        }
    }
    (kept, dropped)
}

/// 在 lark-cli 的输出里找 record_id。外壳不固定，按 key 深度找
pub fn find_record_id(v: &Value) -> Option<String> {
    match v {
        Value::Object(m) => {
            if let Some(id) = m.get("record_id").and_then(Value::as_str) {
                if valid_record_id(id) {
                    return Some(id.to_string());
                }
            }
            m.values().find_map(find_record_id)
        }
        Value::Array(a) => a.iter().find_map(find_record_id),
        _ => None,
    }
}

/// 这条队列项在这张表上已有的记录 id。没有 = 要新建
pub fn existing_record(entry: &Value, target: &str) -> Option<String> {
    entry
        .get("syncs")
        .and_then(|s| s.get(target))
        .and_then(|s| s.get("recordId"))
        .and_then(Value::as_str)
        .filter(|id| valid_record_id(id))
        .map(str::to_string)
}

/// 写入锁：同一时刻只允许一个 `gantt feishu write`。
///
/// 后台同步和用户自己开的 Claude Code 可能同时在跑；两边都看到「这条还没
/// 同步」，就会各建一条记录。锁文件用 create_new 原子创建，进程异常退出
/// 留下的旧锁超过 STALE 秒视为失效。
pub struct WriteLock(PathBuf);

const LOCK_STALE_SECS: u64 = 120;

impl WriteLock {
    pub fn acquire(app_data: &Path) -> Result<WriteLock, String> {
        let dir = data_dir(app_data);
        std::fs::create_dir_all(&dir).map_err(|e| format!("建不了 {}：{e}", dir.display()))?;
        let path = dir.join(".write.lock");
        for _ in 0..50 {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => return Ok(WriteLock(path)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = std::fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age.as_secs() > LOCK_STALE_SECS);
                    if stale {
                        let _ = std::fs::remove_file(&path);
                        continue;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
                Err(e) => return Err(format!("建不了写入锁：{e}")),
            }
        }
        Err("另一个同步正在写飞书（等了 10 秒还没结束），稍后再试".into())
    }
}

impl Drop for WriteLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue() -> Value {
        json!({
            "version": 1,
            "entries": [{
                "key": "note:1",
                "projectId": 1,
                "item": { "title": "夹具尺寸不对", "closed": false, "priority": 1 },
                "syncs": {}
            }]
        })
    }

    #[test]
    fn status_walks_through_its_states() {
        let mut q = queue();
        let t = "bas:tbl";
        assert_eq!(status_of(entries(&q)[0], t), "pending");

        mark_synced(&mut q, "note:1", t, "recA1", "now").unwrap();
        assert_eq!(status_of(entries(&q)[0], t), "synced");

        q["entries"][0]["item"]["closed"] = json!(true);
        assert_eq!(status_of(entries(&q)[0], t), "changed");

        mark_failed(&mut q, "note:1", t, "boom", "now").unwrap();
        assert_eq!(status_of(entries(&q)[0], t), "failed");
        // 失败不丢 recordId：重试还是更新同一条
        assert_eq!(q["entries"][0]["syncs"][t]["recordId"], json!("recA1"));

        mark_synced(&mut q, "note:1", t, "recA1", "now").unwrap();
        assert_eq!(status_of(entries(&q)[0], t), "synced");
        // 另一张表是独立的
        assert_eq!(status_of(entries(&q)[0], "bas:other"), "pending");
    }

    #[test]
    fn fields_outside_the_list_do_not_count_as_changes() {
        let mut q = queue();
        mark_synced(&mut q, "note:1", "b:t", "recA1", "now").unwrap();
        q["entries"][0]["item"]["key"] = json!("risk:9");
        assert_eq!(status_of(entries(&q)[0], "b:t"), "synced");
    }

    #[test]
    fn empty_values_never_reach_feishu() {
        let fields: Map<String, Value> = serde_json::from_value(json!({
            "描述": "夹具尺寸不对", "Close Date": null, "Solution": "  ", "责任人": [], "x": {}, "Lasting": 0, "flag": false
        })).unwrap();
        let (kept, mut dropped) = strip_empty(&fields);
        dropped.sort();
        assert_eq!(dropped, vec!["Close Date", "Solution", "x", "责任人"]);
        // 0 和 false 是真实的值，不算空
        assert_eq!(kept.len(), 3);
    }

    #[test]
    fn record_ids_are_checked() {
        assert!(valid_record_id("recuAbC123"));
        assert!(!valid_record_id("rec"));
        assert!(!valid_record_id("tbl123"));
        assert!(!valid_record_id("rec 1;rm"));
        let out = json!({ "ok": true, "data": { "record": { "record_id": "recNew1", "fields": {} }, "created": true } });
        assert_eq!(find_record_id(&out).as_deref(), Some("recNew1"));
        assert_eq!(find_record_id(&json!({ "record_id": "bogus" })), None);
    }

    #[test]
    fn existing_record_is_per_target() {
        let mut q = queue();
        mark_synced(&mut q, "note:1", "b:t", "recA1", "now").unwrap();
        let e = entries(&q)[0];
        assert_eq!(existing_record(e, "b:t").as_deref(), Some("recA1"));
        assert_eq!(existing_record(e, "b:other"), None);
    }

    #[test]
    fn write_lock_is_exclusive() {
        let dir = std::env::temp_dir().join(format!("gantt-feishu-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let a = WriteLock::acquire(&dir).unwrap();
        assert!(data_dir(&dir).join(".write.lock").exists());
        drop(a);
        assert!(!data_dir(&dir).join(".write.lock").exists());
        let _b = WriteLock::acquire(&dir).unwrap();
    }

    #[test]
    fn unknown_key_and_bad_target_are_explained() {
        let mut q = queue();
        assert!(mark_synced(&mut q, "note:404", "b:t", "recA1", "now").unwrap_err().contains("没有"));
        assert!(parse_target("nocolon").is_err());
        assert_eq!(parse_target("bas:tbl").unwrap(), ("bas".into(), "tbl".into()));
    }
}
