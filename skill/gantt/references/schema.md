# 字段表与校验规则

这份文档是给需要确认细节的场景用的。日常建任务看 SKILL.md 就够。

## 任务字段

`task create` / `task update` 能设的全部字段。JSON 输出的字段名与这里一致（驼峰）。

| 命令行选项 | JSON 字段 | 取值 | 说明 |
|---|---|---|---|
| `--name` | `name` | 非空文本 | 任务的显示名 |
| `--duration` | （换算成 `endDate`） | `5d` / `2w` / `3m` / 裸数字 | **含首尾**：`--start 10-01 --duration 5d` → 结束 10-05 |
| `--start` | `startDate` | ISO / `today` / `+3d` | 计划开始日 |
| `--end` | `endDate` | 同上 | 计划结束日 |
| `--priority` | `priority` | `P0`–`P3` 或 `0`–`3` | **0 最紧急**，3 最低。默认 2 |
| `--assignee` | `personId` | 现有负责人名字 | 不存在则报错并列出现有名字 |
| `--person-id` | `personId` | 数字 id | 直接指定，跳过名字查找 |
| `--clear-assignee` | `personId` | 开关（仅 update） | 清空负责人 |
| `--parent` | `parentId` | 任务 id，或 `none`（仅 update） | 建子任务 / 换父任务 |
| `--after` | `sortOrder` | 任务 id | 排在该任务后面（取其 `sortOrder + 1`），只影响**同级顺序** |
| `--milestone` | `milestone` | 开关 | 里程碑（只 update 能取消，create 只置真） |
| `--progress` | `progress` | `60%` 或 `0.6` | 0–1。**父任务不能设**，见下 |
| `--weight` | `weight` | 数字 | 加权汇总时的权重；不设则按均权 |
| `--note` | `note` | 文本 | 任务备注 |
| `--auto-rollover` | `autoRollover` | 开关 | 逾期自动顺延（默认关） |
| `--no-auto-rollover` | `autoRollover` | 开关（仅 update） | 关掉自动顺延 |

只读字段（永远从 JSON 里读，不能设）：`id`、`actualStart`、`actualEnd`、`collapsed`、
`pinned`、`blocked`、`sortOrder`。

### 工期是含首尾的

`--duration 5d` 从 10-01 起算得到 10-01…10-05（5 天），不是到 10-06。裸数字和 `5d` 等价。
`2w` = 14 个自然日，`3m` 按自然月推。**不跳过周末** —— 工期是自然日，工作日历是应用里的事。

### 同时给 `--start` 和 `--end` 时，`--duration` 被忽略

`(start, end)` 直接采信，工期只是多余的糖。给了 `--end` 就别再给 `--duration`，
否则两者不一致时以 `--end` 为准，容易让你以为工期没生效。

### 只给 `--end` 也可以

`--end 2026-10-15 --duration 5d` → 开始日倒推为 10-11。只给 `--end` 不给工期 → 开始=结束。

### 什么都不给 → 今天，一天

`--start` / `--end` / `--duration` 全不写，任务是「今天一天」。

## 校验规则（每条都会当场报错，告诉你哪里不对）

### 1. 父任务不能设进度和计划起止

只要任务**在当前项目里已经有子任务**，`--progress` / `--start` / `--end` 一律拒绝：

```
错误：任务 47「接口联调」是父任务，它的进度和计划起止由 3 个子任务加权汇总，不能直接设置。
请改成设置具体的子任务，例如：
  gantt task update 48 --progress 60%
```

注意这是按「**它有没有子任务**」判断的，不是按「它有没有 `--parent`」。
一个刚建出来的子任务（有 `--parent`、但自己还没孩子）设 `--progress` 是合法的 ——
那是它自己的进度。

### 2. 结束不能早于开始

```
错误：结束日期 2026-10-01 早于开始日期 2026-10-10。
```

### 3. `--parent` 不能造环

不能把自己设成自己的父任务，也不能把父任务设成自己的后代。报错会说清楚是哪种。

### 4. 负责人必须存在

```
错误：找不到叫「王五」的负责人。现有：张三、李四。
确认是新人请加 --create-missing，或先 `gantt people create --name 王五`。
```

加 `--create-missing` 才会顺便建。这是刻意的 —— 让错别字变成一个真负责人，
比报错难收拾得多。

### 5. 删父任务要显式确认

```
错误：任务 47「接口联调」有 3 个子任务，删它会连子任务一起删。确认请加 --yes。
```

子任务靠数据库的级联删除一起走。没加 `--yes` 就拦下来。

### 6. 优先级 / 进度 / 日期写法不对

```
错误：优先级只能是 0-3（P0 最紧急），收到 9          # 退出码 1
错误：看不懂进度「abc」，写 60% 或 0.6               # 退出码 1
```

## 常用的错误对照与修法

| 错误信息里出现 | 意思 | 怎么改 |
|---|---|---|
| `找不到任务 <id>` | id 不存在 | `gantt task list --project <id>` 看真实 id |
| `是父任务` | 它有子任务 | 改它的某个子任务（错误信息会给出一个 id） |
| `找不到叫「X」的负责人` | 名字没对上 | 用错误信息里列出的名字，或 `--create-missing` |
| `不在项目 <pid> 里` | id 属于别的项目 | 任务 id 是**全库**的，先在正确项目里 `list` 确认 |
| `后面缺一个值` | 选项没给值 | 补上；如果是你不认识的开关，说明它不存在 |

## 负责人（people）

| 选项 | 字段 | 说明 |
|---|---|---|
| `--name` | `name` | 唯一，重名会报错 |
| `--color` | `color` | `#RRGGBB`，不写自动分配 |

删负责人（应用里操作）不会删他的任务，只是那些任务变回「未分配」。

## 项目（project）

| 选项 | 字段 | 说明 |
|---|---|---|
| `--name` | `name` | 唯一 |
| `--color` | `color` | `#RRGGBB`，不写给默认色 |

`project show --project <id|名字>` 能拿单个项目详情；`project list` 列全部。

## 数据在哪

默认按平台推：Windows `%APPDATA%\com.ronghuizhong.gantt\gantt.db`，
macOS `~/Library/Application Support/com.ronghuizhong.gantt/gantt.db`。

`--data-dir <路径>` 或环境变量 `GANTT_DATA_DIR` 可以覆盖。一般不用管 ——
只要你不用这两个覆盖，CLI 和桌面应用读写的就是同一个库。
