-- 初始 schema（对应 DESIGN.md §1 / §2 / §3 / §4）
--
-- 日期一律存 ISO 'YYYY-MM-DD' 字符串，而不是渲染层用的天序号整数。
-- 渲染层用天序号是为了做浮点插值和像素换算；但落库时必须自描述 ——
-- 你哪天用 DB 浏览器打开这个文件，或者从 Excel 导入导出，看到的应该是
-- 「2026-08-03」而不是「9711」。天序号还隐含依赖代码里的纪元常量，
-- 一旦改动全库数据失效。转换只发生在读写边界，成本可以忽略。

PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  -- 项目强调色：进度环、甘特条、卡片都用它，形成项目识别（DESIGN.md §4.3）
  color       TEXT    NOT NULL DEFAULT '#6366f1',
  -- 工作日历（DESIGN.md §1.5）。JSON 数组，0=周日
  work_days   TEXT    NOT NULL DEFAULT '[1,2,3,4,5]',
  holidays    TEXT    NOT NULL DEFAULT '[]',
  sort_order  REAL    NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE TABLE tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id   INTEGER          REFERENCES tasks(id)    ON DELETE CASCADE,
  name        TEXT    NOT NULL DEFAULT '',

  -- 叶子任务的计划起止（含首尾两天）。
  -- 父任务这两列不参与计算 —— 它的日期永远由子任务汇总得出（DESIGN.md §1.3），
  -- 保留列只是为了「最后一个子任务被删掉时」还有个回退值。
  start_date  TEXT    NOT NULL,
  end_date    TEXT    NOT NULL,

  -- 0–1。父任务这一列同样不可信，读取时一律用子任务加权汇总覆盖（DESIGN.md §1.2）
  progress    REAL    NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 1),

  priority    INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  assignee    TEXT    NOT NULL DEFAULT '',
  milestone   INTEGER NOT NULL DEFAULT 0 CHECK (milestone IN (0, 1)),

  -- 手动权重覆盖；NULL = 按工期加权。schema 先留位，UI 到 v2 才暴露
  weight      REAL             CHECK (weight IS NULL OR weight > 0),

  collapsed   INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
  -- 锁定后不参与自动重排（DESIGN.md §2.3），v2 生效
  pinned      INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),

  note        TEXT    NOT NULL DEFAULT '',
  -- REAL 而非 INTEGER：在两行之间插入新行时取平均值即可，不必整表重排
  sort_order  REAL    NOT NULL DEFAULT 0,

  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,

  CHECK (end_date >= start_date)
);

CREATE INDEX idx_tasks_project ON tasks (project_id, sort_order);
CREATE INDEX idx_tasks_parent  ON tasks (parent_id);

-- 依赖关系。
-- 实现层第一版只处理 FS（DESIGN.md §2.1），但 type 列按完整四种约束建好，
-- 将来支持 SS/FF/SF 时不需要做数据迁移。
CREATE TABLE dependencies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_task_id INTEGER NOT NULL REFERENCES tasks(id)    ON DELETE CASCADE,
  to_task_id   INTEGER NOT NULL REFERENCES tasks(id)    ON DELETE CASCADE,
  type         TEXT    NOT NULL DEFAULT 'FS'
                 CHECK (type IN ('FS', 'SS', 'FF', 'SF')),
  -- 延迟/提前量，可为负（lead）
  lag_days     INTEGER NOT NULL DEFAULT 0,

  -- 自依赖是数据损坏，直接在库层挡掉
  CHECK (from_task_id <> to_task_id),
  UNIQUE (from_task_id, to_task_id)
);

CREATE INDEX idx_deps_from ON dependencies (from_task_id);
CREATE INDEX idx_deps_to   ON dependencies (to_task_id);

-- 基线（DESIGN.md §3）。只冻结日期，不冻结进度 —— 存进度会滑向挣值管理。
CREATE TABLE baselines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  created_at  TEXT    NOT NULL
);

CREATE TABLE baseline_tasks (
  baseline_id INTEGER NOT NULL REFERENCES baselines(id) ON DELETE CASCADE,
  -- 不加外键到 tasks：任务删掉之后，基线里那一行必须留着，
  -- 对比模式下要能显示「这个任务原计划存在，现已删除」（DESIGN.md §3.5）
  task_id     INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  start_date  TEXT    NOT NULL,
  end_date    TEXT    NOT NULL,
  duration    INTEGER NOT NULL,
  PRIMARY KEY (baseline_id, task_id)
);

-- 应用级设置：音量、静音、上次打开的项目等
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
