//! 项目文件（`.ganttproj`）的导出与导入 —— 跨电脑传输的往返通道。
//!
//! 和 `export.rs` 是两件事，别混淆：
//!   · `export.rs` 产出 Excel / 时间线 HTML，是**给人看的排版件**，导不回来
//!   · 本模块产出 `.ganttproj`，是**给这个软件看的全保真数据**，能原样导回来
//!
//! ## 为什么整件事都在 Rust 侧
//!
//! 数据本来就在 SQLite 里。走 `export.rs` 那条「前端拼内容 → base64 → IPC →
//! Rust 落盘」的路，等于把几 MB 头像先捞到前端、编码、再传回来。而且这里没有
//! 任何依赖渲染层的东西（不像 Excel 要着色器和汇总结果），前端参与不了也不需要参与。
//!
//! ## 容器
//!
//! 对外是一个文件，内部是目录结构的 zip —— 和 .sketch / .docx / .xmind 同一个套路：
//!
//! ```text
//! manifest.json     格式版本、导出时间、项目名与 uuid（不解开就能预览）
//! project.json      项目 + 任务 + 依赖 + 风险 + 评论 + 逐日记录 + 基线
//! people.json       只含本项目用到的负责人
//! avatars/*.png     头像还原成真实图片文件，不再是 base64 字符串
//! ```
//!
//! ## 两条硬规矩
//!
//! **一、文件里的任务 id 一律重编号成 1..n。** 库里的 id 是全局自增的，
//! 带出去毫无意义，还会让「同一份数据导出两次」得到不同的字节。重编号之后
//! 往返是幂等的 —— 导出→导入→再导出，两次的 project.json 逐字节相同。
//! 这一条不只是洁癖，它是本模块唯一那个能同时抓住「某字段没导出」
//! 「某字段导入时丢了」「排序不稳定」三类 bug 的测试的前提。
//!
//! **二、导入是全有或全无。** 校验在写库之前全部做完，一条不合格就整个拒绝，
//! 不靠数据库的 CHECK 兜底。理由是可发现性：一个 47 个任务的项目，
//! 「跳过坏行」导进来 45 个，用户不会去逐条核对，只会在三周后发现某个任务
//! 凭空消失了 —— 而那时源文件早删了。

use crate::db::{name_taken, Db};
use crate::export::{decode_base64, encode_base64};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

type Result<T> = std::result::Result<T, String>;

/// 格式版本。
///
/// major 变 = 语义改了或字段删了，旧版应用**必须拒绝**；
/// minor 变 = 只加了字段，旧版应用照常导入、忽略不认识的部分。
///
/// 这个两级划分不是形式主义 —— 跨电脑的主线场景就是「两台机器上的 Gantt
/// 版本不一样」（你在家更新了，公司那台还没）。单个整数版本号会让
/// 「加了一个无关紧要的字段」把旧机器彻底锁死。
pub const FORMAT_MAJOR: u32 = 1;
pub const FORMAT_MINOR: u32 = 0;

pub const EXT: &str = "ganttproj";

/* ------------------------------------------------------------------ */
/* 文件内的数据结构                                                     */
/* ------------------------------------------------------------------ */

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// "major.minor"
    pub format_version: String,
    pub app: String,
    pub app_version: String,
    /// Unix 秒，和库里的 created_at 同一个口径
    pub exported_at: String,
    pub project_name: String,
    pub project_uuid: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileProject {
    pub uuid: String,
    pub name: String,
    pub color: String,
    pub work_days: String,
    pub holidays: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileTask {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    pub start_date: String,
    pub end_date: String,
    pub actual_start: Option<String>,
    pub actual_end: Option<String>,
    pub progress: f64,
    pub priority: i64,
    /// 按**名字**引用负责人，不是 id。
    /// people 表是全局的，两台机器上同一个人的 id 必然不同；而合并规则本来
    /// 就是「同名即同人」，那就让文件直接说名字，导入时一步到位。
    pub person: Option<String>,
    pub milestone: bool,
    pub weight: Option<f64>,
    pub collapsed: bool,
    pub pinned: bool,
    pub note: String,
    pub sort_order: f64,
    pub blocked: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileDep {
    pub from_task_id: i64,
    pub to_task_id: i64,
    pub kind: String,
    pub lag_days: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileRisk {
    pub task_id: i64,
    pub content: String,
    pub level: i64,
    pub resolved: bool,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileComment {
    pub task_id: i64,
    pub content: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileNote {
    /// None = 项目级的当天记录，不挂在任何一条任务上
    pub task_id: Option<i64>,
    pub day: String,
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileBaselineTask {
    pub task_id: i64,
    pub name: String,
    pub start_date: String,
    pub end_date: String,
    pub duration: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileBaseline {
    pub name: String,
    pub created_at: String,
    pub tasks: Vec<FileBaselineTask>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FilePerson {
    pub name: String,
    pub color: String,
    /// zip 内的相对路径，如 "avatars/1.png"。为 None 表示这个人没有头像
    pub avatar_file: Option<String>,
    /// 头像不是标准 data URI 时的兜底：原样带走那个字符串。
    /// 正常情况下永远是 None —— 但「导出时静默丢掉一个头像」不可接受
    pub avatar_inline: Option<String>,
    pub sort_order: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    pub project: FileProject,
    pub tasks: Vec<FileTask>,
    pub dependencies: Vec<FileDep>,
    pub risks: Vec<FileRisk>,
    pub comments: Vec<FileComment>,
    pub daily_notes: Vec<FileNote>,
    pub baselines: Vec<FileBaseline>,
}

/// 一份读进内存的完整项目文件。
#[derive(Debug)]
pub struct Archive {
    pub manifest: Manifest,
    pub bundle: Bundle,
    pub people: Vec<FilePerson>,
    /// zip 内相对路径 → 原始字节
    pub avatars: HashMap<String, Vec<u8>>,
    /// project.json 里出现了但本版本不认识的顶层字段名
    pub unknown_sections: Vec<String>,
}

/* ------------------------------------------------------------------ */
/* 从库里取一个项目                                                     */
/* ------------------------------------------------------------------ */

/// 层级展开成一个稳定序：父在子前，同层按 (sort_order, id)。
///
/// 顺序必须只由数据决定、不能由 SQL 的返回顺序决定 —— 否则同一份数据
/// 导出两次会得到不同的字节，往返幂等测试就成了摆设。
fn stable_order(rows: &[(i64, Option<i64>, f64)]) -> Vec<i64> {
    let mut children: HashMap<Option<i64>, Vec<(f64, i64)>> = HashMap::new();
    for &(id, parent, sort) in rows {
        children.entry(parent).or_default().push((sort, id));
    }
    for v in children.values_mut() {
        v.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));
    }

    let mut out = Vec::with_capacity(rows.len());
    let mut stack: Vec<i64> = children
        .get(&None)
        .map(|v| v.iter().rev().map(|&(_, id)| id).collect())
        .unwrap_or_default();
    // 深度优先，且用 seen 兜住万一存在的环 —— repair() 已经清过自引用，
    // 但导出不该是「数据一旦有病就死循环」的那一环
    let mut seen = HashSet::new();
    while let Some(id) = stack.pop() {
        if !seen.insert(id) {
            continue;
        }
        out.push(id);
        if let Some(kids) = children.get(&Some(id)) {
            for &(_, kid) in kids.iter().rev() {
                stack.push(kid);
            }
        }
    }
    // 挂在已删父节点下的孤儿：不能丢，接在最后
    for &(id, _, _) in rows {
        if seen.insert(id) {
            out.push(id);
        }
    }
    out
}

pub fn collect(conn: &Connection, project_id: i64) -> rusqlite::Result<(Bundle, Vec<FilePerson>, HashMap<String, Vec<u8>>)> {
    let project = conn.query_row(
        "SELECT uuid, name, color, work_days, holidays, created_at, updated_at
           FROM projects WHERE id = ?1",
        params![project_id],
        |r| {
            Ok(FileProject {
                uuid: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                work_days: r.get(3)?,
                holidays: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
            })
        },
    )?;

    // 任务：先原样捞出来，再按稳定序重编号成 1..n
    struct Raw {
        id: i64,
        parent_id: Option<i64>,
        name: String,
        start_date: String,
        end_date: String,
        actual_start: Option<String>,
        actual_end: Option<String>,
        progress: f64,
        priority: i64,
        person: Option<String>,
        milestone: bool,
        weight: Option<f64>,
        collapsed: bool,
        pinned: bool,
        note: String,
        sort_order: f64,
        blocked: String,
    }

    let mut stmt = conn.prepare(
        "SELECT t.id, t.parent_id, t.name, t.start_date, t.end_date,
                t.actual_start, t.actual_end, t.progress, t.priority,
                p.name AS person, t.milestone, t.weight, t.collapsed, t.pinned,
                t.note, t.sort_order, t.blocked
           FROM tasks t LEFT JOIN people p ON p.id = t.person_id
          WHERE t.project_id = ?1",
    )?;
    let raws: Vec<Raw> = stmt
        .query_map(params![project_id], |r| {
            Ok(Raw {
                id: r.get(0)?,
                parent_id: r.get(1)?,
                name: r.get(2)?,
                start_date: r.get(3)?,
                end_date: r.get(4)?,
                actual_start: r.get(5)?,
                actual_end: r.get(6)?,
                progress: r.get(7)?,
                priority: r.get(8)?,
                person: r.get(9)?,
                milestone: r.get::<_, i64>(10)? != 0,
                weight: r.get(11)?,
                collapsed: r.get::<_, i64>(12)? != 0,
                pinned: r.get::<_, i64>(13)? != 0,
                note: r.get(14)?,
                sort_order: r.get(15)?,
                blocked: r.get(16)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;

    let shape: Vec<(i64, Option<i64>, f64)> =
        raws.iter().map(|t| (t.id, t.parent_id, t.sort_order)).collect();
    let order = stable_order(&shape);
    let mut remap: HashMap<i64, i64> = HashMap::new();
    for (i, id) in order.iter().enumerate() {
        remap.insert(*id, i as i64 + 1);
    }
    let by_id: HashMap<i64, &Raw> = raws.iter().map(|t| (t.id, t)).collect();

    let tasks: Vec<FileTask> = order
        .iter()
        .filter_map(|id| by_id.get(id))
        .map(|t| FileTask {
            id: remap[&t.id],
            // 父节点跨项目或已不存在时降级为顶层 —— 和 db::repair 同一个判断
            parent_id: t.parent_id.and_then(|p| remap.get(&p).copied()),
            name: t.name.clone(),
            start_date: t.start_date.clone(),
            end_date: t.end_date.clone(),
            actual_start: t.actual_start.clone(),
            actual_end: t.actual_end.clone(),
            progress: t.progress,
            priority: t.priority,
            person: t.person.clone(),
            milestone: t.milestone,
            weight: t.weight,
            collapsed: t.collapsed,
            pinned: t.pinned,
            note: t.note.clone(),
            sort_order: t.sort_order,
            blocked: t.blocked.clone(),
        })
        .collect();

    let mut dependencies: Vec<FileDep> = conn
        .prepare(
            "SELECT from_task_id, to_task_id, type, lag_days
               FROM dependencies WHERE project_id = ?1",
        )?
        .query_map(params![project_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter_map(|(f, t, kind, lag)| {
            Some(FileDep {
                from_task_id: *remap.get(&f)?,
                to_task_id: *remap.get(&t)?,
                kind,
                lag_days: lag,
            })
        })
        .collect();
    dependencies.sort_by_key(|d| (d.from_task_id, d.to_task_id));

    let mut risks: Vec<FileRisk> = conn
        .prepare(
            "SELECT r.task_id, r.content, r.level, r.resolved, r.created_at
               FROM risks r JOIN tasks t ON t.id = r.task_id
              WHERE t.project_id = ?1",
        )?
        .query_map(params![project_id], |r| {
            Ok(FileRisk {
                task_id: r.get(0)?,
                content: r.get(1)?,
                level: r.get(2)?,
                resolved: r.get::<_, i64>(3)? != 0,
                created_at: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter_map(|mut r| {
            r.task_id = *remap.get(&r.task_id)?;
            Some(r)
        })
        .collect();
    risks.sort_by(|a, b| (a.task_id, a.created_at, &a.content).cmp(&(b.task_id, b.created_at, &b.content)));

    let mut comments: Vec<FileComment> = conn
        .prepare(
            "SELECT c.task_id, c.content, c.created_at
               FROM comments c JOIN tasks t ON t.id = c.task_id
              WHERE t.project_id = ?1",
        )?
        .query_map(params![project_id], |r| {
            Ok(FileComment {
                task_id: r.get(0)?,
                content: r.get(1)?,
                created_at: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter_map(|mut c| {
            c.task_id = *remap.get(&c.task_id)?;
            Some(c)
        })
        .collect();
    comments.sort_by(|a, b| (a.task_id, a.created_at, &a.content).cmp(&(b.task_id, b.created_at, &b.content)));

    let mut daily_notes: Vec<FileNote> = conn
        .prepare(
            "SELECT task_id, day, content, created_at, updated_at
               FROM daily_notes WHERE project_id = ?1",
        )?
        .query_map(params![project_id], |r| {
            Ok(FileNote {
                task_id: r.get(0)?,
                day: r.get(1)?,
                content: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|mut n| {
            n.task_id = n.task_id.and_then(|t| remap.get(&t).copied());
            n
        })
        .collect();
    daily_notes.sort_by(|a, b| (&a.day, a.task_id, a.created_at, &a.content).cmp(&(&b.day, b.task_id, b.created_at, &b.content)));

    // 基线：baseline_tasks 故意不挂外键（任务删了那一行也要留着，
    // 用来显示「原计划有这条，现已删除」）。所以这里会有对不上号的 task_id ——
    // 给它们在 1..n 之后顺次发新号，既不与活任务撞车，也保住了那条记录
    let mut orphan_next = tasks.len() as i64 + 1;
    let mut orphan: HashMap<i64, i64> = HashMap::new();

    let baseline_rows: Vec<(i64, String, String)> = conn
        .prepare("SELECT id, name, created_at FROM baselines WHERE project_id = ?1 ORDER BY id")?
        .query_map(params![project_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;

    let mut baselines = Vec::with_capacity(baseline_rows.len());
    for (bid, name, created_at) in baseline_rows {
        let mut bt: Vec<FileBaselineTask> = conn
            .prepare(
                "SELECT task_id, name, start_date, end_date, duration
                   FROM baseline_tasks WHERE baseline_id = ?1 ORDER BY task_id",
            )?
            .query_map(params![bid], |r| {
                Ok(FileBaselineTask {
                    task_id: r.get(0)?,
                    name: r.get(1)?,
                    start_date: r.get(2)?,
                    end_date: r.get(3)?,
                    duration: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        for t in bt.iter_mut() {
            t.task_id = match remap.get(&t.task_id) {
                Some(n) => *n,
                None => *orphan.entry(t.task_id).or_insert_with(|| {
                    let n = orphan_next;
                    orphan_next += 1;
                    n
                }),
            };
        }
        bt.sort_by_key(|t| t.task_id);
        baselines.push(FileBaseline { name, created_at, tasks: bt });
    }

    // 人员：只带这个项目真正用到的。people 表是全局的，把整张表塞进去
    // 等于让「传一个项目」顺手改掉对方机器上所有项目的人员列表
    let used: HashSet<&str> = tasks.iter().filter_map(|t| t.person.as_deref()).collect();
    let mut people: Vec<FilePerson> = Vec::new();
    let mut avatars: HashMap<String, Vec<u8>> = HashMap::new();

    let all: Vec<(String, String, Option<String>, f64)> = conn
        .prepare("SELECT name, color, avatar, sort_order FROM people ORDER BY sort_order, id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;

    for (name, color, avatar, sort_order) in all {
        if !used.contains(name.as_str()) {
            continue;
        }
        let mut avatar_file = None;
        let mut avatar_inline = None;
        if let Some(uri) = avatar {
            match split_data_uri(&uri) {
                Some((mime, b64)) => match decode_base64(b64) {
                    Ok(bytes) => {
                        // 文件名用序号而不是人名：人名可能含 / 或非 ASCII，
                        // 而 zip 的文件名编码在各平台解压工具里表现不一
                        let path = format!("avatars/{}.{}", people.len() + 1, ext_for(mime));
                        avatars.insert(path.clone(), bytes);
                        avatar_file = Some(path);
                    }
                    Err(_) => avatar_inline = Some(uri.clone()),
                },
                None => avatar_inline = Some(uri.clone()),
            }
        }
        people.push(FilePerson { name, color, avatar_file, avatar_inline, sort_order });
    }

    Ok((
        Bundle { project, tasks, dependencies, risks, comments, daily_notes, baselines },
        people,
        avatars,
    ))
}

fn split_data_uri(uri: &str) -> Option<(&str, &str)> {
    let rest = uri.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    Some((meta.strip_suffix(";base64")?, data))
}

fn ext_for(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/svg+xml" => "svg",
        _ => "bin",
    }
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

/* ------------------------------------------------------------------ */
/* zip 读写                                                            */
/* ------------------------------------------------------------------ */

/// JSON 一律 pretty-print。
///
/// 体积代价被 deflate 吃掉了（缩进是全世界最好压的东西），换来的是：
/// 把 .ganttproj 改名成 .zip 解开，里面是人能读、能 diff、必要时能手改的文本。
/// 一个自己都打不开的备份格式，出事时给不了任何安全感。
fn to_json<T: Serialize>(v: &T) -> Result<Vec<u8>> {
    serde_json::to_vec_pretty(v).map_err(|e| format!("序列化失败：{e}"))
}

pub fn write_archive(
    path: &Path,
    app_version: &str,
    exported_at: &str,
    bundle: &Bundle,
    people: &[FilePerson],
    avatars: &HashMap<String, Vec<u8>>,
) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败：{e}"))?;
    }

    let manifest = Manifest {
        format_version: format!("{FORMAT_MAJOR}.{FORMAT_MINOR}"),
        app: "gantt".into(),
        app_version: app_version.into(),
        exported_at: exported_at.into(),
        project_name: bundle.project.name.clone(),
        project_uuid: bundle.project.uuid.clone(),
    };

    // 先在内存里拼完整个 zip，成功之后才落盘。
    // 直接往目标路径写的话，中途失败会在用户的云盘目录里留下一个
    // 大小合适、结构残缺的 .ganttproj —— 那种文件比没有文件危险得多
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut zw = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        let mut put = |name: &str, bytes: &[u8]| -> Result<()> {
            zw.start_file(name, opts).map_err(|e| format!("写入 {name} 失败：{e}"))?;
            zw.write_all(bytes).map_err(|e| format!("写入 {name} 失败：{e}"))
        };

        put("manifest.json", &to_json(&manifest)?)?;
        put("project.json", &to_json(bundle)?)?;
        put("people.json", &to_json(&people)?)?;

        // 顺序固定，否则同一份数据导出两次得到不同的 zip
        let mut names: Vec<&String> = avatars.keys().collect();
        names.sort();
        for name in names {
            put(name, &avatars[name])?;
        }

        zw.finish().map_err(|e| format!("收尾失败：{e}"))?;
    }

    std::fs::write(path, buf.into_inner()).map_err(|e| format!("写入失败：{e}"))
}

pub fn read_archive(path: &Path) -> Result<Archive> {
    let file = std::fs::File::open(path)
        .map_err(|e| format!("打不开这个文件：{e}"))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|_| "这不是一个有效的项目文件（内容不是 zip 容器）".to_string())?;

    let read_entry = |zip: &mut zip::ZipArchive<std::fs::File>, name: &str| -> Result<Vec<u8>> {
        let mut f = zip
            .by_name(name)
            .map_err(|_| format!("这不是一个有效的项目文件（缺少 {name}）"))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).map_err(|e| format!("读取 {name} 失败：{e}"))?;
        Ok(buf)
    };

    let manifest: Manifest = serde_json::from_slice(&read_entry(&mut zip, "manifest.json")?)
        .map_err(|e| format!("manifest.json 解析失败：{e}"))?;

    let project_bytes = read_entry(&mut zip, "project.json")?;
    let bundle: Bundle = serde_json::from_slice(&project_bytes)
        .map_err(|e| format!("project.json 解析失败：{e}"))?;

    // 顶层多出来的段落 = 更新版本写进去的新东西。serde 默认静默忽略未知字段，
    // 这里再单独看一眼，好让用户知道「你这次导入拿到的不是文件的全部」
    let known = ["project", "tasks", "dependencies", "risks", "comments", "dailyNotes", "baselines"];
    let unknown_sections = serde_json::from_slice::<serde_json::Value>(&project_bytes)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .map(|o| {
            o.keys()
                .filter(|k| !known.contains(&k.as_str()))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let people: Vec<FilePerson> = serde_json::from_slice(&read_entry(&mut zip, "people.json")?)
        .map_err(|e| format!("people.json 解析失败：{e}"))?;

    let mut avatars = HashMap::new();
    for p in &people {
        if let Some(file) = &p.avatar_file {
            // 头像读不出来不该让整次导入失败 —— 它是装饰，人和任务才是数据。
            // 静默降级成首字母头像，并在预检里作为提示告诉用户
            if let Ok(bytes) = read_entry(&mut zip, file) {
                avatars.insert(file.clone(), bytes);
            }
        }
    }

    Ok(Archive { manifest, bundle, people, avatars, unknown_sections })
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

fn parse_version(s: &str) -> Option<(u32, u32)> {
    let (a, b) = s.split_once('.')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
}

fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    if !b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit()) {
        return false;
    }
    let m: u32 = s[5..7].parse().unwrap_or(0);
    let d: u32 = s[8..10].parse().unwrap_or(0);
    (1..=12).contains(&m) && (1..=31).contains(&d)
}

/// 任务名可能很长；报错里要能认出是哪一条，又不能把整行日志撑爆。
fn label(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return "（未命名任务）".into();
    }
    let s: String = trimmed.chars().take(20).collect();
    if s.chars().count() < trimmed.chars().count() {
        format!("「{s}…」")
    } else {
        format!("「{s}」")
    }
}

/// 写库之前把整份数据验一遍，返回**人话**的问题清单。
///
/// 这些条件和 schema 里的 CHECK / 触发器一一对应。之所以不直接靠数据库
/// ABORT 兜底：那时用户看到的是 `SQLITE_CONSTRAINT: CHECK constraint failed`，
/// 既不知道哪一条任务有问题，也不知道该怎么办。
pub fn validate(a: &Archive) -> Vec<String> {
    let mut problems = Vec::new();
    let b = &a.bundle;

    if b.project.name.trim().is_empty() {
        problems.push("项目名为空".into());
    }
    if b.project.uuid.trim().is_empty() {
        problems.push("项目缺少身份标识（uuid）".into());
    }
    for (field, v) in [("工作日", &b.project.work_days), ("节假日", &b.project.holidays)] {
        if serde_json::from_str::<Vec<serde_json::Value>>(v).is_err() {
            problems.push(format!("项目的{field}配置不是合法的 JSON 数组"));
        }
    }

    let ids: HashSet<i64> = b.tasks.iter().map(|t| t.id).collect();
    if ids.len() != b.tasks.len() {
        problems.push("任务 id 有重复".into());
    }

    let people_names: HashSet<&str> = a.people.iter().map(|p| p.name.as_str()).collect();
    if people_names.len() != a.people.len() {
        problems.push("负责人名单里有重名".into());
    }
    for p in &a.people {
        if p.name.trim().is_empty() {
            problems.push("有一个负责人的名字为空".into());
        }
    }

    for t in &b.tasks {
        let l = label(&t.name);
        if !is_iso_date(&t.start_date) || !is_iso_date(&t.end_date) {
            problems.push(format!("任务{l}：日期不是 YYYY-MM-DD 格式"));
        } else if t.end_date < t.start_date {
            problems.push(format!(
                "任务{l}：结束日期（{}）早于开始日期（{}）",
                t.end_date, t.start_date
            ));
        }
        match (&t.actual_start, &t.actual_end) {
            (Some(s), Some(e)) => {
                if !is_iso_date(s) || !is_iso_date(e) {
                    problems.push(format!("任务{l}：实施日期不是 YYYY-MM-DD 格式"));
                } else if e < s {
                    problems.push(format!("任务{l}：实施结束日期早于实施开始日期"));
                }
            }
            (Some(_), None) => problems.push(format!("任务{l}：只填了实施开始，没有实施结束")),
            (None, Some(_)) => problems.push(format!("任务{l}：只填了实施结束，没有实施开始")),
            (None, None) => {}
        }
        if !(0.0..=1.0).contains(&t.progress) || t.progress.is_nan() {
            problems.push(format!("任务{l}：进度 {} 不在 0–1 之间", t.progress));
        }
        if !(0..=3).contains(&t.priority) {
            problems.push(format!("任务{l}：紧急度 {} 不在 0–3 之间", t.priority));
        }
        if let Some(w) = t.weight {
            if !(w > 0.0) {
                problems.push(format!("任务{l}：权重必须大于 0"));
            }
        }
        if serde_json::from_str::<Vec<serde_json::Value>>(&t.blocked).is_err() {
            problems.push(format!("任务{l}：受阻时段不是合法的 JSON 数组"));
        }
        if let Some(p) = &t.parent_id {
            if *p == t.id {
                problems.push(format!("任务{l}：自己是自己的父任务"));
            } else if !ids.contains(p) {
                problems.push(format!("任务{l}：父任务在文件里不存在"));
            }
        }
        if let Some(person) = &t.person {
            if !people_names.contains(person.as_str()) {
                problems.push(format!("任务{l}：负责人「{person}」不在 people.json 里"));
            }
        }
    }

    // 环：展平时会死循环，必须在写库前挡掉（库层没有这个约束）
    let parent: HashMap<i64, Option<i64>> = b.tasks.iter().map(|t| (t.id, t.parent_id)).collect();
    for t in &b.tasks {
        let mut cur = t.parent_id;
        let mut hops = 0;
        while let Some(p) = cur {
            if p == t.id {
                problems.push(format!("任务{}：父子关系成环", label(&t.name)));
                break;
            }
            hops += 1;
            if hops > b.tasks.len() {
                break;
            }
            cur = parent.get(&p).copied().flatten();
        }
    }

    let mut seen_dep = HashSet::new();
    for d in &b.dependencies {
        if d.from_task_id == d.to_task_id {
            problems.push("有一条依赖的起点和终点是同一个任务".into());
        }
        if !ids.contains(&d.from_task_id) || !ids.contains(&d.to_task_id) {
            problems.push("有一条依赖指向文件里不存在的任务".into());
        }
        if !["FS", "SS", "FF", "SF"].contains(&d.kind.as_str()) {
            problems.push(format!("依赖类型「{}」不认识", d.kind));
        }
        if !seen_dep.insert((d.from_task_id, d.to_task_id)) {
            problems.push("有两条完全重复的依赖".into());
        }
    }

    for r in &b.risks {
        if !ids.contains(&r.task_id) {
            problems.push("有一条风险点挂在文件里不存在的任务上".into());
        }
        if !(0..=2).contains(&r.level) {
            problems.push(format!("风险点「{}」的等级 {} 不在 0–2 之间", label(&r.content), r.level));
        }
    }
    for c in &b.comments {
        if !ids.contains(&c.task_id) {
            problems.push("有一条评论挂在文件里不存在的任务上".into());
        }
    }
    for n in &b.daily_notes {
        if !is_iso_date(&n.day) {
            problems.push(format!("当日记录{}：日期不是 YYYY-MM-DD 格式", label(&n.content)));
        }
        if let Some(t) = n.task_id {
            if !ids.contains(&t) {
                problems.push("有一条当日记录挂在文件里不存在的任务上".into());
            }
        }
    }

    // 同一条报错可能被几十行数据同时触发，去重后再给用户看
    let mut seen = HashSet::new();
    problems.retain(|p| seen.insert(p.clone()));
    problems.truncate(20);
    problems
}

/* ------------------------------------------------------------------ */
/* 预检                                                                */
/* ------------------------------------------------------------------ */

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SideSummary {
    pub name: String,
    pub task_count: i64,
    pub people_count: i64,
    pub risk_count: i64,
    pub comment_count: i64,
    pub daily_note_count: i64,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    /// Unix 秒字符串，格式化交给前端
    pub updated_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    /// 非空 = 不能导入。全有或全无，这里有一条就一条都不写
    pub problems: Vec<String>,
    /// 能导入，但用户应该知道的事（版本更新、头像缺失等）
    pub warnings: Vec<String>,
    pub file: SideSummary,
    /// 本机匹配到的项目；None = 全新项目
    pub existing: Option<SideSummary>,
    /// "uuid" | "name"，说明是怎么认出来的
    pub matched_by: Option<String>,
    pub target_id: Option<i64>,
    /// 覆盖会把本机项目改成这个名字（None = 名字没变）
    pub rename_to: Option<String>,
    /// rename_to 撞上了本机**另一个**项目，用户必须当场改名才能继续
    pub name_conflict: bool,
    /// 建议填进「新名称」输入框的值
    pub suggested_name: String,
}

fn local_summary(conn: &Connection, id: i64) -> rusqlite::Result<SideSummary> {
    let (name, updated_at) = conn.query_row(
        "SELECT name, updated_at FROM projects WHERE id = ?1",
        params![id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )?;
    let (task_count, start_date, end_date) = conn.query_row(
        "SELECT COUNT(*), MIN(start_date), MAX(end_date) FROM tasks WHERE project_id = ?1",
        params![id],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?)),
    )?;
    let one = |sql: &str| -> rusqlite::Result<i64> { conn.query_row(sql, params![id], |r| r.get(0)) };
    Ok(SideSummary {
        name,
        task_count,
        people_count: one(
            "SELECT COUNT(DISTINCT person_id) FROM tasks
              WHERE project_id = ?1 AND person_id IS NOT NULL",
        )?,
        risk_count: one(
            "SELECT COUNT(*) FROM risks r JOIN tasks t ON t.id = r.task_id
              WHERE t.project_id = ?1",
        )?,
        comment_count: one(
            "SELECT COUNT(*) FROM comments c JOIN tasks t ON t.id = c.task_id
              WHERE t.project_id = ?1",
        )?,
        daily_note_count: one("SELECT COUNT(*) FROM daily_notes WHERE project_id = ?1")?,
        start_date,
        end_date,
        updated_at,
    })
}

fn file_summary(a: &Archive) -> SideSummary {
    let b = &a.bundle;
    SideSummary {
        name: b.project.name.clone(),
        task_count: b.tasks.len() as i64,
        people_count: a.people.len() as i64,
        risk_count: b.risks.len() as i64,
        comment_count: b.comments.len() as i64,
        daily_note_count: b.daily_notes.len() as i64,
        start_date: b.tasks.iter().map(|t| &t.start_date).min().cloned(),
        end_date: b.tasks.iter().map(|t| &t.end_date).max().cloned(),
        updated_at: b.project.updated_at.clone(),
    }
}

/// 版本闸门。major 不同直接拒绝，minor 更高只提示。
fn version_gate(a: &Archive) -> (Vec<String>, Vec<String>) {
    let mut problems = Vec::new();
    let mut warnings = Vec::new();
    match parse_version(&a.manifest.format_version) {
        None => problems.push(format!(
            "格式版本「{}」无法识别",
            a.manifest.format_version
        )),
        Some((major, minor)) => {
            if major > FORMAT_MAJOR {
                problems.push(format!(
                    "这个文件来自更新版本的 Gantt（格式 {major}.{minor}，本机支持 {FORMAT_MAJOR}.x）。请先升级本机的 Gantt。"
                ));
            } else if major < FORMAT_MAJOR {
                problems.push(format!(
                    "这个文件来自旧版格式（{major}.{minor}），本机支持 {FORMAT_MAJOR}.x，无法直接导入。"
                ));
            } else if minor > FORMAT_MINOR {
                let extra = if a.unknown_sections.is_empty() {
                    String::new()
                } else {
                    format!("（{}）", a.unknown_sections.join("、"))
                };
                warnings.push(format!(
                    "文件来自更新的 Gantt（格式 {major}.{minor}，本机 {FORMAT_MAJOR}.{FORMAT_MINOR}）。已导入所有本版本认识的内容，较新的部分{extra}被忽略 —— 升级后重新导入可得到完整数据。"
                ));
            }
        }
    }
    let missing = a
        .people
        .iter()
        .filter(|p| p.avatar_file.as_ref().is_some_and(|f| !a.avatars.contains_key(f)))
        .count();
    if missing > 0 {
        warnings.push(format!("{missing} 个头像文件在压缩包里缺失，这些人会回退到首字母头像。"));
    }
    (problems, warnings)
}

pub fn preview(conn: &Connection, a: &Archive) -> rusqlite::Result<ImportPreview> {
    let (mut problems, warnings) = version_gate(a);
    problems.extend(validate(a));

    // uuid 优先、名字兜底（见 migrations/007_project_identity.sql）
    let by_uuid: Option<i64> = conn
        .query_row(
            "SELECT id FROM projects WHERE uuid = ?1",
            params![a.bundle.project.uuid],
            |r| r.get(0),
        )
        .optional()?;
    let matched = match by_uuid {
        Some(id) => Some((id, "uuid")),
        None => conn
            .query_row(
                "SELECT id FROM projects WHERE name = ?1",
                params![a.bundle.project.name],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .map(|id| (id, "name")),
    };

    let file = file_summary(a);
    let mut rename_to = None;
    let mut name_conflict = false;
    let mut existing = None;

    if let Some((id, _)) = matched {
        let local = local_summary(conn, id)?;
        if local.name != file.name {
            rename_to = Some(file.name.clone());
            name_conflict = conn
                .query_row(
                    "SELECT 1 FROM projects WHERE name = ?1 AND id <> ?2",
                    params![file.name, id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
        }
        existing = Some(local);
    }

    Ok(ImportPreview {
        problems,
        warnings,
        suggested_name: file.name.clone(),
        file,
        existing,
        matched_by: matched.map(|(_, how)| how.to_string()),
        target_id: matched.map(|(id, _)| id),
        rename_to,
        name_conflict,
    })
}

/* ------------------------------------------------------------------ */
/* 落库                                                                */
/* ------------------------------------------------------------------ */

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub project_id: i64,
    pub name: String,
    pub overwritten: bool,
    /// 覆盖前旧版被存到了哪里；用户点「撤销」时把它再导入一次即可
    pub backup_path: Option<String>,
    pub task_count: i64,
    /// 本机原本没有、这次新建出来的负责人
    pub new_people: Vec<String>,
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 深度，用来保证插入时父在子前 —— tasks.parent_id 上有外键，
/// 先插子任务会直接违反约束。导出件本来就是父在子前的，但导入的文件
/// 也可能是别人手改过的，不能假设。
fn depth_of(id: i64, parent: &HashMap<i64, Option<i64>>) -> usize {
    let mut d = 0;
    let mut cur = parent.get(&id).copied().flatten();
    while let Some(p) = cur {
        d += 1;
        if d > parent.len() {
            break;
        }
        cur = parent.get(&p).copied().flatten();
    }
    d
}

pub fn apply(
    conn: &mut Connection,
    a: &Archive,
    target_id: Option<i64>,
    name: &str,
    backup_path: Option<String>,
) -> Result<ImportOutcome> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let ts = now_secs().to_string();

    // ---- 人员：同名即同人，本地优先，头像缺失才补 ----
    let mut person_id: HashMap<&str, i64> = HashMap::new();
    let mut new_people = Vec::new();
    for p in &a.people {
        let avatar = p
            .avatar_file
            .as_ref()
            .and_then(|f| a.avatars.get(f).map(|bytes| (f, bytes)))
            .map(|(f, bytes)| format!("data:{};base64,{}", mime_for(f), encode_base64(bytes)))
            .or_else(|| p.avatar_inline.clone());

        let found: Option<(i64, Option<String>)> = tx
            .query_row(
                "SELECT id, avatar FROM people WHERE name = ?1",
                params![p.name],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        match found {
            Some((id, existing_avatar)) => {
                // 颜色一律不动：people 是全局表，改一下会连带改掉本机
                // 所有其他项目里这个人的甘特条颜色。头像只在本机为空时补 ——
                // 纯增量，不可能让现状变差
                if existing_avatar.is_none() {
                    if let Some(uri) = &avatar {
                        tx.execute(
                            "UPDATE people SET avatar = ?2 WHERE id = ?1",
                            params![id, uri],
                        )
                        .map_err(|e| e.to_string())?;
                    }
                }
                person_id.insert(p.name.as_str(), id);
            }
            None => {
                tx.execute(
                    "INSERT INTO people (name, color, avatar, sort_order, created_at)
                     VALUES (?1, ?2, ?3,
                             (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM people), ?4)",
                    params![p.name, p.color, avatar, ts],
                )
                .map_err(|e| e.to_string())?;
                person_id.insert(p.name.as_str(), tx.last_insert_rowid());
                new_people.push(p.name.clone());
            }
        }
    }

    // ---- 项目行 ----
    let project_id = match target_id {
        Some(id) => {
            tx.execute(
                "UPDATE projects
                    SET name = ?2, color = ?3, work_days = ?4, holidays = ?5,
                        uuid = ?6, updated_at = ?7
                  WHERE id = ?1",
                params![
                    id,
                    name,
                    a.bundle.project.color,
                    a.bundle.project.work_days,
                    a.bundle.project.holidays,
                    a.bundle.project.uuid,
                    a.bundle.project.updated_at,
                ],
            )
            .map_err(|e| name_taken(e, name))?;

            // 旧内容清空。risks / comments 挂在 tasks 上，靠 ON DELETE CASCADE
            // 跟着走；项目级的 daily_notes 没有任务可挂，单独删
            for sql in [
                "DELETE FROM dependencies WHERE project_id = ?1",
                "DELETE FROM baselines WHERE project_id = ?1",
                "DELETE FROM daily_notes WHERE project_id = ?1",
                "DELETE FROM tasks WHERE project_id = ?1",
            ] {
                tx.execute(sql, params![id]).map_err(|e| e.to_string())?;
            }
            id
        }
        None => {
            tx.execute(
                "INSERT INTO projects (name, color, uuid, work_days, holidays,
                                       sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5,
                         (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM projects), ?6, ?7)",
                params![
                    name,
                    a.bundle.project.color,
                    a.bundle.project.uuid,
                    a.bundle.project.work_days,
                    a.bundle.project.holidays,
                    a.bundle.project.created_at,
                    a.bundle.project.updated_at,
                ],
            )
            .map_err(|e| name_taken(e, name))?;
            tx.last_insert_rowid()
        }
    };

    // ---- 任务：文件内 id → 本机 id ----
    //
    // tasks.id 是**全局**主键，不能沿用文件里的 1..n —— 那必然撞上其他项目
    // 已有的行。这正是 db::repair 要收拾的那个历史 bug 的成因
    let base: i64 = tx
        .query_row("SELECT COALESCE(MAX(id), 0) FROM tasks", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let remap: HashMap<i64, i64> = a
        .bundle
        .tasks
        .iter()
        .enumerate()
        .map(|(i, t)| (t.id, base + 1 + i as i64))
        .collect();

    let parent_of: HashMap<i64, Option<i64>> =
        a.bundle.tasks.iter().map(|t| (t.id, t.parent_id)).collect();
    let mut ordered: Vec<&FileTask> = a.bundle.tasks.iter().collect();
    ordered.sort_by_key(|t| depth_of(t.id, &parent_of));

    for t in &ordered {
        tx.execute(
            "INSERT INTO tasks (id, project_id, parent_id, name, start_date, end_date,
                                actual_start, actual_end, progress, priority, person_id,
                                milestone, weight, collapsed, pinned, note, sort_order,
                                blocked, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                     ?16, ?17, ?18, ?19, ?19)",
            params![
                remap[&t.id],
                project_id,
                t.parent_id.map(|p| remap[&p]),
                t.name,
                t.start_date,
                t.end_date,
                t.actual_start,
                t.actual_end,
                t.progress,
                t.priority,
                t.person.as_deref().and_then(|n| person_id.get(n).copied()),
                t.milestone as i64,
                t.weight,
                t.collapsed as i64,
                t.pinned as i64,
                t.note,
                t.sort_order,
                t.blocked,
                ts,
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for d in &a.bundle.dependencies {
        tx.execute(
            "INSERT INTO dependencies (project_id, from_task_id, to_task_id, type, lag_days)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![project_id, remap[&d.from_task_id], remap[&d.to_task_id], d.kind, d.lag_days],
        )
        .map_err(|e| e.to_string())?;
    }
    for r in &a.bundle.risks {
        tx.execute(
            "INSERT INTO risks (task_id, content, level, resolved, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![remap[&r.task_id], r.content, r.level, r.resolved as i64, r.created_at],
        )
        .map_err(|e| e.to_string())?;
    }
    for c in &a.bundle.comments {
        tx.execute(
            "INSERT INTO comments (task_id, content, created_at) VALUES (?1, ?2, ?3)",
            params![remap[&c.task_id], c.content, c.created_at],
        )
        .map_err(|e| e.to_string())?;
    }
    for n in &a.bundle.daily_notes {
        tx.execute(
            "INSERT INTO daily_notes (project_id, task_id, day, content, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                project_id,
                n.task_id.map(|t| remap[&t]),
                n.day,
                n.content,
                n.created_at,
                n.updated_at
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    for b in &a.bundle.baselines {
        tx.execute(
            "INSERT INTO baselines (project_id, name, created_at) VALUES (?1, ?2, ?3)",
            params![project_id, b.name, b.created_at],
        )
        .map_err(|e| e.to_string())?;
        let bid = tx.last_insert_rowid();
        for t in &b.tasks {
            // 对不上号的 task_id 是「原计划有这条、现已删除」，故意保留
            // （baseline_tasks 没有外键，见 001_init.sql）
            tx.execute(
                "INSERT INTO baseline_tasks (baseline_id, task_id, name, start_date, end_date, duration)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    bid,
                    remap.get(&t.task_id).copied().unwrap_or(base + 1_000_000 + t.task_id),
                    t.name,
                    t.start_date,
                    t.end_date,
                    t.duration
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;

    Ok(ImportOutcome {
        project_id,
        name: name.to_string(),
        overwritten: target_id.is_some(),
        backup_path,
        task_count: a.bundle.tasks.len() as i64,
        new_people,
    })
}

/* ------------------------------------------------------------------ */
/* Tauri 命令                                                          */
/* ------------------------------------------------------------------ */

/// 把一个项目导出成 `.ganttproj`。
///
/// 只在项目列表页调用，也就是说项目此刻一定是关闭状态 —— 内存里没有比库
/// 更新的编辑（`closeProject` 已经 `await persistence.flush()` 过了），
/// 直接读库就是当下唯一确定的口径。
#[tauri::command]
pub fn export_project(
    app: tauri::AppHandle,
    db: tauri::State<Db>,
    project_id: i64,
    path: String,
) -> Result<String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let (bundle, people, avatars) = collect(&conn, project_id).map_err(|e| e.to_string())?;
    let path = PathBuf::from(path);
    write_archive(
        &path,
        &app.package_info().version.to_string(),
        &now_secs().to_string(),
        &bundle,
        &people,
        &avatars,
    )?;
    Ok(path.to_string_lossy().into_owned())
}

/// 读文件、校验、和本机现有项目对号 —— 但**一个字都不写库**。
#[tauri::command]
pub fn inspect_import(db: tauri::State<Db>, path: String) -> Result<ImportPreview> {
    let archive = read_archive(Path::new(&path))?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    preview(&conn, &archive).map_err(|e| e.to_string())
}

/// 真正落库。
///
/// 文件在这里**重新读一遍、重新校验一遍**，不复用预检的结果 ——
/// 预检和确认之间隔着用户的思考时间，那期间文件可能被云盘同步换掉、
/// 被拔掉的 U 盘带走、或者被另一个进程改写。
///
/// `backup_stamp` 由前端给：本机时区只有渲染层知道，Rust 这边的 std
/// 拿不到时区，自己拼出来的会是 UTC —— 一个写着 06:02 的「覆盖前」备份
/// 在下午两点的用户眼里就是个谜。
#[tauri::command]
pub fn commit_import(
    app: tauri::AppHandle,
    db: tauri::State<Db>,
    path: String,
    target_id: Option<i64>,
    name: String,
    backup_stamp: String,
) -> Result<ImportOutcome> {
    let archive = read_archive(Path::new(&path))?;

    let (gate, _) = version_gate(&archive);
    let mut problems = gate;
    problems.extend(validate(&archive));
    if !problems.is_empty() {
        return Err(problems.join("\n"));
    }

    let mut conn = db.0.lock().map_err(|e| e.to_string())?;

    // 覆盖前先把本机版整份导成一个 .ganttproj。
    // 用的是和正常导出完全相同的那条代码路径，所以「撤销」不需要第二套恢复
    // 逻辑 —— 把这个文件再导入一次就是了
    let backup_path = match target_id {
        None => None,
        Some(id) => {
            let (bundle, people, avatars) = collect(&conn, id).map_err(|e| e.to_string())?;
            let dir = app
                .path_resolver_backups()
                .ok_or_else(|| "找不到数据目录".to_string())?;
            let file = dir.join(format!(
                "{}-覆盖前-{}.{}",
                safe_stem(&bundle.project.name),
                backup_stamp,
                EXT
            ));
            write_archive(
                &file,
                &app.package_info().version.to_string(),
                &now_secs().to_string(),
                &bundle,
                &people,
                &avatars,
            )?;
            Some(file.to_string_lossy().into_owned())
        }
    };

    apply(&mut conn, &archive, target_id, &name, backup_path)
}

/// 文件名里不能出现的字符换成下划线。
/// 项目名是自由文本，`/` 在 macOS 上会被当成路径分隔符，直接写就落到别处去了。
pub fn safe_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "项目".into()
    } else {
        trimmed.chars().take(60).collect()
    }
}

/// `backups/` 目录，没有就建出来。和滚动备份共用一个目录 ——
/// 用户找「我的东西存哪了」时只需要记住一个地方。
trait BackupDir {
    fn path_resolver_backups(&self) -> Option<PathBuf>;
}

impl BackupDir for tauri::AppHandle {
    fn path_resolver_backups(&self) -> Option<PathBuf> {
        use tauri::Manager;
        let dir = self.path().app_config_dir().ok()?.join("backups");
        std::fs::create_dir_all(&dir).ok()?;
        Some(dir)
    }
}

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::MIGRATIONS;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        for sql in MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    /// 一个尽量把所有表都用上的项目 —— 少一张表，往返测试就少覆盖一块。
    fn seed(conn: &Connection, name: &str) -> i64 {
        conn.execute(
            "INSERT INTO projects (name, color, uuid, work_days, holidays, created_at, updated_at)
             VALUES (?1, '#4f46e5', 'uuid-fixed-0001', '[1,2,3,4,5]', '[\"2026-10-01\"]', '100', '200')",
            params![name],
        )
        .unwrap();
        let pid = conn.last_insert_rowid();

        // 一个有头像、一个没有
        conn.execute(
            "INSERT INTO people (name, color, avatar, sort_order, created_at)
             VALUES ('张三', '#0ea5e9', 'data:image/png;base64,UEsDBBQA', 1, '0'),
                    ('李四', '#059669', NULL, 2, '0')",
            [],
        )
        .unwrap();
        let zhang: i64 = conn
            .query_row("SELECT id FROM people WHERE name = '张三'", [], |r| r.get(0))
            .unwrap();
        let li: i64 = conn
            .query_row("SELECT id FROM people WHERE name = '李四'", [], |r| r.get(0))
            .unwrap();

        let task = |parent: Option<i64>, name: &str, s: &str, e: &str, person: Option<i64>, sort: f64| {
            conn.execute(
                "INSERT INTO tasks (project_id, parent_id, name, start_date, end_date,
                                    actual_start, actual_end, progress, priority, person_id,
                                    milestone, note, sort_order, blocked, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, 0.5, 1, ?6, 0, '备注', ?7,
                         '[{\"id\":\"b1\",\"from\":\"2026-03-02\",\"to\":\"2026-03-03\"}]', '0', '0')",
                params![pid, parent, name, s, e, person, sort],
            )
            .unwrap();
            conn.last_insert_rowid()
        };

        let root = task(None, "地基", "2026-03-01", "2026-03-20", Some(zhang), 1.0);
        let child = task(Some(root), "放线", "2026-03-01", "2026-03-05", Some(li), 1.0);
        let other = task(None, "主体", "2026-03-21", "2026-05-01", None, 2.0);

        conn.execute(
            "INSERT INTO dependencies (project_id, from_task_id, to_task_id, type, lag_days)
             VALUES (?1, ?2, ?3, 'FS', 2)",
            params![pid, root, other],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO risks (task_id, content, level, resolved, created_at)
             VALUES (?1, '雨季延误', 0, 0, 1700000000)",
            params![child],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO comments (task_id, content, created_at)
             VALUES (?1, '已联系监理', 1700000100)",
            params![child],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO daily_notes (project_id, task_id, day, content, created_at, updated_at)
             VALUES (?1, ?2, '2026-03-02', '下雨停工', 1700000200, 1700000200),
                    (?1, NULL, '2026-03-03', '全场例会', 1700000300, 1700000300)",
            params![pid, child],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO baselines (project_id, name, created_at) VALUES (?1, '初版', '300')",
            params![pid],
        )
        .unwrap();
        let bid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO baseline_tasks (baseline_id, task_id, name, start_date, end_date, duration)
             VALUES (?1, ?2, '地基', '2026-03-01', '2026-03-18', 18),
                    (?1, 99999, '已删掉的任务', '2026-03-01', '2026-03-02', 2)",
            params![bid, root],
        )
        .unwrap();
        pid
    }

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("gantt-transfer-test");
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    /**
     * 往返幂等 —— 本模块最重要的一条测试。
     *
     * 导出 → 导入到另一个库 → 再导出，两次的 project.json / people.json
     * 必须逐字节相同。一条断言同时挡住三类 bug：
     *   · 某个字段没被导出（第二次就缺了）
     *   · 某个字段导入时丢了（第二次变成默认值）
     *   · 排序不稳定（同样的数据两次导出字节不同）
     *
     * 写十个「assert 某字段还在」的零散断言，也覆盖不到第三类。
     */
    #[test]
    fn round_trip_is_byte_identical() {
        let a = mem();
        let pid = seed(&a, "厂房建设");
        let (bundle1, people1, avatars1) = collect(&a, pid).unwrap();

        let path = tmp("round.ganttproj");
        write_archive(&path, "0.1.0", "999", &bundle1, &people1, &avatars1).unwrap();

        let archive = read_archive(&path).unwrap();
        assert!(validate(&archive).is_empty(), "{:?}", validate(&archive));

        let mut b = mem();
        // 目标库里先放一个别的项目和一堆任务，好让 id 分配范围完全错开 ——
        // 如果哪里还在沿用文件里的 id，这一步会立刻暴露
        seed(&b, "干扰项目");
        b.execute("UPDATE projects SET uuid = 'other' WHERE name = '干扰项目'", []).unwrap();

        let outcome = apply(&mut b, &archive, None, "厂房建设", None).unwrap();
        assert_eq!(outcome.task_count, 3);

        let (bundle2, people2, avatars2) = collect(&b, outcome.project_id).unwrap();
        assert_eq!(to_json(&bundle1).unwrap(), to_json(&bundle2).unwrap());
        assert_eq!(to_json(&people1).unwrap(), to_json(&people2).unwrap());
        assert_eq!(avatars1, avatars2);

        let _ = std::fs::remove_file(&path);
    }

    /// 头像必须真的还原成 PNG 文件，而不是留在 JSON 里的 base64 字符串。
    #[test]
    fn avatars_become_real_files() {
        let a = mem();
        let pid = seed(&a, "P");
        let (_, people, avatars) = collect(&a, pid).unwrap();

        let zhang = people.iter().find(|p| p.name == "张三").unwrap();
        assert_eq!(zhang.avatar_file.as_deref(), Some("avatars/1.png"));
        assert!(zhang.avatar_inline.is_none());
        // "UEsDBBQA" 解出来就是 PK\x03\x04\x14\x00
        assert_eq!(avatars["avatars/1.png"], vec![0x50, 0x4B, 0x03, 0x04, 0x14, 0x00]);

        let li = people.iter().find(|p| p.name == "李四").unwrap();
        assert!(li.avatar_file.is_none());
    }

    /// 只带这个项目用到的人。people 是全局表，整张塞进去等于让「传一个项目」
    /// 顺手改掉对方机器上所有项目的人员列表。
    #[test]
    fn only_exports_people_in_use() {
        let a = mem();
        let pid = seed(&a, "P");
        a.execute(
            "INSERT INTO people (name, color, sort_order, created_at)
             VALUES ('王五', '#f97316', 9, '0')",
            [],
        )
        .unwrap();
        let (_, people, _) = collect(&a, pid).unwrap();
        assert_eq!(
            people.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            vec!["张三", "李四"]
        );
    }

    /// 同名即同人：颜色一律不动（会影响其他项目），头像只在本机为空时补。
    #[test]
    fn merges_people_by_name_local_wins() {
        let a = mem();
        let pid = seed(&a, "P");
        let (bundle, people, avatars) = collect(&a, pid).unwrap();
        let path = tmp("people.ganttproj");
        write_archive(&path, "0.1.0", "1", &bundle, &people, &avatars).unwrap();
        let archive = read_archive(&path).unwrap();

        let mut b = mem();
        b.execute(
            "INSERT INTO people (name, color, avatar, sort_order, created_at)
             VALUES ('张三', '#111111', 'data:image/png;base64,AAAA', 1, '0'),
                    ('李四', '#222222', NULL, 2, '0')",
            [],
        )
        .unwrap();

        let outcome = apply(&mut b, &archive, None, "P", None).unwrap();
        assert!(outcome.new_people.is_empty(), "两个人本机都已存在，不该新建");

        let zhang: (String, Option<String>) = b
            .query_row("SELECT color, avatar FROM people WHERE name='张三'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(zhang.0, "#111111", "颜色必须保持本机的");
        assert_eq!(zhang.1.as_deref(), Some("data:image/png;base64,AAAA"), "已有头像不该被覆盖");

        let li: (String, Option<String>) = b
            .query_row("SELECT color, avatar FROM people WHERE name='李四'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(li.0, "#222222");
        assert!(li.1.is_none(), "文件里李四也没头像，补不出东西来");

        let _ = std::fs::remove_file(&path);
    }

    /// 覆盖：项目 id 不变（卡片位置、上次打开的项目等引用还指着它），
    /// 旧内容清空，不残留。
    #[test]
    fn overwrite_replaces_contents_and_keeps_id() {
        let a = mem();
        let pid = seed(&a, "厂房建设");
        let (bundle, people, avatars) = collect(&a, pid).unwrap();
        let path = tmp("overwrite.ganttproj");
        write_archive(&path, "0.1.0", "1", &bundle, &people, &avatars).unwrap();
        let archive = read_archive(&path).unwrap();

        let mut b = mem();
        let target = seed(&b, "厂房建设");
        b.execute(
            "INSERT INTO tasks (project_id, name, start_date, end_date, sort_order, created_at, updated_at)
             VALUES (?1, '本机独有的任务', '2026-01-01', '2026-01-02', 99, '0', '0')",
            params![target],
        )
        .unwrap();

        let outcome = apply(&mut b, &archive, Some(target), "厂房建设二期", None).unwrap();
        assert_eq!(outcome.project_id, target, "覆盖不该换 id");
        assert!(outcome.overwritten);

        let name: String = b
            .query_row("SELECT name FROM projects WHERE id=?1", params![target], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "厂房建设二期");

        let leftovers: i64 = b
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE project_id=?1 AND name='本机独有的任务'",
                params![target],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(leftovers, 0, "旧内容必须清干净");

        let projects: i64 = b.query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0)).unwrap();
        assert_eq!(projects, 1, "覆盖不该多出一个项目");

        let _ = std::fs::remove_file(&path);
    }

    /// uuid 优先、名字兜底。
    #[test]
    fn matches_by_uuid_then_name() {
        let a = mem();
        let pid = seed(&a, "厂房建设");
        let (bundle, people, avatars) = collect(&a, pid).unwrap();
        let path = tmp("match.ganttproj");
        write_archive(&path, "0.1.0", "1", &bundle, &people, &avatars).unwrap();
        let archive = read_archive(&path).unwrap();

        // uuid 相同、名字不同 → 认出来，并给出改名提示
        let b = mem();
        let t = seed(&b, "旧名字");
        b.execute("UPDATE projects SET uuid='uuid-fixed-0001' WHERE id=?1", params![t]).unwrap();
        let p = preview(&b, &archive).unwrap();
        assert_eq!(p.matched_by.as_deref(), Some("uuid"));
        assert_eq!(p.rename_to.as_deref(), Some("厂房建设"));
        assert!(!p.name_conflict);

        // uuid 不同、名字相同 → 靠名字兜底（首次使用走的就是这条）
        let c = mem();
        let t2 = seed(&c, "厂房建设");
        c.execute("UPDATE projects SET uuid='completely-different' WHERE id=?1", params![t2]).unwrap();
        let p = preview(&c, &archive).unwrap();
        assert_eq!(p.matched_by.as_deref(), Some("name"));
        assert!(p.rename_to.is_none());

        // 都不匹配 → 全新项目
        let d = mem();
        let p = preview(&d, &archive).unwrap();
        assert!(p.matched_by.is_none() && p.target_id.is_none());

        let _ = std::fs::remove_file(&path);
    }

    /// 改名会撞上本机**另一个**项目时必须提前发现 —— 否则用户点完「覆盖并改名」
    /// 才在 UNIQUE 约束上炸掉，而那时备份都已经写完了。
    #[test]
    fn detects_rename_collision() {
        let a = mem();
        let pid = seed(&a, "办公楼");
        let (bundle, people, avatars) = collect(&a, pid).unwrap();
        let path = tmp("collide.ganttproj");
        write_archive(&path, "0.1.0", "1", &bundle, &people, &avatars).unwrap();
        let archive = read_archive(&path).unwrap();

        let b = mem();
        let t = seed(&b, "厂房建设");
        b.execute("UPDATE projects SET uuid='uuid-fixed-0001' WHERE id=?1", params![t]).unwrap();
        b.execute(
            "INSERT INTO projects (name, color, uuid, created_at, updated_at)
             VALUES ('办公楼', '#000', 'u2', '0', '0')",
            [],
        )
        .unwrap();

        let p = preview(&b, &archive).unwrap();
        assert_eq!(p.rename_to.as_deref(), Some("办公楼"));
        assert!(p.name_conflict, "改成「办公楼」会和现有项目撞名");

        let _ = std::fs::remove_file(&path);
    }

    /// 校验必须在写库前把话说清楚，而不是让 SQLite 抛 CHECK constraint failed。
    #[test]
    fn validation_speaks_human() {
        let a = mem();
        let pid = seed(&a, "P");
        let (mut bundle, people, avatars) = collect(&a, pid).unwrap();

        bundle.tasks[0].end_date = "2026-01-01".into();
        bundle.tasks[1].actual_start = Some("2026-03-01".into());
        bundle.tasks[2].progress = 1.7;

        let path = tmp("bad.ganttproj");
        write_archive(&path, "0.1.0", "1", &bundle, &people, &avatars).unwrap();
        let archive = read_archive(&path).unwrap();
        let problems = validate(&archive);

        assert!(problems.iter().any(|p| p.contains("结束日期") && p.contains("早于开始日期")), "{problems:?}");
        assert!(problems.iter().any(|p| p.contains("只填了实施开始")), "{problems:?}");
        assert!(problems.iter().any(|p| p.contains("进度")), "{problems:?}");

        // 全有或全无：有问题就一行都不该写进去
        let mut b = mem();
        let before: i64 = b.query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0)).unwrap();
        let p = preview(&b, &archive).unwrap();
        assert!(!p.problems.is_empty());
        let after: i64 = b.query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0)).unwrap();
        assert_eq!(before, after, "预检不能碰库");
        let _ = &mut b;

        let _ = std::fs::remove_file(&path);
    }

    /// 环会让展平逻辑死循环，库层没有这个约束，只能在这里挡。
    #[test]
    fn rejects_parent_cycles() {
        let a = mem();
        let pid = seed(&a, "P");
        let (mut bundle, people, avatars) = collect(&a, pid).unwrap();
        bundle.tasks[0].parent_id = Some(bundle.tasks[1].id);

        let path = tmp("cycle.ganttproj");
        write_archive(&path, "0.1.0", "1", &bundle, &people, &avatars).unwrap();
        let archive = read_archive(&path).unwrap();
        assert!(validate(&archive).iter().any(|p| p.contains("成环")));
        let _ = std::fs::remove_file(&path);
    }

    /// 版本闸门：major 高拒绝，minor 高只提示。
    #[test]
    fn version_gate_distinguishes_major_and_minor() {
        let a = mem();
        let pid = seed(&a, "P");
        let (bundle, people, avatars) = collect(&a, pid).unwrap();
        let path = tmp("ver.ganttproj");
        write_archive(&path, "0.1.0", "1", &bundle, &people, &avatars).unwrap();
        let mut archive = read_archive(&path).unwrap();

        archive.manifest.format_version = format!("{}.{}", FORMAT_MAJOR + 1, 0);
        let (problems, _) = version_gate(&archive);
        assert!(problems.iter().any(|p| p.contains("请先升级")), "{problems:?}");

        archive.manifest.format_version = format!("{}.{}", FORMAT_MAJOR, FORMAT_MINOR + 3);
        archive.unknown_sections = vec!["attachments".into()];
        let (problems, warnings) = version_gate(&archive);
        assert!(problems.is_empty(), "只加了字段不该拦下来");
        assert!(warnings[0].contains("attachments"), "{warnings:?}");

        let _ = std::fs::remove_file(&path);
    }

    /// 不是 zip、或者缺关键条目时，报错要能让人看懂在说什么。
    #[test]
    fn rejects_garbage_files() {
        let path = tmp("garbage.ganttproj");
        std::fs::write(&path, "这不是一个 zip".as_bytes()).unwrap();
        let err = read_archive(&path).unwrap_err();
        assert!(err.contains("不是 zip 容器"), "{err}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn sanitizes_file_names() {
        assert_eq!(safe_stem("A/B:C"), "A_B_C");
        assert_eq!(safe_stem("   "), "项目");
        assert_eq!(safe_stem("正常名字"), "正常名字");
    }
}

