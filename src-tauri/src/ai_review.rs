//! AI 复盘用的 `claude` 进程。
//!
//! 内置功能本来没有起子进程的通道 —— 那是插件的能力，受 manifest 白名单约束
//! （plugin_host.rs）。这里给 AI 复盘单开一个口子，而且开得尽量窄：
//!
//! - **程序写死是 `claude`**，前端传不了程序名；
//! - **参数全在这里拼**，前端只给得了提示词和一份输出 schema；
//! - **零工具**：`--tools ""` 把内置工具全关掉，`--strict-mcp-config` 不加载
//!   任何 MCP 服务。这个进程读不了文件、跑不了命令、联不了网，它能做的只有
//!   「读提示词，吐文字」。项目数据由前端拼成快照随提示词送进去（见
//!   src/aiReview/snapshot.ts），它不需要、也拿不到任何别的东西。
//!
//! 所以这条命令不是「前端能起任意进程」，而是「前端能问 Claude 一个问题」。
//!
//! ## 为什么每次调用都是独立的
//!
//! 一次复盘要调三次（出题 → 追问 → 写文档）。用 `--resume` 把它们串成一个会话
//! 看起来更省，但会话存在 `~/.claude` 里，会被定期清理，换台电脑也带不走 ——
//! 而复盘是入库的，隔一个月回来接着答是正常用法。届时 `--resume` 只会得到一句
//! `No conversation found`。所以每次调用都由前端带上完整上下文，这里加
//! `--no-session-persistence`，不在用户的会话列表里留下一堆他没见过的对话。

use tauri::Manager;

use crate::plugin_host::{spawn_piped, which, Procs};

type Result<T> = std::result::Result<T, String>;

/// 进程的工作目录，在 app_config_dir() 下。
///
/// 一个专门的空目录：`claude` 会从工作目录往上找 CLAUDE.md 和项目级设置，
/// 在用户的某个代码仓库里起它，那个仓库的指令就会混进复盘的提示词。
const WORK_DIR: &str = "ai-review";

/// 系统提示词。**必须是单行、不含引号**。
///
/// Windows 上 `claude` 是个 `.cmd`，参数要过一遍 cmd.exe 的转义规则，换行过不去。
/// 所以这里只留一句身份，真正的要求全部写在提示词里走 stdin（那边没有任何限制）。
const SYSTEM_PROMPT: &str =
    "你是一位资深的项目复盘顾问，帮助团队把一个项目的经过变成下次可以直接用的经验。严格按用户消息里给出的要求和格式输出，只用中文。";

/// `claude` 在不在。前端据此决定显示「开始复盘」还是「先装 Claude Code」。
#[tauri::command]
pub fn ai_review_available() -> bool {
    which("claude").is_some()
}

/// 问 Claude 一次。返回 run id，输出按行走 `plugin-proc` 事件，用 `plugin_kill` 取消。
///
/// `schema` 有值时要求结构化输出（出题用），结果在最后那条 result 事件的
/// `structured_output` 里；没有时是普通文本，并打开逐字流式（写文档用）。
#[tauri::command]
pub fn ai_review_run(
    app: tauri::AppHandle,
    procs: tauri::State<'_, Procs>,
    prompt: String,
    schema: Option<String>,
) -> Result<u64> {
    let exe = which("claude").ok_or(
        "找不到 claude —— AI 复盘需要本机装有 Claude Code 并已登录（已在 PATH 和常见安装目录里找过）",
    )?;

    let cwd = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("拿不到配置目录：{e}"))?
        .join(WORK_DIR);
    std::fs::create_dir_all(&cwd).map_err(|e| format!("建不了工作目录：{e}"))?;

    spawn_piped(&app, &procs, &exe, &build_args(schema.as_deref())?, &cwd, Some(prompt))
}

fn build_args(schema: Option<&str>) -> Result<Vec<String>> {
    let mut args: Vec<String> = [
        "-p",
        // 零工具。空字符串是 `--tools` 约定的「全部关掉」
        "--tools",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        // 只读用户级设置：登录方式、代理、模型偏好都在那里，丢了它有些人就连不上了。
        // 项目级和本地级不读 —— 工作目录是我们自己的空目录，本来也不该有
        "--setting-sources",
        "user",
        "--no-session-persistence",
        "--system-prompt",
        SYSTEM_PROMPT,
        "--output-format",
        "stream-json",
        "--verbose",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();

    match schema {
        Some(schema) => {
            // 压成一行再传：理由同 SYSTEM_PROMPT。顺便挡掉不是 JSON 的东西 ——
            // 那种情况 claude 会报一个和 schema 毫无关系的错，很难对上号
            let value: serde_json::Value =
                serde_json::from_str(schema).map_err(|e| format!("输出 schema 不是合法的 JSON：{e}"))?;
            args.push("--json-schema".into());
            args.push(value.to_string());
        }
        None => args.push("--include-partial-messages".into()),
    }
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 零工具是这条命令存在的前提，不能在某次改参数时被悄悄拿掉。
    #[test]
    fn args_always_disable_tools_and_mcp() {
        for schema in [None, Some(r#"{"type":"object"}"#)] {
            let args = build_args(schema).unwrap();
            let at = args.iter().position(|a| a == "--tools").expect("没有 --tools");
            assert_eq!(args[at + 1], "", "--tools 后面必须是空字符串");
            assert!(args.contains(&"--strict-mcp-config".to_string()));
            assert!(args.contains(&"--no-session-persistence".to_string()));
            for banned in ["--dangerously-skip-permissions", "--allowedTools", "--add-dir", "--resume"] {
                assert!(!args.contains(&banned.to_string()), "不该出现 {banned}");
            }
        }
    }

    /// 传给 .cmd 的参数里不能有换行（Windows），schema 要被压成一行。
    #[test]
    fn args_are_single_line() {
        let args = build_args(Some("{\n  \"type\": \"object\"\n}")).unwrap();
        for a in &args {
            assert!(!a.contains('\n') && !a.contains('\r'), "参数里有换行：{a:?}");
        }
        assert!(args.contains(&r#"{"type":"object"}"#.to_string()));
        assert!(!SYSTEM_PROMPT.contains('"'));
    }

    #[test]
    fn schema_must_be_json() {
        assert!(build_args(Some("不是 json")).is_err());
    }

    /// 结构化输出和逐字流式二选一：出题要前者，写文档要后者。
    #[test]
    fn schema_and_partial_messages_are_exclusive() {
        let with = build_args(Some("{}")).unwrap();
        assert!(with.contains(&"--json-schema".to_string()));
        assert!(!with.contains(&"--include-partial-messages".to_string()));
        let without = build_args(None).unwrap();
        assert!(without.contains(&"--include-partial-messages".to_string()));
    }
}
