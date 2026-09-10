/**
 * 时间线视图：按天倒序的项目流水。
 *
 * 甘特按任务组织，这里按日期组织 —— 回答的是"那天到底怎么了"。
 * 聚合规则全在 core/timeline.ts，这里只负责摆出来和写入。
 *
 * 写入口有两个，都落到同一张 daily_notes 表：
 *   · 这里的「记一笔」
 *   · 甘特条上右键某一天（见 GanttView 的 onContextMenu）
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { buildTimeline, type TimelineEvent } from "../core/timeline";
import { resolve } from "../gantt/model";
import { dayToIso, isoToDay, today } from "../gantt/time";
import { useAppStore } from "../store/useAppStore";
import { api, type Risk } from "../db/api";
import { ExportButton } from "./ExportButton";
import { shortcut } from "../core/keys";

const KIND_STYLE: Record<
  TimelineEvent["kind"],
  { dot: string; label: string }
> = {
  start: { dot: "var(--accent)", label: "开工" },
  finish: { dot: "#10b981", label: "完成" },
  blocked: { dot: "#f43f5e", label: "受阻" },
  risk: { dot: "#f59e0b", label: "风险" },
  note: { dot: "var(--text-dim)", label: "记录" },
};

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function TimelineView() {
  const taskMap = useAppStore((s) => s.tasks);
  const revision = useAppStore((s) => s.revision);
  const project = useAppStore((s) => s.project);
  const notes = useAppStore((s) => s.dailyNotes);
  const removeDailyNote = useAppStore((s) => s.removeDailyNote);
  const openDetail = useAppStore((s) => s.openDetail);
  const noteDraft = useAppStore((s) => s.noteDraft);
  const setNoteDraft = useAppStore((s) => s.setNoteDraft);

  const [risks, setRisks] = useState<Risk[]>([]);

  useEffect(() => {
    if (!project) return;
    void api.loadProjectRisks(project.id).then(setRisks).catch(() => setRisks([]));
  }, [project, revision]);

  const tasks = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => resolve([...taskMap.values()].map((t) => ({ ...t, collapsed: false }))),
    [taskMap, revision],
  );

  const days = useMemo(
    () => buildTimeline(tasks, notes, risks),
    [tasks, notes, risks],
  );

  const todayDay = today();

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[760px] p-6">
        <div className="mb-4 flex items-center gap-3">
          <h2 className="text-sm font-semibold text-[var(--text)]">逐日流水</h2>
          <span className="text-[10px] text-[var(--text-dim)]">
            开工、完成、受阻、风险、当日记录，都落在它们发生的那天
          </span>
          {/* 时间线自己的出口：Excel 那份是按任务排的排期表，
              一段段人写的话塞进单元格只会被截断。HTML 单文件、零外部请求，
              发到群里或存进共享盘都能直接打开 */}
          <div className="ml-auto flex items-center gap-2">
            <ExportButton
              label="⤓ 导出 HTML"
              title="把这条时间线导出成一份可以直接转发的网页"
              size="sm"
              run={async () => (await import("../export/run")).exportTimelineToHtml()}
            />
            <button
              onClick={() => setNoteDraft({ taskId: null, day: todayDay })}
              className="rounded-full px-3 py-1 text-xs font-medium text-white"
              style={{ background: "var(--accent)" }}
            >
              记一笔
            </button>
          </div>
        </div>

        {noteDraft && <Composer />}

        {days.length === 0 && !noteDraft && (
          <div className="rounded-xl border border-dashed border-[var(--rule)] px-4 py-10 text-center text-xs text-[var(--text-dim)]">
            还没有任何记录。
            <br />
            拖甘特条开工、在看板里把卡片拖进「卡住」，或者直接「记一笔」。
          </div>
        )}

        <div className="space-y-5">
          {days.map((d) => {
            const date = new Date(Date.parse(`${d.iso}T00:00:00Z`));
            const isToday = d.day === todayDay;
            return (
              <div key={d.iso} className="flex gap-4">
                {/* 日期列固定宽度，右边的内容才能对齐成一条真正的"线" */}
                <div className="w-24 shrink-0 pt-0.5 text-right">
                  <div
                    className="text-xs font-semibold"
                    style={{ color: isToday ? "var(--accent)" : "var(--text)" }}
                  >
                    {d.iso.slice(5)}
                    {isToday && " · 今天"}
                  </div>
                  <div className="text-[10px] text-[var(--text-dim)]">
                    {WEEKDAYS[date.getUTCDay()]} · {d.iso.slice(0, 4)}
                  </div>
                </div>

                <div className="relative flex-1 border-l border-[var(--rule)] pb-1 pl-4">
                  <div className="space-y-1.5">
                    {d.events.map((e) => (
                      <Event
                        key={e.key}
                        event={e}
                        onOpen={() => e.task && openDetail(e.task.id)}
                        onEdit={() =>
                          e.note &&
                          setNoteDraft({
                            id: e.note.id,
                            taskId: e.note.taskId,
                            day: isoToDay(e.note.day),
                            content: e.note.content,
                          })
                        }
                        onDelete={() => e.note && void removeDailyNote(e.note.id)}
                      />
                    ))}
                  </div>

                  <button
                    onClick={() => setNoteDraft({ taskId: null, day: d.day })}
                    className="mt-1 text-[10px] text-[var(--text-dim)] transition-colors hover:text-[var(--accent)]"
                  >
                    ＋ 给这天记一笔
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Event({
  event,
  onOpen,
  onEdit,
  onDelete,
}: {
  event: TimelineEvent;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const style = KIND_STYLE[event.kind];
  const editable = event.note != null;

  return (
    <div className="group relative -ml-[21px] flex items-start gap-2 rounded-lg py-0.5 pl-[21px] hover:bg-[var(--row-hover)]">
      <span
        className="absolute left-[-3.5px] top-[7px] size-[7px] rounded-full ring-2"
        style={{ background: style.dot, boxShadow: "0 0 0 2px var(--surface)" }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span
            className="text-[10px] font-medium"
            style={{ color: style.dot }}
          >
            {style.label}
          </span>
          {event.task && (
            <button
              onClick={onOpen}
              className="text-xs font-medium text-[var(--text)] hover:underline"
            >
              {event.task.name || "未命名"}
            </button>
          )}
          {!event.task && (
            <span className="text-[10px] text-[var(--text-dim)]">全项目</span>
          )}
          {event.days != null && event.days > 1 && (
            <span className="text-[10px] text-[#f43f5e]">共 {event.days} 天</span>
          )}
          {event.unresolved && (
            <span
              className="rounded px-1 text-[9px] font-semibold leading-none text-white"
              style={{ background: "#f43f5e" }}
              title="这条阻碍还没关掉，天数每天还在长"
            >
              未关闭
            </span>
          )}
          {event.backdated && (
            <span
              className="text-[10px] text-[var(--text-dim)]"
              title="写下的日子晚于它所说的日子"
            >
              事后补记
            </span>
          )}
        </div>
        {/* 开工/完成没有正文，标题行已经说完了 */}
        {event.kind !== "start" && event.kind !== "finish" && (
          <div className="text-xs leading-snug whitespace-pre-wrap text-[var(--text-dim)]">
            {event.text}
          </div>
        )}
      </div>

      {editable && (
        <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={onEdit}
            className="rounded px-1.5 py-0.5 text-[10px] text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            改
          </button>
          <button
            onClick={onDelete}
            className="rounded px-1.5 py-0.5 text-[10px] text-[var(--text-dim)] hover:text-[#f43f5e]"
          >
            删
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 记一笔。
 *
 * 挂不挂任务是可选的 —— 「今天下雨全场停工」不属于任何一条活，硬塞给某个任务
 * 会让它在复盘里被算到那条活头上。
 */
function Composer() {
  const draft = useAppStore((s) => s.noteDraft)!;
  const setNoteDraft = useAppStore((s) => s.setNoteDraft);
  const addDailyNote = useAppStore((s) => s.addDailyNote);
  const editDailyNote = useAppStore((s) => s.editDailyNote);
  const taskMap = useAppStore((s) => s.tasks);

  const [text, setText] = useState(draft.content ?? "");
  const [day, setDay] = useState(dayToIso(draft.day));
  const [taskId, setTaskId] = useState<number | null>(draft.taskId);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setText(draft.content ?? "");
    setDay(dayToIso(draft.day));
    setTaskId(draft.taskId);
    ref.current?.focus();
  }, [draft]);

  const leaves = useMemo(
    () => [...taskMap.values()].filter((t) => ![...taskMap.values()].some((c) => c.parentId === t.id)),
    [taskMap],
  );

  const submit = () => {
    if (!text.trim()) return;
    if (draft.id != null) void editDailyNote(draft.id, day, text);
    else void addDailyNote(taskId, day, text);
    setNoteDraft(null);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-5 rounded-xl border border-[var(--accent)] bg-[var(--surface-alt)] p-3"
    >
      <div className="mb-2 flex items-center gap-2">
        <input
          type="date"
          value={day}
          onChange={(e) => e.target.value && setDay(e.target.value)}
          className="rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)]"
        />
        <select
          value={taskId ?? ""}
          onChange={(e) => setTaskId(e.target.value ? Number(e.target.value) : null)}
          disabled={draft.id != null}
          className="min-w-0 flex-1 rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)] disabled:opacity-50"
        >
          <option value="">不挂任务（全项目）</option>
          {leaves.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name || "未命名"}
            </option>
          ))}
        </select>
      </div>

      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setNoteDraft(null);
          // ⌘Enter 提交：这是个多行输入框，裸 Enter 必须留给换行
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
        rows={3}
        placeholder="这天发生了什么？例如：三号机主轴异响，停了半天等维修"
        className="w-full resize-none rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-2 text-xs leading-relaxed text-[var(--text)] outline-none focus:border-[var(--accent)]"
      />

      <div className="mt-2 flex items-center gap-2">
        <span className="text-[10px] text-[var(--text-dim)]">{shortcut("mod", "Enter")} 保存 · Esc 取消</span>
        <button
          onClick={() => setNoteDraft(null)}
          className="ml-auto rounded-lg px-3 py-1 text-xs text-[var(--text-dim)] hover:text-[var(--text)]"
        >
          取消
        </button>
        <button
          onClick={submit}
          disabled={!text.trim()}
          className="rounded-lg px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
          style={{ background: "var(--accent)" }}
        >
          保存
        </button>
      </div>
    </motion.div>
  );
}
