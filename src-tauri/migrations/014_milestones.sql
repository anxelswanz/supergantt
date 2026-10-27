-- 里程碑：用户自己设立的项目节点，独立于任务体系。
--
-- 任务表里早有一个 `milestone` 布尔字段，但那是「把某条任务标记成里程碑」
-- —— 它依附在任务上，没有独立的名称/日期/说明，也不能脱离任务存在。
-- 这张表是另一回事：用户自己设的关键节点，可以关联到若干条任务，
-- 也可以不关联任何任务，在甘特图上是一个独立的标记。
--
-- 两套东西并存是刻意的：任务级里程碑回答「这条活本身是不是个节点」，
-- 项目级里程碑回答「整个项目走到哪算一站」。前者跟着任务走、进命令栈、
-- 随整项目保存；后者是独立的记录，有自己的增删改，不进任务表的撤销栈。

CREATE TABLE milestones (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  -- ISO 'YYYY-MM-DD'，和 tasks 一样（见 001_init.sql 顶部关于日期存储的说明）
  date         TEXT    NOT NULL,
  color        TEXT    NOT NULL DEFAULT '#f59e0b',
  description  TEXT    NOT NULL DEFAULT '',
  -- 手动排序，REAL 同 tasks.sort_order：在两行之间插入取中点即可
  sort_order   REAL    NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- 列表按手动顺序取一个项目的全部里程碑
CREATE INDEX idx_milestones_project ON milestones (project_id, sort_order, id);

-- 关联表：一个里程碑可关联多条任务，一条任务也可被多个里程碑关联。
-- 两端都 ON DELETE CASCADE：删里程碑清关联，删任务清关联，都不伤及对方实体。
CREATE TABLE milestone_tasks (
  milestone_id INTEGER NOT NULL REFERENCES milestones (id) ON DELETE CASCADE,
  task_id      INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  PRIMARY KEY (milestone_id, task_id)
);

-- 让存过视图开关的老用户也能看见这个新视图，只打开一次。
-- 和 013 同理：没存过的不动（走默认全开），已经有的不重复加，坏 JSON 不碰。
UPDATE settings
   SET value = json_insert(value, '$[#]', 'milestone')
 WHERE key = 'enabled_views'
   AND json_valid(value)
   AND json_type(value) = 'array'
   AND NOT EXISTS (SELECT 1 FROM json_each(settings.value) WHERE json_each.value = 'milestone');
