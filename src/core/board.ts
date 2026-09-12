/**
 * 看板的四列。
 *
 * **列是算出来的，不是存下来的** —— 任务上没有 status 字段，也不会有。
 *
 * 加一个 status 字段的代价不是多一列数据，而是多一个真相：卡片拖进"已完成"、
 * 而 progress 还停在 0.6 时，屏幕上会同时出现两个互相矛盾的说法，用户
 * 从此不再相信其中任何一个（同 model.ts 里"父任务进度只读"防的是同一件事）。
 * 更麻烦的是父任务：progress 有明确的加权汇总规则，status 没有 ——
 * 三个子任务分别待办/进行中/完成，父任务该显示哪个？没有自然答案。
 *
 * 所以这里反过来做：列由现有字段推导，拖动卡片则**写回那些字段**。
 * 看板因此不是一份新数据，而是甘特、时间线、复盘之外的第四个投影，
 * 四者永远自洽。代价是列固定四个，不能自定义「待评审」「待验收」。
 */

import type { BlockedPeriod } from "./blocked";
import { closeOpenBlocks, newBlockId, type BlockReason } from "./blocked";
import type { ResolvedTask, Task } from "../gantt/model";

export type BoardColumn = "todo" | "doing" | "blocked" | "done";

export const BOARD_COLUMNS: {
  key: BoardColumn;
  label: string;
  /** 列头下的一行小字，说明这一列的判据 —— 否则没人猜得到卡片为什么在这 */
  rule: string;
}[] = [
  { key: "todo", label: "未开始", rule: "没有实施日期，进度为 0" },
  { key: "doing", label: "进行中", rule: "已经动过，但还没做完" },
  // 「卡住」改叫「受阻」：和详情面板、甘特标识、复盘报表用同一个词。
  // 同一件事在四个地方三种叫法，用户会以为它们是三件不同的事
  { key: "blocked", label: "受阻", rule: "有一条还没关掉的阻碍" },
  { key: "done", label: "已完成", rule: "进度 100%" },
];

/**
 * 这条任务此刻算不算受阻。
 *
 * 两种都算：**没关掉的阻碍**（`open`），和**今天落在区间里的历史标注**。
 * 前者是主要来源；后者留着是因为 ⌥ 拖出来的标注可以标到未来几天，
 * 那几天到了同样是卡着，不该因为没走「新建阻碍」那个入口就不算数。
 *
 * 光看 `open` 不够的另一个原因：跨天延长是每分钟检查一次的，
 * 刚过零点那一小会儿 `to` 还停在昨天，只认区间会让卡片短暂地跳出受阻列。
 */
export function isBlockedOn(task: Pick<Task, "blocked">, day: number): boolean {
  return task.blocked.some((b) => b.open === true || (b.from <= day && day <= b.to));
}

/**
 * 这条活算不算「进行中」—— 新建阻碍和新建风险共用的准入判据。
 *
 * **受阻列里的活也算进行中**：它已经开工了，只是被卡住。一条活同时卡在
 * 等料和设备故障上是常事，不许它再开第二条阻碍，用户只能把两件事挤进
 * 同一条说明里，归因统计当场失真。
 *
 * 排除的是另外两头：还没开工的活谈不上「推不动」（那个阶段该改的是计划日期），
 * 已完成的活挂一条没关的阻碍，只会让看板长期挂着一个不会有人处理的假警报。
 *
 * 这条规矩管的是**独立新建**那两个入口。把卡片从「未开始」直接拖进受阻列
 * 仍然允许：那个动作本身会先补上实施开始日（见 moveToColumn），
 * 落地之后关联到的同样是一条已经动起来的活。
 */
export const isInProgress = (
  task: Pick<Task, "progress" | "actualStartDay" | "blocked">,
  today: number,
): boolean => {
  const column = columnOf(task, today);
  return column === "doing" || column === "blocked";
};

/**
 * 这张卡片该落在哪一列。
 *
 * 顺序有讲究：**完成优先于卡住**。一件已经做完的活，即使它的受阻记录
 * 一直拖到今天还没关掉（很常见，人不会记得回去关），它也不该显示成卡住 ——
 * 那会让看板长期挂着一堆假警报，警报一多就没人看了。
 */
export function columnOf(
  task: Pick<Task, "progress" | "actualStartDay" | "blocked">,
  today: number,
): BoardColumn {
  if (task.progress >= 1) return "done";
  if (isBlockedOn(task, today)) return "blocked";
  if (task.actualStartDay != null || task.progress > 0) return "doing";
  return "todo";
}

/**
 * 把卡片拖到某一列意味着改什么。
 *
 * 返回要写进任务的字段；已经在目标列时返回 null（调用方据此不产生命令，
 * 否则撤销栈里会堆满一串什么都没改的"移动卡片"）。
 *
 * 实施日期两端必须同空同有（库层有触发器兜底），所以凡是要填的地方
 * 都一次填两端。
 */
export function moveToColumn(
  task: Pick<
    Task,
    "progress" | "startDay" | "endDay" | "actualStartDay" | "actualEndDay" | "blocked"
  >,
  column: BoardColumn,
  today: number,
  reason: BlockReason = "other",
): Partial<Task> | null {
  if (columnOf(task, today) === column) return null;

  switch (column) {
    case "todo":
      // 退回未开始 = 抹掉实施痕迹。受阻记录是历史事实，不跟着抹 ——
      // 只把今天还在生效的那段关掉
      return {
        progress: 0,
        actualStartDay: null,
        actualEndDay: null,
        blocked: closeOpenBlocks(task.blocked, today),
      };

    case "doing": {
      const blocked = closeOpenBlocks(task.blocked, today);
      if (task.actualStartDay != null && task.actualEndDay != null) {
        // 已经有实施区间了（从"卡住"或"已完成"退回来），只需要解除受阻、
        // 并把 100% 的进度退一档 —— 否则它会立刻被判回"已完成"
        return {
          blocked,
          ...(task.progress >= 1 ? { progress: 0.99 } : {}),
        };
      }
      // 第一次开工：从今天起算，先按计划的结束日收尾。
      // 计划结束日已经过去的（这活本来就该做完了），退化成当天一天
      return {
        actualStartDay: today,
        actualEndDay: Math.max(today, task.endDay),
        blocked,
      };
    }

    case "blocked": {
      // 还没开工就卡住是常见的（等料、等审批），所以这里不强制先进"进行中"，
      // 但要把实施区间补上 —— 否则时间线上这段受阻会飘在没有条子的地方
      const started =
        task.actualStartDay != null && task.actualEndDay != null
          ? {}
          : { actualStartDay: today, actualEndDay: Math.max(today, task.endDay) };
      return { ...started, ...openBlockerOn(task, today, reason) };
    }

    case "done": {
      const start = task.actualStartDay ?? today;
      return {
        progress: 1,
        actualStartDay: start,
        // 完成日就是今天。真实完成日不是今天的，去详情里改 —— 
        // 在看板上再加一个日期选择器，会把"一拖了事"这个唯一的优点弄没
        actualEndDay: Math.max(start, today),
        blocked: closeOpenBlocks(task.blocked, today),
      };
    }
  }
}

/**
 * 新开一条阻碍。
 *
 * 默认是**未关闭**的、从今天起算：把卡片拖进受阻列走的就是这条路，
 * 那个手势描述的是此刻正卡着的事，它要一直跟着往后长到有人来关掉它
 * （见 blocked.ts 的 extendOpenBlocks）。
 *
 * `span` 和 `live` 是给**补记**用的：上个月那条活卡了三天，人往往是在
 * 它做完之后的复盘会上才想起来记 —— 那时既不该从今天起算，也不该让它
 * 继续往后长。两个参数都不传时行为和以前一模一样。
 *
 * 持续中的那条终点一律顶到今天，和 fitBlocked 同一套口径：
 * 「一直卡到我手动关掉」的起码含义就是「到此刻为止都还卡着」。
 */
export function newBlocker(
  today: number,
  reason: BlockReason,
  note?: string,
  span?: { from: number; to: number },
  live = true,
): BlockedPeriod {
  const from = Math.floor(span?.from ?? today);
  const filled = Math.max(from, Math.floor(span?.to ?? today));
  return {
    id: newBlockId(),
    from,
    to: live ? Math.max(filled, today) : filled,
    reason,
    ...(live ? { open: true } : {}),
    ...(note?.trim() ? { note: note.trim() } : {}),
  };
}

/**
 * 开一条阻碍要写回任务的全部字段。两个入口（看板的「新建阻碍」和把卡片
 * 拖进受阻列）共用它，否则两条路会慢慢长出不一样的行为。
 *
 * 除了那条阻碍本身，还要**把区间拉到今天**。这不是顺手多做一步：
 * 受阻段必须落在任务区间内（clampToTask / reclamp 会裁掉外面的部分），
 * 而一条计划早就该结束、实际还在做的活，`endDay` 是小于今天的 ——
 * 不拉长的话，这条新开的阻碍会在用户下一次改它的归类时被静默裁掉。
 */
export function openBlockerOn(
  task: Pick<Task, "blocked" | "endDay" | "actualEndDay">,
  today: number,
  reason: BlockReason,
  note?: string,
  span?: { from: number; to: number },
  live = true,
): Partial<Task> {
  const period = newBlocker(today, reason, note, span, live);
  // 拉到这条阻碍的终点，而不是一律拉到今天：补记一段上个月的受阻，
  // 不该把一条早就做完的活的计划结束日拽到今天
  const reach = period.to;
  return {
    blocked: [...task.blocked, period],
    ...(task.endDay < reach ? { endDay: reach } : {}),
    ...(task.actualEndDay != null && task.actualEndDay < reach
      ? { actualEndDay: reach }
      : {}),
  };
}

/**
 * 能不能给这条活记一条阻碍 —— 只管**阻碍**这一个入口。
 *
 * 比 isInProgress 宽一格：**已完成的活也能记**。补记是真实需求 —— 上个月
 * 那条活卡了三天，人往往是在它做完之后的复盘会上才想起来记，而那时它已经
 * 在「已完成」列里了。挡住它等于逼用户先把进度调回 99% 记一条、再调回去。
 *
 * 仍然排除「还没开工」：那个阶段谈不上「推不动」，该改的是计划日期。
 *
 * 风险那边继续用 isInProgress，没有跟着放宽：风险说的是「接下来可能出问题」，
 * 给一条已经做完的活记一条未来的风险，本身就不成立。
 */
export const canRecordBlocker = (
  task: Pick<Task, "progress" | "actualStartDay" | "blocked">,
  today: number,
): boolean => columnOf(task, today) !== "todo";

/**
 * 看板只放叶子任务。
 *
 * 父任务的进度和日期都是子任务汇总出来的，拖它等于同时改一串子任务，
 * 但"拖到已完成"该把哪个子任务标完成？没有答案。父任务在卡片上以
 * 面包屑的形式出现（见 BoardView），信息不丢，但不可拖。
 */
export const boardTasks = (tasks: ResolvedTask[]): ResolvedTask[] =>
  tasks.filter((t) => !t.hasChildren);
