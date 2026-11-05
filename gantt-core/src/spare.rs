//! 备件台账的读写，给 `gantt spare` 用（插件 `plugins/spare-parts` 的另一半）。
//!
//! 台账是插件目录下的一份 JSON：`plugins/spare-parts/data/accounts/<uuid>/inventory-<项目 id>.json`。
//! 插件在应用里维护它（内存 → 每次改动整份写回），CLI 只在应用**没开**的时候改 ——
//! 应用开着时插件的下一次写回会把 CLI 的插入覆盖掉，静默丢数据。判据和 `gantt feishu write`
//! 同一条铁律（见 bin/gantt.rs 文件头）。
//!
//! 两边对同一份数据各写一半，所以这里的规则和插件 `main.js` 的领域层**必须一致**：
//! 序号单调、SKU 不重复、库存 = 最后一条日志的 after、库存不为负。改规则要两边一起改，
//! 单测在 `spare::tests` 和插件仓库的 `main.test.ts` 各有一份。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

pub const PLUGIN_ID: &str = "spare-parts";

type Result<T> = std::result::Result<T, String>;

/* ------------------------------------------------------------------ */
/* 数据形状（只声明 CLI 要读写的字段，其余原样保留）                     */
/* ------------------------------------------------------------------ */

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Ledger {
    pub version: u32,
    pub rev: i64,
    pub meta: Value,
    pub parts: Vec<Part>,
    pub logs: Vec<Log>,
    pub entities: Vec<Value>,
    pub imports: Vec<Value>,
    /// 插件以后加的字段，CLI 读进来再原样写回去
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl Default for Ledger {
    fn default() -> Self {
        Self {
            version: 1,
            rev: 0,
            meta: Value::Object(Default::default()),
            parts: vec![],
            logs: vec![],
            entities: vec![],
            imports: vec![],
            extra: Default::default(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Part {
    pub id: String,
    pub seq: i64,
    pub name: String,
    pub sku: String,
    pub spec: String,
    pub category: String,
    pub location: String,
    pub unit: String,
    pub qty: i64,
    pub min_qty: Option<i64>,
    pub note: String,
    pub fields: Vec<Value>,
    pub archived: bool,
    pub created_at: String,
    pub created_by: String,
    pub updated_at: String,
    pub updated_by: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Log {
    pub id: String,
    #[serde(rename = "partId")]
    pub part_id: String,
    pub seq: i64,
    #[serde(rename = "type")]
    pub kind: String,
    pub qty: i64,
    pub before: i64,
    pub after: i64,
    #[serde(rename = "entityId")]
    pub entity_id: Option<String>,
    #[serde(rename = "entityName")]
    pub entity_name: String,
    #[serde(rename = "personId")]
    pub person_id: Option<i64>,
    pub by: String,
    pub note: String,
    pub at: String,
    #[serde(rename = "importId")]
    pub import_id: Option<String>,
    pub raw: Option<Value>,
    pub confidence: Option<f64>,
    #[serde(rename = "checkId")]
    pub check_id: Option<String>,
    #[serde(rename = "revertedBy")]
    pub reverted_by: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/* ------------------------------------------------------------------ */
/* 路径                                                                */
/* ------------------------------------------------------------------ */

pub fn ledger_path(app_data: &Path, account_uuid: &str, project_id: i64) -> PathBuf {
    crate::locate::plugin_data_dir(app_data, PLUGIN_ID, account_uuid)
        .join(format!("inventory-{project_id}.json"))
}

/// 读；不存在当成空台账（项目第一次用备件是正常状态）
pub fn load(path: &Path) -> Result<Ledger> {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("{} 不是合法的台账 JSON：{e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Ledger::default()),
        Err(e) => Err(format!("读不了 {}：{e}", path.display())),
    }
}

/// 原子写回（临时文件 + rename）。插件可能正开着这个文件读它。
pub fn save(path: &Path, ledger: &Ledger) -> Result<()> {
    let dir = path.parent().ok_or("路径不对")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("建不了 {}：{e}", dir.display()))?;
    let tmp = dir.join(".inventory.tmp");
    let text = serde_json::to_string_pretty(ledger).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("写不了 {}：{e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("写不了 {}：{e}", path.display()))
}

/* ------------------------------------------------------------------ */
/* Agent 交进来的东西                                                   */
/* ------------------------------------------------------------------ */

/// 一条待入库的备件。字段名和插件「从发货单导入」的结构化输出一致。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Item {
    pub name: String,
    pub sku: String,
    pub spec: String,
    pub category: String,
    pub location: String,
    pub unit: String,
    pub qty: i64,
    pub fields: Vec<Field>,
    pub confidence: Option<f64>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Field {
    pub key: String,
    pub label: String,
    pub value: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Batch {
    /// 单号或来源说明
    pub source: String,
    pub items: Vec<Item>,
}

impl Batch {
    /// 整个推送文件允许是 `{ "items": [...] }`，也允许直接是数组
    pub fn parse(raw: &str) -> Result<Batch> {
        let value: Value = serde_json::from_str(raw).map_err(|e| format!("推送文件不是合法 JSON：{e}"))?;
        if value.is_array() {
            let items: Vec<Item> = serde_json::from_value(value).map_err(|e| format!("推送文件里的条目读不出来：{e}"))?;
            return Ok(Batch { source: String::new(), items });
        }
        serde_json::from_value(value)
            .map_err(|e| format!("推送文件要形如 {{\"source\": \"单号\", \"items\": [...]}}：{e}"))
    }
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PushSummary {
    pub import_id: String,
    pub created: Vec<i64>,
    pub received: Vec<(i64, i64)>,
    pub skipped: Vec<String>,
    pub total: usize,
}

/* ------------------------------------------------------------------ */
/* 写入                                                                */
/* ------------------------------------------------------------------ */

/// 一个稳定的 uuid 派生物：CLI 没有随机数依赖，用时间 + 序号拼就够用（同一次推送内唯一）
fn uid(prefix: &str, seed: i64) -> String {
    format!("{prefix}_{seed:x}")
}

/// 把一批条目写进台账：SKU 命中就入库，没命中就新建。空名称的跳过（返回在 skipped 里）。
///
/// `by` 是操作人名字（CLI 里取当前账号名），`at` 是 ISO 时间。
pub fn apply_batch(
    ledger: &mut Ledger,
    batch: &Batch,
    by: &str,
    at: &str,
    seed_base: i64,
) -> Result<PushSummary> {
    let import_id = uid("imp", seed_base);
    let mut summary = PushSummary { import_id: import_id.clone(), total: batch.items.len(), ..Default::default() };
    let mut used_seqs: BTreeSet<i64> = ledger.parts.iter().map(|p| p.seq).collect();
    let mut next_seq = used_seqs.iter().copied().max().unwrap_or(0) + 1;

    for (i, item) in batch.items.iter().enumerate() {
        let name = item.name.trim();
        if name.is_empty() {
            summary.skipped.push(format!("第 {} 条没有名称", i + 1));
            continue;
        }
        if item.qty < 0 {
            return Err(format!("「{name}」的数量是负数"));
        }
        let seed = seed_base + i as i64 + 1;

        // SKU 命中（不分大小写）→ 入库
        let existing = if item.sku.trim().is_empty() {
            None
        } else {
            let sku = item.sku.trim().to_lowercase();
            ledger
                .parts
                .iter_mut()
                .find(|p| !p.archived && !p.sku.is_empty() && p.sku.to_lowercase() == sku)
        };
        if let Some(part) = existing {
            let id = part.id.clone();
            let seq = part.seq;
            let before = part.qty;
            let after = before + item.qty;
            part.qty = after;
            part.updated_at = at.to_string();
            part.updated_by = by.to_string();
            ledger.logs.push(Log {
                id: uid("l", seed),
                part_id: id,
                seq,
                kind: "import".into(),
                qty: item.qty,
                before,
                after,
                by: by.to_string(),
                note: format!("导入：{}", batch.source),
                at: at.to_string(),
                import_id: Some(import_id.clone()),
                raw: serde_json::to_value(item).ok(),
                confidence: item.confidence,
                ..Default::default()
            });
            summary.received.push((seq, item.qty));
            continue;
        }

        let seq = next_seq;
        next_seq += 1;
        used_seqs.insert(seq);
        let id = uid("p", seed);
        ledger.parts.push(Part {
            id: id.clone(),
            seq,
            name: name.to_string(),
            sku: item.sku.trim().to_string(),
            spec: item.spec.trim().to_string(),
            category: item.category.trim().to_string(),
            location: item.location.trim().to_string(),
            unit: if item.unit.trim().is_empty() { "个".into() } else { item.unit.trim().to_string() },
            qty: item.qty,
            note: String::new(),
            fields: item
                .fields
                .iter()
                .filter(|f| !f.label.trim().is_empty())
                .map(|f| serde_json::to_value(f).unwrap_or(Value::Null))
                .collect(),
            created_at: at.to_string(),
            created_by: by.to_string(),
            updated_at: at.to_string(),
            updated_by: by.to_string(),
            ..Default::default()
        });
        if item.qty > 0 {
            ledger.logs.push(Log {
                id: uid("l", seed),
                part_id: id,
                seq,
                kind: "import".into(),
                qty: item.qty,
                before: 0,
                after: item.qty,
                by: by.to_string(),
                note: format!("导入：{}", batch.source),
                at: at.to_string(),
                import_id: Some(import_id.clone()),
                raw: serde_json::to_value(item).ok(),
                confidence: item.confidence,
                ..Default::default()
            });
        }
        summary.created.push(seq);
    }

    ledger.imports.push(serde_json::json!({
        "id": import_id,
        "at": at,
        "by": by,
        "source": if batch.source.is_empty() { "Agent 推送" } else { batch.source.as_str() },
        "count": summary.created.len() + summary.received.len(),
    }));
    ledger.rev += 1;

    let problems = check(&ledger);
    if !problems.is_empty() {
        return Err(format!("写进去之后对不上，已放弃本次推送：{}", problems.join("；")));
    }
    Ok(summary)
}

/// 和插件侧 `checkInvariants` 同一套规则
pub fn check(ledger: &Ledger) -> Vec<String> {
    let mut problems = Vec::new();
    let mut last_after = std::collections::HashMap::new();
    let mut logs: Vec<&Log> = ledger.logs.iter().collect();
    logs.sort_by(|a, b| a.at.cmp(&b.at));
    for l in logs {
        if l.after != l.before + l.qty {
            problems.push(format!("日志 {}：{} + {} ≠ {}", l.id, l.before, l.qty, l.after));
        }
        last_after.insert(l.part_id.clone(), l.after);
    }
    for p in &ledger.parts {
        if p.qty < 0 {
            problems.push(format!("「{}」库存是负数", p.name));
        }
        if let Some(last) = last_after.get(&p.id) {
            if *last != p.qty {
                problems.push(format!("「{}」库存 {}，最后一条日志是 {}", p.name, p.qty, last));
            }
        }
    }
    problems
}

/* ------------------------------------------------------------------ */
/* 收件箱：应用开着时 Agent 交进来的批次                                   */
/* ------------------------------------------------------------------ */

/// 应用开着时，台账在插件内存里，CLI 不能直接写文件（会被下一次写回覆盖）。
/// 这时 `gantt spare push` 把批次放进收件箱，插件轮询到后自己入库 —— 所有写入都由
/// 持有台账的那一方完成。格式：`{ "batches": [{ id, at, by, source, items }] }`。
pub fn inbox_path(app_data: &Path, account_uuid: &str, project_id: i64) -> PathBuf {
    crate::locate::plugin_data_dir(app_data, PLUGIN_ID, account_uuid)
        .join(format!("inbox-{project_id}.json"))
}

/// 追加一批，返回批次 id。原子写；已有的批次原样保留
pub fn push_inbox(path: &Path, batch: &Batch, by: &str, at: &str, seed: i64) -> Result<String> {
    let mut inbox: Value = match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| serde_json::json!({ "batches": [] })),
        Err(_) => serde_json::json!({ "batches": [] }),
    };
    if !inbox["batches"].is_array() {
        inbox["batches"] = Value::Array(vec![]);
    }
    let id = uid("imp", seed);
    inbox["batches"].as_array_mut().unwrap().push(serde_json::json!({
        "id": id,
        "at": at,
        "by": by,
        "source": batch.source,
        "items": batch.items,
    }));
    let dir = path.parent().ok_or("路径不对")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("建不了 {}：{e}", dir.display()))?;
    let tmp = dir.join(".inbox.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&inbox).map_err(|e| e.to_string())?)
        .map_err(|e| format!("写不了 {}：{e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("写不了 {}：{e}", path.display()))?;
    Ok(id)
}

/* ------------------------------------------------------------------ */
/* 撤销                                                                */
/* ------------------------------------------------------------------ */

/// 撤销一整批导入：给每条还在的日志写一条反向调整，原日志只标 `revertedBy`。
/// 返回冲销了几条。和插件里 `revertImport` 同一语义。
pub fn revert_batch(ledger: &mut Ledger, import_id: &str, by: &str, at: &str) -> Result<usize> {
    let applied: Vec<(String, String, i64)> = ledger
        .logs
        .iter()
        .filter(|l| l.import_id.as_deref() == Some(import_id) && l.reverted_by.is_none())
        .map(|l| (l.id.clone(), l.part_id.clone(), l.qty))
        .collect();
    if applied.is_empty() {
        return Err(format!("批次「{import_id}」没有可撤销的记录"));
    }

    let mut n = 0;
    for (i, (log_id, part_id, qty)) in applied.iter().enumerate() {
        let Some(part) = ledger.parts.iter_mut().find(|p| &p.id == part_id) else { continue };
        let before = part.qty;
        let after = before - qty;
        if after < 0 {
            return Err(format!("「{}」撤销后库存会变成负数（{} − {}），先处理这一条", part.name, before, qty));
        }
        part.qty = after;
        part.updated_at = at.to_string();
        part.updated_by = by.to_string();
        let seq = part.seq;
        let back_id = uid("l", 9_000_000 + i as i64);
        ledger.logs.push(Log {
            id: back_id.clone(),
            part_id: part_id.clone(),
            seq,
            kind: "adjust".into(),
            qty: -qty,
            before,
            after,
            by: by.to_string(),
            note: format!("撤销导入（{seq}）"),
            at: at.to_string(),
            ..Default::default()
        });
        if let Some(log) = ledger.logs.iter_mut().find(|l| &l.id == log_id) {
            log.reverted_by = Some(back_id);
        }
        n += 1;
    }

    if let Some(imp) = ledger
        .imports
        .iter_mut()
        .find(|i| i.get("id").and_then(Value::as_str) == Some(import_id))
    {
        imp["revertedAt"] = Value::String(at.to_string());
    }
    ledger.rev += 1;
    Ok(n)
}

/* ------------------------------------------------------------------ */
/* 写入锁                                                              */
/* ------------------------------------------------------------------ */

/// 和插件争同一个文件时的互斥：台账旁边一个 `.write.lock`，2 分钟后视为过期。
/// 应用开着时根本走不到这里（`spare_scope` 先挡了），这是给 `--force` 和两个 CLI 进程用的。
pub struct WriteLock(PathBuf);

const LOCK_STALE_SECS: u64 = 120;

impl WriteLock {
    pub fn acquire(ledger: &Path) -> Result<WriteLock> {
        let dir = ledger.parent().ok_or("路径不对")?;
        std::fs::create_dir_all(dir).map_err(|e| format!("建不了 {}：{e}", dir.display()))?;
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
        Err("另一个进程正在写这份备件台账，等一会儿再试".into())
    }
}

impl Drop for WriteLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/* ------------------------------------------------------------------ */
/* 读取                                                                */
/* ------------------------------------------------------------------ */

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub seq: i64,
    pub name: String,
    pub sku: String,
    pub spec: String,
    pub category: String,
    pub location: String,
    pub unit: String,
    pub qty: i64,
    pub min_qty: Option<i64>,
    pub archived: bool,
}

/// 关键字过滤（名称 / SKU / 规格 / 分类 / 位置），和插件里搜索框同一套匹配
pub fn search<'a>(ledger: &'a Ledger, q: &str, include_archived: bool) -> Vec<Row> {
    let q = q.trim().to_lowercase();
    let hit = |s: &str| q.is_empty() || s.to_lowercase().contains(&q);
    let mut rows: Vec<Row> = ledger
        .parts
        .iter()
        .filter(|p| include_archived || !p.archived)
        .filter(|p| hit(&p.name) || hit(&p.sku) || hit(&p.spec) || hit(&p.category) || hit(&p.location))
        .map(|p| Row {
            seq: p.seq,
            name: p.name.clone(),
            sku: p.sku.clone(),
            spec: p.spec.clone(),
            category: p.category.clone(),
            location: p.location.clone(),
            unit: p.unit.clone(),
            qty: p.qty,
            min_qty: p.min_qty,
            archived: p.archived,
        })
        .collect();
    rows.sort_by(|a, b| a.seq.cmp(&b.seq));
    rows
}

/// 当前账号的 uuid：台账按账号分目录，和插件 `api.storage` 落在同一个地方
pub fn account_uuid(conn: &Connection, me: i64) -> Result<String> {
    crate::account::get_account(conn, me)
        .map(|a| a.uuid)
        .map_err(|e| format!("拿不到当前账号：{e}"))
}

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    fn item(name: &str, sku: &str, qty: i64) -> Item {
        Item { name: name.into(), sku: sku.into(), qty, ..Default::default() }
    }

    #[test]
    fn new_skus_are_created_with_monotonic_seq_and_a_log_each() {
        let mut l = Ledger::default();
        let b = Batch { source: "S-1".into(), items: vec![item("电机", "SM1", 20), item("线缆", "C1", 3)] };
        let s = apply_batch(&mut l, &b, "张三", "2026-11-04T10:00:00Z", 100).unwrap();
        assert_eq!(s.created, vec![1, 2]);
        assert_eq!(l.parts[0].qty, 20);
        assert_eq!(l.parts[0].created_by, "张三");
        assert_eq!(l.logs.len(), 2);
        assert_eq!(l.logs[0].kind, "import");
        assert_eq!(l.logs[0].import_id.as_deref(), Some(s.import_id.as_str()));
        assert!(check(&l).is_empty());
    }

    #[test]
    fn known_sku_is_received_not_duplicated() {
        let mut l = Ledger::default();
        apply_batch(&mut l, &Batch { source: "".into(), items: vec![item("电机", "SM-1", 2)] }, "张三", "t1", 1).unwrap();
        let s = apply_batch(&mut l, &Batch { source: "".into(), items: vec![item("电机（补）", "sm-1", 5)] }, "李四", "t2", 2).unwrap();
        assert_eq!(s.created, Vec::<i64>::new());
        assert_eq!(s.received, vec![(1, 5)]);
        assert_eq!(l.parts.len(), 1);
        assert_eq!(l.parts[0].qty, 7);
        assert_eq!(l.logs.last().unwrap().before, 2);
        assert_eq!(l.logs.last().unwrap().after, 7);
        assert_eq!(l.parts[0].updated_by, "李四");
    }

    #[test]
    fn seq_never_reuses_archived_numbers() {
        let mut l = Ledger::default();
        apply_batch(&mut l, &Batch { source: "".into(), items: vec![item("A", "a", 1), item("B", "b", 1)] }, "x", "t1", 1).unwrap();
        l.parts[1].archived = true;
        let s = apply_batch(&mut l, &Batch { source: "".into(), items: vec![item("C", "c", 1)] }, "x", "t2", 2).unwrap();
        assert_eq!(s.created, vec![3]);
    }

    #[test]
    fn nameless_items_are_skipped_and_negative_qty_is_rejected() {
        let mut l = Ledger::default();
        let s = apply_batch(&mut l, &Batch { source: "".into(), items: vec![item("  ", "x", 1)] }, "x", "t", 1).unwrap();
        assert_eq!(s.skipped.len(), 1);
        let err = apply_batch(&mut l, &Batch { source: "".into(), items: vec![item("A", "a", -1)] }, "x", "t", 2).unwrap_err();
        assert!(err.contains("负数"), "{err}");
    }

    #[test]
    fn batch_accepts_a_bare_array_too() {
        let b = Batch::parse(r#"[{"name":"A","qty":2}]"#).unwrap();
        assert_eq!(b.items.len(), 1);
        let b = Batch::parse(r#"{"source":"S9","items":[{"name":"A","qty":2}]}"#).unwrap();
        assert_eq!(b.source, "S9");
    }

    #[test]
    fn search_hits_name_sku_and_skips_archived_by_default() {
        let mut l = Ledger::default();
        apply_batch(&mut l, &Batch { source: "".into(), items: vec![item("伺服电机", "SM-400W", 1), item("急停按钮", "ES-22", 1)] }, "x", "t", 1).unwrap();
        l.parts[1].archived = true;
        assert_eq!(search(&l, "sm-400", false).len(), 1);
        assert_eq!(search(&l, "按钮", false).len(), 0);
        assert_eq!(search(&l, "按钮", true).len(), 1);
        assert_eq!(search(&l, "", true).len(), 2);
    }

    #[test]
    fn unknown_fields_round_trip_untouched() {
        let raw = r#"{"version":1,"rev":3,"meta":{"checks":[{"id":"c1"}]},"parts":[],"logs":[],
                      "entities":[{"id":"e1","name":"Robot1"}],"imports":[],"futureField":{"a":1}}"#;
        let mut l: Ledger = serde_json::from_str(raw).unwrap();
        l.rev += 1;
        let text = serde_json::to_string(&l).unwrap();
        assert!(text.contains("futureField"));
        assert!(text.contains("Robot1"));
        assert!(text.contains("c1"));
    }

    #[test]
    fn part_fields_are_camel_case_like_the_plugin_writes_them() {
        let mut l = Ledger::default();
        apply_batch(&mut l, &Batch { source: "".into(), items: vec![item("A", "a", 1)] }, "张三", "t", 1).unwrap();
        let text = serde_json::to_string(&l).unwrap();
        for k in ["\"createdBy\"", "\"minQty\"", "\"updatedAt\"", "\"partId\"", "\"importId\""] {
            assert!(text.contains(k), "缺 {k}：{text}");
        }
        assert!(!text.contains("created_by"));
    }

    #[test]
    fn inbox_appends_batches_and_keeps_existing_ones() {
        let dir = std::env::temp_dir().join(format!("spare-inbox-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("inbox-1.json");
        let b = Batch { source: "S1".into(), items: vec![item("A", "a", 2)] };
        let id1 = push_inbox(&path, &b, "张三", "t1", 1).unwrap();
        let id2 = push_inbox(&path, &b, "李四", "t2", 2).unwrap();
        let inbox: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let batches = inbox["batches"].as_array().unwrap();
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0]["id"], id1);
        assert_eq!(batches[1]["id"], id2);
        assert_eq!(batches[1]["by"], "李四");
        assert_eq!(batches[0]["items"][0]["name"], "A");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
