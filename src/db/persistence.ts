/**
 * 命令栈 → SQLite：每条命令防抖后整项目单事务写回，磁盘上不存在半写状态。
 * 崩溃最多丢 FLUSH_DELAY 的编辑，所以失焦/关闭前强制冲刷。
 */

import type { CommandStack } from "../core/commandStack";
import type { TaskMap } from "../core/edits";
import { api, type DependencyRow, type TaskRow } from "./api";
import { taskToRow } from "./convert";

const FLUSH_DELAY = 400;

export class Persistence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private pending = false;
  private unsubscribe: (() => void) | null = null;

  /** 最近一次从库里读到的原始行，用于保留渲染模型里没有的字段（note / sortOrder） */
  private rowCache = new Map<number, TaskRow>();

  /** 落库失败时对外暴露，让 UI 能显示「未保存」而不是假装一切正常 */
  lastError: unknown = null;

  constructor(
    private projectId: number,
    private tasks: TaskMap,
    private dependencies: () => DependencyRow[],
  ) {}

  primeRowCache(rows: TaskRow[]) {
    this.rowCache = new Map(rows.map((r) => [r.id, r]));
  }

  attach(stack: CommandStack) {
    this.detach();
    // 撤销/重做也要落库，否则重启后回到撤销前
    this.unsubscribe = stack.subscribe(() => this.schedule());
  }

  detach() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private schedule() {
    this.pending = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), FLUSH_DELAY);
  }

  /** 立即写入；切换项目前必须 await。 */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pending) return;

    // 上一次写入还没回来就先等它，避免两次全量替换交错
    if (this.inFlight) {
      await this.inFlight.catch(() => {});
      if (!this.pending) return;
    }

    this.pending = false;
    const rows = [...this.tasks.values()].map((t) =>
      taskToRow(t, this.rowCache.get(t.id)),
    );

    this.inFlight = api
      .saveProject(this.projectId, rows, this.dependencies())
      .then(() => {
        this.lastError = null;
        this.primeRowCache(rows);
      })
      .catch((err) => {
        this.lastError = err;
        // 标记回待写，下次操作或手动冲刷时重试
        this.pending = true;
        throw err;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  get hasUnsaved(): boolean {
    return this.pending || this.inFlight !== null;
  }
}

export function installFlushGuards(persistence: Persistence) {
  const flush = () => void persistence.flush().catch(() => {});
  window.addEventListener("blur", flush);
  window.addEventListener("beforeunload", flush);
  return () => {
    window.removeEventListener("blur", flush);
    window.removeEventListener("beforeunload", flush);
  };
}
