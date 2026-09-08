-- 逐日记录：时间线视图的本体。
--
-- 「这一天发生了什么」在现有 schema 里无处安放：
--   · comments 只有 created_at（写下的时刻），没有「说的是哪一天」——
--     周五补记周三的事，时间线就会把它挂在周五，从第一天起就是错的
--   · comments 必须挂 task_id，而「今天下雨全场停工」不属于任何一条任务
--
-- 所以新开一张表，并且**两个时间分开存**：
--   day        —— 说的是哪一天（时间线按它排）
--   created_at —— 什么时候写的（详情里能看出这是不是事后补记）
--
-- task_id 可空：有值 = 「这件活那天怎么了」，为空 = 「今天整体怎么样」。
-- 一张表两种粒度，时间线一次查完，不需要 union 两个来源。
--
-- 和 risks / comments 一样是即写即存的独立实体，不进命令栈 ——
-- ⌘Z 不该把你刚敲的一条当日记录撤掉。

CREATE TABLE daily_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- 可空。指向任务时随任务删除一起清掉 —— 一条挂在已删任务上的记录
  -- 在时间线上没有落点，留着只会变成孤儿
  task_id    INTEGER          REFERENCES tasks (id) ON DELETE CASCADE,
  -- ISO 'YYYY-MM-DD'，与 tasks 的日期存储约定一致（见 001_init.sql 顶部）
  day        TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  -- Unix 秒
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 时间线的主查询：某项目、按天排
CREATE INDEX idx_daily_notes_project_day ON daily_notes (project_id, day);
-- 任务详情里要列出这条活的所有当日记录
CREATE INDEX idx_daily_notes_task ON daily_notes (task_id);
