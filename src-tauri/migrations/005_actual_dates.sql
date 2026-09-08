-- 实施日期：任务「实际」从哪天干到哪天。
--
-- 一条任务只有一行，上面挂**两组日期**：
--   start_date  / end_date   → 计划（目标排期）
--   actual_start/ actual_end → 实施（实际发生）
--
-- 为什么不另建一张「实施表」：名字、层级、紧急度、负责人、进度、受阻、
-- 风险、评论这些东西两个视图看到的必须永远一致。做成两张表就需要写同步代码，
-- 而**凡是需要同步的两份数据最终都会分叉**。做成同一行的两组字段，
-- 「自动同步」是免费的，也不可能出现两边对不上的情况。
--
-- 允许为空，且空有明确语义：**还没动过**。
-- 界面据此显示计划的虚线轮廓，一旦填了就说明用户已经表过态，
-- 之后计划怎么改都不再覆盖它。
--
-- 也允许超出计划区间 —— 「计划 8/17 交，实际干到 8/22」正是这个功能要回答的。

ALTER TABLE tasks ADD COLUMN actual_start TEXT;
ALTER TABLE tasks ADD COLUMN actual_end   TEXT;

-- 两端要么都为空（未开始），要么都有值（已表态）。半填状态没有意义，
-- 而且会让所有取区间的地方都得多一个分支
CREATE TRIGGER actual_dates_must_be_paired_insert
AFTER INSERT ON tasks
WHEN (NEW.actual_start IS NULL) <> (NEW.actual_end IS NULL)
BEGIN
  SELECT RAISE(ABORT, '实施起止日期必须同时为空或同时有值');
END;

CREATE TRIGGER actual_dates_must_be_paired_update
AFTER UPDATE OF actual_start, actual_end ON tasks
WHEN (NEW.actual_start IS NULL) <> (NEW.actual_end IS NULL)
BEGIN
  SELECT RAISE(ABORT, '实施起止日期必须同时为空或同时有值');
END;
