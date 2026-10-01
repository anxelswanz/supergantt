---
name: gantt
description: |
  用命令行直接操作本机的 Gantt（甘特图）项目数据库：建项目、建任务、设工期/开始日/
  优先级/负责人/子任务层级、改进度、删任务、查任务列表。当用户说「帮我在甘特图里
  建任务」「把这个需求排个排期」「把这些活儿分给张三李四」「看看项目 3 里有什么任务」
  「这个任务工期改成两周」，或提到 .gantt 项目、排期、负责人分配时，用这个技能。
  不适用：操作云端/在线甘特图服务，或用户明确说要手点界面。
---

# Gantt 命令行

`gantt` 是一个直接读写本机 Gantt 桌面应用数据库的命令行工具。它和桌面应用共用同一个
SQLite 文件，所以你在这里建的任务，用户打开应用就能看见。

## 最重要的三条规矩

**1. 永远不要让用户或你自己去算日期。**

日期只认三种写法：ISO（`2026-10-01`）、`today`、相对（`+3d` / `-2w` / `+1m`）。
工期写成 `5d`（5 个自然日）/ `2w` / `3m`。让工具去算 `end_date`，不要自己推。

```bash
# 对：今天开始，做 5 天
gantt task create --project 3 --name "接口联调" --start today --duration 5d
# 错：自己算出结束日，算错一次排期全错一片
gantt task create --project 3 --name "接口联调" --start 2026-10-01 --end 2026-10-06
```

**2. 父任务不能设进度和计划起止。**

只要一个任务有了子任务，它的 `进度`/`开始`/`结束` 就变成由子任务**加权汇总**出来的。
直接设会被界面重算覆盖。工具会当场报错并告诉你该改哪个子任务 —— 照它说的改。

```bash
$ gantt task update 47 --progress 60%
错误：任务 47「接口联调」是父任务，它的进度和计划起止由 3 个子任务加权汇总，不能直接设置。
请改成设置具体的子任务，例如：
  gantt task update 48 --progress 60%
```

**3. 负责人必须先存在。**

`--assignee 王五` 如果王五不在负责人列表里，命令**会失败**（不会偷偷建一个 —— 那样一个
错别字就多出一个负责人）。报错会列出所有现有名字。要么用对名字，要么先建：

```bash
gantt people create --name 王五
# 或者，确认就是这个新人：
gantt task create ... --assignee 王五 --create-missing
```

## 桌面应用开着时写不进去

应用每 400ms 会把整个项目写回数据库。你这时候写，下一帧就被覆盖掉 —— 而且是**静默**覆盖。
所以 CLI 检测到应用在跑时会拒绝写入（退出码 3）：

```
错误：桌面应用 Gantt 正在运行（PID 12345），它每 400ms 会把整个项目写回数据库，
你现在写入会被覆盖。
```

**这时候该做的是告诉用户关掉应用**，而不是加 `--force`。`--force` 是给「应用开着但
用户人不在、只是忘了关」这类场景用的，最后一个写入者赢 —— 你在应用里的改动会丢。读操作
（`list` / `show`）任何时候都能跑，不受影响。

## 命令速查

```bash
# 项目
gantt project list [--json]
gantt project show --project <id|名称> [--json]
gantt project create --name <名称> [--color #RRGGBB] [--json]

# 任务
gantt task list --project <id|名称> [--json]
gantt task show <id> [--json]
gantt task create --project <id|名称> --name <名称>
                  [--duration 5d|2w] [--start today|2026-10-01|+3d] [--end ...]
                  [--priority P0|P1|P2|P3] [--assignee <名字>|--person-id <n>]
                  [--parent <id>] [--after <id>] [--milestone]
                  [--progress 60%] [--weight <n>] [--note <文本>]
                  [--auto-rollover] [--create-missing] [--json]
gantt task update <id> [上面任意字段] [--parent none] [--clear-assignee] [--json]
gantt task delete <id> [--yes] [--json]

# 负责人
gantt people list [--json]
gantt people create --name <名字> [--color #RRGGBB] [--json]

# 结构自检（查数据库有没有坏掉）
gantt check [--json]
```

全局选项：`--data-dir <路径>`（换数据目录，一般不用）、`--force`（见上）、`--json`。

`--data-dir` / `--force` / `--json` 要写在**子命令之后**（`gantt task list --project 3 --json`）。
写在最前面会被当成命令名，报「不认识的命令」。

`--project` 接受 id 或项目名。名字有歧义时工具会报错并列出候选。

## 退出码

按退出码分支，不要靠解析中文错误文本来判断成败：

| 码 | 含义 | 怎么办 |
|---|---|---|
| 0 | 成功 | — |
| 1 | 参数写错了 | 看错误信息改命令行，重试 |
| 2 | 数据校验没过 | 看错误信息（比如找出人名、父任务不能设进度），改正后重试 |
| 3 | 桌面应用占用 | 让用户关掉应用，别加 `--force` |
| 4 | 数据库错误 | 别重试，告诉用户 |

## 推荐的工作方式

1. **先看现场再动手。** 建任务前先 `gantt project list --json` 和 `gantt task list --project <id> --json`，
   确认项目 id、已有的任务（避免重复建）、以及负责人名字怎么写的。
2. **批量建任务时按依赖顺序（父任务先建）。** 用 `--parent <id>` 建子任务前，父任务必须已经存在，
   所以先建父任务拿到它的 id，再建子任务。
3. **用 `--json` 拿结果。** 建完任务后 JSON 会回显完整字段，从里面读回 `id` 给下一步用。
4. **一次建一条，拿回 id 再用。** 不要假设 id 会连号 —— 任务的 id 是**全库**分配的，
   不是你项目里的序号。永远从 JSON 的返回值里读 id。

## 更细的字段和错误处理

- 完整字段表、每个字段的取值范围：见 `references/schema.md`
- 端到端的实战示例（「把这 8 个功能点排进项目 3」）：见 `references/examples.md`
