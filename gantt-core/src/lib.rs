//! Gantt 的数据层。桌面应用和命令行共用同一份。
//!
//! 存在的理由只有一条：**schema 只能有一份**。
//!
//! 在抽出这个 crate 之前，"给任务加一列"意味着改 `src-tauri/migrations/`，
//! 再同步改 `db.rs` 里的模型、SQL、测试。CLI 如果自己拿一份 schema，
//! 加列那天就会分叉：桌面应用升了库，CLI 的 SQL 对不上，读出来的任务
//! 少一个字段或者报错 —— 而且是"有时候能用有时候不能"的那种坏法，
//! 因为分叉只在升级过的那台机器上暴露。
//!
//! 所以迁移、模型、查询、写入全在这里，`src-tauri/src/db.rs` 只是它的
//! Tauri 薄包装（`State<Db>` ↔ `&Connection` 的搬运），CLI 是它的直接调用方。
//!
//! ## 模块
//!
//! - [`schema`] —— 迁移数组、打开、自愈。加列只改这里。
//! - [`model`] —— 结构体。字段名即 JSON 契约，两个消费方共用。
//! - [`query`] —— 读 + 各类 CRUD。桌面应用的 40 多个命令都转发到这里。
//! - [`write`] —— 写入。应用走整项目事务替换，CLI 走行级 upsert。
//! - [`calendar`] —— 日期助手。不引 `chrono`。
//! - [`locate`] —— 数据目录定位 + 应用存活探测。
//!
//! ## 错误约定
//!
//! 所有可能失败的操作返回 [`model::Result`]，也就是 `Result<T, String>`，
//! 字符串是**给人看的中文**。桌面应用把它丢给前端 toast，CLI 把它打到 stderr
//! 并据此决定退出码。库层就把 rusqlite 的英文报错翻掉，调用方不再各翻一遍。

pub mod calendar;
pub mod locate;
pub mod model;
pub mod query;
pub mod schema;
pub mod write;

pub use model::Result;
pub use schema::{migrate, open, repair, MIGRATIONS};
