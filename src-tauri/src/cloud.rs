//! 云数据备份：把本账号**拥有**的项目，以 `.ganttproj` 快照同步到用户自己的 Supabase。
//!
//! 粒度是整个项目，不是一行行的任务。前端本来就是「整项目全量写回」（db/persistence.ts），
//! 没有任何字段级的合并逻辑；同步也按同一粒度做，冲突时**以云端为准**，
//! 被盖掉的本机版先存一份到 `backups/`，后悔了能导回来。
//!
//! 每一轮：
//! 1. 列出云端所有项目的 (uuid, hash, version, deleted)，不下载内容
//! 2. 和本机快照、上次同步记下的状态（`cloud.state`）逐个比 —— 规则全在纯函数 [`plan`] 里
//! 3. 云端变了就拉（覆盖本机），否则本机变了就推；都没变什么都不传
//!
//! 「变了没有」本机看内容指纹（[`content_hash`]），云端看 version（每次写入 +1）。
//! 上传按 `version=eq.<上次看到的>` 条件更新：两台电脑同时推，后到的那台改不到任何行，
//! 下一轮自然先拉取 —— 不会互相覆盖。
//!
//! 删除用标记（`deleted = true`）传播，不真删行：否则别的电脑只会看到「我这里多了一个项目」，
//! 然后把它传回去。

use crate::db::Db;
use crate::export::{decode_base64, encode_base64};
use crate::transfer::{self, BackupDir, Bundle, FilePerson, EXT, FORMAT_MAJOR, FORMAT_MINOR};
use gantt_core::{account, query};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

type Result<T> = std::result::Result<T, String>;

/// 随应用发的建表 SQL。用户在 Supabase 的 SQL Editor 里执行它
pub const SQL: &str = include_str!("../../supabase/supergantt-cloud.sql");

const CONFIG_KEY: &str = "cloud.config";
const STATE_KEY: &str = "cloud.state";
const TABLE: &str = "supergantt_projects";

/// 自动同步和「立即同步」可能撞在一起；同一时刻只跑一轮
static SYNCING: AtomicBool = AtomicBool::new(false);

struct SyncingGuard;
impl Drop for SyncingGuard {
    fn drop(&mut self) {
        SYNCING.store(false, Ordering::SeqCst);
    }
}

/* ------------------------------------------------------------------ */
/* 配置与状态（都存在账号设置里，按账号分开）                             */
/* ------------------------------------------------------------------ */

/// 前端写进 `cloud.config` 的那份 JSON
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CloudConfig {
    pub enabled: bool,
    /// Supabase 的 Project URL，如 https://xxxx.supabase.co
    pub url: String,
    /// anon key 或新版的 publishable key
    pub anon_key: String,
    /// 执行 SQL 后显示的那串同步密钥
    pub sync_key: String,
    /// 自动同步间隔（分钟）；前端管，这里只是一并存着
    pub interval_min: u32,
}

impl CloudConfig {
    fn require_complete(&self) -> Result<()> {
        if self.url.trim().is_empty() || self.anon_key.trim().is_empty() || self.sync_key.trim().is_empty() {
            return Err("云备份还没配置完：Project URL、anon key、同步密钥三项都要填".into());
        }
        if !self.url.trim().starts_with("https://") && !self.url.trim().starts_with("http://") {
            return Err("Project URL 要以 https:// 开头，在 Supabase 的 Project Settings → API 里复制".into());
        }
        Ok(())
    }

    fn rest_base(&self) -> String {
        format!("{}/rest/v1", self.url.trim().trim_end_matches('/'))
    }
}

/// 一个项目上次同步完时两边的样子
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Linked {
    /// 那一刻本机内容的指纹
    pub local_hash: String,
    /// 那一刻云端的 version
    pub remote_version: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncState {
    /// 这份状态是对着哪个 Supabase 记的。换了地址就作废，否则会拿 A 库的版本号去比 B 库
    pub target: String,
    /// uuid → 上次同步状态
    pub projects: HashMap<String, Linked>,
}

fn load_config(conn: &Connection, me: i64) -> Result<CloudConfig> {
    Ok(query::get_setting(conn, me, CONFIG_KEY.into())?
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default())
}

fn load_state(conn: &Connection, me: i64, target: &str) -> Result<SyncState> {
    let state: SyncState = query::get_setting(conn, me, STATE_KEY.into())?
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    Ok(if state.target == target {
        state
    } else {
        SyncState { target: target.to_string(), projects: HashMap::new() }
    })
}

fn save_state(conn: &Connection, me: i64, state: &SyncState) -> Result<()> {
    let raw = serde_json::to_string(state).map_err(|e| e.to_string())?;
    query::set_setting(conn, me, STATE_KEY.into(), raw)
}

/* ------------------------------------------------------------------ */
/* 本机快照                                                            */
/* ------------------------------------------------------------------ */

/// 内容指纹。去掉 updated_at：它只说明「什么时候写过库」，不说明「内容变没变」，
/// 留着它的话每次打开项目都会触发一次上传
pub fn content_hash(
    bundle: &Bundle,
    people: &[FilePerson],
    avatars: &HashMap<String, Vec<u8>>,
) -> Result<String> {
    let mut b = bundle.clone();
    b.project.updated_at = String::new();
    let mut h = Sha256::new();
    h.update(serde_json::to_vec(&b).map_err(|e| e.to_string())?);
    h.update(serde_json::to_vec(people).map_err(|e| e.to_string())?);
    let mut names: Vec<&String> = avatars.keys().collect();
    names.sort();
    for n in names {
        h.update(n.as_bytes());
        h.update(&avatars[n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

struct Snapshot {
    id: i64,
    name: String,
    bundle: Bundle,
    people: Vec<FilePerson>,
    avatars: HashMap<String, Vec<u8>>,
    hash: String,
}

fn snapshot(conn: &Connection, id: i64) -> Result<Snapshot> {
    let (bundle, people, avatars) = transfer::collect(conn, id).map_err(|e| e.to_string())?;
    let hash = content_hash(&bundle, &people, &avatars)?;
    Ok(Snapshot { id, name: bundle.project.name.clone(), bundle, people, avatars, hash })
}

/// （我拥有的项目 uuid → 快照，本机有但不归我的 uuid）
fn local_projects(conn: &Connection, me: i64) -> Result<(HashMap<String, Snapshot>, HashSet<String>)> {
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.uuid,
                    EXISTS (SELECT 1 FROM project_members m
                             WHERE m.project_id = p.id AND m.account_id = ?1 AND m.role = 'owner')
               FROM projects p",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(i64, String, bool)> = stmt
        .query_map(params![me], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;

    let mut owned = HashMap::new();
    let mut foreign = HashSet::new();
    for (id, uuid, mine) in rows {
        if mine {
            owned.insert(uuid, snapshot(conn, id)?);
        } else {
            foreign.insert(uuid);
        }
    }
    Ok((owned, foreign))
}

/* ------------------------------------------------------------------ */
/* 决策：纯函数                                                        */
/* ------------------------------------------------------------------ */

/// 云端一行（列表里不带 payload）
#[derive(Deserialize, Clone, Debug)]
pub struct RemoteRow {
    pub uuid: String,
    pub name: String,
    pub hash: String,
    pub version: i64,
    pub deleted: bool,
}

#[derive(Clone, Debug)]
pub struct LocalSnap {
    pub id: i64,
    pub uuid: String,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    /// 上传。base = Some(v)：按 version = v 条件更新；None：新插入
    Push { uuid: String, base: Option<i64> },
    /// 拉云端。target = Some(id) 覆盖本机那个项目，None 新建；backup = 覆盖前先存一份本机版
    Pull { uuid: String, target: Option<i64>, backup: bool },
    /// 两边内容本来就一样（第一次连上同一份数据），只记下关联
    Link { uuid: String, version: i64 },
    /// 云端标了删除：删本机（先备份）
    DeleteLocal { uuid: String, id: i64 },
    /// 本机删了：给云端打删除标记
    Tombstone { uuid: String, version: i64 },
    /// 两边都没了，丢掉状态
    Forget { uuid: String },
    /// 这一轮不动，说明原因
    Skip { uuid: String, why: String },
}

/// 这一轮每个项目该做什么。规则：
/// - 云端变了（version 和上次不同）→ 拉，**哪怕本机也改了**：以云端为准，本机版先备份
/// - 云端没变、本机变了 → 推
/// - 第一次见到、两边都有且内容不同 → 拉（同样以云端为准）
/// - 正开着的项目不在这一轮被删掉，说明原因、下一轮再说
pub fn plan(
    local: &[LocalSnap],
    foreign: &HashSet<String>,
    remote: &[RemoteRow],
    state: &SyncState,
    open: Option<i64>,
) -> Vec<Step> {
    let remote_by: HashMap<&str, &RemoteRow> = remote.iter().map(|r| (r.uuid.as_str(), r)).collect();
    let mut steps = Vec::new();

    for l in local {
        let uuid = l.uuid.clone();
        let st = state.projects.get(&l.uuid);
        let step = match (st, remote_by.get(l.uuid.as_str()).copied()) {
            (_, None) => Step::Push { uuid, base: None },
            // 别处删过、这里又有：当它是要恢复的，传回去
            (None, Some(r)) if r.deleted => Step::Push { uuid, base: Some(r.version) },
            (None, Some(r)) if r.hash == l.hash => Step::Link { uuid, version: r.version },
            (None, Some(_)) => Step::Pull { uuid, target: Some(l.id), backup: true },
            (Some(st), Some(r)) => {
                let remote_changed = r.version != st.remote_version;
                let local_changed = l.hash != st.local_hash;
                if remote_changed && r.deleted {
                    if open == Some(l.id) {
                        Step::Skip {
                            uuid,
                            why: "在别的电脑上被删了；你正开着它，先不删，回到项目列表后下一轮再处理".into(),
                        }
                    } else {
                        Step::DeleteLocal { uuid, id: l.id }
                    }
                } else if remote_changed {
                    Step::Pull { uuid, target: Some(l.id), backup: local_changed }
                } else if local_changed || r.deleted {
                    Step::Push { uuid, base: Some(r.version) }
                } else {
                    continue;
                }
            }
        };
        steps.push(step);
    }

    let local_uuids: HashSet<&str> = local.iter().map(|l| l.uuid.as_str()).collect();
    for r in remote {
        if local_uuids.contains(r.uuid.as_str()) {
            continue;
        }
        let uuid = r.uuid.clone();
        if foreign.contains(&r.uuid) {
            if !r.deleted {
                steps.push(Step::Skip {
                    uuid,
                    why: "本机有这个项目，但当前账号不是它的所有者，由所有者的账号来同步".into(),
                });
            }
            continue;
        }
        match state.projects.get(&r.uuid) {
            Some(_) if r.deleted => steps.push(Step::Forget { uuid }),
            // 上次同步过、本机没了、云端之后也没人动过 → 是本机删的
            Some(st) if r.version == st.remote_version => {
                steps.push(Step::Tombstone { uuid, version: r.version })
            }
            // 本机删了，但云端之后又被改过：以云端为准，拉回来
            Some(_) => steps.push(Step::Pull { uuid, target: None, backup: false }),
            None if r.deleted => {}
            None => steps.push(Step::Pull { uuid, target: None, backup: false }),
        }
    }
    steps
}

/* ------------------------------------------------------------------ */
/* Supabase REST（PostgREST）                                          */
/* ------------------------------------------------------------------ */

struct Rest {
    client: reqwest::Client,
    cfg: CloudConfig,
}

impl Rest {
    fn new(cfg: CloudConfig) -> Result<Self> {
        let client = reqwest::Client::builder()
            .user_agent(concat!("SuperGantt/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|e| format!("网络组件初始化失败：{e}"))?;
        Ok(Self { client, cfg })
    }

    fn req(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let key = self.cfg.anon_key.trim();
        let mut b = self
            .client
            .request(method, format!("{}/{}", self.cfg.rest_base(), path))
            .header("apikey", key)
            .header("x-supergantt-key", self.cfg.sync_key.trim());
        // 老的 anon key 是 JWT，要同时放进 Authorization；新的 publishable key 不是，只放 apikey
        if key.starts_with("eyJ") {
            b = b.bearer_auth(key);
        }
        b
    }

    async fn send(&self, b: reqwest::RequestBuilder) -> Result<String> {
        let resp = b.send().await.map_err(|e| {
            if e.is_timeout() {
                "连接 Supabase 超时，检查网络".to_string()
            } else {
                format!("连不上 Supabase（检查 Project URL 和网络）：{e}")
            }
        })?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if status.is_success() {
            Ok(body)
        } else {
            Err(explain(status.as_u16(), &body))
        }
    }

    async fn authorized(&self) -> Result<bool> {
        let body = self
            .send(json(self.req(reqwest::Method::POST, "rpc/supergantt_authorized"), &serde_json::json!({})))
            .await?;
        Ok(body.trim() == "true")
    }

    async fn list(&self) -> Result<Vec<RemoteRow>> {
        let body = self
            .send(self.req(
                reqwest::Method::GET,
                &format!("{TABLE}?select=uuid,name,hash,version,deleted"),
            ))
            .await?;
        serde_json::from_str(&body).map_err(|e| format!("云端返回的数据看不懂：{e}"))
    }

    /// (payload, version)
    async fn fetch(&self, uuid: &str) -> Result<(String, i64)> {
        #[derive(Deserialize)]
        struct Row {
            payload: String,
            version: i64,
        }
        let body = self
            .send(self.req(
                reqwest::Method::GET,
                &format!("{TABLE}?select=payload,version&uuid=eq.{}", enc(uuid)),
            ))
            .await?;
        let rows: Vec<Row> = serde_json::from_str(&body).map_err(|e| format!("云端返回的数据看不懂：{e}"))?;
        rows.into_iter()
            .next()
            .map(|r| (r.payload, r.version))
            .ok_or_else(|| "云端这一行刚刚不见了".to_string())
    }

    async fn insert(&self, row: serde_json::Value) -> Result<()> {
        self.send(
            json(self.req(reqwest::Method::POST, TABLE).header("Prefer", "return=minimal"), &row),
        )
        .await
        .map(|_| ())
    }

    /// 只在云端还是 version = base 时才改；改到了返回 true，被别人抢先了返回 false
    async fn update_if(&self, uuid: &str, base: i64, row: serde_json::Value) -> Result<bool> {
        let body = self
            .send(
                json(
                    self.req(
                        reqwest::Method::PATCH,
                        &format!("{TABLE}?uuid=eq.{}&version=eq.{base}&select=uuid", enc(uuid)),
                    )
                    .header("Prefer", "return=representation"),
                    &row,
                ),
            )
            .await?;
        let rows: Vec<serde_json::Value> = serde_json::from_str(&body).unwrap_or_default();
        Ok(!rows.is_empty())
    }
}

/// reqwest 没开 json feature（插件商店用不着），这里手动带上 body 和类型
fn json(b: reqwest::RequestBuilder, v: &serde_json::Value) -> reqwest::RequestBuilder {
    b.header("Content-Type", "application/json").body(v.to_string())
}

/// 只给 uuid 用：它是十六进制或带横线的 uuid，这里只是防止有人手改出奇怪字符
fn enc(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect()
}

/// 把 Supabase 的报错翻成「下一步该做什么」
fn explain(status: u16, body: &str) -> String {
    let lower = body.to_lowercase();
    if lower.contains("pgrst205")
        || lower.contains("pgrst202")
        || lower.contains("42p01")
        || lower.contains("could not find the")
    {
        return "Supabase 里还没有 SuperGantt 的表：先下载 SQL 文件，在 Supabase 的 SQL Editor 里执行一遍".into();
    }
    match status {
        401 | 403 => "Supabase 拒绝了请求：anon key 不对，或同步密钥不对".into(),
        404 => "找不到这个 Supabase 项目：检查 Project URL".into(),
        409 => "云端已经有这个项目了（另一台电脑刚刚传上去），下一轮会先拉取".into(),
        413 => "项目太大，Supabase 拒收（多半是头像图片太大）".into(),
        _ => {
            let short: String = body.chars().take(200).collect();
            format!("Supabase 返回 {status}：{short}")
        }
    }
}

fn host_label() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".into())
}

/* ------------------------------------------------------------------ */
/* 命令                                                                */
/* ------------------------------------------------------------------ */

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PulledProject {
    pub id: i64,
    pub name: String,
    /// true = 本机原来没有，新建的
    pub created: bool,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    /// 传上去的项目名
    pub pushed: Vec<String>,
    /// 拉下来（覆盖或新建）的项目
    pub pulled: Vec<PulledProject>,
    /// 因云端删除而删掉的本机项目 id
    pub deleted_local: Vec<i64>,
    /// 给云端打了删除标记的项目名
    pub deleted_remote: Vec<String>,
    /// 覆盖 / 删除前存下的本机版
    pub backups: Vec<String>,
    /// 不是错误，但该让用户知道的
    pub notes: Vec<String>,
    pub errors: Vec<String>,
    /// Unix 秒
    pub at: i64,
}

/// 随应用带的 SQL 原文：设置页「复制 SQL」用
#[tauri::command]
pub fn cloud_sql() -> String {
    SQL.to_string()
}

/// 把 SQL 存成文件：设置页「下载 SQL 文件」
#[tauri::command]
pub fn cloud_save_sql(path: String) -> Result<String> {
    std::fs::write(&path, SQL).map_err(|e| format!("写入失败：{e}"))?;
    Ok(path)
}

/// 测连接：地址、key、表、同步密钥逐项验，返回一句人话
#[tauri::command]
pub async fn cloud_check(config: CloudConfig) -> Result<String> {
    config.require_complete()?;
    let rest = Rest::new(config)?;
    // 先探表：没执行 SQL 时这里报的错最好懂
    let rows = rest.list().await?;
    if !rest.authorized().await? {
        return Err("同步密钥不对：复制 SQL 执行结果里的那一串（或在 Supabase 里查 supergantt_keys 表）".into());
    }
    let live = rows.iter().filter(|r| !r.deleted).count();
    Ok(if live == 0 {
        "连接正常，云端还没有项目".into()
    } else {
        format!("连接正常，云端有 {live} 个项目")
    })
}

/// 跑一轮同步。`open_project_id` 是前端正开着的项目（前端已先把它落库）；
/// `stamp` 是备份文件名里的时间，由前端给 —— Rust 的 std 拿不到时区
#[tauri::command]
pub async fn cloud_sync(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    open_project_id: Option<i64>,
    stamp: String,
) -> Result<SyncReport> {
    if SYNCING.swap(true, Ordering::SeqCst) {
        return Err("上一轮同步还没结束".into());
    }
    let _guard = SyncingGuard;

    let me = db.me()?;
    let app_version = app.package_info().version.to_string();

    // 锁只在这几个块里拿：跨 await 拿着 std 的 Mutex，界面上所有读写库的操作都得等网络
    let (cfg, mut state, mut snaps, foreign) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let cfg = load_config(&conn, me)?;
        cfg.require_complete()?;
        if !cfg.enabled {
            return Err("云备份没有开启".into());
        }
        let state = load_state(&conn, me, cfg.url.trim())?;
        let (snaps, foreign) = local_projects(&conn, me)?;
        (cfg, state, snaps, foreign)
    };

    let rest = Rest::new(cfg)?;
    let remote = rest.list().await?;
    let remote_names: HashMap<String, String> =
        remote.iter().map(|r| (r.uuid.clone(), r.name.clone())).collect();

    let local: Vec<LocalSnap> = snaps
        .iter()
        .map(|(uuid, s)| LocalSnap { id: s.id, uuid: uuid.clone(), hash: s.hash.clone() })
        .collect();
    let steps = plan(&local, &foreign, &remote, &state, open_project_id);

    let mut report = SyncReport { at: transfer::now_secs(), ..Default::default() };
    let backups_dir = app.path_resolver_backups();
    let format_version = format!("{FORMAT_MAJOR}.{FORMAT_MINOR}");

    for step in steps {
        let uuid = match &step {
            Step::Push { uuid, .. }
            | Step::Pull { uuid, .. }
            | Step::Link { uuid, .. }
            | Step::DeleteLocal { uuid, .. }
            | Step::Tombstone { uuid, .. }
            | Step::Forget { uuid }
            | Step::Skip { uuid, .. } => uuid.clone(),
        };
        let name = snaps
            .get(&uuid)
            .map(|s| s.name.clone())
            .or_else(|| remote_names.get(&uuid).cloned())
            .unwrap_or_else(|| uuid.clone());

        let result: Result<()> = async {
            match step {
                Step::Link { version, .. } => {
                    let s = &snaps[&uuid];
                    state.projects.insert(uuid.clone(), Linked { local_hash: s.hash.clone(), remote_version: version });
                }

                Step::Push { base, .. } => {
                    let s = &snaps[&uuid];
                    let now = transfer::now_secs().to_string();
                    let bytes = transfer::archive_bytes(&app_version, &now, &s.bundle, &s.people, &s.avatars)?;
                    let mut row = serde_json::json!({
                        "uuid": uuid,
                        "name": s.name,
                        "payload": encode_base64(&bytes),
                        "hash": s.hash,
                        "format_version": format_version,
                        "updated_by": host_label(),
                    });
                    match base {
                        None => {
                            row["version"] = 1.into();
                            rest.insert(row).await?;
                            state.projects.insert(uuid.clone(), Linked { local_hash: s.hash.clone(), remote_version: 1 });
                        }
                        Some(v) => {
                            row["version"] = (v + 1).into();
                            row["deleted"] = false.into();
                            if !rest.update_if(&uuid, v, row).await? {
                                report.notes.push(format!("「{name}」云端刚被别的电脑改过，下一轮先拉取"));
                                return Ok(());
                            }
                            state.projects.insert(uuid.clone(), Linked { local_hash: s.hash.clone(), remote_version: v + 1 });
                        }
                    }
                    report.pushed.push(name.clone());
                }

                Step::Pull { target, backup, .. } => {
                    let (payload, version) = rest.fetch(&uuid).await?;
                    let bytes = decode_base64(payload.trim())?;
                    let archive = transfer::read_archive_bytes(&bytes)?;
                    let (mut problems, _) = transfer::version_gate(&archive);
                    problems.extend(transfer::validate(&archive));
                    if !problems.is_empty() {
                        return Err(problems.join("；"));
                    }

                    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
                    let accounts = match target {
                        Some(id) => account::member_ids(&conn, id)?,
                        None => vec![me],
                    };
                    let mut pname = archive.bundle.project.name.clone();
                    if account::check_project_name(&conn, target, &accounts, &pname).is_err() {
                        pname = format!("{pname}（云端）");
                        account::check_project_name(&conn, target, &accounts, &pname)?;
                    }

                    let backup_path = match (target, backup) {
                        (Some(_), true) => {
                            let s = &snaps[&uuid];
                            Some(write_backup(&backups_dir, &app_version, s, "云端覆盖前", &stamp)?)
                        }
                        _ => None,
                    };
                    if let Some(p) = &backup_path {
                        report.backups.push(p.clone());
                    }

                    let outcome = transfer::apply(&mut conn, &archive, target, &pname, backup_path, me)?;
                    // 拉下来之后本机重新取一次指纹：人员合并等会让本机内容和云端那份字节上不完全一样，
                    // 要记的是「本机此刻的样子」，否则下一轮会误判本机改过
                    let fresh = snapshot(&conn, outcome.project_id)?;
                    state.projects.insert(uuid.clone(), Linked { local_hash: fresh.hash.clone(), remote_version: version });
                    snaps.insert(uuid.clone(), fresh);
                    report.pulled.push(PulledProject { id: outcome.project_id, name: pname, created: target.is_none() });
                }

                Step::DeleteLocal { id, .. } => {
                    let conn = db.0.lock().map_err(|e| e.to_string())?;
                    let path = write_backup(&backups_dir, &app_version, &snaps[&uuid], "云端删除前", &stamp)?;
                    report.backups.push(path);
                    query::delete_project(&conn, me, id)?;
                    state.projects.remove(&uuid);
                    report.deleted_local.push(id);
                }

                Step::Tombstone { version, .. } => {
                    let row = serde_json::json!({ "deleted": true, "version": version + 1, "updated_by": host_label() });
                    if rest.update_if(&uuid, version, row).await? {
                        state.projects.remove(&uuid);
                        report.deleted_remote.push(name.clone());
                    } else {
                        report.notes.push(format!("「{name}」本机删了，但云端刚被改过，下一轮会把它拉回来"));
                    }
                }

                Step::Forget { .. } => {
                    state.projects.remove(&uuid);
                }

                Step::Skip { why, .. } => report.notes.push(format!("「{name}」{why}")),
            }
            Ok(())
        }
        .await;

        if let Err(e) = result {
            report.errors.push(format!("「{name}」{e}"));
        }
    }

    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        save_state(&conn, me, &state)?;
    }
    Ok(report)
}

fn write_backup(
    dir: &Option<std::path::PathBuf>,
    app_version: &str,
    s: &Snapshot,
    why: &str,
    stamp: &str,
) -> Result<String> {
    let dir = dir.as_ref().ok_or_else(|| "找不到数据目录，没法先备份，这一步不做".to_string())?;
    let file = dir.join(format!("{}-{why}-{stamp}.{EXT}", transfer::safe_stem(&s.name)));
    transfer::write_archive(
        &file,
        app_version,
        &transfer::now_secs().to_string(),
        &s.bundle,
        &s.people,
        &s.avatars,
    )?;
    Ok(file.to_string_lossy().into_owned())
}

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    fn local(id: i64, uuid: &str, hash: &str) -> LocalSnap {
        LocalSnap { id, uuid: uuid.into(), hash: hash.into() }
    }
    fn remote(uuid: &str, hash: &str, version: i64, deleted: bool) -> RemoteRow {
        RemoteRow { uuid: uuid.into(), name: uuid.into(), hash: hash.into(), version, deleted }
    }
    fn state(entries: &[(&str, &str, i64)]) -> SyncState {
        SyncState {
            target: "t".into(),
            projects: entries
                .iter()
                .map(|(u, h, v)| (u.to_string(), Linked { local_hash: h.to_string(), remote_version: *v }))
                .collect(),
        }
    }
    fn run(l: &[LocalSnap], r: &[RemoteRow], s: &SyncState) -> Vec<Step> {
        plan(l, &HashSet::new(), r, s, None)
    }

    #[test]
    fn nothing_changed_means_nothing_moves() {
        let steps = run(&[local(1, "a", "h1")], &[remote("a", "h1", 3, false)], &state(&[("a", "h1", 3)]));
        assert!(steps.is_empty(), "{steps:?}");
    }

    #[test]
    fn local_only_change_is_pushed_against_the_seen_version() {
        let steps = run(&[local(1, "a", "h2")], &[remote("a", "h1", 3, false)], &state(&[("a", "h1", 3)]));
        assert_eq!(steps, vec![Step::Push { uuid: "a".into(), base: Some(3) }]);
    }

    #[test]
    fn remote_change_wins_even_when_local_changed_too_and_local_is_backed_up() {
        let steps = run(&[local(1, "a", "h2")], &[remote("a", "h9", 4, false)], &state(&[("a", "h1", 3)]));
        assert_eq!(steps, vec![Step::Pull { uuid: "a".into(), target: Some(1), backup: true }]);
    }

    #[test]
    fn remote_change_without_local_change_needs_no_backup() {
        let steps = run(&[local(1, "a", "h1")], &[remote("a", "h9", 4, false)], &state(&[("a", "h1", 3)]));
        assert_eq!(steps, vec![Step::Pull { uuid: "a".into(), target: Some(1), backup: false }]);
    }

    #[test]
    fn new_local_project_is_inserted() {
        let steps = run(&[local(1, "a", "h1")], &[], &state(&[]));
        assert_eq!(steps, vec![Step::Push { uuid: "a".into(), base: None }]);
    }

    #[test]
    fn first_contact_with_different_content_takes_remote() {
        let steps = run(&[local(1, "a", "mine")], &[remote("a", "theirs", 7, false)], &state(&[]));
        assert_eq!(steps, vec![Step::Pull { uuid: "a".into(), target: Some(1), backup: true }]);
    }

    #[test]
    fn first_contact_with_same_content_just_links() {
        let steps = run(&[local(1, "a", "same")], &[remote("a", "same", 7, false)], &state(&[]));
        assert_eq!(steps, vec![Step::Link { uuid: "a".into(), version: 7 }]);
    }

    #[test]
    fn remote_only_project_is_pulled_as_new() {
        let steps = run(&[], &[remote("b", "h", 1, false)], &state(&[]));
        assert_eq!(steps, vec![Step::Pull { uuid: "b".into(), target: None, backup: false }]);
    }

    #[test]
    fn local_deletion_tombstones_the_untouched_remote() {
        let steps = run(&[], &[remote("a", "h1", 3, false)], &state(&[("a", "h1", 3)]));
        assert_eq!(steps, vec![Step::Tombstone { uuid: "a".into(), version: 3 }]);
    }

    #[test]
    fn local_deletion_loses_to_a_later_remote_edit() {
        let steps = run(&[], &[remote("a", "h2", 4, false)], &state(&[("a", "h1", 3)]));
        assert_eq!(steps, vec![Step::Pull { uuid: "a".into(), target: None, backup: false }]);
    }

    #[test]
    fn remote_deletion_deletes_local_but_not_the_open_one() {
        let l = [local(1, "a", "h1")];
        let r = [remote("a", "h1", 4, true)];
        let s = state(&[("a", "h1", 3)]);
        assert_eq!(run(&l, &r, &s), vec![Step::DeleteLocal { uuid: "a".into(), id: 1 }]);
        assert!(matches!(plan(&l, &HashSet::new(), &r, &s, Some(1))[0], Step::Skip { .. }));
    }

    #[test]
    fn old_tombstones_are_ignored_and_forgotten() {
        assert!(run(&[], &[remote("a", "h", 4, true)], &state(&[])).is_empty());
        assert_eq!(
            run(&[], &[remote("a", "h", 4, true)], &state(&[("a", "h", 3)])),
            vec![Step::Forget { uuid: "a".into() }]
        );
    }

    #[test]
    fn projects_owned_by_someone_else_are_left_to_their_owner() {
        let foreign: HashSet<String> = ["a".to_string()].into();
        let steps = plan(&[], &foreign, &[remote("a", "h", 1, false)], &state(&[]), None);
        assert!(matches!(steps[0], Step::Skip { .. }));
    }

    #[test]
    fn hash_ignores_updated_at_but_not_content() {
        let conn = Connection::open_in_memory().unwrap();
        gantt_core::schema::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO projects (name, color, uuid, work_days, holidays, created_at, updated_at)
             VALUES ('P', '#4f46e5', 'u1', '[1,2,3,4,5]', '[]', '100', '200')",
            [],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        let (mut b, p, a) = transfer::collect(&conn, id).unwrap();
        let h1 = content_hash(&b, &p, &a).unwrap();
        b.project.updated_at = "999".into();
        assert_eq!(h1, content_hash(&b, &p, &a).unwrap());
        b.project.name = "Q".into();
        assert_ne!(h1, content_hash(&b, &p, &a).unwrap());
    }
}
