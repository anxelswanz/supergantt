-- AI 复盘：一次「问答 → 文档」的完整记录。
--
-- 和「复盘」视图（core/review.ts）的分工：那一页是**算出来的**，随数据实时变，
-- 不存任何东西；这里是**问出来、写出来的**，是一份会被导出、发给别人的文档，
-- 而且生成它要等三次模型调用、答十道题 —— 中途切走、关应用都很正常，
-- 所以每一步都要落库，回来能接着答。
--
-- 一个项目可以有多份：阶段复盘和结项复盘并存，互不覆盖。
CREATE TABLE ai_reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 项目删了复盘跟着走：一份讲「厂房建设」的复盘在那个项目不存在之后
  -- 没有任何入口能再打开它
  project_id  INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,

  title       TEXT    NOT NULL,

  -- 走到了哪一步。**只记「下一步该做什么」，不记「有没有进程在跑」** ——
  -- 进程是内存里的事，应用一关就没了；把 running 存进库，下次打开会看到
  -- 一份永远转圈的复盘。所以调用失败或被取消时这一列不动，重试就是原地再来一次。
  --
  --   ask1    该出首轮题了        answer1 首轮题已出，等用户答
  --   ask2    该出追问了          answer2 追问已出，等用户答
  --   write   该写文档了          done    文档已生成
  stage       TEXT    NOT NULL DEFAULT 'ask1'
                CHECK (stage IN ('ask1', 'answer1', 'ask2', 'answer2', 'write', 'done')),

  -- 开始前那张小表单：复盘类型、目标与成功标准、实际结果、补充说明。JSON。
  -- 项目表里没有「目标」这回事，而模型猜不出来 —— 见 src/aiReview/types.ts
  background  TEXT    NOT NULL,

  -- 点「开始复盘」那一刻的项目数据。JSON，**之后不再变**。
  --
  -- 冻结是必须的：三次调用和文档里的数据表都读它。不冻结的话，答题期间
  -- 改了一条任务的日期，文档里的叙述说「晚 6 天」而表格写「晚 4 天」。
  snapshot    TEXT    NOT NULL,

  -- 题目和回答，两轮在同一个 JSON 数组里（每题带 round）。每答一题就写一次
  questions   TEXT    NOT NULL DEFAULT '[]',

  -- 生成的 Markdown，用户可以直接改。导出的就是这一列
  document    TEXT    NOT NULL DEFAULT '',

  -- Unix 秒
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 列表按「最近动过的在前」取一个项目的全部复盘
CREATE INDEX idx_ai_reviews_project ON ai_reviews (project_id, updated_at DESC);

-- 让已经调过视图开关的人也能看见这个新视图。
--
-- settings.enabled_views 存的是「开着的那几个」，所以一个新视图对存过这一项的
-- 用户来说天然是「关着的」—— 而没人会去设置里找一个自己不知道存在的东西
-- （core/views.ts 里 DEFAULT_ENABLED 的注释说的就是这件事）。新视图问世的
-- 这一次替他们打开，之后关不关由他们。没存过这一项的用户走默认值，本来就全开。
UPDATE settings
   SET value = json_insert(value, '$[#]', 'ai-review')
 WHERE key = 'enabled_views'
   AND json_valid(value)
   AND json_type(value) = 'array'
   AND NOT EXISTS (SELECT 1 FROM json_each(settings.value) WHERE json_each.value = 'ai-review');
