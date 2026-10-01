# 实战示例

这些都是用户会真的说出口的话，以及把它们翻译成的命令序列。

---

## 例 1：「把这 8 个功能点排进项目 3」

用户给了个清单，要你建进去、分给几个人。**先看现场**，再动手。

```bash
# 1. 找到项目、看现有任务（别重复建）、看负责人名字怎么写的
gantt project list --json
gantt task list --project 3 --json
gantt people list --json
```

```bash
# 2. 建一个父任务，把这一批活儿归到它下面
gantt task create --project 3 --name "v2.1 迭代" --start today --duration 20d --json
# → 读回 id，假设是 100
```

```bash
# 3. 建子任务。父任务 100 已经存在，可以引用它了
gantt task create --project 3 --name "接口联调" --parent 100 \
    --start today --duration 5d --priority P1 --assignee 张三 --json
gantt task create --project 3 --name "权限改造" --parent 100 \
    --start +3d --duration 3d --priority P0 --assignee 李四 --json
gantt task create --project 3 --name "数据迁移" --parent 100 \
    --start +7d --duration 5d --priority P2 --assignee 张三 --json
```

**注意两点：**

- 父任务（100）要**先建**，子任务才能用 `--parent 100` 引它。所以顺序是父 → 子。
- 每条命令的 JSON 里读回 `id`。**不要假设 id 连号** —— 任务 id 是全库分配的，
  项目 3 的下一条可能是 101，也可能因为别的项目建过任务是 137。

---

## 例 2：「这个任务工期改成两周」

```bash
gantt task show 47 --json          # 先看它现在什么情况
gantt task update 47 --duration 2w --json
```

如果 47 已经是个父任务（有子任务），`--duration` 也会被拒 —— 因为父任务的起止是算出来的。
错误信息会告诉你该改哪个子任务。

---

## 例 3：「上午的活儿干完了，把进度更到 70%」

```bash
# 只能更到**叶子任务**（没有子任务的）上
gantt task update 48 --progress 70% --json
```

如果 48 是父任务：

```
错误：任务 48「接口联调」是父任务，它的进度和计划起止由 3 个子任务加权汇总，不能直接设置。
请改成设置具体的子任务，例如：
  gantt task update 49 --progress 60%
```

照它给的 id 改子任务。父任务的进度会自己按子任务汇总出来，不用你管。

---

## 例 4：「张三不干了，他的活儿转给李四」

得先把张三名下的活儿找出来。`task list` 的人读输出里有「负责人」一列：

```bash
gantt task list --project 3          # 人读表格，扫一眼谁是谁
```

然后逐个改。没有「按负责人批量改」的命令，就一条条来：

```bash
gantt task update 51 --assignee 李四 --json
gantt task update 52 --assignee 李四 --json
```

李四如果还不在负责人列表里：

```bash
gantt people create --name 李四
```

---

## 例 5：「把这个大任务拆成三块」

原任务 47 现在是叶子，要变成父任务：

```bash
# 建三个子任务，父任务指向 47
gantt task create --project 3 --name "前端" --parent 47 --start today --duration 5d --assignee 张三 --json
gantt task create --project 3 --name "后端" --parent 47 --start today --duration 8d --assignee 李四 --json
gantt task create --project 3 --name "联调" --parent 47 --start +7d --duration 3d --assignee 张三 --json
```

从这一刻起，47 变成父任务，它自己的进度/起止不再能直接设 —— 由这三个子任务汇总。

---

## 例 6：应用开着，写不进去

```bash
$ gantt task create --project 3 --name "临时任务" --start today
错误：桌面应用 Gantt 正在运行（PID 12345），它每 400ms 会把整个项目写回数据库，
你现在写入会被覆盖。

  · 关掉 Gantt 后重试，或
  · 加 --force 承担风险（仅适合应用闲置时快速补一条）
```

**正确的回应是告诉用户关掉应用。** 不要自己加 `--force` —— 用户如果在应用里编辑着，
你的写入会和他的改动相互覆盖，最后一个赢，而他不会知道发生了什么。

读操作不受影响，任何时候都能跑：

```bash
gantt task list --project 3 --json     # 应用开着也照常
```

---

## 例 7：验证写完的东西对不对

```bash
gantt check --json
```

`check` 做数据库结构自检。正常时 `{"ok": true, "issues": []}`。有 `issues` 就是库里
有坏数据（比如跨项目的父子引用），告诉用户，别自己修。

---

## 一条经验：批量操作要能中途停下

一次建 20 个任务是 20 条命令。如果第 7 条失败了（比如负责人名字打错），前 6 条
**已经写进库了**，不会回滚。所以：

- 建之前先把 `people list` 和 `project list` 核对清楚，让失败概率降到最低
- 失败了就修那一条继续，不要从头再来 —— 从头会建出重复任务
- 想确认已经建了哪些，`gantt task list --project <id> --json` 看
