-- 项目身份：uuid + 名称唯一。
--
-- 起因是跨电脑传输（.ganttproj 导入导出）。导入一个文件时必须回答一个问题：
-- 「这是本机某个项目的新版本，还是一个全新的项目？」
--
-- 光靠名字回答不了 —— 你在另一台电脑上把项目改了名，带回来就认不出了。
-- 光靠 uuid 也回答不了 —— 这个功能上线之前，你两台机器上那两个「同一个项目」
-- 是各自建出来的，uuid 是各自随机生成的，第一次导入必然对不上。
--
-- 所以两者都要，**uuid 优先、名字兜底**：
--   uuid 命中 → 是同一个项目，哪怕名字变了（覆盖时顺便改名）
--   uuid 不中但名字命中 → 也当同一个项目（首次使用靠这条）
--   都不中 → 全新项目
--
-- 名字能当兜底的前提是它唯一，所以这里把它升成硬约束。副作用是新建和重命名
-- 时要挡重名 —— 那是好事：一旦允许出现「厂房建设」和「厂房建设 (2)」，
-- 名字作为身份线索就废了，而这正是我们唯一的兜底手段。

-- randomblob(16) 走 SQLite 自己的 CSPRNG，不必为一个 uuid 引 crate。
-- 不是 RFC 4122 格式（没有版本位和分隔符），但我们只要求它全局不重复。
ALTER TABLE projects ADD COLUMN uuid TEXT NOT NULL DEFAULT '';
UPDATE projects SET uuid = lower(hex(randomblob(16))) WHERE uuid = '';
CREATE UNIQUE INDEX idx_projects_uuid ON projects (uuid);

-- 生成规则放在 schema 里，不放在调用方。
--
-- SQLite 的 DEFAULT 只能是常量，给不了随机值，所以用触发器补。这样**任何**
-- 插入路径都会拿到 uuid —— 现在的 create_project、导入、将来某条迁移里的
-- INSERT、乃至你用 DB 浏览器手动加的一行。写在调用方就意味着「以后每个人
-- 都得记得」，而这类「记得」迟早有人不记得。
--
-- 唯一索引和触发器不冲突：UNIQUE 在插入那一刻检查，此时上一行的 '' 已经被
-- 它自己的触发器换成随机值了，所以任何时刻库里最多只有一个 ''。
CREATE TRIGGER projects_uuid_default
AFTER INSERT ON projects
WHEN NEW.uuid = ''
BEGIN
  UPDATE projects SET uuid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;

-- 加唯一索引之前必须先把已有的重名消掉，否则整条迁移 ABORT，应用直接起不来。
-- 每组重名里保留 id 最小的那个原名，其余追加 id 后缀 —— id 唯一，所以
-- 消歧后的名字之间不会再撞。
UPDATE projects
   SET name = name || ' (' || id || ')'
 WHERE id NOT IN (SELECT MIN(id) FROM projects GROUP BY name);

CREATE UNIQUE INDEX idx_projects_name ON projects (name);
