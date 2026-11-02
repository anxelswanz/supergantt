-- 账号：从「单人使用」走向「一台电脑上的多个人」（DESIGN.md §13）。
--
-- 几条前提，整份迁移都建立在它们之上：
--
-- 1. 还是**一个库**。账号之间的隔离靠 project_members 这张归属表，而不是
--    每个账号一个 .db —— 共享项目时两边看的必须是同一行数据，拆成两个库
--    就等于提前做了一套同步，而且迟早分叉。
-- 2. 本地密码不是安全边界。谁拿到这个文件都能用 DB 浏览器读出所有账号的数据，
--    密码只挡「在界面上误点进别人的账号」。所以库层不加密，也不假装加密。
-- 3. 长期要接服务端同步，所以账号和人员这次就带上 uuid：.ganttproj 跨机器
--    导入时重新绑定人员靠的就是它。其余实体的 uuid 等真正设计同步协议时再加。
--
-- 整份迁移包在一个事务里：中途失败就整份回滚，user_version 不会前进，
-- 下次启动从头再来。重建 people 需要先关外键（见下方），而 PRAGMA foreign_keys
-- 在事务内是无效的，所以它必须写在 BEGIN 之前。

PRAGMA foreign_keys = OFF;
BEGIN;

/* ------------------------------------------------------------------ */
/* 账号                                                                */
/* ------------------------------------------------------------------ */

CREATE TABLE accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid          TEXT    NOT NULL DEFAULT '',
  name          TEXT    NOT NULL,
  color         TEXT    NOT NULL DEFAULT '#6366f1',
  -- data URI；为 NULL 时回退到首字母头像。理由同 people.avatar：备份只拷一个 .db
  avatar        TEXT,
  -- argon2 的 PHC 字符串；NULL = 没设密码，启动时直接进入
  password_hash TEXT,
  sort_order    REAL    NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT '0'
);

-- 名字唯一：CLI 的 --account 按名字找人，重名就有歧义
CREATE UNIQUE INDEX idx_accounts_name ON accounts (name);
CREATE UNIQUE INDEX idx_accounts_uuid ON accounts (uuid);

-- 和 projects 一样用触发器补 uuid，任何插入路径都拿得到（理由见 007）
CREATE TRIGGER accounts_uuid_default
AFTER INSERT ON accounts
WHEN NEW.uuid = ''
BEGIN
  UPDATE accounts SET uuid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;

-- 默认账号。老库里的一切都归它；新装的库也有它，单人用户打开软件和以前一样，
-- 不必先「注册」。名字在 Rust 侧迁移完后换成系统用户名（schema.rs 的
-- name_default_account），SQL 里拿不到。
INSERT INTO accounts (id, name, color, sort_order, created_at)
VALUES (1, '我', '#6366f1', 1, CAST(strftime('%s', 'now') AS TEXT));

/* ------------------------------------------------------------------ */
/* 项目成员                                                            */
/* ------------------------------------------------------------------ */

-- 账号能看到哪些项目，以及在里面能做什么。
--   owner  —— 删项目、管成员、移交所有权。每个项目恰好一个
--   editor —— 改项目内容；不能删项目，不能管成员
-- role 用 TEXT 而不是布尔：将来加 viewer 不需要迁移数据
CREATE TABLE project_members (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  role       TEXT    NOT NULL CHECK (role IN ('owner', 'editor')),
  added_at   TEXT    NOT NULL DEFAULT '0',
  PRIMARY KEY (project_id, account_id)
);

-- 「恰好一个所有者」的「至多一个」那一半由库层保证；「至少一个」靠
-- 删账号 / 移交的业务逻辑（query::accounts）
CREATE UNIQUE INDEX idx_members_one_owner ON project_members (project_id) WHERE role = 'owner';
CREATE INDEX idx_members_account ON project_members (account_id);

INSERT INTO project_members (project_id, account_id, role, added_at)
SELECT id, 1, 'owner', CAST(strftime('%s', 'now') AS TEXT) FROM projects;

-- 项目名不再全库唯一，改为「同一个账号看得见的项目里唯一」。
-- 这条规则跨了两张表，SQL 的唯一索引表达不了，交给 query::check_project_name。
-- 全库唯一在多账号下会变成信息泄露：B 建项目时被告知「已有名为『裁员名单』的项目」。
DROP INDEX idx_projects_name;

/* ------------------------------------------------------------------ */
/* 人员：从全局改为归项目                                               */
/* ------------------------------------------------------------------ */

-- 为什么归项目而不归账号：共享项目时名单要跟着项目走。归账号的话，
-- B 打开 A 共享的项目，看到的负责人来自 A 的通讯录 —— 既不属于 B，
-- 导出、同步时也说不清该带走谁。跨项目认出「同一个人」靠绑定的账号。
--
-- 要加 NOT NULL 的 project_id，SQLite 只能重建表。标准做法：关外键 →
-- 建新表 → 拷数据 → 删旧表 → 改名。关外键是必须的：tasks.person_id 挂着
-- ON DELETE SET NULL，外键开着时 DROP TABLE people 会把所有任务的负责人清空。
CREATE TABLE people_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- 绑定的本机账号；NULL = 没有账号的人（外包、甲方、还没装软件的同事）。
  -- 账号被删时解绑而不是删人：历史任务上的负责人不能凭空消失
  account_id   INTEGER          REFERENCES accounts (id) ON DELETE SET NULL,
  -- 记住的账号身份。绑定时等于 accounts.uuid；导入一个 .ganttproj、本机却没有
  -- 这个账号时，account_id 为空但这里留着 —— 将来服务端同步时能认出是谁，
  -- 本机以后建了 / 导入了这个账号也能自动接上
  account_uuid TEXT,
  uuid         TEXT    NOT NULL DEFAULT '',
  name         TEXT    NOT NULL,
  color        TEXT    NOT NULL DEFAULT '#6366f1',
  avatar       TEXT,
  sort_order   REAL    NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT '0',
  legacy_id    INTEGER
);

-- 每个「项目 × 用到的人」一行。没被任何任务或事项用过的人不迁 ——
-- 他们不属于任何项目，硬塞进每个项目只会让名单里全是无关的人
INSERT INTO people_new (project_id, name, color, avatar, sort_order, created_at, legacy_id)
SELECT u.project_id, p.name, p.color, p.avatar, p.sort_order, p.created_at, p.id
FROM people p
JOIN (
  SELECT project_id, person_id FROM tasks      WHERE person_id IS NOT NULL
  UNION
  SELECT project_id, person_id FROM item_notes WHERE person_id IS NOT NULL
) u ON u.person_id = p.id
ORDER BY u.project_id, p.sort_order, p.id;

UPDATE tasks
   SET person_id = (SELECT n.id FROM people_new n
                     WHERE n.legacy_id = tasks.person_id AND n.project_id = tasks.project_id)
 WHERE person_id IS NOT NULL;

UPDATE item_notes
   SET person_id = (SELECT n.id FROM people_new n
                     WHERE n.legacy_id = item_notes.person_id AND n.project_id = item_notes.project_id)
 WHERE person_id IS NOT NULL;

DROP TABLE people;
ALTER TABLE people_new RENAME TO people;
ALTER TABLE people DROP COLUMN legacy_id;

UPDATE people SET uuid = lower(hex(randomblob(16))) WHERE uuid = '';

CREATE UNIQUE INDEX idx_people_uuid ON people (uuid);
-- 重名只在项目内有歧义；两个项目里各有一个「张三」很正常
CREATE UNIQUE INDEX idx_people_project_name ON people (project_id, name);
-- 一个账号在一个项目里只对应一个人，否则「我的任务」会分成两份
CREATE UNIQUE INDEX idx_people_project_account ON people (project_id, account_id)
  WHERE account_id IS NOT NULL;
CREATE INDEX idx_people_account ON people (account_id);

CREATE TRIGGER people_uuid_default
AFTER INSERT ON people
WHEN NEW.uuid = ''
BEGIN
  UPDATE people SET uuid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;

/* ------------------------------------------------------------------ */
/* 设置：账号级                                                         */
/* ------------------------------------------------------------------ */

-- 原 settings 表保留为「全机」设置（上次登录的账号等）；偏好、插件配置、
-- API key 按账号存在这里。哪些 key 是全机的由 query::is_global_setting 决定，
-- 前端读写设置的接口不变。
CREATE TABLE account_settings (
  account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  PRIMARY KEY (account_id, key)
) WITHOUT ROWID;

-- 老设置全部归默认账号。此刻 settings 里还没有任何全机 key（它们是这次才有的），
-- 所以不必筛
INSERT INTO account_settings (account_id, key, value)
SELECT 1, key, value FROM settings;
DELETE FROM settings;

/* ------------------------------------------------------------------ */
/* 作者                                                                */
/* ------------------------------------------------------------------ */

-- 共享项目里「这句是谁写的」。可空：账号删了作者变成「已删除的账号」，内容留着。
-- 老数据都是默认账号写的 —— 这次不记，以后就再也追溯不回来了
ALTER TABLE comments    ADD COLUMN author_id INTEGER REFERENCES accounts (id) ON DELETE SET NULL;
ALTER TABLE daily_notes ADD COLUMN author_id INTEGER REFERENCES accounts (id) ON DELETE SET NULL;
ALTER TABLE item_notes  ADD COLUMN author_id INTEGER REFERENCES accounts (id) ON DELETE SET NULL;
ALTER TABLE ai_reviews  ADD COLUMN author_id INTEGER REFERENCES accounts (id) ON DELETE SET NULL;

UPDATE comments    SET author_id = 1;
UPDATE daily_notes SET author_id = 1;
UPDATE item_notes  SET author_id = 1;
UPDATE ai_reviews  SET author_id = 1;

/* ------------------------------------------------------------------ */
/* 折叠状态：每个人一份                                                 */
/* ------------------------------------------------------------------ */

-- tasks.collapsed 是视图状态而不是项目事实：A 折起一个分组，B 打开时
-- 不该也是折着的。tasks.collapsed 列保留不删（删列要重建 tasks 表，
-- 而它挂着一大串级联），但从此不再读写它。
CREATE TABLE task_view_state (
  account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  task_id    INTEGER NOT NULL REFERENCES tasks (id)    ON DELETE CASCADE,
  collapsed  INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
  PRIMARY KEY (account_id, task_id)
) WITHOUT ROWID;

INSERT INTO task_view_state (account_id, task_id, collapsed)
SELECT 1, id, 1 FROM tasks WHERE collapsed = 1;

/* ------------------------------------------------------------------ */
/* 事项类型：自定义的归创建者                                           */
/* ------------------------------------------------------------------ */

-- 内置两行（account_id 为空）所有人共用。自定义类型归创建它的账号：
-- 只有它自己的下拉里有，只有它能改能删。别人在共享项目里看到用了这个类型的
-- 事项时，类型照样能显示（query::list_item_kinds 会把可见项目里用到的带上），
-- 只是改不了。
ALTER TABLE item_kinds ADD COLUMN account_id INTEGER REFERENCES accounts (id) ON DELETE SET NULL;
UPDATE item_kinds SET account_id = 1 WHERE builtin = 0;

COMMIT;
PRAGMA foreign_keys = ON;
