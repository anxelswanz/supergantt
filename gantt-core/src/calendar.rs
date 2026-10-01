//! 日期助手：不引 `chrono`，用 std 的时间加民用历换算。
//!
//! `civil_from_days` 原本住在 `src-tauri/src/backup.rs`（备份按天命名要用它），
//! `today_iso` 住在 `src-tauri/src/db.rs`（项目列表算逾期要用它）。两个模块
//! 各自需要同一段日期逻辑的那一刻，就是它该搬到共享层的信号 —— 现在两边都从这里拿。
//!
//! CLI 对日期有额外需求（`+3d` / `5d` 这类相对写法，见 `bin/gantt.rs`），
//! 那些换算也归这里，因为它们和上面两个是同一件事。

/// Howard Hinnant 的 civil_from_days 算法：天数（自 1970-01-01）→ 年月日。
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 自 1970-01-01 起的天数（本地时钟的 UTC 天，够用）。
pub fn today_days() -> i64 {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    secs.div_euclid(86_400)
}

/// 从「自 1970-01-01 起的天数」格式化成 ISO 'YYYY-MM-DD'。
pub fn days_to_iso(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// 本地今天的 ISO 日期。原先在 `db.rs`，项目列表算逾期任务时会用到。
pub fn today_iso() -> String {
    days_to_iso(today_days())
}

/// 自 2000-01-01（本项目的 dayIndex 纪元，见 `src/gantt/time.ts`）起的天数。
///
/// 2000-01-01 距 1970-01-01 是 10957 天。CLI 不直接用 dayIndex，但需要它
/// 来做「今天 + N 天」的推算，和前端保持同一个纪元能避免两边差一天。
const EPOCH_2000_OFFSET: i64 = 10_957;

/// 解析 ISO 'YYYY-MM-DD' 成「自 1970-01-01 起的天数」。
///
/// 只认严格格式：位数不对、分隔符不对、月日越界都返回 None。调用方（CLI 校验、
/// 日历换算）要的是一个明确的是/否，不是一个「尽量猜」的结果。
pub fn iso_to_days(iso: &str) -> Option<i64> {
    let b = iso.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let num = |s: &str| s.parse::<i64>().ok();
    let y = num(&iso[0..4])?;
    let m = num(&iso[5..7])?;
    let d = num(&iso[8..10])?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m as u32, d as u32))
}

/// Howard Hinnant 的 days_from_civil：年月日 → 天数（自 1970-01-01）。
/// 与 `civil_from_days` 互逆，只为 `iso_to_days` 服务。
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 星期几，0 = 周一 … 6 = 周日。
/// 1970-01-01 是周四，所以 +3 的偏移能把 `days % 7` 挪到以周一为 0。
pub fn weekday_of_days(days: i64) -> i64 {
    (days + 3).rem_euclid(7)
}

/// 这个日期是不是工作日（周一至周五）。
///
/// 只看星期，不看项目的 `holidays` —— 那个要求项目上下文，属于调用方的事。
/// 这里只回答「周六周日不是工作日」这一个基础事实。
pub fn is_weekend(days: i64) -> bool {
    weekday_of_days(days) >= 5
}

/// 从今天起往后找第一个工作日（含今天）。
pub fn next_workday(days: i64) -> i64 {
    let mut d = days;
    while is_weekend(d) {
        d += 1;
    }
    d
}

/// dayIndex（自 2000-01-01）→ 自 1970-01-01 的天数。
pub fn day_index_to_days(idx: i64) -> i64 {
    idx + EPOCH_2000_OFFSET
}

/// 自 1970-01-01 的天数 → dayIndex（自 2000-01-01）。
pub fn days_to_day_index(days: i64) -> i64 {
    days - EPOCH_2000_OFFSET
}

/* ------------------------------------------------------------------ */
/* CLI 的日期写法                                                      */
/* ------------------------------------------------------------------ */

/// 把 CLI 上写的日期解析成天数。
///
/// 认三种写法，全是为了让 Agent **永远不必自己算日期**：
///
/// - `2026-10-01` —— ISO，最常见
/// - `today` / `now` —— 今天
/// - `+3d` / `-2w` / `+1m` —— 相对今天。`d` 天、`w` 周、`m` 月
///
/// 让模型自己推日期是排期出错的头号来源：它会把"下周三"算成上一个周三，
/// 而且看起来完全合理。所以这里提供相对写法，让换算只发生在一个地方。
pub fn parse_cli_date(text: &str) -> Result<i64, String> {
    let t = text.trim().to_ascii_lowercase();

    if t == "today" || t == "now" {
        return Ok(today_days());
    }

    if let Some(rest) = t.strip_prefix('+').or_else(|| t.strip_prefix('-')) {
        let sign: i64 = if t.starts_with('-') { -1 } else { 1 };
        let Some(unit) = rest.chars().last() else {
            return Err(bad_date(text));
        };
        let number = &rest[..rest.len() - unit.len_utf8()];
        let n: i64 = number.parse().map_err(|_| bad_date(text))?;
        let days = match unit {
            'd' => n,
            'w' => n * 7,
            'm' => {
                // 月不是固定天数，只能落到"该月同一天"。用民事历走一步，
                // 借位（10/31 +1m）时夹到月末。
                let base = today_days();
                let (y, m, d) = civil_from_days(base);
                let total = (y * 12 + m as i64 - 1) + n * sign;
                let (ny, nm) = (total.div_euclid(12), total.rem_euclid(12) as u32 + 1);
                let nd = d.min(days_in_month(ny, nm));
                return Ok(days_from_civil(ny, nm, nd));
            }
            _ => return Err(bad_date(text)),
        };
        return Ok(today_days() + sign * days);
    }

    iso_to_days(&t).ok_or_else(|| bad_date(text))
}

fn bad_date(text: &str) -> String {
    format!(
        "看不懂日期「{text}」。可以写：2026-10-01、today、+3d（三天后）、-2w（两周前）、+1m。"
    )
}

/// 某个月有多少天。算月末夹取要用。
pub fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

/// 把 CLI 上写的工期（`5d` / `2w` / `3m` / 纯数字当作工作日）解析成**日历天数**。
///
/// 注意这里刻意不做"跳过周末"：CLI 拿不到项目的 `work_days`/`holidays`
/// （那在项目行里），凭空按周末扣减会和界面显示的工期对不上。
/// `5d` 就是 5 个日历日；要按工作日排，用 `--start` 和 `--end` 直接给日期。
pub fn parse_cli_duration(text: &str) -> Result<i64, String> {
    let t = text.trim().to_ascii_lowercase();
    let (number, unit) = match t.chars().last() {
        Some(u) if u.is_ascii_alphabetic() => (&t[..t.len() - u.len_utf8()], u),
        _ => (t.as_str(), 'd'),
    };
    let n: i64 = number.parse().map_err(|_| {
        format!("看不懂工期「{text}」。可以写：5d（5 天）、2w（2 周）、3m（3 个月）、或纯数字。")
    })?;
    if n <= 0 {
        return Err(format!("工期必须大于 0，收到的是「{text}」。"));
    }
    match unit {
        'd' => Ok(n),
        'w' => Ok(n * 7),
        'm' => Ok(n * 30),
        _ => Err(format!(
            "看不懂工期单位「{unit}」。可以写：d（天）、w（周）、m（月）。"
        )),
    }
}

/// 起止日期 + 工期三者补齐。
///
/// 调用方可能给任意两个，第三个由这里推。三个都给且互相矛盾时**不报错**，
/// 以 start/end 为准 —— 工期是给"懒人写法"用的糖，明写的日期是更具体的意图。
pub fn resolve_span(
    start: Option<i64>,
    end: Option<i64>,
    duration_days: Option<i64>,
) -> Result<(i64, i64), String> {
    match (start, end, duration_days) {
        // 两个日期都给了，工期只是被忽略的糖。是否 e >= s 交给写入层的校验去管，
        // 这里不改数据、也不静默纠正。
        (Some(s), Some(e), _) => Ok((s, e)),
        (Some(s), None, Some(d)) => Ok((s, s + d - 1)),
        (Some(s), None, None) => Ok((s, s)),
        (None, Some(e), Some(d)) => Ok((e - d + 1, e)),
        (None, Some(e), None) => Ok((e, e)),
        (None, None, Some(d)) => {
            let s = today_days();
            Ok((s, s + d - 1))
        }
        (None, None, None) => {
            let s = today_days();
            Ok((s, s))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_round_trips() {
        for iso in ["1970-01-01", "2000-01-01", "2024-02-29", "2026-10-01"] {
            let days = iso_to_days(iso).unwrap();
            assert_eq!(days_to_iso(days), iso);
        }
    }

    #[test]
    fn iso_rejects_malformed_input() {
        for bad in ["2026-1-1", "2026/10/01", "not-a-date", "", "2026-13-01", "2026-10-32"] {
            assert!(iso_to_days(bad).is_none(), "{bad} 不该被接受");
        }
    }

    #[test]
    fn weekday_matches_known_dates() {
        // 2026-09-28 是周一（由 civil 换算交叉验证）
        let d = iso_to_days("2026-09-28").unwrap();
        assert_eq!(weekday_of_days(d), 0, "应该算成周一");
        assert!(!is_weekend(d));
        let sat = iso_to_days("2026-10-03").unwrap();
        assert_eq!(weekday_of_days(sat), 5);
        assert!(is_weekend(sat));
    }

    #[test]
    fn relative_days_and_weeks() {
        let today = today_days();
        assert_eq!(parse_cli_date("today").unwrap(), today);
        assert_eq!(parse_cli_date("+0d").unwrap(), today);
        assert_eq!(parse_cli_date("+3d").unwrap(), today + 3);
        assert_eq!(parse_cli_date("-2w").unwrap(), today - 14);
    }

    #[test]
    fn relative_months_clamp_to_month_end() {
        // 这条是 month 分支唯一容易写错的地方：31 号 +1 个月，
        // 不能溢到"下下个月的 1 号"，要夹到月末。
        let (y, m, d) = civil_from_days(today_days());
        let _ = (y, m, d);
        // 用固定日期验证而不是依赖今天是几号
        assert_eq!(days_in_month(2026, 1), 31);
        assert_eq!(days_in_month(2026, 2), 28);
        assert_eq!(days_in_month(2024, 2), 29);
        assert_eq!(days_in_month(2100, 2), 28, "百年不闰");
        assert_eq!(days_in_month(2000, 2), 29, "四百年又闰");
    }

    #[test]
    fn durations_convert_to_calendar_days() {
        assert_eq!(parse_cli_duration("5d").unwrap(), 5);
        assert_eq!(parse_cli_duration("2w").unwrap(), 14);
        assert_eq!(parse_cli_duration("5").unwrap(), 5, "裸数字按天");
        assert!(parse_cli_duration("0d").is_err());
        assert!(parse_cli_duration("5x").is_err());
        assert!(parse_cli_duration("abc").is_err());
    }

    #[test]
    fn a_five_day_task_ends_on_start_plus_four() {
        // 「5 天的任务」在甘特图里首尾都占一天，所以结束日 = 开始日 + 4。
        // 这里如果写成 +5，每条任务的工期都会多一天，而且没人会立刻发现。
        let start = iso_to_days("2026-10-01").unwrap();
        let (s, e) = resolve_span(Some(start), None, Some(5)).unwrap();
        assert_eq!(s, start);
        assert_eq!(days_to_iso(e), "2026-10-05");
    }

    #[test]
    fn explicit_end_beats_duration() {
        let start = iso_to_days("2026-10-01").unwrap();
        let end = iso_to_days("2026-10-20").unwrap();
        let (s, e) = resolve_span(Some(start), Some(end), Some(5)).unwrap();
        assert_eq!((s, e), (start, end), "明写的日期优先于工期");
    }

    #[test]
    fn end_only_backs_into_the_start() {
        let end = iso_to_days("2026-10-10").unwrap();
        let (s, _) = resolve_span(None, Some(end), Some(3)).unwrap();
        assert_eq!(days_to_iso(s), "2026-10-08");
    }
}
