-- 事项的类型清单。全局表，没有 project_id。
--
-- 为什么全局：类型是「这个团队怎么给事情分类」，不是某个项目的属性。
-- 分项目会让同一个「问题」在两个项目里是两个东西，统计口径当场分叉。
-- 代价写在设计稿的「已知缺口」里：每个项目看到的清单一样，用不上的类型
-- 也在下拉里。类型总数超过十个时再考虑按项目收敛。
--
-- **阻碍和风险不在这张表里。** 它们是实体（tasks.blocked / risks），
-- 不是分类；它们的身份由 item_notes.promoted_kind + promoted_ref 表达。
-- 把它们也做成这里的两行，会制造出「分类名叫阻碍、但底下没有任何实体」
-- 的悬空状态 —— 用户点进去看到的和看板、复盘里说的不是一回事。
--
-- 字段只有四个，刻意的：名称、颜色、关闭是否需要结论、排序。再多就变成
-- 一个小型工作流引擎，而这里要的只是「给随手记的东西分个类」。

CREATE TABLE item_kinds (
  -- 'todo' | 'issue' | 'custom:<uuid>'。内置的两个 key 不可删（UI 层拦）
  key            TEXT    PRIMARY KEY,
  label          TEXT    NOT NULL,
  color          TEXT    NOT NULL,

  -- 关闭时是否必须写一句结论。
  --
  -- 这条规则的价值在 008_risk_resolution.sql 已经论证过一遍：一个 resolved
  -- 布尔把「这条不用管了」和「我们做了什么让它不用管」压成同一个比特，
  -- 而后者才是复盘时唯一值得抄的东西。所以「问题」默认开着；
  -- 「代办」不开 —— 打个电话确认交期，关它的时候没有什么结论可写。
  requires_note  INTEGER NOT NULL DEFAULT 0 CHECK (requires_note IN (0, 1)),

  -- 内置行。内置的可以改名改色（团队习惯叫「待办」不叫「代办」），但不可删
  builtin        INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
  sort_order     REAL    NOT NULL DEFAULT 0
);

-- 内置两行。
--
-- OR IGNORE：这条迁移和启动时那一步「确保内置类型存在」是同一个意图的两处
-- 落点。导入一个旧版 .ganttproj（里面没有这张表的内容）之后，启动步骤会把
-- 这两行补回来 —— 否则用户给「问题」改过的颜色会和自定义类型分两处存。
INSERT OR IGNORE INTO item_kinds (key, label, color, requires_note, builtin, sort_order)
VALUES ('todo',  '代办', '#0ea5e9', 0, 1, 0),
       ('issue', '问题', '#a855f7', 1, 1, 1);
