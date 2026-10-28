/**
 * 所有子进程输出共用 `plugin-proc` 事件（plugin_host.rs spawn_piped），插件和 AI 复盘都走这里。
 * 分发表必须只有一份，否则各自会把对方的事件当早到事件攒着，永不释放。
 */

import { listen } from "@tauri-apps/api/event";

interface ProcEvent {
  run_id: number;
  kind: "stdout" | "stderr" | "exit" | "error";
  data: string;
}

export interface RunHandlers {
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  /** code 为 null 表示被信号杀掉或出错 */
  finish: (code: number | null) => void;
}

const runs = new Map<number, RunHandlers>();
/** 事件可能在 spawn 返回 run id 之前到达，先攒着，attachRun 时补发。 */
const early = new Map<number, ProcEvent[]>();
let listening: Promise<void> | null = null;

function dispatch(ev: ProcEvent) {
  const h = runs.get(ev.run_id);
  if (!h) {
    const list = early.get(ev.run_id) ?? [];
    list.push(ev);
    early.set(ev.run_id, list);
    return;
  }
  try {
    if (ev.kind === "stdout") h.onStdout?.(ev.data);
    else if (ev.kind === "stderr") h.onStderr?.(ev.data);
    else {
      if (ev.kind === "error") h.onStderr?.(ev.data);
      if (ev.kind === "exit") {
        runs.delete(ev.run_id);
        const n = Number(ev.data);
        h.finish(Number.isFinite(n) ? n : null);
      }
    }
  } catch (e) {
    // 回调抛错不能把事件分发打断，否则后面的行都丢了
    console.warn(`[proc] 子进程回调抛错：${e}`);
  }
}

/** 全局只监听一次；必须在起进程之前 await，否则监听挂上前的事件直接丢。 */
export function ensureProcListener(): Promise<void> {
  listening ??= listen<ProcEvent>("plugin-proc", (e) => dispatch(e.payload)).then(() => {});
  return listening;
}

/** 给一个 run id 登记回调，并把它早到的事件补发出来 */
export function attachRun(runId: number, handlers: RunHandlers): void {
  runs.set(runId, handlers);
  for (const ev of early.get(runId) ?? []) dispatch(ev);
  early.delete(runId);
}
