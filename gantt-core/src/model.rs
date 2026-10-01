//! 数据模型。
//!
//! 全部从 `src-tauri/src/db.rs` 平移，字段、`serde` 重命名、文档串一字未改 ——
//! `#[serde(rename_all = "camelCase")]` 是前端 JSON 契约，也是 CLI `--json` 输出的契约，
//! 动它就等于同时改了两个消费方。

use serde::{Deserialize, Serialize};

/// 数据层统一的错误类型：给人看的字符串。
///
/// 桌面应用把它直接丢给前端 toast，CLI 把它打到 stderr。两边都要求「一句人话」，
/// 所以库层就把 rusqlite 的错误翻成中文，调用方不再各翻一遍。
pub type Result<T> = std::result::Result<T, String>;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: i64,
    /**
     * 跨机器的项目身份，见 migrations/007_project_identity.sql。
     *
     * 和 `id` 的分工：`id` 只在本机这一个库里有意义，导出到文件、
     * 在另一台机器上导入之后就换了一个值；`uuid` 跟着项目本身走，
     * 无论传几台电脑都不变，导入时靠它认出「这是同一个项目」。
     */
    pub uuid: String,
    pub name: String,
    pub color: String,
    /// JSON 数组字符串，如 "[1,2,3,4,5]"
    pub work_days: String,
    pub holidays: String,
    pub sort_order: f64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskRow {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    /// ISO 'YYYY-MM-DD'，见 migrations/001_init.sql 顶部关于日期存储的说明
    pub start_date: String,
    pub end_date: String,
    /// 实施起止。两端要么都为 None（还没动过），要么都有值
    pub actual_start: Option<String>,
    pub actual_end: Option<String>,
    pub progress: f64,
    pub priority: i64,
    /// 指向 people 表；为 None 表示无负责人
    pub person_id: Option<i64>,
    pub milestone: bool,
    pub weight: Option<f64>,
    pub collapsed: bool,
    pub pinned: bool,
    pub note: String,
    pub sort_order: f64,
    /// 受阻时段的 JSON 数组，见 migrations/004_blocked.sql
    pub blocked: String,
    /// 实施逾期时自动顺延计划结束日。见 migrations/009_auto_rollover.sql
    pub auto_rollover: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DependencyRow {
    pub id: i64,
    pub from_task_id: i64,
    pub to_task_id: i64,
    /// 'FS' | 'SS' | 'FF' | 'SF'。第一版只产生 FS（DESIGN.md §2.1）
    pub kind: String,
    pub lag_days: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BaselineRow {
    pub id: i64,
    pub name: String,
    pub created_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BaselineTaskRow {
    pub task_id: i64,
    pub name: String,
    pub start_date: String,
    pub end_date: String,
    pub duration: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: i64,
    pub name: String,
    /// 头像底色，同时也是「按负责人着色」时甘特条的颜色
    pub color: String,
    /// base64 data URI；为 None 时前端回退到首字母头像
    pub avatar: Option<String>,
    pub sort_order: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectData {
    pub project: Project,
    pub tasks: Vec<TaskRow>,
    pub dependencies: Vec<DependencyRow>,
    pub baselines: Vec<BaselineRow>,
    pub people: Vec<Person>,
    /**
     * 全局下一个可用的任务 id。
     *
     * 前端自己分配 id，但 tasks.id 是**全局**主键 —— 只看当前项目的最大 id 去 +1，
     * 在项目 B 里造出的 id 会撞上项目 A 已有的行。所以这个值必须由库来给。
     */
    pub next_task_id: i64,
}

/// 项目列表卡片需要的汇总值，全部在 SQL 里算，不用把任务捞到前端再统计。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub project: Project,
    pub task_count: i64,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    /// 只统计叶子任务，父任务的 progress 列不可信（DESIGN.md §1.2）
    pub leaf_count: i64,
    pub overdue_count: i64,
    pub progress: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Risk {
    pub id: i64,
    pub task_id: i64,
    pub content: String,
    /// 0 高 / 1 中 / 2 低
    pub level: i64,
    pub resolved: bool,
    /// Unix 秒，格式化交给前端
    pub created_at: i64,
    /// 关闭的时刻。None = 还开着，或者是没有这一列的历史记录
    pub resolved_at: Option<i64>,
    /// 怎么关掉的。复盘时真正有价值的是这一句，不是那个勾
    pub resolution: Option<String>,
    /**
     * 「先做哪个」。和 `level` 是两个轴，见 migrations/012_risk_priority.sql。
     *
     * None = 没填过。历史风险确实没有这一项，不伪造一个「中」——
     * 界面上显示一个空的优先级槽。
     */
    pub priority: Option<i64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: i64,
    pub task_id: i64,
    pub content: String,
    pub created_at: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskNotes {
    pub risks: Vec<Risk>,
    pub comments: Vec<Comment>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DailyNote {
    pub id: i64,
    pub project_id: i64,
    /// null = 项目级的当天记录，不挂在任何一条任务上
    pub task_id: Option<i64>,
    /// 说的是哪一天。ISO 'YYYY-MM-DD'
    pub day: String,
    pub content: String,
    /// 什么时候写的。和 day 不是一回事 —— 周五补记周三的事，两者相差两天
    pub created_at: i64,
    pub updated_at: i64,
}

/* ------------------------------------------------------------------ */
/* 事项                                                                */
/* ------------------------------------------------------------------ */

/**
 * 一条事项（QuickNote）。见 migrations/010_item_notes.sql。
 *
 * 它是系统里唯一一种**不需要日期就能存在**的东西。四个计划视图都要求
 * 「任务 + 日期 + 负责人」齐备才接得住，而现实里最先出现的东西只有一句话。
 *
 * 分拣（决定它是什么）是和录入分开的动作：`kind` 为 None 就是「还没想清楚」，
 * 那是一个真实且重要的状态，不是缺省值。
 */
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ItemNote {
    pub id: i64,
    pub project_id: i64,
    pub name: String,
    /// None = 未分拣。不是「其他」
    pub kind: Option<String>,
    /// P0–P3，和任务的紧急度同一把刻度
    pub priority: i64,
    pub person_id: Option<i64>,
    /// 关联的活。任务删掉后这里变 None，但记录留着（ON DELETE SET NULL）
    pub task_id: Option<i64>,
    /// 'blocker' | 'risk'。非 None = 已经晋升成一个真实实体
    pub promoted_kind: Option<String>,
    /// 阻碍是 '<taskId>/<periodId>'，风险是 '<riskId>'。可能悬挂 —— 那是预期状态
    pub promoted_ref: Option<String>,
    /// 关闭时刻（Unix 秒）。None = 还开着。**没有单独的 closed 布尔**
    pub closed_at: Option<i64>,
    pub resolution: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/**
 * 一个事项类型。全局表，见 migrations/011_item_kinds.sql。
 *
 * 阻碍和风险**不在**这里：它们是实体不是分类，身份由 ItemNote 的
 * promoted_kind + promoted_ref 表达。
 */
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ItemKind {
    /// 'todo' | 'issue' | 'custom:<uuid>'
    pub key: String,
    pub label: String,
    pub color: String,
    /// 关闭时是否必须写一句结论
    pub requires_note: bool,
    /// 内置行：可改名改色，不可删
    pub builtin: bool,
    pub sort_order: f64,
}
