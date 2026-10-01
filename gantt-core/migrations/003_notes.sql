-- 任务的两类附注：风险点与评论。
--
-- 它们不属于「排期数据」—— 排期数据走命令栈、可 ⌘Z 撤销、整项目事务替换；
-- 附注是即写即存的独立实体，⌘Z 不该把你刚敲的一条评论撤掉。
--
-- ⚠️ 这两张表能存在的前提，是 save_project 已经从「删光再插入」改成 upsert。
-- 否则每次自动保存都会删掉所有 tasks 行，级联把风险和评论一起清空 ——
-- 而且是静默清空，用户下次打开才发现全没了。

CREATE TABLE risks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  content    TEXT    NOT NULL,
  -- 0 高 / 1 中 / 2 低。和紧急度一样用小整数，顺序即严重程度
  level      INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 0 AND 2),
  -- 已解决的风险不删掉，留作记录 —— 「这个坑我们踩过并且填了」本身是信息
  resolved   INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
  -- Unix 秒。展示格式交给前端，库里不存已经本地化过的字符串
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_risks_task ON risks (task_id);

CREATE TABLE comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  content    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_comments_task ON comments (task_id);
