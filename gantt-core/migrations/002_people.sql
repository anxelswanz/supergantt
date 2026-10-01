-- 负责人从自由文本升格为实体。
--
-- 原来 tasks.assignee 是一个 TEXT，打错一个字就多出一个「负责人」，
-- 也挂不住头像和颜色。现在建成正式的表，任务通过外键引用。
--
-- 表是**全局**的，不挂 project_id：同一个人通常同时出现在多个项目里，
-- 每个项目重新录一遍既烦人，也让「张三在 3 个项目里的总负载」这种
-- 跨项目视图（v3）无从谈起。
--
-- 头像存 base64 data URI，直接落在这张表里，不写成独立文件。
-- 理由是备份 —— 我们的备份是「复制单个 .db 文件」，头像一旦存到文件系统，
-- 备份就会静默地不包含它，等于回到之前那个空壳备份的坑里。

CREATE TABLE people (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  -- 既是头像底色，也是「按负责人着色」时甘特条的颜色 —— 两处必须一致，
  -- 否则用户要在头像色和条子色之间做二次映射
  color      TEXT    NOT NULL DEFAULT '#6366f1',
  -- data URI；为 NULL 时前端回退到首字母头像
  avatar     TEXT,
  sort_order REAL    NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT '0'
);

-- 重名会让「按名字找人」产生歧义，直接在库层挡掉
CREATE UNIQUE INDEX idx_people_name ON people (name);

-- 把已有的 assignee 文本去重后迁进来，颜色按名字顺序轮转分配，
-- 免得迁移完所有人都是同一个色、「按负责人着色」失去意义
INSERT INTO people (name, color, sort_order, created_at)
SELECT
  name,
  CASE (ROW_NUMBER() OVER (ORDER BY name)) % 8
    WHEN 1 THEN '#4f46e5'
    WHEN 2 THEN '#0ea5e9'
    WHEN 3 THEN '#059669'
    WHEN 4 THEN '#f59e0b'
    WHEN 5 THEN '#be185d'
    WHEN 6 THEN '#14b8a6'
    WHEN 7 THEN '#7c3aed'
    ELSE '#f97316'
  END,
  ROW_NUMBER() OVER (ORDER BY name),
  '0'
FROM (
  SELECT DISTINCT TRIM(assignee) AS name FROM tasks WHERE TRIM(assignee) <> ''
);

-- ON DELETE SET NULL：删掉一个人不该连带删掉他的任务，
-- 任务只是变成「无负责人」
ALTER TABLE tasks ADD COLUMN person_id INTEGER REFERENCES people (id) ON DELETE SET NULL;

UPDATE tasks
   SET person_id = (SELECT id FROM people WHERE people.name = TRIM(tasks.assignee));

-- 名字不再冗余存一份。两处存同一个事实，迟早会分叉 ——
-- 和「父任务进度不可手填」是同一条理由
ALTER TABLE tasks DROP COLUMN assignee;

CREATE INDEX idx_tasks_person ON tasks (person_id);
