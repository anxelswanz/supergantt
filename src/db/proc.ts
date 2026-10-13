/**
 * 子进程输出的分发。
 *
 * Rust 那边所有子进程的输出都走同一个 `plugin-proc` 事件，按 run id 区分
 * （src-tauri/src/plugin_host.rs 的 spawn_piped）。起进程的有两家：插件
 * （plugins/registry.ts）和内置的 AI 复盘（aiReview/claude.ts）。
 *
 * 分发表必须只有一份。两家各听各的话，每一家都会把对方的事件当成「run id
 * 还没登记的早到事件」攒起来等人认领 —— 而那个人永远不会来，一份复盘文档的
 * 几千行流式输出就这么一直留在内存里。
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
/**
 * 事件在 spawn 返回 run id **之前**就可能到达（短命令几毫秒就跑完）。
 * 那时还不知道该交给谁，先攒着，登记回调时一次放出来。
 */
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

/**
 * 全局只监听一次。**必须在起进程之前 await** —— 监听还没挂上时到达的事件
 * 是真的丢了，不是早到。
 */
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
