//! `gantt` —— Gantt 的命令行接口，给 AI（Claude Skill）和脚本用。
//!
//! 桌面应用有 40 多个 `#[tauri::command]`，但它们只走 WebView 的 IPC，
//! 外部进程碰不到。这个二进制直接开同一个 `gantt.db`，把「建任务 / 设工期 /
//! 派活」变成一行命令、一段稳定 JSON。
//!
//! ## 三条铁律（都来自调研中真出过事的坑）
//!
//! 1. **应用开着时不写。** 前端每 400ms 把整个项目写回库；这时 CLI 的插入
//!    会被下一帧覆盖，静默丢数据。写前查 `gantt.lock`，进程还活着就拒绝
//!    （除非 `--force`）。见 `gantt_core::locate`。
//! 2. **父任务的进度/起止是算出来的。** `--progress`/`--start`/`--end` 落到
//!    一个有子任务的任务上会被汇总覆盖 —— 直接报错，不静默接受。
//! 3. **任务 id 是全库主键。** 新建走 `write::allocate_task_id`，和前端同源，
//!    否则会撞上别的项目的行。
//!
//! ## 给 Agent 的约定
//!
//! - `--json`：稳定 schema，字段名同 `TaskRow`，不做二次映射。不带则打人读表格。
//! - 日期只认 ISO / `today` / `+3d`：**绝不让模型自己算日期**。
//! - 负责人按名字找不到就报错并列出现有人名，不静默创建。
//! - 退出码：0 成功 / 1 参数错 / 2 数据校验失败 / 3 应用占用 / 4 数据库错误。
//!   错误信息写成模型能读懂并自我纠正的中文。

use gantt_core::calendar::{days_to_iso, parse_cli_date, parse_cli_duration, resolve_span};
use gantt_core::model::*;
use gantt_core::{locate, query, write};
use rusqlite::Connection;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;

/* ------------------------------------------------------------------ */
/* 退出码                                                              */
/* ------------------------------------------------------------------ */

/// 退出码。Skill 可以据此分支：2 是「我写错了，能改」，3 是「先关应用」。
mod code {
    pub const OK: u8 = 0;
    pub const ARGS: u8 = 1; // 参数拼错、缺必填项
    pub const VALIDATION: u8 = 2; // 数据不合法（父任务设进度、日期倒置…）
    pub const APP_BUSY: u8 = 3; // 桌面应用正开着
    pub const DB: u8 = 4; // 打不开库、SQL 出错
}

/// CLI 内部的错误：一句人话 + 一个退出码。
///
/// `Debug` 和 `Display` 都只是为了**测试**里能 `.unwrap()` / 断言文案 ——
/// 真正跑起来的那条路径（`main`）直接读 `message` 字段，不走这两个 trait。
#[derive(Debug)]
struct CliError {
    message: String,
    code: u8,
}

impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl CliError {
    fn args(m: impl Into<String>) -> Self {
        CliError { message: m.into(), code: code::ARGS }
    }
    fn validation(m: impl Into<String>) -> Self {
        CliError { message: m.into(), code: code::VALIDATION }
    }
    fn db(m: impl Into<String>) -> Self {
        CliError { message: m.into(), code: code::DB }
    }
}

type CliResult<T> = std::result::Result<T, CliError>;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(args) {
        Ok(()) => ExitCode::from(code::OK),
        Err(e) => {
            eprintln!("错误：{}", e.message);
            ExitCode::from(e.code)
        }
    }
}

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

/// 手写的参数袋。刻意不引 clap：参数面不大，而错误文案要写成给模型看的中文，
/// 自己拿着才好控制。
///
/// 规则简单到不会有歧义：
/// - `--flag value` 或 `--flag=value` 都收
/// - 没有值的开关（`--json` / `--milestone`）记成存在
/// - 不以 `--` 开头的收进 `positionals`
struct Args {
    flags: BTreeMap<String, String>,
    switches: Vec<String>,
    positionals: Vec<String>,
}

impl Args {
    /// 这些名字是「开关」：出现即为真，后面**不**吃一个值。
    /// 其余 `--x y` 一律当作「带值选项」。
    // `flat` 曾经在这里，但没人读过它 —— JSON 出来本来就是平铺数组（层级靠
    // `parentId` 字段表达），所以它没有任何可做的事。留着比删掉危险：Agent
    // 传了它、命令成功、结果是它以为的另一样东西，而错误要等它去别处才发现。
    const KNOWN_SWITCHES: &'static [&'static str] = &[
        "json", "force", "milestone", "yes", "no-auto-rollover",
        "auto-rollover", "create-missing", "clear-assignee",
    ];

    fn parse(raw: &[String]) -> CliResult<Args> {
        let mut flags = BTreeMap::new();
        let mut switches = Vec::new();
        let mut positionals = Vec::new();

        let mut i = 0;
        while i < raw.len() {
            let a = &raw[i];
            if let Some(rest) = a.strip_prefix("--") {
                if let Some((k, v)) = rest.split_once('=') {
                    flags.insert(k.to_string(), v.to_string());
                } else if Self::KNOWN_SWITCHES.contains(&rest) {
                    switches.push(rest.to_string());
                } else {
                    // 带值选项：吃下一个 token。缺值就报错，别静默当开关。
                    let v = raw.get(i + 1).ok_or_else(|| {
                        CliError::args(format!("选项 --{rest} 后面缺一个值"))
                    })?;
                    if v.starts_with("--") {
                        return Err(CliError::args(format!(
                            "选项 --{rest} 后面缺一个值（后面跟的是另一个选项 {v}）"
                        )));
                    }
                    flags.insert(rest.to_string(), v.clone());
                    i += 1;
                }
            } else {
                positionals.push(a.clone());
            }
            i += 1;
        }
        Ok(Args { flags, switches, positionals })
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.flags.get(key).map(|s| s.as_str())
    }

    fn has(&self, key: &str) -> bool {
        self.switches.iter().any(|s| s == key)
    }

    fn require(&self, key: &str) -> CliResult<&str> {
        self.get(key)
            .ok_or_else(|| CliError::args(format!("缺少必填选项 --{key}")))
    }

    fn json(&self) -> bool {
        self.has("json")
    }
}

/* ------------------------------------------------------------------ */
/* 分发                                                                */
/* ------------------------------------------------------------------ */

/// 全局选项可以写在组名之前，也可以写在子命令之后：
/// `gantt --data-dir X project list` 与 `gantt project list --data-dir X` 等价。
///
/// 做法：扫开头**连续的**全局选项，遇到第一个非选项 token 就认定它是组名并停下。
///
/// 返回 `(tail, group)`。`group` 是组名，**单独**返回、不留在 `tail` 里；`tail`
/// 是交给 `dispatch_<组>` 的东西，形状必须是 **子命令 + 选项**。所以摘出来的全局
/// 选项要塞在子命令**之后**：
///
/// ```text
/// gantt --data-dir X project list --json
///       └──全局──┘ └组┘ └─ 之后 ─┘
///                 ↓
/// group = "project"
/// tail  = ["list", "--data-dir", "X", "--json"]
/// ```
///
/// 各组都用 `split_sub(rest, group)` 取 `rest[0]` 当子命令，而它只认「`--` 开头就
/// 不是子命令」。把全局选项摆在子命令之前会让每个组都以为用户漏了子命令 —— 这正是
/// 「`gantt --data-dir X project list` 报『不认识的命令』」那个老 bug 的根。
///
/// 只摘「肯定全局」的那几个（`--data-dir` / `--json` / `--force`）。像 `--name`
/// 这种既可能是全局也可能是子命令选项的，摘了就会抢走子命令的参数。
fn hoist_globals(argv: &[String]) -> CliResult<(Vec<String>, Option<String>)> {
    let mut globals = Vec::new();
    let mut i = 0;
    let mut group = None;

    while i < argv.len() {
        let a = &argv[i];
        if !a.starts_with("--") {
            group = Some(a.clone());
            i += 1;
            break;
        }
        match a.split_once('=') {
            // --data-dir=X 是「自带值」的形式，原样收进全局袋
            Some(_) => {
                globals.push(a.clone());
                i += 1;
            }
            None => {
                let key = a.trim_start_matches('-');
                if key == "data-dir" {
                    let v = argv.get(i + 1).ok_or_else(|| {
                        CliError::args("选项 --data-dir 后面缺一个值")
                    })?;
                    globals.push(a.clone());
                    globals.push(v.clone());
                    i += 2;
                } else {
                    // --json / --force 这类无值开关
                    globals.push(a.clone());
                    i += 1;
                }
            }
        }
    }

    // argv[i..] 是组名之后的一切 = [子命令, ...选项]。把全局选项插在子命令之后，
    // 好让 split_sub 仍能从 tail[0] 拿到子命令。没有子命令时（argv 全是选项）
    // tail 就只剩全局选项，dispatch 侧的 split_sub 会报「缺子命令」。
    let after_group = &argv[i..];
    let tail = match after_group.split_first() {
        Some((sub, rest_opts)) => {
            let mut t = Vec::with_capacity(after_group.len() + globals.len());
            t.push(sub.clone());
            t.extend(globals);
            t.extend_from_slice(rest_opts);
            t
        }
        None => globals,
    };
    Ok((tail, group))
}

fn run(argv: Vec<String>) -> CliResult<()> {
    // `--help` / `-h` 出现在哪儿都算求助，不必先解析出组名。
    if argv.iter().any(|a| a == "help" || a == "--help" || a == "-h") {
        print_usage();
        return Ok(());
    }

    let (rest, group) = hoist_globals(&argv)?;
    let group = group.ok_or_else(|| {
        CliError::args("没给命令。可用：project / task / people / risk / comment / note / baseline / setting / check。敲 `gantt help` 看用法。")
    })?;

    match group.as_str() {
        "project" => dispatch_project(&rest),
        "task" => dispatch_task(&rest),
        "people" | "person" => dispatch_people(&rest),
        "risk" => dispatch_risk(&rest),
        "comment" => dispatch_comment(&rest),
        "note" => dispatch_note(&rest),
        "baseline" => dispatch_baseline(&rest),
        "setting" => dispatch_setting(&rest),
        "check" => cmd_check(&Args::parse(&rest)?),
        other => Err(CliError::args(format!(
            "不认识的命令「{other}」。可用：project / task / people / risk / comment / note / baseline / setting / check。敲 `gantt help` 看用法。"
        ))),
    }
}

fn dispatch_project(rest: &[String]) -> CliResult<()> {
    let (sub, tail) = split_sub(rest, "project")?;
    let args = Args::parse(tail)?;
    match sub.as_str() {
        "list" => cmd_project_list(&args),
        "show" => cmd_project_show(&args),
        "create" => cmd_project_create(&args),
        "rename" => cmd_project_rename(&args),
        "calendar" => cmd_project_calendar(&args),
        "delete" => cmd_project_delete(&args),
        other => Err(CliError::args(format!(
            "project 没有子命令「{other}」。可用：list / show / create / rename / calendar / delete。"
        ))),
    }
}

fn dispatch_task(rest: &[String]) -> CliResult<()> {
    let (sub, tail) = split_sub(rest, "task")?;
    let args = Args::parse(tail)?;
    match sub.as_str() {
        "list" => cmd_task_list(&args),
        "show" => cmd_task_show(&args),
        "create" => cmd_task_create(&args),
        "update" => cmd_task_update(&args),
        "delete" => cmd_task_delete(&args),
        other => Err(CliError::args(format!(
            "task 没有子命令「{other}」。可用：list / show / create / update / delete。"
        ))),
    }
}

fn dispatch_people(rest: &[String]) -> CliResult<()> {
    let (sub, tail) = split_sub(rest, "people")?;
    let args = Args::parse(tail)?;
    match sub.as_str() {
        "list" => cmd_people_list(&args),
        "create" => cmd_people_create(&args),
        "update" => cmd_people_update(&args),
        "delete" => cmd_people_delete(&args),
        other => Err(CliError::args(format!(
            "people 没有子命令「{other}」。可用：list / create / update / delete。"
        ))),
    }
}

fn dispatch_risk(rest: &[String]) -> CliResult<()> {
    let (sub, tail) = split_sub(rest, "risk")?;
    let args = Args::parse(tail)?;
    match sub.as_str() {
        "add" => cmd_risk_add(&args),
        "list" => cmd_risk_list(&args),
        "project" => cmd_risk_project(&args),
        "update" => cmd_risk_update(&args),
        "resolve" => cmd_risk_resolve(&args),
        "reopen" => cmd_risk_reopen(&args),
        "delete" => cmd_risk_delete(&args),
        other => Err(CliError::args(format!(
            "risk 没有子命令「{other}」。可用：add / list / project / update / resolve / reopen / delete。"
        ))),
    }
}

fn dispatch_comment(rest: &[String]) -> CliResult<()> {
    let (sub, tail) = split_sub(rest, "comment")?;
    let args = Args::parse(tail)?;
    match sub.as_str() {
        "add" => cmd_comment_add(&args),
        "list" => cmd_comment_list(&args),
        "delete" => cmd_comment_delete(&args),
        other => Err(CliError::args(format!(
            "comment 没有子命令「{other}」。可用：add / list / delete。"
        ))),
    }
}

fn dispatch_note(rest: &[String]) -> CliResult<()> {
    let (sub, tail) = split_sub(rest, "note")?;
    let args = Args::parse(tail)?;
    match sub.as_str() {
        "add" => cmd_note_add(&args),
        "list" => cmd_note_list(&args),
        "update" => cmd_note_update(&args),
        "delete" => cmd_note_delete(&args),
        other => Err(CliError::args(format!(
            "note 没有子命令「{other}」。可用：add / list / update / delete。"
        ))),
    }
}

fn dispatch_baseline(rest: &[String]) -> CliResult<()> {
    let (sub, tail) = split_sub(rest, "baseline")?;
    let args = Args::parse(tail)?;
    match sub.as_str() {
        "create" => cmd_baseline_create(&args),
        "list" => cmd_baseline_list(&args),
        "show" => cmd_baseline_show(&args),
        "delete" => cmd_baseline_delete(&args),
        other => Err(CliError::args(format!(
            "baseline 没有子命令「{other}」。可用：create / list / show / delete。"
        ))),
    }
}

fn dispatch_setting(rest: &[String]) -> CliResult<()> {
    let (sub, tail) = split_sub(rest, "setting")?;
    let args = Args::parse(tail)?;
    match sub.as_str() {
        "get" => cmd_setting_get(&args),
        "set" => cmd_setting_set(&args),
        "list" => cmd_setting_list(&args),
        other => Err(CliError::args(format!(
            "setting 没有子命令「{other}」。可用：get / set / list。"
        ))),
    }
}

/// 从 `["show", "--project", "3"]` 里拆出子命令和其余参数。
/// 子命令必须在最前面，且不带 `--`。
fn split_sub<'a>(rest: &'a [String], group: &str) -> CliResult<(String, &'a [String])> {
    let first = rest.first().ok_or_else(|| {
        CliError::args(format!("{group} 后面要跟一个子命令。敲 `gantt help` 看用法。"))
    })?;
    if first.starts_with("--") {
        return Err(CliError::args(format!(
            "{group} 后面要先跟子命令，再跟选项；「{first}」看起来是个选项。"
        )));
    }
    Ok((first.clone(), &rest[1..]))
}

/* ------------------------------------------------------------------ */
/* 打开数据库 + 存活检测                                               */
/* ------------------------------------------------------------------ */

/// 数据目录：`--data-dir` > `GANTT_DATA_DIR` > 平台默认。
fn resolve_data_dir(args: &Args) -> CliResult<PathBuf> {
    let explicit = args.get("data-dir").map(PathBuf::from);
    locate::data_dir(explicit.as_deref()).map_err(CliError::args)
}

/// 只读打开：不查锁。读永远安全（WAL 下读写不互斥）。
fn open_ro(args: &Args) -> CliResult<Connection> {
    let dir = resolve_data_dir(args)?;
    let path = locate::db_path(&dir);
    if !path.exists() {
        return Err(CliError::db(format!(
            "在 {} 找不到 gantt.db。\
             先用桌面应用建一个项目，或用 --data-dir 指到正确的数据目录。",
            dir.display()
        )));
    }
    gantt_core::open(&path).map_err(|e| CliError::db(format!("打开数据库失败：{e}")))
}

/// 可写打开：先做存活检测。这是「铁律 1」的落点。
fn open_rw(args: &Args) -> CliResult<Connection> {
    let dir = resolve_data_dir(args)?;

    if !args.has("force") {
        if let Some(lock) = locate::running_app(&dir) {
            return Err(CliError {
                message: format!(
                    "桌面应用 Gantt 正在运行（PID {}），它每 400ms 会把整个项目写回数据库，\
                     你现在写入会被覆盖。\n\n  · 关掉 Gantt 后重试，或\n  \
                     · 加 --force 承担风险（仅适合应用闲置时快速补一条）",
                    lock.pid
                ),
                code: code::APP_BUSY,
            });
        }
    }

    let path = locate::db_path(&dir);
    if !path.exists() {
        return Err(CliError::db(format!(
            "在 {} 找不到 gantt.db。\
             先用桌面应用建一个项目，或用 --data-dir 指到正确的数据目录。",
            dir.display()
        )));
    }
    gantt_core::open(&path).map_err(|e| CliError::db(format!("打开数据库失败：{e}")))
}

/// 建库（`project create` 允许在空目录里起一个新库）。
fn open_or_create(args: &Args) -> CliResult<Connection> {
    let dir = resolve_data_dir(args)?;

    if !args.has("force") {
        if let Some(lock) = locate::running_app(&dir) {
            return Err(CliError {
                message: format!(
                    "桌面应用 Gantt 正在运行（PID {}），现在写入会被它覆盖。\
                     关掉 Gantt 后重试，或加 --force。",
                    lock.pid
                ),
                code: code::APP_BUSY,
            });
        }
    }

    std::fs::create_dir_all(&dir)
        .map_err(|e| CliError::db(format!("建不了数据目录 {}：{e}", dir.display())))?;
    gantt_core::open(&locate::db_path(&dir))
        .map_err(|e| CliError::db(format!("打开数据库失败：{e}")))
}

/* ------------------------------------------------------------------ */
/* project 命令                                                        */
/* ------------------------------------------------------------------ */

fn cmd_project_list(args: &Args) -> CliResult<()> {
    let conn = open_ro(args)?;
    let projects = query::list_projects(&conn).map_err(CliError::db)?;

    if args.json() {
        print_json(&projects)?;
        return Ok(());
    }

    if projects.is_empty() {
        println!("（还没有项目）");
        return Ok(());
    }
    println!("{:>4}  {:<24} {:>5}  {:>4}  {:>6}  {}", "ID", "名称", "任务", "逾期", "进度", "起止");
    for p in &projects {
        let span = match (&p.start_date, &p.end_date) {
            (Some(s), Some(e)) => format!("{s} → {e}"),
            _ => "—".to_string(),
        };
        println!(
            "{:>4}  {:<24} {:>5}  {:>4}  {:>5.0}%  {}",
            p.project.id,
            truncate(&p.project.name, 24),
            p.task_count,
            p.overdue_count,
            p.progress * 100.0,
            span
        );
    }
    Ok(())
}

fn cmd_project_show(args: &Args) -> CliResult<()> {
    let conn = open_ro(args)?;
    let id = resolve_project(&conn, project_selector(args)?)?;
    let data = query::load_project(&conn, id).map_err(CliError::db)?;

    if args.json() {
        print_json(&data)?;
        return Ok(());
    }
    println!("项目 {}「{}」", data.project.id, data.project.name);
    println!("  任务数：{}", data.tasks.len());
    println!("  负责人：{}", data.people.len());
    println!("  依赖：{}", data.dependencies.len());
    println!("  下一个任务 id：{}", data.next_task_id);
    Ok(())
}

fn cmd_project_create(args: &Args) -> CliResult<()> {
    let name = args.require("name")?.to_string();
    let color = args.get("color").unwrap_or("#4C6EF5").to_string();
    validate_color(&color)?;

    let conn = open_or_create(args)?;
    let project = query::create_project(&conn, name, color).map_err(CliError::validation)?;

    if args.json() {
        print_json(&project)?;
    } else {
        println!("已建项目 {}「{}」", project.id, project.name);
    }
    Ok(())
}

/// 改项目名（和可选的颜色）。
///
/// `rename_project` 是 name + color 一起写的，所以不给 `--color` 时必须
/// **先读回当前色再写** —— 否则改个名字会顺手把颜色重置成默认值，而这种
/// 「只改了我说的那一样」的意外最难发现。
fn cmd_project_rename(args: &Args) -> CliResult<()> {
    let name = args.require("name")?.to_string();
    if name.trim().is_empty() {
        return Err(CliError::validation("项目名不能为空"));
    }
    let conn = open_rw(args)?;
    let id = resolve_project(&conn, project_selector(args)?)?;

    let current = conn
        .query_row("SELECT color FROM projects WHERE id = ?1", [id], |r| {
            r.get::<_, String>(0)
        })
        .map_err(|e| CliError::db(format!("读项目 {id} 的颜色失败：{e}")))?;
    let color = match args.get("color") {
        Some(c) => {
            validate_color(c)?;
            c.to_string()
        }
        None => current,
    };

    query::rename_project(&conn, id, name, color).map_err(CliError::validation)?;

    let project = conn
        .query_row("SELECT * FROM projects WHERE id = ?1", [id], map_project_row)
        .map_err(|e| CliError::db(e.to_string()))?;
    if args.json() {
        print_json(&project)?;
    } else {
        println!("已改项目 {} 的名字为「{}」", id, project.name);
    }
    Ok(())
}

/// 改项目的工作日历。
///
/// 存进去的是两段 JSON 文本（`projects.work_days` / `holidays`），消费方是
/// 前端的 `WorkCalendar.fromProject`，它按 JS `getUTCDay()` 解释星期序号 ——
/// 0 = 周日。所以 `7` 要在存储前折成 `0`（见 `parse_work_days`）。
fn cmd_project_calendar(args: &Args) -> CliResult<()> {
    let conn = open_rw(args)?;
    let id = resolve_project(&conn, project_selector(args)?)?;

    let cur = conn
        .query_row(
            "SELECT work_days, holidays FROM projects WHERE id = ?1",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .map_err(|e| CliError::db(format!("读项目 {id} 的日历失败：{e}")))?;

    // 和 rename 同理：只改说了的那一半，另一半原样留着。
    let work_days = match args.get("work-days") {
        Some(w) => parse_work_days(w)?,
        None => cur.0,
    };
    let holidays = match args.get("holidays") {
        Some(h) => parse_holidays(h)?,
        None => cur.1,
    };

    query::update_project_calendar(&conn, id, work_days.clone(), holidays.clone())
        .map_err(CliError::db)?;

    if args.json() {
        let project = conn
            .query_row("SELECT * FROM projects WHERE id = ?1", [id], map_project_row)
            .map_err(|e| CliError::db(e.to_string()))?;
        print_json(&project)?;
    } else {
        println!("已更新项目 {id} 的工作日历");
        println!("  工作日：{work_days}");
        println!("  节假日：{holidays}");
    }
    Ok(())
}

/// 删项目。级联删掉它下面所有任务、依赖、基线 —— 破坏性最大的一条命令，
/// 没有 `--yes` 一律拦下，并把「会删掉什么」写在错误里。
fn cmd_project_delete(args: &Args) -> CliResult<()> {
    let conn = open_rw(args)?;
    let id = resolve_project(&conn, project_selector(args)?)?;
    let data = query::load_project(&conn, id).map_err(CliError::db)?;

    if !args.has("yes") {
        return Err(CliError::validation(format!(
            "项目 {id}「{}」下面有 {} 个任务、{} 条依赖、{} 个基线，删项目会把它们一起删掉。\
             确认请加 --yes。",
            data.project.name,
            data.tasks.len(),
            data.dependencies.len(),
            data.baselines.len()
        )));
    }

    query::delete_project(&conn, id).map_err(CliError::db)?;
    if args.json() {
        print_json(&serde_json::json!({
            "deleted": id,
            "name": data.project.name,
            "tasks": data.tasks.len(),
        }))?;
    } else {
        println!(
            "已删项目 {id}「{}」（含 {} 个任务）",
            data.project.name,
            data.tasks.len()
        );
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* people 命令                                                         */
/* ------------------------------------------------------------------ */

fn cmd_people_list(args: &Args) -> CliResult<()> {
    let conn = open_ro(args)?;
    let people = query::list_people(&conn).map_err(CliError::db)?;

    if args.json() {
        print_json(&people)?;
        return Ok(());
    }
    if people.is_empty() {
        println!("（还没有负责人）");
        return Ok(());
    }
    println!("{:>4}  {:<16} {}", "ID", "名字", "颜色");
    for p in &people {
        println!("{:>4}  {:<16} {}", p.id, truncate(&p.name, 16), p.color);
    }
    Ok(())
}

fn cmd_people_create(args: &Args) -> CliResult<()> {
    let name = args.require("name")?.to_string();
    let color = args.get("color").unwrap_or("#868E96").to_string();
    validate_color(&color)?;

    let conn = open_rw(args)?;
    let person = query::create_person(&conn, name, color).map_err(CliError::validation)?;

    if args.json() {
        print_json(&person)?;
    } else {
        println!("已建负责人 {}「{}」", person.id, person.name);
    }
    Ok(())
}

/// 改负责人。`update_person` 要 name + color 一起给，所以缺哪一半就读回哪一半。
///
/// 尤其注意 avatar：CLI 传 `None` 表示「不动它」。这是 core 特意留的三态 ——
/// 传 `Some("")` 是清除，`None` 是不改。CLI 不暴露头像（base64 太大，Agent 用不上），
/// 但也绝不能顺手把它清掉，所以这里恒传 `None`。
fn cmd_people_update(args: &Args) -> CliResult<()> {
    let id = bare_id(args, "people update")?;
    let conn = open_rw(args)?;

    let existing = conn
        .query_row(
            "SELECT name, color FROM people WHERE id = ?1",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .map_err(|_| {
            CliError::validation(format!("没有 id 为 {id} 的负责人。用 `gantt people list` 看看。"))
        })?;

    let name = match args.get("name") {
        Some(n) => {
            if n.trim().is_empty() {
                return Err(CliError::validation("负责人名字不能为空"));
            }
            n.to_string()
        }
        None => existing.0,
    };
    let color = match args.get("color") {
        Some(c) => {
            validate_color(c)?;
            c.to_string()
        }
        None => existing.1,
    };

    if args.get("name").is_none() && args.get("color").is_none() {
        return Err(CliError::args(
            "没有要改的字段。可用：--name <新名> --color #RRGGBB",
        ));
    }

    query::update_person(&conn, id, name, color, None).map_err(CliError::validation)?;

    let person = conn
        .query_row(
            "SELECT id, name, color, avatar, sort_order FROM people WHERE id = ?1",
            [id],
            |r| {
                Ok(Person {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    color: r.get(2)?,
                    avatar: r.get(3)?,
                    sort_order: r.get(4)?,
                })
            },
        )
        .map_err(|e| CliError::db(e.to_string()))?;
    if args.json() {
        print_json(&person)?;
    } else {
        println!("已更新负责人 {}「{}」", person.id, person.name);
    }
    Ok(())
}

/// 删负责人。**不会删他的任务** —— 外键是 `ON DELETE SET NULL`，
/// 那些任务只是变回「未分配」。但即便如此，一个人身上挂着几十条任务时
/// 直接删掉也多半不是本意，所以有任务就要 `--yes`。
fn cmd_people_delete(args: &Args) -> CliResult<()> {
    let id = bare_id(args, "people delete")?;
    let conn = open_rw(args)?;

    let name: String = conn
        .query_row("SELECT name FROM people WHERE id = ?1", [id], |r| r.get(0))
        .map_err(|_| {
            CliError::validation(format!("没有 id 为 {id} 的负责人。用 `gantt people list` 看看。"))
        })?;

    let n = query::count_person_tasks(&conn, id).map_err(CliError::db)?;
    if n > 0 && !args.has("yes") {
        return Err(CliError::validation(format!(
            "负责人 {id}「{name}」名下有 {n} 个任务。删掉这个人不会删任务，\
             但那 {n} 个任务会变成「未分配」。确认请加 --yes。"
        )));
    }

    query::delete_person(&conn, id).map_err(CliError::db)?;
    if args.json() {
        print_json(&serde_json::json!({ "deleted": id, "name": name, "unassigned": n }))?;
    } else {
        println!("已删负责人 {id}「{name}」（{n} 个任务变成未分配）");
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* task 命令                                                           */
/* ------------------------------------------------------------------ */

fn cmd_task_list(args: &Args) -> CliResult<()> {
    let conn = open_ro(args)?;
    let pid = resolve_project(&conn, project_selector(args)?)?;
    let data = query::load_project(&conn, pid).map_err(CliError::db)?;

    if args.json() {
        print_json(&data.tasks)?;
        return Ok(());
    }
    if data.tasks.is_empty() {
        println!("（项目 {pid} 里还没有任务）");
        return Ok(());
    }

    // 建一张 id → 名字 方便显示负责人
    let people: BTreeMap<i64, String> =
        data.people.iter().map(|p| (p.id, p.name.clone())).collect();
    let has_child: std::collections::HashSet<i64> =
        data.tasks.iter().filter_map(|t| t.parent_id).collect();

    println!(
        "{:>5}  {:<28} {:<10} {:<12} {:<12} {:>5}  {}",
        "ID", "名称", "优先级", "开始", "结束", "进度", "负责人"
    );
    for t in &data.tasks {
        let indent = if t.parent_id.is_some() { "  " } else { "" };
        let name = format!("{indent}{}", t.name);
        let who = t
            .person_id
            .and_then(|id| people.get(&id))
            .cloned()
            .unwrap_or_else(|| "—".to_string());
        let prog = if has_child.contains(&t.id) {
            "（汇总）".to_string()
        } else {
            format!("{:.0}%", t.progress * 100.0)
        };
        println!(
            "{:>5}  {:<28} {:<10} {:<12} {:<12} {:>5}  {}",
            t.id,
            truncate(&name, 28),
            priority_label(t.priority),
            t.start_date,
            t.end_date,
            prog,
            who
        );
    }
    Ok(())
}

fn cmd_task_show(args: &Args) -> CliResult<()> {
    let conn = open_ro(args)?;
    let id = single_id(args, "task show")?;
    let (task, pid) = find_task_anywhere(&conn, id)?;

    // 任务本身 + 挂在它身上的东西，一次读齐。风险和评论走 load_task_notes
    // （它一次把两张表都查了），依赖从 load_project 里筛。
    let notes = query::load_task_notes(&conn, id).map_err(CliError::db)?;
    let data = query::load_project(&conn, pid).map_err(CliError::db)?;
    let incoming: Vec<&DependencyRow> =
        data.dependencies.iter().filter(|d| d.to_task_id == id).collect();
    let outgoing: Vec<&DependencyRow> =
        data.dependencies.iter().filter(|d| d.from_task_id == id).collect();

    if args.json() {
        // JSON 里把任务字段平铺在最外层（`task.id` / `task.name` 这些**原样保留**，
        // 老的消费者不会因为这次增强而读不到字段），风险 / 评论 / 依赖另开三个键。
        print_json(&serde_json::json!({
            "task": task,
            "risks": notes.risks,
            "comments": notes.comments,
            "dependenciesIn": incoming,
            "dependenciesOut": outgoing,
        }))?;
        return Ok(());
    }

    println!("任务 {}「{}」（项目 {pid}）", task.id, task.name);
    println!("  优先级：{}", priority_label(task.priority));
    println!("  计划：{} → {}", task.start_date, task.end_date);
    if let (Some(s), Some(e)) = (&task.actual_start, &task.actual_end) {
        println!("  实施：{s} → {e}");
    }
    println!("  进度：{:.0}%", task.progress * 100.0);
    if task.milestone {
        println!("  里程碑：是");
    }

    // 依赖是只读的（本轮 CLI 不写依赖 —— 唯一的写入口是 save_project，
    // 而它会拿陈旧快照覆盖用户改动）。这里把和本任务相关的依赖列出来，
    // 让 Agent 至少能「看见」排期约束。
    let names: BTreeMap<i64, String> =
        data.tasks.iter().map(|t| (t.id, t.name.clone())).collect();
    let label = |tid: i64| -> String {
        match names.get(&tid) {
            Some(n) => format!("{tid}「{}」", truncate(n, 20)),
            None => tid.to_string(),
        }
    };
    if !incoming.is_empty() || !outgoing.is_empty() {
        println!("  依赖：");
        for d in &incoming {
            println!("    {} → 本任务（{}）", label(d.from_task_id), d.kind);
        }
        for d in &outgoing {
            println!("    本任务 → {}（{}）", label(d.to_task_id), d.kind);
        }
    }
    if !notes.risks.is_empty() {
        println!("  风险：");
        for r in &notes.risks {
            println!(
                "    [{}] {}{}",
                level_label(r.level),
                truncate(&r.content, 40),
                if r.resolved { "（已解决）" } else { "" }
            );
        }
    }
    if !notes.comments.is_empty() {
        println!("  评论：");
        for c in &notes.comments {
            println!("    {} {}", fmt_unix(c.created_at), truncate(&c.content, 40));
        }
    }
    Ok(())
}

fn cmd_task_create(args: &Args) -> CliResult<()> {
    let name = args.require("name")?.to_string();
    if name.trim().is_empty() {
        return Err(CliError::validation("任务名不能为空"));
    }

    let conn = open_rw(args)?;
    let pid = resolve_project(&conn, project_selector(args)?)?;
    let data = query::load_project(&conn, pid).map_err(CliError::db)?;

    // 父任务校验（铁律 2 的一半）
    let parent_id = match args.get("parent") {
        Some(p) => {
            let pid_parent: i64 = p
                .parse()
                .map_err(|_| CliError::args(format!("--parent 要一个任务 id，收到「{p}」")))?;
            if !data.tasks.iter().any(|t| t.id == pid_parent) {
                return Err(CliError::validation(format!(
                    "父任务 {pid_parent} 不在项目 {pid} 里。用 `gantt task list --project {pid}` 看看有哪些任务。"
                )));
            }
            Some(pid_parent)
        }
        None => None,
    };

    // 新建的任务此刻还没有子任务，所以 --progress 落在它身上是合法的 ——
    // 铁律 2 拦的是「给一个**已有子任务**的父任务设进度」，那发生在 update。
    let start = args.get("start").map(parse_cli_date).transpose().map_err(CliError::validation)?;
    let end = args.get("end").map(parse_cli_date).transpose().map_err(CliError::validation)?;
    let dur = args
        .get("duration")
        .map(parse_cli_duration)
        .transpose()
        .map_err(CliError::validation)?;
    let (start_days, end_days) = resolve_span(start, end, dur).map_err(CliError::validation)?;
    if end_days < start_days {
        return Err(CliError::validation(format!(
            "结束日期 {} 早于开始日期 {}。",
            days_to_iso(end_days),
            days_to_iso(start_days)
        )));
    }

    let mut task = write::NewTask::blank(
        name,
        days_to_iso(start_days),
        days_to_iso(end_days),
    );
    task.parent_id = parent_id;

    if let Some(p) = args.get("priority") {
        task.priority = parse_priority(p)?;
    }
    if let Some(pr) = args.get("progress") {
        task.progress = parse_progress(pr)?;
    }
    if let Some(w) = args.get("weight") {
        task.weight = Some(w.parse().map_err(|_| CliError::args(format!("--weight 要一个数字，收到「{w}」")))?);
    }
    if args.has("milestone") {
        task.milestone = true;
    }
    if args.has("auto-rollover") {
        task.auto_rollover = true;
    }
    task.person_id = resolve_assignee(&conn, &data, args)?;
    if let Some(note) = args.get("note") {
        task.note = note.to_string();
    }
    // 排在某个任务后面：拿它的 sort_order + 一个小增量
    if let Some(after) = args.get("after") {
        let after_id: i64 = after
            .parse()
            .map_err(|_| CliError::args(format!("--after 要一个任务 id，收到「{after}」")))?;
        match data.tasks.iter().find(|t| t.id == after_id) {
            Some(a) => task.sort_order = a.sort_order + 1.0,
            None => {
                return Err(CliError::validation(format!(
                    "--after 指的任务 {after_id} 不在项目 {pid} 里。"
                )))
            }
        }
    }

    let new_id = write::allocate_task_id(&conn).map_err(CliError::db)?;
    let mut conn = conn;
    write::insert_tasks(&mut conn, pid, vec![(new_id, task)]).map_err(CliError::db)?;

    // 回读一遍，输出的就是库里真实的样子
    let data = query::load_project(&conn, pid).map_err(CliError::db)?;
    let created = data
        .tasks
        .iter()
        .find(|t| t.id == new_id)
        .ok_or_else(|| CliError::db("任务写入后回读失败"))?;
    if args.json() {
        print_json(created)?;
    } else {
        println!("已建任务 {}「{}」（{} → {}）", created.id, created.name, created.start_date, created.end_date);
    }
    Ok(())
}

fn cmd_task_update(args: &Args) -> CliResult<()> {
    let id = single_id(args, "task update")?;
    let conn = open_rw(args)?;
    let (task, pid) = find_task_anywhere(&conn, id)?;
    let data = query::load_project(&conn, pid).map_err(CliError::db)?;
    let is_parent = data.tasks.iter().any(|t| t.parent_id == Some(id));

    let mut patch = write::TaskPatch::default();

    if let Some(name) = args.get("name") {
        if name.trim().is_empty() {
            return Err(CliError::validation("任务名不能为空"));
        }
        patch.name = Some(name.to_string());
    }

    // 铁律 2：有子任务的父任务，进度和计划起止都是**汇总出来的**，
    // 直接设会被 resolve() 覆盖 —— 与其静默无效，不如当场报错并教怎么改。
    if is_parent && (args.get("progress").is_some() || args.get("start").is_some() || args.get("end").is_some()) {
        let child = data
            .tasks
            .iter()
            .find(|t| t.parent_id == Some(id))
            .map(|t| t.id)
            .unwrap_or(0);
        return Err(CliError::validation(format!(
            "任务 {id}「{}」是父任务，它的进度和计划起止由 {} 个子任务加权汇总，不能直接设置。\n\
             请改成设置具体的子任务，例如：\n  gantt task update {child} --progress 60%",
            task.name,
            data.tasks.iter().filter(|t| t.parent_id == Some(id)).count()
        )));
    }

    // 解析起止：允许只给一个。给了就地校验倒置。
    let new_start = args.get("start").map(parse_cli_date).transpose().map_err(CliError::validation)?;
    let new_end = args.get("end").map(parse_cli_date).transpose().map_err(CliError::validation)?;
    let cur_start = gantt_core::calendar::iso_to_days(&task.start_date);
    let cur_end = gantt_core::calendar::iso_to_days(&task.end_date);
    let eff_start = new_start.or(cur_start);
    let eff_end = new_end.or(cur_end);
    if let (Some(s), Some(e)) = (eff_start, eff_end) {
        if e < s {
            return Err(CliError::validation(format!(
                "结束日期 {} 早于开始日期 {}。",
                days_to_iso(e),
                days_to_iso(s)
            )));
        }
    }
    if let Some(s) = new_start {
        patch.start_date = Some(days_to_iso(s));
    }
    if let Some(e) = new_end {
        patch.end_date = Some(days_to_iso(e));
    }
    // --duration：以现有（或新给的）开始日为锚推结束日
    if let Some(d) = args.get("duration") {
        let days = parse_cli_duration(d).map_err(CliError::validation)?;
        let anchor = eff_start.ok_or_else(|| {
            CliError::validation("用 --duration 需要知道开始日期，但这个任务没有可用的开始日期")
        })?;
        patch.end_date = Some(days_to_iso(anchor + days - 1));
    }

    if let Some(p) = args.get("priority") {
        patch.priority = Some(parse_priority(p)?);
    }
    if let Some(pr) = args.get("progress") {
        patch.progress = Some(parse_progress(pr)?);
    }
    if let Some(w) = args.get("weight") {
        patch.weight = Some(Some(
            w.parse().map_err(|_| CliError::args(format!("--weight 要一个数字，收到「{w}」")))?,
        ));
    }
    if args.has("milestone") {
        patch.milestone = Some(true);
    }
    if args.has("auto-rollover") {
        patch.auto_rollover = Some(true);
    }
    if args.has("no-auto-rollover") {
        patch.auto_rollover = Some(false);
    }
    if let Some(note) = args.get("note") {
        patch.note = Some(note.to_string());
    }

    // 负责人：--clear-assignee 清空，否则按名字/id 找
    if args.has("clear-assignee") {
        patch.person_id = Some(None);
    } else if args.get("assignee").is_some() || args.get("person-id").is_some() {
        patch.person_id = Some(resolve_assignee(&conn, &data, args)?);
    }

    // 换父任务：不能指到自己或自己的后代（会造出环）
    if let Some(np) = args.get("parent") {
        let target: Option<i64> = if np == "none" || np.is_empty() {
            None
        } else {
            let t: i64 = np
                .parse()
                .map_err(|_| CliError::args(format!("--parent 要一个任务 id 或 none，收到「{np}」")))?;
            if t == id {
                return Err(CliError::validation("任务不能把自己当父任务"));
            }
            if !data.tasks.iter().any(|x| x.id == t) {
                return Err(CliError::validation(format!("父任务 {t} 不在项目 {pid} 里")));
            }
            if is_descendant(&data.tasks, t, id) {
                return Err(CliError::validation(format!(
                    "不能把任务 {id} 挂到 {t} 下：{t} 是 {id} 的后代，这样会造出环。"
                )));
            }
            Some(t)
        };
        patch.parent_id = Some(target);
    }

    if patch.is_empty() {
        return Err(CliError::args(
            "没有要改的字段。可用：--name --start --end --duration --priority --progress --weight --assignee --parent --note --milestone …",
        ));
    }

    write::update_task(&conn, id, &patch).map_err(CliError::db)?;

    let (updated, _) = find_task_anywhere(&conn, id)?;
    if args.json() {
        print_json(&updated)?;
    } else {
        println!("已更新任务 {}「{}」", updated.id, updated.name);
    }
    Ok(())
}

fn cmd_task_delete(args: &Args) -> CliResult<()> {
    let id = single_id(args, "task delete")?;
    let conn = open_rw(args)?;
    let (task, pid) = find_task_anywhere(&conn, id)?;
    let data = query::load_project(&conn, pid).map_err(CliError::db)?;
    let child_count = data.tasks.iter().filter(|t| t.parent_id == Some(id)).count();

    if child_count > 0 && !args.has("yes") {
        return Err(CliError::validation(format!(
            "任务 {id}「{}」有 {child_count} 个子任务，删它会连子任务一起删。\
             确认请加 --yes。",
            task.name
        )));
    }

    write::delete_task(&conn, id).map_err(CliError::db)?;
    if args.json() {
        print_json(&serde_json::json!({ "deleted": id, "children": child_count }))?;
    } else {
        println!("已删任务 {id}「{}」（含 {child_count} 个子任务）", task.name);
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* risk 命令                                                           */
/* ------------------------------------------------------------------ */

fn cmd_risk_add(args: &Args) -> CliResult<()> {
    let task_id = bare_id(args, "risk add")?;
    let content = args.require("content")?.to_string();
    let level = args
        .get("level")
        .map(parse_level)
        .transpose()?
        .unwrap_or(1); // 不指定时按「中」——最高档留给明确的判断

    let conn = open_rw(args)?;
    // 先确认任务存在：外键会拦，但那样报出来的是 SQL 的错误，
    // 这里给一句能直接照做的中文。
    find_task_anywhere(&conn, task_id)?;

    let risk = query::add_risk(&conn, task_id, content, level).map_err(CliError::validation)?;
    if args.json() {
        print_json(&risk)?;
    } else {
        println!(
            "已在任务 {task_id} 上记风险 {}「{}」（{}）",
            risk.id,
            truncate(&risk.content, 30),
            level_label(risk.level)
        );
    }
    Ok(())
}

fn cmd_risk_list(args: &Args) -> CliResult<()> {
    let task_id = bare_id(args, "risk list")?;
    let conn = open_ro(args)?;
    find_task_anywhere(&conn, task_id)?;
    let notes = query::load_task_notes(&conn, task_id).map_err(CliError::db)?;

    if args.json() {
        print_json(&notes.risks)?;
        return Ok(());
    }
    if notes.risks.is_empty() {
        println!("（任务 {task_id} 上没有风险）");
        return Ok(());
    }
    print_risk_table(&notes.risks);
    Ok(())
}

/// 整个项目的风险 —— 站在项目视角看「还有哪些坑没填」，
/// 比逐个任务翻要实用，也是复盘时的入口。
fn cmd_risk_project(args: &Args) -> CliResult<()> {
    let conn = open_ro(args)?;
    let pid = resolve_project(&conn, project_selector(args)?)?;
    let risks = query::load_project_risks(&conn, pid).map_err(CliError::db)?;

    if args.json() {
        print_json(&risks)?;
        return Ok(());
    }
    if risks.is_empty() {
        println!("（项目 {pid} 里没有风险）");
        return Ok(());
    }
    // 项目视角下任务 id 才有意义 —— 同一张表里混着多个任务的风险
    println!("{:>5}  {:>5}  {:<8} {:<6} {}", "风险", "任务", "等级", "状态", "内容");
    for r in &risks {
        println!(
            "{:>5}  {:>5}  {:<8} {:<6} {}",
            r.id,
            r.task_id,
            level_label(r.level),
            if r.resolved { "已解决" } else { "未解决" },
            truncate(&r.content, 40)
        );
    }
    Ok(())
}

/// 改措辞或等级。**不碰开关状态** —— 关闭风险只能走 `risk resolve`，
/// 那里强制写处置说明（core 层也一样，`update_risk` 有意不碰 `resolved`）。
fn cmd_risk_update(args: &Args) -> CliResult<()> {
    let id = bare_id(args, "risk update")?;
    if args.get("content").is_none() && args.get("level").is_none() {
        return Err(CliError::args(
            "没有要改的字段。可用：--content <文本> --level high|medium|low",
        ));
    }
    let conn = open_rw(args)?;

    let (content, level) = read_risk(&conn, id)?;
    let content = args.get("content").map(str::to_string).unwrap_or(content);
    let level = match args.get("level") {
        Some(l) => parse_level(l)?,
        None => level,
    };

    query::update_risk(&conn, id, content, level).map_err(CliError::validation)?;
    if args.json() {
        print_json(&read_risk_json(&conn, id)?)?;
    } else {
        println!("已更新风险 {id}");
    }
    Ok(())
}

/// 关闭一条风险。`--resolution` 是必填 —— core 会拒空说明，这里先拦一道，
/// 好把「为什么必填」讲给 Agent 听，而不是让它收到一句「要写清楚是怎么解决的」。
fn cmd_risk_resolve(args: &Args) -> CliResult<()> {
    let id = bare_id(args, "risk resolve")?;
    let resolution = args.require("resolution")?.to_string();
    if resolution.trim().is_empty() {
        return Err(CliError::validation(
            "关闭风险要写清楚怎么解决的。--resolution 不能是空的。",
        ));
    }
    let conn = open_rw(args)?;
    read_risk(&conn, id)?; // 先确认存在，好报一句人话
    query::resolve_risk(&conn, id, resolution).map_err(CliError::db)?;

    if args.json() {
        print_json(&read_risk_json(&conn, id)?)?;
    } else {
        println!("已关闭风险 {id}");
    }
    Ok(())
}

/// 重开：问题又回来了，或上次关早了。处置说明会被清掉（core 有意为之，
/// 免得界面上出现一条「未关闭」却挂着「已解决：…」的矛盾记录）。
fn cmd_risk_reopen(args: &Args) -> CliResult<()> {
    let id = bare_id(args, "risk reopen")?;
    let conn = open_rw(args)?;
    read_risk(&conn, id)?;
    query::reopen_risk(&conn, id).map_err(CliError::db)?;
    if args.json() {
        print_json(&read_risk_json(&conn, id)?)?;
    } else {
        println!("已重新打开风险 {id}");
    }
    Ok(())
}

fn cmd_risk_delete(args: &Args) -> CliResult<()> {
    let id = bare_id(args, "risk delete")?;
    let conn = open_rw(args)?;
    read_risk(&conn, id)?;
    query::delete_risk(&conn, id).map_err(CliError::db)?;
    if args.json() {
        print_json(&serde_json::json!({ "deleted": id }))?;
    } else {
        println!("已删风险 {id}");
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* comment 命令                                                        */
/* ------------------------------------------------------------------ */

/// 评论是**只有追加**的：core 里没有 `update_comment`。要改就删了重发 ——
/// 评论的意思是「什么时候谁说了什么」，改一条已发出的评论会让历史失真。
fn cmd_comment_add(args: &Args) -> CliResult<()> {
    let task_id = bare_id(args, "comment add")?;
    let content = args.require("content")?.to_string();
    let conn = open_rw(args)?;
    find_task_anywhere(&conn, task_id)?;
    let comment = query::add_comment(&conn, task_id, content).map_err(CliError::validation)?;
    if args.json() {
        print_json(&comment)?;
    } else {
        println!(
            "已在任务 {task_id} 上加评论 {}「{}」",
            comment.id,
            truncate(&comment.content, 30)
        );
    }
    Ok(())
}

fn cmd_comment_list(args: &Args) -> CliResult<()> {
    let task_id = bare_id(args, "comment list")?;
    let conn = open_ro(args)?;
    find_task_anywhere(&conn, task_id)?;
    let notes = query::load_task_notes(&conn, task_id).map_err(CliError::db)?;

    if args.json() {
        print_json(&notes.comments)?;
        return Ok(());
    }
    if notes.comments.is_empty() {
        println!("（任务 {task_id} 上没有评论）");
        return Ok(());
    }
    println!("{:>5}  {:<17} {}", "ID", "时间", "内容");
    for c in &notes.comments {
        println!(
            "{:>5}  {:<17} {}",
            c.id,
            fmt_unix(c.created_at),
            truncate(&c.content, 40)
        );
    }
    Ok(())
}

fn cmd_comment_delete(args: &Args) -> CliResult<()> {
    let id = bare_id(args, "comment delete")?;
    let conn = open_rw(args)?;
    let exists: bool = conn
        .query_row("SELECT 1 FROM comments WHERE id = ?1", [id], |_| Ok(true))
        .unwrap_or(false);
    if !exists {
        return Err(CliError::validation(format!("找不到评论 {id}")));
    }
    query::delete_comment(&conn, id).map_err(CliError::db)?;
    if args.json() {
        print_json(&serde_json::json!({ "deleted": id }))?;
    } else {
        println!("已删评论 {id}");
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* note 命令（逐日记录）                                                */
/* ------------------------------------------------------------------ */

/// 记一条当天的进展。`--day` 缺省是今天；`--task` 把这条记录挂到某条任务上
/// （不挂就是项目级的）。
fn cmd_note_add(args: &Args) -> CliResult<()> {
    let content = args.require("content")?.to_string();
    let day = match args.get("day") {
        Some(d) => days_to_iso(parse_cli_date(d).map_err(CliError::validation)?),
        None => gantt_core::calendar::today_iso(),
    };
    let task_id = match args.get("task") {
        Some(t) => {
            let id: i64 = t
                .parse()
                .map_err(|_| CliError::args(format!("--task 要一个任务 id，收到「{t}」")))?;
            Some(id)
        }
        None => None,
    };

    let conn = open_rw(args)?;
    let pid = resolve_project(&conn, project_selector(args)?)?;

    // --task 必须属于这个项目，否则会在库里留下一条跨项目的引用
    // —— 那正是 `check` 要抓的坏数据之一。
    if let Some(tid) = task_id {
        let owns: bool = conn
            .query_row(
                "SELECT 1 FROM tasks WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![tid, pid],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !owns {
            return Err(CliError::validation(format!(
                "任务 {tid} 不在项目 {pid} 里。跨项目的逐日记录会造成数据不一致。"
            )));
        }
    }

    let note = query::add_daily_note(&conn, pid, task_id, day, content)
        .map_err(CliError::validation)?;
    if args.json() {
        print_json(&note)?;
    } else {
        println!("已记 {} 的进展 {}「{}」", note.day, note.id, truncate(&note.content, 30));
    }
    Ok(())
}

fn cmd_note_list(args: &Args) -> CliResult<()> {
    let conn = open_ro(args)?;
    let pid = resolve_project(&conn, project_selector(args)?)?;
    let notes = query::load_daily_notes(&conn, pid).map_err(CliError::db)?;

    if args.json() {
        print_json(&notes)?;
        return Ok(());
    }
    if notes.is_empty() {
        println!("（项目 {pid} 里还没有逐日记录）");
        return Ok(());
    }
    println!("{:>5}  {:<12} {:>5} {}", "ID", "日期", "任务", "内容");
    for n in &notes {
        let task = n.task_id.map(|t| t.to_string()).unwrap_or_else(|| "—".into());
        println!(
            "{:>5}  {:<12} {:>5} {}",
            n.id,
            n.day,
            task,
            truncate(&n.content, 40)
        );
    }
    Ok(())
}

/// 改内容或归属的那一天。同日可以改 `--day`（周一早上补记周五的事很容易写成今天），
/// 但 `created_at` 不动 —— 那是「这句话什么时候说的」，是历史事实。
fn cmd_note_update(args: &Args) -> CliResult<()> {
    let id = bare_id(args, "note update")?;
    if args.get("content").is_none() && args.get("day").is_none() {
        return Err(CliError::args(
            "没有要改的字段。可用：--content <文本> --day <日期>",
        ));
    }
    let conn = open_rw(args)?;
    let (cur_day, cur_content) = read_note(&conn, id)?;

    let day = match args.get("day") {
        Some(d) => days_to_iso(parse_cli_date(d).map_err(CliError::validation)?),
        None => cur_day,
    };
    let content = args.get("content").map(str::to_string).unwrap_or(cur_content);

    query::update_daily_note(&conn, id, day, content).map_err(CliError::validation)?;
    if args.json() {
        print_json(&read_note_json(&conn, id)?)?;
    } else {
        println!("已更新逐日记录 {id}");
    }
    Ok(())
}

fn cmd_note_delete(args: &Args) -> CliResult<()> {
    let id = bare_id(args, "note delete")?;
    let conn = open_rw(args)?;
    read_note(&conn, id)?;
    query::delete_daily_note(&conn, id).map_err(CliError::db)?;
    if args.json() {
        print_json(&serde_json::json!({ "deleted": id }))?;
    } else {
        println!("已删逐日记录 {id}");
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* baseline 命令                                                       */
/* ------------------------------------------------------------------ */

/// 把当前所有任务的计划日期冻结成一条基线。只存日期，不存进度
/// （DESIGN.md §3.1）—— 基线回答的是「当初说好什么时候做」，不是「做到哪了」。
fn cmd_baseline_create(args: &Args) -> CliResult<()> {
    let name = args.require("name")?.to_string();
    let mut conn = open_rw(args)?;
    let pid = resolve_project(&conn, project_selector(args)?)?;

    let baseline = query::create_baseline(&mut conn, pid, name).map_err(CliError::db)?;
    if args.json() {
        print_json(&baseline)?;
    } else {
        println!("已为项目 {pid} 建基线 {}「{}」", baseline.id, baseline.name);
    }
    Ok(())
}

fn cmd_baseline_list(args: &Args) -> CliResult<()> {
    let conn = open_ro(args)?;
    let pid = resolve_project(&conn, project_selector(args)?)?;
    let data = query::load_project(&conn, pid).map_err(CliError::db)?;

    if args.json() {
        print_json(&data.baselines)?;
        return Ok(());
    }
    if data.baselines.is_empty() {
        println!("（项目 {pid} 里还没有基线）");
        return Ok(());
    }
    println!("{:>4}  {:<20} {}", "ID", "名称", "建立时间");
    for b in &data.baselines {
        println!("{:>4}  {:<20} {}", b.id, truncate(&b.name, 20), b.created_at);
    }
    Ok(())
}

fn cmd_baseline_show(args: &Args) -> CliResult<()> {
    let id = bare_id(args, "baseline show")?;
    let conn = open_ro(args)?;
    let rows = query::load_baseline(&conn, id).map_err(CliError::db)?;

    if args.json() {
        print_json(&rows)?;
        return Ok(());
    }
    if rows.is_empty() {
        // 空可能是「这条基线建的时候项目还没任务」，也可能是 id 根本不存在。
        // 前者是合法的，所以不报错，但要把话说明白。
        println!("（基线 {id} 里没有任务快照）");
        return Ok(());
    }
    println!("{:>5}  {:<28} {:<12} {:<12} {:>4}", "任务", "名称", "计划开始", "计划结束", "工期");
    for r in &rows {
        println!(
            "{:>5}  {:<28} {:<12} {:<12} {:>4}",
            r.task_id,
            truncate(&r.name, 28),
            r.start_date,
            r.end_date,
            r.duration
        );
    }
    Ok(())
}

fn cmd_baseline_delete(args: &Args) -> CliResult<()> {
    let id = bare_id(args, "baseline delete")?;
    let conn = open_rw(args)?;
    query::delete_baseline(&conn, id).map_err(CliError::db)?;
    if args.json() {
        print_json(&serde_json::json!({ "deleted": id }))?;
    } else {
        println!("已删基线 {id}");
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* setting 命令                                                        */
/* ------------------------------------------------------------------ */

/// 设置表是给插件系统和排障用的键值仓，不是 Agent 的主力工作面。
/// 暴露出来是为了「脚本能读回自己上次写了什么」，而不是鼓励往里堆业务数据。
fn cmd_setting_get(args: &Args) -> CliResult<()> {
    let key = args
        .positionals
        .first()
        .ok_or_else(|| CliError::args("setting get 需要一个键，例如 `gantt setting get plugin.foo`"))?
        .clone();
    let conn = open_ro(args)?;
    let value = query::get_setting(&conn, key.clone()).map_err(CliError::db)?;

    if args.json() {
        print_json(&serde_json::json!({ "key": key, "value": value }))?;
    } else {
        match value {
            Some(v) => println!("{key} = {v}"),
            None => println!("（没有设置项「{key}」）"),
        }
    }
    Ok(())
}

fn cmd_setting_set(args: &Args) -> CliResult<()> {
    let key = args
        .positionals
        .first()
        .ok_or_else(|| CliError::args("setting set 需要一个键，例如 `gantt setting set plugin.foo --value bar`"))?
        .clone();
    let value = args.require("value")?.to_string();
    let conn = open_rw(args)?;
    query::set_setting(&conn, key.clone(), value.clone()).map_err(CliError::db)?;
    if args.json() {
        print_json(&serde_json::json!({ "key": key, "value": value }))?;
    } else {
        println!("已设置 {key} = {value}");
    }
    Ok(())
}

fn cmd_setting_list(args: &Args) -> CliResult<()> {
    let prefix = args.get("prefix").unwrap_or("").to_string();
    let conn = open_ro(args)?;
    let rows = query::list_settings_with_prefix(&conn, prefix).map_err(CliError::db)?;

    if args.json() {
        let map: BTreeMap<String, String> = rows.into_iter().collect();
        print_json(&map)?;
        return Ok(());
    }
    if rows.is_empty() {
        println!("（没有匹配的设置项）");
        return Ok(());
    }
    println!("{:<32} {}", "键", "值");
    for (k, v) in &rows {
        println!("{:<32} {}", truncate(k, 32), v);
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* check                                                               */
/* ------------------------------------------------------------------ */

fn cmd_check(args: &Args) -> CliResult<()> {
    let conn = open_ro(args)?;
    let issues = query::check_integrity(&conn).map_err(CliError::db)?;
    if args.json() {
        print_json(&serde_json::json!({ "ok": issues.is_empty(), "issues": issues }))?;
    } else if issues.is_empty() {
        println!("✓ 没有发现结构性问题");
    } else {
        println!("发现 {} 个问题：", issues.len());
        for i in &issues {
            println!("  · {i}");
        }
    }
    // 有问题时也用退出码 2，让脚本能分支
    if !issues.is_empty() {
        return Err(CliError {
            message: format!("完整性检查发现 {} 个问题（详见上方）", issues.len()),
            code: code::VALIDATION,
        });
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* 共用助手                                                            */
/* ------------------------------------------------------------------ */

/// `--project <id|name>`。两种都收：脚本方便用 id，人方便用名。
fn project_selector(args: &Args) -> CliResult<String> {
    args.get("project")
        .map(|s| s.to_string())
        .ok_or_else(|| CliError::args("缺少 --project <id 或 项目名>"))
}

/// 把 id 或名字解析成项目 id。名字要唯一命中，命不中或撞名都报清楚。
fn resolve_project(conn: &Connection, selector: String) -> CliResult<i64> {
    if let Ok(id) = selector.parse::<i64>() {
        let exists: bool = conn
            .query_row("SELECT 1 FROM projects WHERE id = ?1", [id], |_| Ok(true))
            .unwrap_or(false);
        if exists {
            return Ok(id);
        }
        // 数字但没这个 id：也许有人把项目命名成数字，往下走按名字试
    }

    let projects = query::list_projects(conn).map_err(CliError::db)?;
    let matches: Vec<&ProjectSummary> = projects
        .iter()
        .filter(|p| p.project.name == selector)
        .collect();
    match matches.as_slice() {
        [one] => Ok(one.project.id),
        [] => Err(CliError::validation(format!(
            "找不到项目「{selector}」。用 `gantt project list` 看看有哪些。"
        ))),
        many => Err(CliError::validation(format!(
            "有 {} 个项目都叫「{selector}」，请改用 id：{}",
            many.len(),
            many.iter().map(|p| p.project.id.to_string()).collect::<Vec<_>>().join(" / ")
        ))),
    }
}

/// 单个位置参数当作任务 id：`gantt task show 47`。
fn single_id(args: &Args, cmd: &str) -> CliResult<i64> {
    let raw = args
        .positionals
        .first()
        .ok_or_else(|| CliError::args(format!("{cmd} 需要一个任务 id，例如 `{cmd} 47`")))?;
    raw.parse()
        .map_err(|_| CliError::args(format!("任务 id 要是数字，收到「{raw}」")))
}

/// 全库找一条任务，连它属于哪个项目一起返回。CLI 的 show/update/delete
/// 只给 id，不给项目，所以要能凭 id 反查。
fn find_task_anywhere(conn: &Connection, id: i64) -> CliResult<(TaskRow, i64)> {
    let pid: Option<i64> = conn
        .query_row("SELECT project_id FROM tasks WHERE id = ?1", [id], |r| r.get(0))
        .ok();
    let pid = pid.ok_or_else(|| {
        CliError::validation(format!("找不到任务 {id}。用 `gantt task list --project <id>` 看看。"))
    })?;
    let data = query::load_project(conn, pid).map_err(CliError::db)?;
    let task = data
        .tasks
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| CliError::db(format!("任务 {id} 在项目 {pid} 里没找到（数据不一致）")))?;
    Ok((task, pid))
}

/// 把 `--assignee 名字` / `--person-id n` 解析成 person_id。
/// 找不到名字时**报错并列出现有人名**，绝不静默创建 —— 一个错别字多一个「负责人」
/// 正是 002_people.sql 当初要根治的问题。加 --create-missing 才新建。
fn resolve_assignee(conn: &Connection, data: &ProjectData, args: &Args) -> CliResult<Option<i64>> {
    if let Some(pid) = args.get("person-id") {
        let id: i64 = pid
            .parse()
            .map_err(|_| CliError::args(format!("--person-id 要一个数字，收到「{pid}」")))?;
        if !data.people.iter().any(|p| p.id == id) {
            return Err(CliError::validation(format!("没有 id 为 {id} 的负责人")));
        }
        return Ok(Some(id));
    }

    let Some(name) = args.get("assignee") else {
        return Ok(None);
    };
    let name = name.trim();
    if let Some(p) = data.people.iter().find(|p| p.name == name) {
        return Ok(Some(p.id));
    }

    if args.has("create-missing") {
        let person = query::create_person(conn, name.to_string(), "#868E96".to_string())
            .map_err(CliError::validation)?;
        return Ok(Some(person.id));
    }

    let existing = if data.people.is_empty() {
        "（这个项目还没有任何负责人）".to_string()
    } else {
        data.people.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join("、")
    };
    Err(CliError::validation(format!(
        "找不到叫「{name}」的负责人。现有：{existing}。\n\
         确认是新人请加 --create-missing，或先 `gantt people create --name {name}`。"
    )))
}

/// 优先级：P0–P3 或 0–3，都映射到 0=紧急 … 3=低（同前端 PRIORITY_LABELS）。
fn parse_priority(text: &str) -> CliResult<i64> {
    let t = text.trim().to_ascii_uppercase();
    let n = t.strip_prefix('P').unwrap_or(&t);
    let v: i64 = n
        .parse()
        .map_err(|_| CliError::args(format!("看不懂优先级「{text}」。写 P0/P1/P2/P3 或 0-3。")))?;
    if !(0..=3).contains(&v) {
        return Err(CliError::args(format!("优先级只能是 0-3（P0 最紧急），收到 {v}")));
    }
    Ok(v)
}

/// 进度：`60%` 或 `0.6`，都归一到 0.0–1.0。
fn parse_progress(text: &str) -> CliResult<f64> {
    let t = text.trim();
    let v = if let Some(pct) = t.strip_suffix('%') {
        pct.trim()
            .parse::<f64>()
            .map_err(|_| CliError::args(format!("看不懂进度「{text}」，写 60% 或 0.6")))?
            / 100.0
    } else {
        t.parse::<f64>()
            .map_err(|_| CliError::args(format!("看不懂进度「{text}」，写 60% 或 0.6")))?
    };
    if !(0.0..=1.0).contains(&v) {
        return Err(CliError::validation(format!(
            "进度要在 0% 到 100% 之间，收到「{text}」"
        )));
    }
    Ok(v)
}

fn priority_label(p: i64) -> &'static str {
    match p {
        0 => "P0 紧急",
        1 => "P1 高",
        2 => "P2 中",
        _ => "P3 低",
    }
}

fn validate_color(color: &str) -> CliResult<()> {
    let ok = color.len() == 7
        && color.starts_with('#')
        && color[1..].bytes().all(|b| b.is_ascii_hexdigit());
    if ok {
        Ok(())
    } else {
        Err(CliError::args(format!("颜色要写成 #RRGGBB，收到「{color}」")))
    }
}

/// t 是不是 ancestor 的后代（沿 parent 链往上找 ancestor）。换父任务防环用。
fn is_descendant(tasks: &[TaskRow], t: i64, ancestor: i64) -> bool {
    let mut cur = Some(t);
    let mut guard = 0;
    while let Some(id) = cur {
        if id == ancestor {
            return true;
        }
        guard += 1;
        if guard > 1000 {
            break; // 已有的环，别陷进去
        }
        cur = tasks.iter().find(|x| x.id == id).and_then(|x| x.parent_id);
    }
    false
}

fn truncate(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        s.to_string()
    } else {
        format!("{}…", chars[..max.saturating_sub(1)].iter().collect::<String>())
    }
}

/// 单个位置参数当作一个「某种 id」——`gantt risk update 12`、`gantt note delete 5`。
///
/// 和 `single_id` 的差别只在报错措辞：`single_id` 咬死「任务 id」，
/// 而风险 / 评论 / 逐日记录 / 基线拿的是它们各自的 id，不是任务 id，
/// 把 id 张冠李戴正是最容易让 Agent 犯的错，报错里得说清是哪种 id。
fn bare_id(args: &Args, cmd: &str) -> CliResult<i64> {
    let raw = args
        .positionals
        .first()
        .ok_or_else(|| CliError::args(format!("{cmd} 需要一个 id，例如 `gantt {cmd} 12`")))?;
    raw.parse()
        .map_err(|_| CliError::args(format!("id 要是数字，收到「{raw}」")))
}

/// 把 `SELECT * FROM projects` 的一行映射成 `Project`。
/// 列序按 001_init.sql 的定义：id, name, color, work_days, holidays,
/// sort_order, created_at, updated_at —— **注意没有 uuid 列在这个位置**，
/// uuid 是 007 后加的，排在最后。
fn map_project_row(r: &rusqlite::Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: r.get("id")?,
        uuid: r.get("uuid")?,
        name: r.get("name")?,
        color: r.get("color")?,
        work_days: r.get("work_days")?,
        holidays: r.get("holidays")?,
        sort_order: r.get("sort_order")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

/// 风险等级：`high|medium|low` → `0|1|2`，也接受裸的 `0|1|2`。
/// 方向和优先级一致（数字越小越严重），所以 high=0。
fn parse_level(text: &str) -> CliResult<i64> {
    match text.trim().to_ascii_lowercase().as_str() {
        "high" | "h" | "0" => Ok(0),
        "medium" | "mid" | "m" | "1" => Ok(1),
        "low" | "l" | "2" => Ok(2),
        other => Err(CliError::args(format!(
            "风险等级只能是 high|medium|low（或 0|1|2），收到「{other}」"
        ))),
    }
}

fn level_label(level: i64) -> &'static str {
    match level {
        0 => "高",
        1 => "中",
        _ => "低",
    }
}

/// 工作日：接受 `1,2,3,4,5`（逗号分隔）或 JSON 数组文本 `[1,2,3,4,5]`，
/// 存成 core 期望的 JSON 数组字符串。
///
/// 序号用 JS `Date.getUTCDay()` 的约定 —— **0=周日、1=周一 … 6=周六**
/// （消费方是前端 `WorkCalendar.fromProject`）。为了照顾「周日写 7」的直觉，
/// 这里把 `7` 折成 `0`。结果去重并排序，免得 `[1,1,2]` 这种脏值进库。
fn parse_work_days(text: &str) -> CliResult<String> {
    let body = text.trim().trim_start_matches('[').trim_end_matches(']');
    let mut days: Vec<i64> = Vec::new();
    for part in body.split(',') {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        let mut n: i64 = p
            .parse()
            .map_err(|_| CliError::args(format!("工作日要是 0-7 的数字，收到「{p}」")))?;
        if n == 7 {
            n = 0; // 周日：7 和 0 都收，存 0
        }
        if !(0..=6).contains(&n) {
            return Err(CliError::args(format!(
                "工作日只能是 0-6（0=周日，1=周一 … 6=周六；周日也可写 7），收到「{p}」"
            )));
        }
        if !days.contains(&n) {
            days.push(n);
        }
    }
    if days.is_empty() {
        return Err(CliError::args(
            "工作日不能为空。例如 --work-days 1,2,3,4,5（周一到周五）",
        ));
    }
    days.sort_unstable();
    Ok(serde_json::to_string(&days).unwrap())
}

/// 节假日：接受逗号分隔的 ISO 日期（`2026-10-01,2026-10-02`）或 JSON 数组文本，
/// 存成 JSON 数组字符串。每个日期都走 `iso_to_days` 校验，挡掉 `2026-13-40` 这种。
/// 空串合法（表示「没有节假日」），存成 `[]`。
fn parse_holidays(text: &str) -> CliResult<String> {
    let body = text.trim().trim_start_matches('[').trim_end_matches(']');
    let mut dates: Vec<String> = Vec::new();
    for part in body.split(',') {
        let p = part.trim().trim_matches('"');
        if p.is_empty() {
            continue;
        }
        if gantt_core::calendar::iso_to_days(p).is_none() {
            return Err(CliError::args(format!(
                "节假日要写成 ISO 日期 YYYY-MM-DD，收到「{p}」"
            )));
        }
        if !dates.contains(&p.to_string()) {
            dates.push(p.to_string());
        }
    }
    dates.sort();
    Ok(serde_json::to_string(&dates).unwrap())
}

/// Unix 秒渲染成 `YYYY-MM-DD`（展示用，够了；小时分钟对排期没意义）。
fn fmt_unix(secs: i64) -> String {
    days_to_iso(secs.div_euclid(86_400))
}

/// 读回一条风险的 (content, level)，顺便确认它存在 —— 存在检查放在这里，
/// 好在 update/resolve/reopen/delete 前统一报一句人话，而不是让 core 的
/// `n == 0` 分支或外键抛出难懂的 SQL 错。
fn read_risk(conn: &Connection, id: i64) -> CliResult<(String, i64)> {
    conn.query_row(
        "SELECT content, level FROM risks WHERE id = ?1",
        [id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
    )
    .map_err(|_| CliError::validation(format!("找不到风险 {id}。用 `gantt risk project <项目>` 看看。")))
}

fn read_risk_json(conn: &Connection, id: i64) -> CliResult<Risk> {
    conn.query_row(
        "SELECT id, task_id, content, level, resolved, created_at, resolved_at, resolution \
         FROM risks WHERE id = ?1",
        [id],
        |r| {
            Ok(Risk {
                id: r.get(0)?,
                task_id: r.get(1)?,
                content: r.get(2)?,
                level: r.get(3)?,
                resolved: r.get::<_, i64>(4)? != 0,
                created_at: r.get(5)?,
                resolved_at: r.get(6)?,
                resolution: r.get(7)?,
            })
        },
    )
    .map_err(|e| CliError::db(e.to_string()))
}

fn print_risk_table(risks: &[Risk]) {
    println!("{:>5}  {:<8} {:<6} {}", "ID", "等级", "状态", "内容");
    for r in risks {
        println!(
            "{:>5}  {:<8} {:<6} {}",
            r.id,
            level_label(r.level),
            if r.resolved { "已解决" } else { "未解决" },
            truncate(&r.content, 40)
        );
    }
}

/// 读回一条逐日记录的 (day, content)，顺便确认存在。
fn read_note(conn: &Connection, id: i64) -> CliResult<(String, String)> {
    conn.query_row(
        "SELECT day, content FROM daily_notes WHERE id = ?1",
        [id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )
    .map_err(|_| CliError::validation(format!("找不到逐日记录 {id}。用 `gantt note list --project <项目>` 看看。")))
}

fn read_note_json(conn: &Connection, id: i64) -> CliResult<DailyNote> {
    conn.query_row(
        "SELECT id, project_id, task_id, day, content, created_at, updated_at \
         FROM daily_notes WHERE id = ?1",
        [id],
        |r| {
            Ok(DailyNote {
                id: r.get(0)?,
                project_id: r.get(1)?,
                task_id: r.get(2)?,
                day: r.get(3)?,
                content: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
            })
        },
    )
    .map_err(|e| CliError::db(e.to_string()))
}

fn print_json<T: serde::Serialize>(value: &T) -> CliResult<()> {
    let s = serde_json::to_string_pretty(value)
        .map_err(|e| CliError::db(format!("序列化 JSON 失败：{e}")))?;
    println!("{s}");
    Ok(())
}

fn print_usage() {
    println!(
        r#"gantt —— Gantt 的命令行接口（给 AI / 脚本用）

项目：
  gantt project list [--json]
  gantt project show --project <id|名称> [--json]
  gantt project create --name <名称> [--color #RRGGBB] [--json]
  gantt project rename --project <id|名称> --name <新名> [--color #RRGGBB] [--json]
  gantt project calendar --project <id|名称> [--work-days 1,2,3,4,5] [--holidays 2026-10-01,2026-10-02] [--json]
  gantt project delete --project <id|名称> --yes [--json]

任务：
  gantt task list --project <id|名称> [--json]
  gantt task show <id> [--json]
  gantt task create --project <id|名称> --name <名称>
                    [--duration 5d|2w] [--start today|2026-10-01|+3d] [--end ...]
                    [--priority P0|P1|P2|P3] [--assignee <名字>|--person-id <n>]
                    [--parent <id>] [--after <id>] [--milestone]
                    [--progress 60%] [--weight <n>] [--note <文本>]
                    [--auto-rollover] [--create-missing] [--json]
  gantt task update <id> [上面任意字段] [--parent none] [--clear-assignee] [--json]
  gantt task delete <id> [--yes] [--json]

风险（<task> 是任务 id；update/resolve/reopen/delete 拿的是风险 id）：
  gantt risk add <task> --content <文本> [--level high|medium|low] [--json]
  gantt risk list <task> [--json]
  gantt risk project --project <id|名称> [--json]
  gantt risk update <risk-id> [--content <文本>] [--level high|medium|low] [--json]
  gantt risk resolve <risk-id> --resolution <处置说明> [--json]
  gantt risk reopen <risk-id> [--json]
  gantt risk delete <risk-id> [--json]

评论（只可追加，改就删了重发）：
  gantt comment add <task> --content <文本> [--json]
  gantt comment list <task> [--json]
  gantt comment delete <comment-id> [--json]

逐日记录：
  gantt note add --project <id|名称> --content <文本> [--day today|2026-10-01] [--task <id>] [--json]
  gantt note list --project <id|名称> [--json]
  gantt note update <note-id> [--content <文本>] [--day <日期>] [--json]
  gantt note delete <note-id> [--json]

基线（show/delete 拿的是基线 id）：
  gantt baseline create --project <id|名称> --name <名称> [--json]
  gantt baseline list --project <id|名称> [--json]
  gantt baseline show <baseline-id> [--json]
  gantt baseline delete <baseline-id> [--json]

负责人：
  gantt people list [--json]
  gantt people create --name <名字> [--color #RRGGBB] [--json]
  gantt people update <id> [--name <新名>] [--color #RRGGBB] [--json]
  gantt people delete <id> [--yes] [--json]

设置（给脚本 / 排障用）：
  gantt setting get <key> [--json]
  gantt setting set <key> --value <值> [--json]
  gantt setting list [--prefix <前缀>] [--json]

自检：
  gantt check [--json]

全局选项（可写在组名之前或子命令之后）：
  --data-dir <路径>   覆盖数据目录（默认按平台推，或读 GANTT_DATA_DIR）
  --force             桌面应用开着时也强行写（最后写入者胜出，慎用）
  --json              输出稳定 JSON
  --yes               确认破坏性操作（project/people/task delete）

退出码：0 成功 / 1 参数错 / 2 数据校验失败 / 3 应用占用 / 4 数据库错误

日期只认 ISO（2026-10-01）、today、相对（+3d/-2w/+1m）；工期用 5d/2w/3m。
优先级 P0 最紧急，P3 最低。风险 high 最严重，low 最轻。"#
    );
}

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// 每个测试一个独占的临时数据目录 —— 互不干扰，可以并行跑。
    fn tmp_dir() -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("gantt-cli-test-{}-{}", std::process::id(), n));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// 把一串 token 包成 Args，并把 `--data-dir` 追加在末尾
    /// （先加后加都行，`Args::parse` 只看得到 key/value）。
    fn args(dir: &std::path::Path, tokens: &[&str]) -> Args {
        let mut v: Vec<String> = tokens.iter().map(|s| s.to_string()).collect();
        let flag = v.iter().position(|a| a == "--data-dir");
        if let Some(i) = flag {
            v[i + 1] = dir.display().to_string();
        } else {
            v.push("--data-dir".into());
            v.push(dir.display().to_string());
        }
        Args::parse(&v).expect("测试参数不该解析失败")
    }

    fn db(dir: &std::path::Path) -> Connection {
        gantt_core::open(&locate::db_path(dir)).unwrap()
    }

    /// 建一个项目（id 1）+ 一个任务（id 1），返回临时目录。
    /// 后面的风险 / 评论 / 逐日记录 / 基线都挂在这两个上。
    fn seed() -> PathBuf {
        let dir = tmp_dir();
        cmd_project_create(&args(&dir, &["--name", "验证"])).unwrap();
        cmd_task_create(&args(
            &dir,
            &["--project", "1", "--name", "联调", "--duration", "5d"],
        ))
        .unwrap();
        dir
    }

    /* ---------------------------------------------------------- */
    /* 纯解析器                                                    */
    /* ---------------------------------------------------------- */

    #[test]
    fn parse_level_takes_words_and_digits() {
        assert_eq!(parse_level("high").unwrap(), 0);
        assert_eq!(parse_level("medium").unwrap(), 1);
        assert_eq!(parse_level("low").unwrap(), 2);
        assert_eq!(parse_level("0").unwrap(), 0);
        assert_eq!(parse_level("2").unwrap(), 2);
        assert_eq!(parse_level("  HIGH  ").unwrap(), 0);
        assert!(parse_level("urgent").is_err());
        // 3 越界：CHECK 约束只允许 0-2，必须在解析层就拦住
        assert!(parse_level("3").is_err());
    }

    #[test]
    fn parse_work_days_forms() {
        assert_eq!(parse_work_days("1,2,3,4,5").unwrap(), "[1,2,3,4,5]");
        // 也接受 JSON 数组的字面量
        assert_eq!(parse_work_days("[1,2,3,4,5]").unwrap(), "[1,2,3,4,5]");
        // 7 折成 0（周日 = JS getUTCDay() 的 0），排序后排到最前
        assert_eq!(parse_work_days("7").unwrap(), "[0]");
        assert_eq!(parse_work_days("1,7").unwrap(), "[0,1]");
        // 去重 + 升序
        assert_eq!(parse_work_days("5,1,1,3").unwrap(), "[1,3,5]");
        assert!(parse_work_days("").is_err());
        assert!(parse_work_days("8").is_err());
        assert!(parse_work_days("周一").is_err());
    }

    #[test]
    fn parse_holidays_forms() {
        assert_eq!(
            parse_holidays("2026-10-01,2026-10-02").unwrap(),
            r#"["2026-10-01","2026-10-02"]"#
        );
        assert_eq!(parse_holidays("").unwrap(), "[]");
        assert_eq!(parse_holidays("[]").unwrap(), "[]");
        // 去重 + 升序
        assert_eq!(parse_holidays("2026-10-02,2026-10-01").unwrap(), r#"["2026-10-01","2026-10-02"]"#);
        assert!(parse_holidays("2026-13-40").is_err());
        assert!(parse_holidays("不是日期").is_err());
    }

    #[test]
    fn hoist_globals_lifts_options_before_the_group() {
        let argv: Vec<String> = ["--data-dir", "/tmp/x", "project", "list", "--json"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let (tail, group) = hoist_globals(&argv).unwrap();
        assert_eq!(group.as_deref(), Some("project"));
        // 组名单独返回；tail 以子命令 list 打头，全局选项插在它后面，
        // 这样 dispatch 侧的 split_sub 仍能从 tail[0] 拿到子命令
        assert_eq!(
            tail,
            vec!["list", "--data-dir", "/tmp/x", "--json"]
        );
    }

    #[test]
    fn hoist_globals_group_first_is_untouched() {
        let argv: Vec<String> = ["task", "list", "--project", "3"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let (tail, group) = hoist_globals(&argv).unwrap();
        assert_eq!(group.as_deref(), Some("task"));
        // 组名在开头，全局袋是空的 —— tail 就是组名之后的那一段，原样不动
        assert_eq!(tail, vec!["list", "--project", "3"]);
    }

    #[test]
    fn hoist_globals_missing_value_is_an_error() {
        let argv: Vec<String> = ["--data-dir"].iter().map(|s| s.to_string()).collect();
        assert!(hoist_globals(&argv).is_err());
    }

    /* ---------------------------------------------------------- */
    /* 风险全生命周期                                              */
    /* ---------------------------------------------------------- */

    #[test]
    fn risk_full_lifecycle() {
        let dir = seed();

        cmd_risk_add(&args(
            &dir,
            &["1", "--content", "供应商延期", "--level", "high"],
        ))
        .unwrap();
        {
            let c = db(&dir);
            let (level, resolved): (i64, i64) = c
                .query_row("SELECT level, resolved FROM risks WHERE id = 1", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .unwrap();
            assert_eq!(level, 0, "high 应存成 0");
            assert_eq!(resolved, 0);
        }

        // 处置说明是空的 —— 关掉一个风险却不说怎么处置的，等于没关
        assert!(cmd_risk_resolve(&args(&dir, &["1", "--resolution", "   "])).is_err());

        cmd_risk_resolve(&args(&dir, &["1", "--resolution", "换了供应商"])).unwrap();
        {
            let c = db(&dir);
            let (resolved, at, res): (i64, Option<i64>, Option<String>) = c
                .query_row(
                    "SELECT resolved, resolved_at, resolution FROM risks WHERE id = 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap();
            assert_eq!(resolved, 1);
            assert!(at.is_some(), "resolve 要盖上 resolved_at");
            assert_eq!(res.as_deref(), Some("换了供应商"));
        }

        // 重开：三个字段一起清干净，不留半截状态
        cmd_risk_reopen(&args(&dir, &["1"])).unwrap();
        {
            let c = db(&dir);
            let (resolved, at, res): (i64, Option<i64>, Option<String>) = c
                .query_row(
                    "SELECT resolved, resolved_at, resolution FROM risks WHERE id = 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap();
            assert_eq!(resolved, 0);
            assert!(at.is_none());
            assert!(res.is_none());
        }

        cmd_risk_delete(&args(&dir, &["1"])).unwrap();
        {
            let c = db(&dir);
            let n: i64 = c
                .query_row("SELECT COUNT(*) FROM risks", [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0);
        }
    }

    #[test]
    fn risk_defaults_to_medium_when_level_omitted() {
        let dir = seed();
        cmd_risk_add(&args(&dir, &["1", "--content", "说不准"])).unwrap();
        let c = db(&dir);
        let level: i64 = c
            .query_row("SELECT level FROM risks WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(level, 1, "不写 --level 时默认中");
    }

    #[test]
    fn risk_update_leaves_resolved_alone() {
        let dir = seed();
        cmd_risk_add(&args(&dir, &["1", "--content", "旧措辞", "--level", "low"])).unwrap();
        cmd_risk_update(&args(
            &dir,
            &["1", "--content", "新措辞", "--level", "high"],
        ))
        .unwrap();
        let c = db(&dir);
        let (content, level, resolved): (String, i64, i64) = c
            .query_row(
                "SELECT content, level, resolved FROM risks WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(content, "新措辞");
        assert_eq!(level, 0);
        assert_eq!(resolved, 0, "update 不该顺手把风险关掉或打开");
    }

    #[test]
    fn risk_on_missing_task_is_rejected_with_a_readable_error() {
        let dir = seed();
        let err = cmd_risk_add(&args(&dir, &["999", "--content", "孤儿风险"]))
            .unwrap_err()
            .to_string();
        // 不能漏出原始的外键错误，得让 Agent 看懂该先做什么
        assert!(err.contains("999"), "报错里要说清是哪个任务：{err}");
        assert!(!err.contains("FOREIGN KEY"), "不该漏出 SQLite 原文：{err}");
    }

    #[test]
    fn risk_list_and_project_views_agree() {
        let dir = seed();
        cmd_risk_add(&args(&dir, &["1", "--content", "R1"])).unwrap();
        cmd_risk_add(&args(&dir, &["1", "--content", "R2", "--level", "high"])).unwrap();
        // 两条人读输出都该跑得通
        cmd_risk_list(&args(&dir, &["1"])).unwrap();
        cmd_risk_project(&args(&dir, &["--project", "1"])).unwrap();
        let c = db(&dir);
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM risks WHERE task_id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2);
    }

    /* ---------------------------------------------------------- */
    /* 评论                                                        */
    /* ---------------------------------------------------------- */

    #[test]
    fn comment_add_list_delete() {
        let dir = seed();
        cmd_comment_add(&args(&dir, &["1", "--content", "已同步前端"])).unwrap();
        cmd_comment_list(&args(&dir, &["1"])).unwrap();
        {
            let c = db(&dir);
            let (content, created): (String, i64) = c
                .query_row("SELECT content, created_at FROM comments WHERE id = 1", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .unwrap();
            assert_eq!(content, "已同步前端");
            assert!(created > 0, "created_at 是 Unix 秒，不该是 0");
        }

        cmd_comment_delete(&args(&dir, &["1"])).unwrap();
        {
            let c = db(&dir);
            let n: i64 = c
                .query_row("SELECT COUNT(*) FROM comments", [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0);
        }
        // 删不存在的评论要报错，而不是静默成功
        assert!(cmd_comment_delete(&args(&dir, &["999"])).is_err());
    }

    #[test]
    fn comment_content_is_required() {
        let dir = seed();
        assert!(cmd_comment_add(&args(&dir, &["1"])).is_err());
        assert!(cmd_comment_add(&args(&dir, &["1", "--content", "  "])).is_err());
    }

    /* ---------------------------------------------------------- */
    /* 逐日记录                                                    */
    /* ---------------------------------------------------------- */

    #[test]
    fn note_add_update_delete_preserves_created_at() {
        let dir = seed();
        cmd_note_add(&args(
            &dir,
            &[
                "--project",
                "1",
                "--content",
                "今天联调通过",
                "--day",
                "2026-10-01",
            ],
        ))
        .unwrap();
        let created0: i64 = {
            let c = db(&dir);
            c.query_row(
                "SELECT created_at FROM daily_notes WHERE id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };

        // 改日期：记录本身没变，只是换了一天 —— created_at 不能跟着变
        cmd_note_update(&args(&dir, &["1", "--day", "2026-10-02"])).unwrap();
        {
            let c = db(&dir);
            let (day, content, created1): (String, String, i64) = c
                .query_row(
                    "SELECT day, content, created_at FROM daily_notes WHERE id = 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap();
            assert_eq!(day, "2026-10-02");
            assert_eq!(content, "今天联调通过", "没给 --content 时内容应保持不变");
            assert_eq!(created0, created1, "改日期不该动 created_at");
        }

        cmd_note_delete(&args(&dir, &["1"])).unwrap();
        {
            let c = db(&dir);
            let n: i64 = c
                .query_row("SELECT COUNT(*) FROM daily_notes", [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0);
        }
    }

    #[test]
    fn note_day_defaults_to_today() {
        let dir = seed();
        cmd_note_add(&args(&dir, &["--project", "1", "--content", "没写日期"])).unwrap();
        let c = db(&dir);
        let day: String = c
            .query_row("SELECT day FROM daily_notes WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(day, gantt_core::calendar::today_iso());
    }

    #[test]
    fn note_rejects_task_from_another_project() {
        let dir = seed();
        cmd_project_create(&args(&dir, &["--name", "另一个"])).unwrap();
        // 任务 1 属于项目 1，却想挂到项目 2 的逐日记录上 —— 跨项目引用正是 check 要抓的坏数据
        let err = cmd_note_add(&args(
            &dir,
            &["--project", "2", "--content", "错挂", "--task", "1"],
        ));
        assert!(err.is_err());
        // 而且什么都没写进去
        let c = db(&dir);
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM daily_notes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    /* ---------------------------------------------------------- */
    /* 基线                                                        */
    /* ---------------------------------------------------------- */

    #[test]
    fn baseline_create_show_delete() {
        let dir = seed();
        cmd_baseline_create(&args(&dir, &["--project", "1", "--name", "初始排期"])).unwrap();

        // 快照里的日期应等于任务此刻的计划日期
        let rows = query::load_baseline(&db(&dir), 1).unwrap();
        assert_eq!(rows.len(), 1, "一个任务应有一条快照");
        assert_eq!(rows[0].task_id, 1);
        assert_eq!(rows[0].name, "联调");

        let (s, e): (String, String) = {
            let c = db(&dir);
            c.query_row("SELECT start_date, end_date FROM tasks WHERE id = 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap()
        };
        assert_eq!(rows[0].start_date, s);
        assert_eq!(rows[0].end_date, e);
        assert_eq!(rows[0].duration, 5, "5d 的工期含首尾，快照里应是 5");

        cmd_baseline_list(&args(&dir, &["--project", "1"])).unwrap();
        cmd_baseline_show(&args(&dir, &["1"])).unwrap();

        cmd_baseline_delete(&args(&dir, &["1"])).unwrap();
        let c = db(&dir);
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM baselines", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn baseline_snapshot_does_not_follow_later_edits() {
        let dir = seed();
        cmd_baseline_create(&args(&dir, &["--project", "1", "--name", "初始排期"])).unwrap();
        let before = query::load_baseline(&db(&dir), 1).unwrap()[0].end_date.clone();

        // 打基线之后再改工期 —— 快照是「当时那一版」，必须原地不动
        cmd_task_update(&args(&dir, &["1", "--duration", "10d"])).unwrap();

        let rows = query::load_baseline(&db(&dir), 1).unwrap();
        assert_eq!(rows[0].end_date, before, "基线是快照，不该跟着任务改");
    }

    /* ---------------------------------------------------------- */
    /* 设置                                                        */
    /* ---------------------------------------------------------- */

    #[test]
    fn setting_set_get_list() {
        let dir = seed();
        cmd_setting_set(&args(&dir, &["plugin.foo", "--value", "bar"])).unwrap();
        assert_eq!(
            query::get_setting(&db(&dir), "plugin.foo".into())
                .unwrap()
                .as_deref(),
            Some("bar")
        );
        assert_eq!(
            query::list_settings_with_prefix(&db(&dir), "plugin.".into())
                .unwrap()
                .len(),
            1
        );
        // 前缀不匹配时不该漏出来
        assert!(query::list_settings_with_prefix(&db(&dir), "other.".into())
            .unwrap()
            .is_empty());

        cmd_setting_get(&args(&dir, &["plugin.foo"])).unwrap();
        cmd_setting_list(&args(&dir, &["--prefix", "plugin."])).unwrap();
    }

    #[test]
    fn setting_get_missing_key_is_not_an_error() {
        let dir = seed();
        // 「这个键没设过」不是错误 —— 和 `git config --get` 一样，问一个没设过的键
        // 是正常查询，只是答案为空。出错会让 Agent 把「没设过」当成命令用错了。
        cmd_setting_get(&args(&dir, &["没这个键"])).unwrap();
        assert!(query::get_setting(&db(&dir), "没这个键".into())
            .unwrap()
            .is_none());
    }

    /* ---------------------------------------------------------- */
    /* 破坏性操作要 --yes 把关                                     */
    /* ---------------------------------------------------------- */

    #[test]
    fn people_delete_with_tasks_needs_yes() {
        let dir = tmp_dir();
        cmd_project_create(&args(&dir, &["--name", "验证"])).unwrap();
        cmd_people_create(&args(&dir, &["--name", "张三"])).unwrap();
        cmd_task_create(&args(
            &dir,
            &[
                "--project",
                "1",
                "--name",
                "联调",
                "--duration",
                "5d",
                "--assignee",
                "张三",
            ],
        ))
        .unwrap();

        // 名下有任务又没给 --yes —— 拦住
        let err = cmd_people_delete(&args(&dir, &["1"])).unwrap_err().to_string();
        assert!(err.contains("--yes"), "报错要告诉 Agent 怎么继续：{err}");
        {
            let c = db(&dir);
            let n: i64 = c
                .query_row("SELECT COUNT(*) FROM people", [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 1, "拒绝之后人必须还在");
        }

        // 给了 --yes：人删掉，任务留着但变未分配（FK 是 ON DELETE SET NULL）
        cmd_people_delete(&args(&dir, &["1", "--yes"])).unwrap();
        let c = db(&dir);
        let people: i64 = c
            .query_row("SELECT COUNT(*) FROM people", [], |r| r.get(0))
            .unwrap();
        let tasks: i64 = c
            .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
            .unwrap();
        let assigned: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE person_id IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(people, 0);
        assert_eq!(tasks, 1, "删人不该删活");
        assert_eq!(assigned, 0);
    }

    #[test]
    fn people_delete_without_tasks_needs_no_yes() {
        let dir = tmp_dir();
        cmd_project_create(&args(&dir, &["--name", "验证"])).unwrap();
        cmd_people_create(&args(&dir, &["--name", "闲人"])).unwrap();
        // 名下没活儿，不该逼着加 --yes
        cmd_people_delete(&args(&dir, &["1"])).unwrap();
    }

    #[test]
    fn project_delete_needs_yes() {
        let dir = seed();
        let err = cmd_project_delete(&args(&dir, &["--project", "1"]))
            .unwrap_err()
            .to_string();
        assert!(err.contains("--yes"), "报错要告诉 Agent 怎么继续：{err}");
        {
            let c = db(&dir);
            let n: i64 = c
                .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 1, "拒绝之后项目必须还在");
        }

        // --yes 之后级联把任务一起带走
        cmd_project_delete(&args(&dir, &["--project", "1", "--yes"])).unwrap();
        let c = db(&dir);
        let p: i64 = c
            .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
            .unwrap();
        let t: i64 = c
            .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(p, 0);
        assert_eq!(t, 0);
    }

    /* ---------------------------------------------------------- */
    /* 部分更新不能误伤其它字段                                    */
    /* ---------------------------------------------------------- */

    #[test]
    fn project_rename_keeps_color_when_not_given() {
        let dir = tmp_dir();
        cmd_project_create(&args(&dir, &["--name", "验证", "--color", "#123456"])).unwrap();
        cmd_project_rename(&args(&dir, &["--project", "1", "--name", "改名了"])).unwrap();
        let c = db(&dir);
        let (name, color): (String, String) = c
            .query_row("SELECT name, color FROM projects WHERE id = 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(name, "改名了");
        assert_eq!(color, "#123456", "没给 --color 就不该把颜色冲回默认值");
    }

    #[test]
    fn project_calendar_updates_only_the_half_given() {
        let dir = tmp_dir();
        cmd_project_create(&args(&dir, &["--name", "验证"])).unwrap();
        cmd_project_calendar(&args(&dir, &["--project", "1", "--work-days", "1,2,3"])).unwrap();
        let (wd, hol): (String, String) = {
            let c = db(&dir);
            c.query_row("SELECT work_days, holidays FROM projects WHERE id = 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap()
        };
        assert_eq!(wd, "[1,2,3]");
        assert_eq!(hol, "[]", "只给了 --work-days，节假日应保持默认");

        cmd_project_calendar(&args(
            &dir,
            &["--project", "1", "--holidays", "2026-10-01"],
        ))
        .unwrap();
        let (wd2, hol2): (String, String) = {
            let c = db(&dir);
            c.query_row("SELECT work_days, holidays FROM projects WHERE id = 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap()
        };
        assert_eq!(wd2, "[1,2,3]", "只给了 --holidays，工作日应保持不变");
        assert_eq!(hol2, r#"["2026-10-01"]"#);
    }

    #[test]
    fn people_update_keeps_name_and_color_when_not_given() {
        let dir = tmp_dir();
        cmd_project_create(&args(&dir, &["--name", "验证"])).unwrap();
        cmd_people_create(&args(&dir, &["--name", "张三", "--color", "#abcdef"])).unwrap();

        // 只改名：颜色得留着
        cmd_people_update(&args(&dir, &["1", "--name", "张三丰"])).unwrap();
        let (name, color): (String, String) = {
            let c = db(&dir);
            c.query_row("SELECT name, color FROM people WHERE id = 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap()
        };
        assert_eq!(name, "张三丰");
        assert_eq!(color, "#abcdef");

        // 只改色：名字得留着
        cmd_people_update(&args(&dir, &["1", "--color", "#111111"])).unwrap();
        let (name2, color2): (String, String) = {
            let c = db(&dir);
            c.query_row("SELECT name, color FROM people WHERE id = 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap()
        };
        assert_eq!(name2, "张三丰");
        assert_eq!(color2, "#111111");
    }

    /* ---------------------------------------------------------- */
    /* 全局选项前置（这条以前是坏的）                              */
    /* ---------------------------------------------------------- */

    #[test]
    fn global_options_may_precede_the_group() {
        let dir = seed();
        // 老的 bug：`gantt --data-dir X project list` 把 --data-dir 当成组名
        let argv: Vec<String> = vec![
            "--data-dir".into(),
            dir.display().to_string(),
            "project".into(),
            "list".into(),
            "--json".into(),
        ];
        // 只到分派这一步 —— run() 会去找真实数据目录之外的东西，这里验的是解析
        let (tail, group) = hoist_globals(&argv).unwrap();
        assert_eq!(group.as_deref(), Some("project"));
        let sub = split_sub(&tail, "project").unwrap();
        assert_eq!(sub.0, "list");
        let parsed = Args::parse(sub.1).unwrap();
        assert!(parsed.json());
        // resolve_data_dir 拿到的是同一个目录 —— 也就是这条路径现在真的通了
        assert_eq!(resolve_data_dir(&parsed).unwrap(), dir);
    }

    /* ---------------------------------------------------------- */
    /* 自检：新写进去的东西不该让它报坏数据                        */
    /* ---------------------------------------------------------- */

    #[test]
    fn check_is_clean_after_writing_notes_and_risks() {
        let dir = seed();
        cmd_risk_add(&args(&dir, &["1", "--content", "R1", "--level", "high"])).unwrap();
        cmd_comment_add(&args(&dir, &["1", "--content", "C1"])).unwrap();
        cmd_note_add(&args(&dir, &["--project", "1", "--content", "N1"])).unwrap();
        cmd_note_add(&args(&dir, &["--project", "1", "--content", "N2", "--task", "1"])).unwrap();
        cmd_baseline_create(&args(&dir, &["--project", "1", "--name", "B1"])).unwrap();

        cmd_check(&args(&dir, &["--json"])).unwrap();
        let issues = query::check_integrity(&db(&dir)).unwrap();
        assert!(issues.is_empty(), "自检不该报出问题：{issues:?}");
    }
}
