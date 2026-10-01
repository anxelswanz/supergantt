-- 事项（QuickNote）：系统里第一个「还没成为计划」的收容区。
--
-- 现有的四个视图全部在处理**已经放进计划里的活**：甘特问「排在哪」、看板问
-- 「此刻谁卡住了」、时间线问「那天发生了什么」、复盘问「差在哪」。它们都要求
-- 一件事先被翻译成「任务 + 日期 + 负责人」才接得住。
--
-- 而现实里最先出现的东西没有日期：会上的一句话、邮件里的一个隐患、走廊里提的
-- 一个问题。要求它们当场完成那次翻译，就是它们最后没被记下来的原因。
-- 这张表的全部意义是让**记录和分拣解耦**：先原样存下来，什么时候想清楚
-- 它是什么，再分拣。
--
-- ⚠️ 几个字段的「可空」是设计，不是偷懒，逐条说明在下面。

CREATE TABLE item_notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name         TEXT    NOT NULL DEFAULT '',

  -- 类型。**未分拣时为 NULL**，它的含义是「我还没决定这是什么」，
  -- 不是「其他」。硬给一个默认值（比如默认「代办」）会让每一条随手记的
  -- 东西一出生就被贴上一个大概率是错的标签，而人不会回去改它 ——
  -- 「其他」这一类的污染就是这么发生的。
  kind         TEXT,

  -- P0–P3，和任务的紧急度同一把刻度。默认 P2（中），因为录入时不选优先级
  -- 也要能 Enter 存下 —— 录入界面每多一个必填项，记下来的概率就低一分。
  priority     INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),

  -- 单人。任务已经是单人，多人会连带分叉着色模式、看板头像、导出格式，
  -- 收益不抵成本（见 产品设计-事项与视图开关.md §10）
  person_id    INTEGER REFERENCES people (id) ON DELETE SET NULL,

  -- 关联的活。**ON DELETE SET NULL**，和 risks.task_id 的 CASCADE 刻意不同：
  -- 一条风险不挂在任何活上就没有意义，而一条 Note 是独立记录下来的东西，
  -- 任务删了它应该留着 —— 它不是任务的附属品。
  task_id      INTEGER REFERENCES tasks  (id) ON DELETE SET NULL,

  -- 晋升去向。两列同生同灭：要么都为 NULL（还没晋升成实体），要么都有值。
  --
  -- promoted_ref 编成一个字符串，两种形态：
  --   阻碍：'<taskId>/<periodId>'（BlockedPeriod.id 是稳定的本地标识）
  --   风险：'<riskId>'
  -- 不拆两列是因为 promoted_kind 已经区分了，拆开必有一列恒为 NULL；
  -- 不用外键是因为两种去向指向两套不同的实体，外键表达不了 ——
  -- 而且**悬挂引用是预期要发生的事**（阻碍能删、风险能删），按外键那种
  -- 严肃程度去要求它反而不对。界面上对悬挂引用有专门的出路。
  promoted_kind TEXT CHECK (promoted_kind IN ('blocker', 'risk')),
  promoted_ref  TEXT,

  -- 关闭时刻（Unix 秒）。**没有单独的 closed 布尔** —— 多一个布尔就会出现
  -- 「closed = 1 而 closed_at 为空」的自相矛盾状态，那是 risks 表已经
  -- 演示过一次的错误（见 008_risk_resolution.sql 的注释）。
  closed_at    INTEGER,
  -- 怎么关掉的。只对「关闭需写结论」的类型有值（item_kinds.requires_note）
  resolution   TEXT,

  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- 列表默认按创建时间倒序取一个项目的全部事项
CREATE INDEX idx_item_notes_project ON item_notes (project_id, created_at DESC);
CREATE INDEX idx_item_notes_task    ON item_notes (task_id);
