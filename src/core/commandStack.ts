/**
 * 撤销 / 重做栈（DESIGN.md §7）。
 *
 * 为什么这个必须在 v1 就位：整个应用的主要交互是拖拽。
 * 拖拽 + 无撤销 = 用户不敢拖；而「敢乱动」正是 Motion-first 体验成立的前提。
 * 事后再补，等于把已经散落各处的写操作全部重写一遍。
 */

import {
  applyEdits,
  invertEdits,
  type Command,
  type Edit,
  type TaskMap,
} from "./edits";

const DEFAULT_LIMIT = 200;

export interface StackListener {
  /** 每次栈发生变化后调用，参数是本次实际落地的 edits（供持久化层写库）。 */
  (edits: Edit[], source: "execute" | "undo" | "redo"): void;
}

export class CommandStack {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private listeners = new Set<StackListener>();

  constructor(
    private tasks: TaskMap,
    private limit = DEFAULT_LIMIT,
  ) {}

  subscribe(fn: StackListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(edits: Edit[], source: "execute" | "undo" | "redo") {
    for (const fn of this.listeners) fn(edits, source);
  }

  /** 执行一条命令。任何新操作都会清空 redo 栈 —— 这是撤销栈的通用语义。 */
  execute(command: Command | null): void {
    if (!command || command.edits.length === 0) return;

    applyEdits(this.tasks, command.edits);
    this.undoStack.push(command);
    this.redoStack.length = 0;

    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.emit(command.edits, "execute");
  }

  undo(): Command | null {
    const command = this.undoStack.pop();
    if (!command) return null;

    const inverse = invertEdits(command.edits);
    applyEdits(this.tasks, inverse);
    this.redoStack.push(command);
    this.emit(inverse, "undo");
    return command;
  }

  redo(): Command | null {
    const command = this.redoStack.pop();
    if (!command) return null;

    applyEdits(this.tasks, command.edits);
    this.undoStack.push(command);
    this.emit(command.edits, "redo");
    return command;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** 用于「⌘Z 撤销「重排 7 个任务」」这样的提示文案 */
  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }

  /**
   * 把最近一条命令与新命令合并成一条。
   *
   * 用于连续型手势：拖动进度手柄时每一帧都产生一次变更，如果每帧压一条命令，
   * 用户撤销一次只退回一帧，得按住 ⌘Z 几十下才回到起点。
   * 合并规则很保守 —— 必须是同一 label、且改的是同一批任务的同一批字段。
   */
  executeOrMerge(command: Command | null): void {
    if (!command || command.edits.length === 0) return;
    const last = this.undoStack.at(-1);

    if (last && last.label === command.label && sameShape(last.edits, command.edits)) {
      applyEdits(this.tasks, command.edits);
      // 保留最早的 before、采用最新的 after，合成一次完整的位移
      last.edits = last.edits.map((prev, i) => {
        const next = command.edits[i];
        if (prev.kind !== "update" || next.kind !== "update") return next;
        return { kind: "update", id: prev.id, before: prev.before, after: next.after };
      });
      this.redoStack.length = 0;
      this.emit(command.edits, "execute");
      return;
    }

    this.execute(command);
  }

  /**
   * 系统自己改的一批数据：照常落地、照常触发落库，但**不进撤销栈**。
   *
   * 目前只有一个用户：跨天时把没关掉的阻碍往后延（store.extendOpenBlockers）。
   * 它不是谁点出来的操作，压进撤销栈只会造成两种坏结果 —— 用户按 ⌘Z
   * 本想撤销自己刚才那次拖拽，结果撤掉的是一次自动延长；或者他真的撤掉了
   * 延长，而下一次跨天检查立刻又把它加回来，撤销键看上去坏了。
   *
   * redo 栈同样不动：这批变更和用户的操作历史不在一条线上。
   */
  applySystem(command: Command | null): void {
    if (!command || command.edits.length === 0) return;
    applyEdits(this.tasks, command.edits);
    this.emit(command.edits, "execute");
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}

/** 两批 edits 是否针对完全相同的任务和字段 —— 合并的前提条件。 */
function sameShape(a: Edit[], b: Edit[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.kind !== "update" || y.kind !== "update") return false;
    if (x.id !== y.id) return false;
    const kx = Object.keys(x.after).sort().join(",");
    const ky = Object.keys(y.after).sort().join(",");
    if (kx !== ky) return false;
  }
  return true;
}
