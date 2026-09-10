//! 整库（`.db`）的导出与导入 —— 跨电脑的另一条通道。
//!
//! 和 `transfer.rs`（`.ganttproj`）的分工：
//!   · `.ganttproj` —— 一次带**一个**项目，挑着搬
//!   · `.db`        —— 一次带**整个库**：那台电脑上的所有项目和全部负责人
//!
//! SQLite 的文件格式本身跨平台（大端序、自描述的页头），Mac 上的 gantt.db
//! 原样拷到 Windows 就打得开 —— 难的不是字节，是**合进本机已有的数据**。
//!
//! ## 为什么是合并，而不是把本机的库整个换掉
//!
//! 整个换掉最省事，但它会静默抹掉本机独有的项目：你在 Windows 上已经记了
//! 两周的新工地，导入一次 Mac 的库就没了，而对话框里根本看不出这一点。
//!
//! 所以这里不另起炉灶：源库里的每个项目先 `transfer::collect` 成一份和
//! .ganttproj 一模一样的 Archive，再走同一套校验、同一套「uuid 优先、名字兜底」
//! 的对号、同一个 `apply_in` 落库。两条通道共用一条写库路径 —— 任何一条被
//! 日常走过，另一条也就跟着被验证过。
//!
//! ## 三条规矩
//!
//! 1. **源文件一个字节都不碰。** 先整份拷进临时目录（连同旁边的 `-wal`），
//!    在副本上迁移、读取。直接打开会让 SQLite 在用户的 U 盘上 checkpoint、
//!    留下 `-shm`，旧版本的库还会被当场迁移掉。
//! 2. **全有或全无。** 所有项目放进同一个事务，第 17 个写不进去就一个都不写。
//! 3. **写之前先给本机整库拍快照。** 「撤销」就是把快照恢复回来 ——
//!    覆盖了哪些、新建了哪些，都不用逐个记。

use crate::backup;
use crate::db::{self, Db, MIGRATIONS};
use crate::transfer::{self, Archive, Manifest, SideSummary, FORMAT_MAJOR, FORMAT_MINOR};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

type Result<T> = std::result::Result<T, String>;

/// SQLite 文件头的前 16 字节。所有平台、所有版本都一样 —— 这正是 Mac 的库
/// 能直接拿到 Windows 上读的原因。
const SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";

/* ------------------------------------------------------------------ */
/* 源库：拷一份再读                                                     */
/* ------------------------------------------------------------------ */

/// 临时目录，离开作用域就删掉。
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Result<Self> {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "gantt-dbimport-{}-{nanos}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
        Ok(TempDir(dir))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// 源库在临时目录里的副本。
///
/// 字段顺序是有意的：Rust 按声明顺序析构，连接必须先于目录关掉 ——
/// Windows 上被打开着的文件删不掉。
pub struct Source {
    pub conn: Connection,
    /// 能读，但用户应该知道的事
    pub warnings: Vec<String>,
    _dir: TempDir,
}

/// `gantt.db` → `gantt.db-wal`。不能用 with_extension：那会把 `.db` 换掉。
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// 拷文件，但不和别的进程抢锁。
///
/// Windows 上 fs::copy 走 CopyFileEx，源文件正被别的程序以写方式打开时可能
/// 报共享冲突；std 的 File::open 在 Windows 上默认允许读、写、删共享 ——
/// 另一个 Gantt 或 SQLite 工具开着的库也照样读得出来。
fn copy_shared(from: &Path, to: &Path) -> std::io::Result<u64> {
    let mut src = fs::File::open(from)?;
    let mut dst = fs::File::create(to)?;
    std::io::copy(&mut src, &mut dst)
}

pub fn open_source(path: &Path) -> Result<Source> {
    let mut head = Vec::with_capacity(100);
    fs::File::open(path)
        .and_then(|f| f.take(100).read_to_end(&mut head))
        .map_err(|e| format!("打不开这个文件：{e}"))?;
    if head.len() < 100 || !head.starts_with(SQLITE_MAGIC) {
        return Err("这不是一个 SQLite 数据库文件。".into());
    }
    // 页头第 18 字节是写入格式：1 = 回滚日志，2 = WAL
    let wal_mode = head[18] == 2;
    let wal = with_suffix(path, "-wal");
    let has_wal = wal.is_file();

    let dir = TempDir::new()?;
    let copy = dir.0.join("source.db");
    copy_shared(path, &copy).map_err(|e| format!("读取数据库失败：{e}"))?;
    // 还没 checkpoint 的提交全在 -wal 里。只拷主文件，拿到的是缺了最近
    // 一段时间修改的库 —— 和 backup.rs 顶部说的是同一个坑
    if has_wal {
        copy_shared(&wal, &with_suffix(&copy, "-wal"))
            .map_err(|e| format!("读取 {} 失败：{e}", wal.display()))?;
    }

    let mut warnings = Vec::new();
    if wal_mode && !has_wal {
        warnings.push(
            "这个文件是 Gantt 运行中的主库格式，但旁边没有同名的 -wal 文件。\
             如果它是从另一台电脑的数据目录直接复制来的，请确认复制时那边的 Gantt 已经退出，\
             否则最近的修改可能不在里面 —— 更稳妥的做法是在那台电脑上用「设置 → 数据 → 导出数据库」。"
                .into(),
        );
    }

    let conn = Connection::open(&copy).map_err(|e| format!("打不开这个数据库：{e}"))?;

    // 先认身份，再迁移。顺序反过来的话，随便一个 SQLite 文件都会被迁移
    // 「建」出一套空表，然后报「0 个项目」—— 比直接说「不是」更让人糊涂
    let has_projects = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| format!("数据库文件已损坏：{e}"))?
        .is_some();
    if !has_projects {
        return Err("这个 SQLite 文件不是 Gantt 的数据库（里面没有项目表）。".into());
    }

    let version: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let latest = MIGRATIONS.len() as i64;
    if version > latest {
        return Err(format!(
            "这个数据库来自更新版本的 Gantt（数据库版本 {version}，本机支持到 {latest}）。请先升级本机的 Gantt。"
        ));
    }

    let check: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| format!("数据库文件已损坏：{e}"))?;
    if check != "ok" {
        return Err(format!("数据库文件已损坏：{check}"));
    }

    conn.pragma_update(None, "foreign_keys", "ON").map_err(|e| e.to_string())?;
    if version < latest {
        warnings.push(format!(
            "这个数据库来自较旧版本的 Gantt（数据库版本 {version}，本机 {latest}），\
             已在临时副本上补齐，源文件没有任何改动。"
        ));
    }
    db::migrate(&conn).map_err(|e| format!("升级旧版数据库失败：{e}"))?;

    Ok(Source { conn, warnings, _dir: dir })
}

/* ------------------------------------------------------------------ */
/* 预检：每个项目去哪                                                   */
/* ------------------------------------------------------------------ */

/// 预检里一个项目的去向。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DbImportItem {
    pub file: SideSummary,
    /// 本机会被覆盖的那个项目；None = 新建
    pub existing: Option<SideSummary>,
    /// "uuid" | "name"
    pub matched_by: Option<String>,
    pub target_id: Option<i64>,
    /// 落库后的名字。和 file.name 不同 = 原名被本机另一个项目占着，换了一个
    pub final_name: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DbImportPreview {
    /// 非空 = 不能导入。全有或全无，有一条就一个项目都不写
    pub problems: Vec<String>,
    pub warnings: Vec<String>,
    pub projects: Vec<DbImportItem>,
    /// 源库里有、没有任何项目用到、本机也还没有的负责人 —— 一并带过来
    pub extra_people: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DbImportOutcome {
    pub created: i64,
    pub overwritten: i64,
    pub new_people: Vec<String>,
    /// 导入前本机整库的快照；「撤销」就是把它恢复回来
    pub backup_path: String,
}

struct ExtraPerson {
    name: String,
    color: String,
    avatar: Option<String>,
}

pub struct Plan {
    items: Vec<(Archive, DbImportItem)>,
    extra_people: Vec<ExtraPerson>,
    problems: Vec<String>,
    warnings: Vec<String>,
}

impl Plan {
    pub fn preview(&self, source_warnings: &[String]) -> DbImportPreview {
        DbImportPreview {
            problems: self.problems.clone(),
            warnings: source_warnings.iter().chain(&self.warnings).cloned().collect(),
            projects: self.items.iter().map(|(_, item)| item.clone()).collect(),
            extra_people: self.extra_people.iter().map(|p| p.name.clone()).collect(),
        }
    }
}

/// 读源库、校验、和本机对号、定名 —— 一个字都不写。
pub fn plan(local: &Connection, src: &Connection) -> rusqlite::Result<Plan> {
    let ids: Vec<i64> = src
        .prepare("SELECT id FROM projects ORDER BY sort_order, id")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;

    let mut problems = Vec::new();
    let mut warnings = Vec::new();
    let mut archives = Vec::with_capacity(ids.len());
    for id in ids {
        let (bundle, people, avatars) = transfer::collect(src, id)?;
        let manifest = Manifest {
            format_version: format!("{FORMAT_MAJOR}.{FORMAT_MINOR}"),
            app: "gantt".into(),
            app_version: String::new(),
            exported_at: String::new(),
            project_name: bundle.project.name.clone(),
            project_uuid: bundle.project.uuid.clone(),
        };
        let archive = Archive { manifest, bundle, people, avatars, unknown_sections: Vec::new() };
        // 带上项目名：几十个项目的问题混在一张清单里，
        // 光说「任务「验收」……」没人知道是哪个项目的
        for p in transfer::validate(&archive) {
            problems.push(format!("「{}」{p}", archive.bundle.project.name));
        }
        archives.push(archive);
    }
    if archives.is_empty() {
        problems.push("这个数据库里一个项目都没有。".into());
    }

    let locals: Vec<(i64, String, String)> = local
        .prepare("SELECT id, uuid, name FROM projects ORDER BY id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;

    // ---- 对号：uuid 优先、名字兜底，而且一个本机项目只能被认领一次 ----
    //
    // 单文件导入不需要「认领」：一次只有一个项目。整库导入时，源库里的 A 可能
    // 按 uuid 认走了本机的 X，而源库里的 B 恰好和 X 同名 —— 不挡的话两个项目
    // 会覆盖同一个本机项目，后写的那个把先写的整个冲掉
    let mut claimed: HashSet<i64> = HashSet::new();
    let mut matched: Vec<Option<(i64, &'static str)>> = vec![None; archives.len()];
    for (i, a) in archives.iter().enumerate() {
        if let Some((id, _, _)) = locals.iter().find(|(_, uuid, _)| *uuid == a.bundle.project.uuid) {
            matched[i] = Some((*id, "uuid"));
            claimed.insert(*id);
        }
    }
    for (i, a) in archives.iter().enumerate() {
        if matched[i].is_some() {
            continue;
        }
        if let Some((id, _, _)) = locals
            .iter()
            .find(|(id, _, name)| !claimed.contains(id) && *name == a.bundle.project.name)
        {
            matched[i] = Some((*id, "name"));
            claimed.insert(*id);
        }
    }

    // ---- 定名 ----
    //
    // 没被覆盖的本机项目名字不动，它们占着的名字谁也不能用。导入的项目尽量
    // 用源库里的原名；原名被占时，覆盖的沿用本机原名，实在不行才加后缀 ——
    // 并且在预检里明说，不悄悄改
    let mut taken: HashSet<String> = locals
        .iter()
        .filter(|(id, _, _)| !claimed.contains(id))
        .map(|(_, _, name)| name.clone())
        .collect();
    let mut names: Vec<Option<String>> = vec![None; archives.len()];
    // 源库里的名字本身唯一，所以第一轮之间不会互相撞，只可能撞本机的
    for (i, a) in archives.iter().enumerate() {
        let want = &a.bundle.project.name;
        if taken.insert(want.clone()) {
            names[i] = Some(want.clone());
        }
    }
    for (i, a) in archives.iter().enumerate() {
        if names[i].is_some() {
            continue;
        }
        let want = &a.bundle.project.name;
        let local_name = matched[i]
            .and_then(|(id, _)| locals.iter().find(|(l, _, _)| *l == id))
            .map(|(_, _, name)| name.clone());
        let name = match local_name.filter(|n| !taken.contains(n)) {
            Some(n) => n,
            None => (1..)
                .map(|k| {
                    if k == 1 {
                        format!("{want}（导入）")
                    } else {
                        format!("{want}（导入 {k}）")
                    }
                })
                .find(|n| !taken.contains(n))
                .expect("无限序列里总有一个没被占用的名字"),
        };
        warnings.push(format!(
            "「{want}」这个名字在本机已被另一个项目占用，这一份会以「{name}」为名导入。"
        ));
        taken.insert(name.clone());
        names[i] = Some(name);
    }

    let mut items = Vec::with_capacity(archives.len());
    for ((archive, m), name) in archives.into_iter().zip(matched).zip(names) {
        let existing = match m {
            Some((id, _)) => Some(transfer::local_summary(local, id)?),
            None => None,
        };
        let item = DbImportItem {
            file: transfer::file_summary(&archive),
            existing,
            matched_by: m.map(|(_, how)| how.to_string()),
            target_id: m.map(|(id, _)| id),
            final_name: names_unwrap(name),
        };
        items.push((archive, item));
    }

    // ---- 没有项目用到的负责人 ----
    //
    // .ganttproj 只带用到的人（传一个项目不该改掉对方的整张人员表）；
    // 但整库导入的意思就是「把那台电脑上的东西都搬过来」，人员表也是其中之一
    let used: HashSet<String> = items
        .iter()
        .flat_map(|(a, _)| a.people.iter().map(|p| p.name.clone()))
        .collect();
    let local_people: HashSet<String> = local
        .prepare("SELECT name FROM people")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let extra_people = src
        .prepare("SELECT name, color, avatar FROM people ORDER BY sort_order, id")?
        .query_map([], |r| {
            Ok(ExtraPerson { name: r.get(0)?, color: r.get(1)?, avatar: r.get(2)? })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter(|p| !used.contains(&p.name) && !local_people.contains(&p.name))
        .collect();

    Ok(Plan { items, extra_people, problems, warnings })
}

fn names_unwrap(name: Option<String>) -> String {
    // 两轮定名覆盖了每一个下标，走到这里一定有值
    name.expect("每个项目都已定名")
}

/* ------------------------------------------------------------------ */
/* 落库、快照、恢复                                                     */
/* ------------------------------------------------------------------ */

fn now_secs() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        .to_string()
}

/// 落库。返回（新建数，覆盖数，新增的负责人）。
pub fn import_all(conn: &mut Connection, plan: &Plan) -> Result<(i64, i64, Vec<String>)> {
    if !plan.problems.is_empty() {
        return Err(plan.problems.join("\n"));
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // 先把要被覆盖的项目统统挪到临时名字上。
    //
    // 项目名是唯一索引，而且逐条语句检查：两个本机项目互换名字（A↔B）时，
    // 不管先写哪个，第一条 UPDATE 都会撞上另一个还没改的。事务内的中间状态
    // 外面看不见，挪一下不留痕迹
    for (_, item) in &plan.items {
        if let Some(id) = item.target_id {
            tx.execute(
                "UPDATE projects SET name = ?2 WHERE id = ?1",
                params![id, format!("\u{1}gantt-import-{id}")],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    let mut created = 0;
    let mut overwritten = 0;
    let mut new_people = Vec::new();
    for (archive, item) in &plan.items {
        let (_, added) = transfer::apply_in(&tx, archive, item.target_id, &item.final_name)
            .map_err(|e| format!("「{}」写入失败，没有导入任何项目：{e}", item.file.name))?;
        if item.target_id.is_some() {
            overwritten += 1;
        } else {
            created += 1;
        }
        new_people.extend(added);
    }

    let ts = now_secs();
    for p in &plan.extra_people {
        tx.execute(
            "INSERT INTO people (name, color, avatar, sort_order, created_at)
             VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM people), ?4)",
            params![p.name, p.color, p.avatar, ts],
        )
        .map_err(|e| e.to_string())?;
        new_people.push(p.name.clone());
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok((created, overwritten, new_people))
}

/// 把快照整份恢复进活动连接 —— 「撤销整库导入」。
///
/// 走 SQLite 的在线备份 API 反方向拷：连接不用关、文件不用换，
/// 前端手里的一切句柄都还有效。
pub fn restore(live: &mut Connection, snapshot: &Path) -> Result<()> {
    let src = Connection::open_with_flags(snapshot, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("打不开快照：{e}"))?;
    {
        let backup = rusqlite::backup::Backup::new(&src, live).map_err(|e| e.to_string())?;
        backup.step(-1).map_err(|e| format!("恢复失败：{e}"))?;
    }
    // 快照是回滚日志模式的单文件；拷完之后活动库要回到 WAL，和 db::open 一致
    live.pragma_update(None, "journal_mode", "WAL").map_err(|e| e.to_string())?;
    db::migrate(live).map_err(|e| e.to_string())
}

/* ------------------------------------------------------------------ */
/* Tauri 命令                                                          */
/* ------------------------------------------------------------------ */

fn backups_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?.join("backups");
    fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败：{e}"))?;
    Ok(dir)
}

/// path 是不是本机正在用的那个库。
fn is_live_db(app: &tauri::AppHandle, path: &Path) -> bool {
    use tauri::Manager;
    let Ok(dir) = app.path().app_config_dir() else { return false };
    matches!(
        (fs::canonicalize(path), fs::canonicalize(dir.join(crate::DB_FILE))),
        (Ok(a), Ok(b)) if a == b
    )
}

/// 把整个库导出成一个独立的 .db 文件 —— 拷到另一台电脑上导入用。
///
/// 和「立即备份」是同一个快照，只是位置由用户挑：备份埋在应用数据目录里，
/// 那个目录在 Mac 上藏在 ~/Library 下，让人去那儿翻文件等于没给这个功能。
#[tauri::command]
pub fn export_database(app: tauri::AppHandle, db: tauri::State<Db>, path: String) -> Result<String> {
    let path = PathBuf::from(path);
    // 挑中了正在用的库本身：Mac 上改名覆盖会让活动连接对着一个已被替换掉的
    // 文件继续写，Windows 上则直接失败。两种都不该发生
    if is_live_db(&app, &path) {
        return Err("不能导出到本机正在使用的数据库文件上，请换一个位置。".into());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    backup::snapshot(&conn, &path).map_err(|e| format!("导出失败：{e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// 读源库、校验、和本机对号 —— 一个字都不写库。
#[tauri::command]
pub fn inspect_db_import(
    app: tauri::AppHandle,
    db: tauri::State<Db>,
    path: String,
) -> Result<DbImportPreview> {
    let path = PathBuf::from(path);
    if is_live_db(&app, &path) {
        return Err("这就是本机正在使用的数据库，不需要导入。".into());
    }
    let src = open_source(&path)?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let plan = plan(&conn, &src.conn).map_err(|e| format!("读取数据库失败：{e}"))?;
    Ok(plan.preview(&src.warnings))
}

/// 真正落库。
///
/// 和 .ganttproj 一样：源文件**重新读、重新对号**，不复用预检的结果 ——
/// 预检和确认之间隔着用户的思考时间，那期间文件可能被云盘同步换掉。
#[tauri::command]
pub fn commit_db_import(
    app: tauri::AppHandle,
    db: tauri::State<Db>,
    path: String,
    backup_stamp: String,
) -> Result<DbImportOutcome> {
    let path = PathBuf::from(path);
    if is_live_db(&app, &path) {
        return Err("这就是本机正在使用的数据库，不需要导入。".into());
    }
    let src = open_source(&path)?;
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let plan = plan(&conn, &src.conn).map_err(|e| format!("读取数据库失败：{e}"))?;
    if !plan.problems.is_empty() {
        return Err(plan.problems.join("\n"));
    }

    // 文件名故意不以 gantt 开头：滚动备份按这个前缀清理旧文件，
    // 撤销要用的快照不能被下次启动顺手删掉
    let backup_path = backups_dir(&app)?.join(format!(
        "整库导入前-{}.db",
        transfer::safe_stem(&backup_stamp)
    ));
    backup::snapshot(&conn, &backup_path)
        .map_err(|e| format!("导入前备份失败，没有写入任何数据：{e}"))?;

    let (created, overwritten, new_people) = import_all(&mut conn, &plan)?;
    Ok(DbImportOutcome {
        created,
        overwritten,
        new_people,
        backup_path: backup_path.to_string_lossy().into_owned(),
    })
}

/// 撤销一次整库导入：把导入前的快照恢复回来。
#[tauri::command]
pub fn undo_db_import(
    app: tauri::AppHandle,
    db: tauri::State<Db>,
    backup_path: String,
) -> Result<()> {
    let dir = backups_dir(&app)?;
    let path = PathBuf::from(backup_path);
    // 只认 backups/ 里的快照：这条命令会把整个库换掉，
    // 不能变成一个「随便给个文件就覆盖全部数据」的入口
    let inside = matches!(
        (fs::canonicalize(&path), fs::canonicalize(&dir)),
        (Ok(p), Ok(d)) if p.starts_with(&d)
    );
    if !inside {
        return Err("找不到导入前的快照，无法撤销。".into());
    }
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    restore(&mut conn, &path)
}

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gantt-dbfile-test-{name}"));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        db::migrate(&conn).unwrap();
        conn
    }

    /// 一个项目：两层任务、一条风险、一条项目级当日记录、一个带头像的负责人。
    fn project(conn: &Connection, uuid: &str, name: &str, person: &str) -> i64 {
        conn.execute(
            "INSERT INTO projects (name, uuid, created_at, updated_at) VALUES (?1, ?2, '1', '2')",
            params![name, uuid],
        )
        .unwrap();
        let pid = conn.last_insert_rowid();
        conn.execute(
            "INSERT OR IGNORE INTO people (name, color, avatar, created_at)
             VALUES (?1, '#0ea5e9', 'data:image/png;base64,UEsDBBQA', '0')",
            params![person],
        )
        .unwrap();
        let person_id: i64 = conn
            .query_row("SELECT id FROM people WHERE name = ?1", params![person], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO tasks (project_id, name, start_date, end_date, person_id, created_at, updated_at)
             VALUES (?1, '地基', '2026-03-01', '2026-03-20', ?2, '0', '0')",
            params![pid, person_id],
        )
        .unwrap();
        let root = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO tasks (project_id, parent_id, name, start_date, end_date, created_at, updated_at)
             VALUES (?1, ?2, '放线', '2026-03-01', '2026-03-05', '0', '0')",
            params![pid, root],
        )
        .unwrap();
        let child = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO risks (task_id, content, level, created_at) VALUES (?1, '雨季', 0, 1)",
            params![child],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO daily_notes (project_id, task_id, day, content, created_at, updated_at)
             VALUES (?1, NULL, '2026-03-02', '例会', 1, 1)",
            params![pid],
        )
        .unwrap();
        pid
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn names(conn: &Connection) -> Vec<String> {
        conn.prepare("SELECT name FROM projects ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    /// 主线场景：Mac 上的整个库导进一台已经有自己项目的 Windows。
    /// 本机独有的项目必须还在，人员表里没被任何任务用到的人也要带过来。
    #[test]
    fn imports_every_project_and_keeps_local_ones() {
        let d = dir("all");
        let path = d.join("gantt.db");
        {
            let src = db::open(&path).unwrap();
            project(&src, "u-mac-1", "厂房建设", "张三");
            project(&src, "u-mac-2", "办公楼", "李四");
            src.execute(
                "INSERT INTO people (name, color, created_at) VALUES ('王五', '#f97316', '0')",
                [],
            )
            .unwrap();
        }

        let mut local = mem();
        project(&local, "u-win-1", "新工地", "赵六");

        let source = open_source(&path).unwrap();
        let plan = plan(&local, &source.conn).unwrap();
        assert!(plan.problems.is_empty(), "{:?}", plan.problems);
        assert!(plan.items.iter().all(|(_, i)| i.target_id.is_none()));

        let (created, overwritten, new_people) = import_all(&mut local, &plan).unwrap();
        assert_eq!((created, overwritten), (2, 0));
        assert_eq!(names(&local), vec!["办公楼", "厂房建设", "新工地"]);
        assert_eq!(count(&local, "SELECT COUNT(*) FROM tasks"), 6);
        assert_eq!(count(&local, "SELECT COUNT(*) FROM risks"), 3);
        assert!(new_people.contains(&"王五".to_string()), "{new_people:?}");

        // 父子关系没有跨项目串线
        assert_eq!(
            count(
                &local,
                "SELECT COUNT(*) FROM tasks c JOIN tasks p ON p.id = c.parent_id
                  WHERE c.project_id <> p.project_id"
            ),
            0
        );
        // 头像跟着人一起过来了
        let avatar: Option<String> = local
            .query_row("SELECT avatar FROM people WHERE name = '张三'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(avatar.as_deref(), Some("data:image/png;base64,UEsDBBQA"));
    }

    /// 源文件一个字节都不能动；还在 -wal 里的提交必须读得到。
    ///
    /// 这里刻意让源库的连接一直开着、不 checkpoint —— 这就是「Mac 上的 Gantt
    /// 还开着，用户直接把数据目录拷走」时的样子：主文件里几乎什么都没有。
    #[test]
    fn reads_the_wal_and_never_touches_the_source() {
        let d = dir("wal");
        let path = d.join("gantt.db");
        let live = db::open(&path).unwrap();
        project(&live, "u1", "还在 WAL 里的项目", "张三");

        let wal = with_suffix(&path, "-wal");
        let before = (fs::read(&path).unwrap(), fs::read(&wal).unwrap());

        {
            let source = open_source(&path).unwrap();
            let plan = plan(&mem(), &source.conn).unwrap();
            assert_eq!(plan.items.len(), 1);
            assert_eq!(plan.items[0].1.file.name, "还在 WAL 里的项目");
            assert!(source.warnings.is_empty(), "{:?}", source.warnings);
        }

        let after = (fs::read(&path).unwrap(), fs::read(&wal).unwrap());
        assert!(before == after, "导入不能改动源文件");
        drop(live);
    }

    /// 只拷了主文件、没带 -wal 时要提醒一句；导出的快照是单文件，不该误报。
    #[test]
    fn warns_only_when_a_wal_database_arrives_alone() {
        let d = dir("lonely");
        let live_path = d.join("gantt.db");
        let lonely = d.join("拷过来的.db");
        let exported = d.join("导出的.db");
        {
            let live = db::open(&live_path).unwrap();
            project(&live, "u1", "P", "张三");
            // 连接开着时 -wal 还在；只拷主文件就是用户最容易犯的那个错
            live.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
            copy_shared(&live_path, &lonely).unwrap();
            backup::snapshot(&live, &exported).unwrap();
        }

        let w = open_source(&lonely).unwrap().warnings;
        assert!(w.iter().any(|m| m.contains("-wal")), "{w:?}");
        assert!(open_source(&exported).unwrap().warnings.is_empty());
    }

    /// 另一台电脑上的 Gantt 比本机旧：在副本上迁移，源文件原封不动。
    #[test]
    fn upgrades_an_older_database_on_the_copy_only() {
        let d = dir("old");
        let path = d.join("old.db");
        {
            // 停在 006：还没有 uuid，也还没有项目名唯一
            let old = Connection::open(&path).unwrap();
            old.pragma_update(None, "foreign_keys", "ON").unwrap();
            for sql in &MIGRATIONS[..6] {
                old.execute_batch(sql).unwrap();
            }
            old.pragma_update(None, "user_version", 6).unwrap();
            old.execute(
                "INSERT INTO projects (name, created_at, updated_at) VALUES ('老项目', '0', '0')",
                [],
            )
            .unwrap();
            old.execute(
                "INSERT INTO tasks (project_id, name, start_date, end_date, created_at, updated_at)
                 VALUES (1, '老任务', '2025-01-01', '2025-01-02', '0', '0')",
                [],
            )
            .unwrap();
        }
        let before = fs::read(&path).unwrap();

        let source = open_source(&path).unwrap();
        assert!(source.warnings.iter().any(|w| w.contains("较旧版本")), "{:?}", source.warnings);
        let plan = plan(&mem(), &source.conn).unwrap();
        assert!(plan.problems.is_empty(), "{:?}", plan.problems);
        assert_eq!(plan.items[0].1.file.task_count, 1);
        assert!(!plan.items[0].0.bundle.project.uuid.is_empty(), "迁移应补上 uuid");
        drop(source);

        assert!(fs::read(&path).unwrap() == before, "源文件不该被迁移");
    }

    /// 读不了的东西要说人话，而且说清楚是哪种读不了。
    #[test]
    fn rejects_what_it_cannot_read() {
        let d = dir("reject");

        let text = d.join("notes.db");
        fs::write(&text, "这不是数据库".repeat(20)).unwrap();
        assert!(open_source(&text).err().unwrap().contains("不是一个 SQLite"));

        let other = d.join("other.db");
        Connection::open(&other)
            .unwrap()
            .execute_batch("CREATE TABLE foo (x); INSERT INTO foo VALUES (1);")
            .unwrap();
        assert!(open_source(&other).err().unwrap().contains("不是 Gantt 的数据库"));

        let newer = d.join("newer.db");
        {
            let c = db::open(&newer).unwrap();
            c.pragma_update(None, "user_version", MIGRATIONS.len() as i64 + 1).unwrap();
        }
        assert!(open_source(&newer).err().unwrap().contains("请先升级"));
    }

    /// uuid 对上 → 覆盖并改名；本机独有的项目原样留着。
    #[test]
    fn overwrites_by_uuid_and_leaves_local_only_projects_alone() {
        let src = mem();
        project(&src, "u1", "厂房建设二期", "张三");

        let mut local = mem();
        let target = project(&local, "u1", "厂房建设", "张三");
        local
            .execute(
                "INSERT INTO tasks (project_id, name, start_date, end_date, created_at, updated_at)
                 VALUES (?1, '本机独有的任务', '2026-01-01', '2026-01-02', '0', '0')",
                params![target],
            )
            .unwrap();
        project(&local, "u9", "本机项目", "李四");

        let plan = plan(&local, &src).unwrap();
        let item = &plan.items[0].1;
        assert_eq!(item.target_id, Some(target));
        assert_eq!(item.matched_by.as_deref(), Some("uuid"));
        assert_eq!(item.final_name, "厂房建设二期");

        let (created, overwritten, _) = import_all(&mut local, &plan).unwrap();
        assert_eq!((created, overwritten), (0, 1));
        assert_eq!(names(&local), vec!["厂房建设二期", "本机项目"]);
        assert_eq!(count(&local, "SELECT COUNT(*) FROM tasks WHERE name = '本机独有的任务'"), 0);
    }

    /// 两个本机项目在另一台电脑上互换了名字。逐个写的话第一条 UPDATE 就会
    /// 撞上唯一索引 —— 先挪到临时名字上才过得去。
    #[test]
    fn swapped_names_do_not_trip_the_unique_index() {
        let src = mem();
        project(&src, "u1", "B", "张三");
        project(&src, "u2", "A", "张三");

        let mut local = mem();
        project(&local, "u1", "A", "张三");
        project(&local, "u2", "B", "张三");

        let plan = plan(&local, &src).unwrap();
        assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
        import_all(&mut local, &plan).unwrap();

        let u1: String = local
            .query_row("SELECT name FROM projects WHERE uuid = 'u1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(u1, "B");
        assert_eq!(count(&local, "SELECT COUNT(*) FROM projects"), 2);
    }

    /// 名字被本机另一个项目占着：覆盖的沿用本机原名；原名也被占了才加后缀。
    /// 两种情况都要在预检里说出来，并且最后所有名字仍然唯一。
    #[test]
    fn a_taken_name_falls_back_and_is_announced() {
        // 源库：P 的 uuid 对上本机的「B」，但它自己叫「A」；Q 是新项目，叫「B」
        let src = mem();
        project(&src, "u1", "A", "张三");
        project(&src, "u3", "B", "张三");

        // 本机：「A」被一个和这次导入无关的项目占着
        let mut local = mem();
        project(&local, "u1", "B", "张三");
        project(&local, "u2", "A", "张三");

        let plan = plan(&local, &src).unwrap();
        let finals: Vec<&str> = plan.items.iter().map(|(_, i)| i.final_name.as_str()).collect();
        assert_eq!(finals, vec!["A（导入）", "B"]);
        assert!(plan.warnings.iter().any(|w| w.contains("「A（导入）」")), "{:?}", plan.warnings);

        import_all(&mut local, &plan).unwrap();
        assert_eq!(names(&local), vec!["A", "A（导入）", "B"]);
    }

    /// 全有或全无：一个项目有问题，整份库都不导；写到一半失败，前面写的也要退回去。
    #[test]
    fn all_or_nothing() {
        let src = mem();
        project(&src, "u1", "好项目", "张三");
        let bad = project(&src, "u2", "坏项目", "张三");
        src.execute("UPDATE tasks SET blocked = 'oops' WHERE project_id = ?1", params![bad])
            .unwrap();

        let mut local = mem();
        let rejected = plan(&local, &src).unwrap();
        assert!(rejected.problems.iter().any(|p| p.starts_with("「坏项目」")), "{:?}", rejected.problems);
        assert!(import_all(&mut local, &rejected).is_err());
        assert_eq!(count(&local, "SELECT COUNT(*) FROM projects"), 0);

        // 预检之后本机又冒出一个同名项目，第二个项目会在唯一索引上失败 ——
        // 这时第一个已经写进去的也必须一起撤掉
        let src = mem();
        project(&src, "u1", "第一个", "张三");
        project(&src, "u2", "第二个", "张三");
        let mut local = mem();
        let stale = plan(&local, &src).unwrap();
        local
            .execute(
                "INSERT INTO projects (name, uuid, created_at, updated_at) VALUES ('第二个', 'late', '0', '0')",
                [],
            )
            .unwrap();
        let err = import_all(&mut local, &stale).unwrap_err();
        assert!(err.contains("没有导入任何项目"), "{err}");
        assert_eq!(names(&local), vec!["第二个"]);
        assert_eq!(count(&local, "SELECT COUNT(*) FROM tasks"), 0);
    }

    /// 撤销 = 把导入前的快照恢复回来。恢复之后活动库仍然是 WAL。
    #[test]
    fn undo_restores_the_snapshot() {
        let d = dir("undo");
        let mut live = db::open(&d.join("gantt.db")).unwrap();
        project(&live, "u-local", "本机项目", "张三");

        let snap = d.join("整库导入前.db");
        backup::snapshot(&live, &snap).unwrap();

        let src = mem();
        project(&src, "u-local", "被覆盖成这个", "张三");
        project(&src, "u-new", "新来的", "李四");
        let plan = plan(&live, &src).unwrap();
        import_all(&mut live, &plan).unwrap();
        assert_eq!(names(&live), vec!["新来的", "被覆盖成这个"]);

        restore(&mut live, &snap).unwrap();
        assert_eq!(names(&live), vec!["本机项目"]);
        assert_eq!(count(&live, "SELECT COUNT(*) FROM tasks"), 2);
        assert_eq!(count(&live, "SELECT COUNT(*) FROM people WHERE name = '李四'"), 0);
        let mode: String = live.pragma_query_value(None, "journal_mode", |r| r.get(0)).unwrap();
        assert_eq!(mode, "wal");
    }

    /// 导出的库是一个自给自足的单文件：不带 -wal、不留 .part，拷走就能用。
    #[test]
    fn exported_database_is_one_self_contained_file() {
        let d = dir("export");
        let live = db::open(&d.join("gantt.db")).unwrap();
        project(&live, "u1", "P", "张三");

        let out = d.join("Gantt 数据库.db");
        backup::snapshot(&live, &out).unwrap();
        // 再导一次覆盖同名文件 —— 用户在保存对话框里点了「替换」就是这样
        backup::snapshot(&live, &out).unwrap();

        assert!(!with_suffix(&out, "-wal").exists());
        assert!(!d.join("Gantt 数据库.db.part").exists());
        let head = fs::read(&out).unwrap();
        assert_eq!(head[18], 1, "应是回滚日志模式，不依赖旁边的 -wal");

        let copy = Connection::open(&out).unwrap();
        assert_eq!(count(&copy, "SELECT COUNT(*) FROM tasks"), 2);
    }
}
