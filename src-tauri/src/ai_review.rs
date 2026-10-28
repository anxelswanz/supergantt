//! AI 复盘用的 `claude` 进程。内置功能本来没有起子进程的通道（那是插件的能力），
//! 这里单开一个窄口子：程序名写死、参数全在这里拼、零工具（`--tools ""` +
//! `--strict-mcp-config`），它只能「读提示词，吐文字」。
//!
//! 每次调用独立（前端带全部上下文）：会话存在 `~/.claude` 会被清理、换机器带不走，
//! 而复盘是入库的，隔月回来 `--resume` 只会得到 `No conversation found`。

use tauri::Manager;

use crate::plugin_host::{spawn_piped, which, Procs};

type Result<T> = std::result::Result<T, String>;

/// 进程工作目录（app_config_dir 下的空目录）：`claude` 会从 cwd 往上找
/// CLAUDE.md 和项目级设置，在用户的代码仓库里起它会把那个仓库的指令混进来。
const WORK_DIR: &str = "ai-review";

/// 系统提示词。**必须是单行、不含引号**：Windows 上 `claude` 是 `.cmd`，
/// 参数要过 cmd.exe 转义，换行过不去。真正的要求走 stdin 的提示词。
const SYSTEM_PROMPT: &str =
    "你是一位资深的项目复盘顾问，帮助团队把一个项目的经过变成下次可以直接用的经验。严格按用户消息里给出的要求和格式输出，只用中文。";

/// `claude` 在不在。前端据此决定显示「开始复盘」还是「先装 Claude Code」。
#[tauri::command]
pub fn ai_review_available() -> bool {
    which("claude").is_some()
}

/// 问 Claude 一次。返回 run id，输出按行走 `plugin-proc` 事件，用 `plugin_kill` 取消。
///
/// `schema` 有值时要求结构化输出，结果在最后一条 result 事件的 `structured_output`。
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
        // 只读用户级设置：登录方式、代理、模型偏好都在那里，丢了有些人连不上
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
            // 压成一行再传：理由同 SYSTEM_PROMPT。顺便挡掉非 JSON ——
            // 那样 claude 会报一个和 schema 毫无关系的错
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
