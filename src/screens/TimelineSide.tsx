/** 时间线右栏：任务履历，数据来自 core/timeline.buildCareers */

import type { Career } from "../core/timeline";
import { dayToIso } from "../gantt/time";

const DONE = "#10b981";
const STUCK = "var(--danger)";
const LIVE = "var(--accent)";

const md = (day: number) => dayToIso(day).slice(5);

const tint = (color: string, pct: number) =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`;

interface Props {
  careers: Career[];
  /** 点日期，左边流水滚到那天 */
  onJump: (day: number) => void;
  onOpen: (taskId: number) => void;
}

export function TimelineSide({ careers, onJump, onOpen }: Props) {
  const live = careers.filter((c) => c.end == null).length;
  // 各任务受阻天数相加，即人天，不是日历天数
  const stuck = careers.reduce((sum, c) => sum + c.blockedDays, 0);

  return (
    <div className="px-7 pb-16 pt-7">
      {/* 尺寸与左边流水一致，两栏横线水平对齐 */}
      <div className="mb-4">
        <h3 className="text-[19px] font-semibold leading-tight tracking-tight text-[var(--text)]">
          任务履历
        </h3>
        <p className="mt-1 text-[11px] text-[var(--text-dim)]">
          每条任务从开工到完成，中间受阻几天
        </p>
      </div>

      <div className="mb-6 flex min-h-9 items-center gap-x-3 border-y border-[var(--rule)] py-1.5 font-mono text-[11px] tabular-nums text-[var(--text-dim)]">
        <span className="flex items-center gap-1.5">
          <span className="size-[6px] rounded-full" style={{ background: LIVE }} />
          进行中
          <b className="font-semibold text-[var(--text)]">{live}</b>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-[6px] rotate-45 rounded-[1.5px]" style={{ background: DONE }} />
          已完成
          <b className="font-semibold text-[var(--text)]">{careers.length - live}</b>
        </span>
        {stuck > 0 && (
          <span className="ml-auto" style={{ color: STUCK }}>
            累计受阻 {stuck} 天
          </span>
        )}
      </div>

      {careers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--rule)] px-3 py-8 text-center text-[11px] leading-relaxed text-[var(--text-dim)]">
          还没有开工的任务。
          <br />
          填写实施开始日后会出现在这里。
        </div>
      ) : (
        <Cards careers={careers} onJump={onJump} onOpen={onOpen} />
      )}
    </div>
  );
}

function Cards({ careers, onJump, onOpen }: Props) {
  return (
    <div className="space-y-2">
      {careers.map((c) => {
        const done = c.end != null;
        const color = done ? DONE : LIVE;
        return (
          <div
            key={c.task.id}
            className="rounded-xl border border-[var(--rule)] bg-[var(--surface-alt)] px-3.5 py-3 transition-colors hover:border-[color-mix(in_srgb,var(--text-dim)_45%,transparent)]"
          >
            <div className="flex items-center gap-2">
              <span
                className={`size-[7px] shrink-0 ${done ? "rotate-45 rounded-[1.5px]" : "rounded-full"}`}
                style={{ background: color }}
              />
              <button
                onClick={() => onOpen(c.task.id)}
                className="min-w-0 truncate text-[13px] font-medium text-[var(--text)] hover:underline"
              >
                {c.task.name || "未命名"}
              </button>
              <span
                className="ml-auto shrink-0 font-mono text-[10px] tabular-nums"
                style={{ color: done ? "var(--text-dim)" : color }}
              >
                {done ? `${c.days} 天` : `第 ${c.days} 天`}
              </span>
            </div>

            {/* 时间轴：左端开工，右端完成或今天，红色是受阻的那几天 */}
            <div
              className="relative mt-2.5 h-[5px] overflow-hidden rounded-full"
              style={{
                background: done
                  ? color
                  : // 未完成的右端渐隐，避免被读成终点
                    `linear-gradient(90deg, ${color} 55%, ${tint(color, 25)})`,
              }}
            >
              {c.blocked.map((b, i) => (
                <span
                  key={i}
                  className="absolute inset-y-0"
                  style={{
                    left: `${((b.from - c.start) / c.days) * 100}%`,
                    width: `${((b.to - b.from + 1) / c.days) * 100}%`,
                    background: STUCK,
                  }}
                />
              ))}
            </div>

            <div className="mt-2 flex items-center gap-1 font-mono text-[10px] tabular-nums text-[var(--text-dim)]">
              <JumpDate day={c.start} onJump={onJump} title="跳到开工那天" />
              <span className="opacity-50">→</span>
              {done ? (
                <JumpDate day={c.until} onJump={onJump} title="跳到完成那天" />
              ) : (
                <span>
                  进行中
                  {c.task.progress > 0 && ` ${Math.round(c.task.progress * 100)}%`}
                </span>
              )}
              {c.blockedDays > 0 && (
                <span className="ml-auto" style={{ color: STUCK }}>
                  受阻 {c.blockedDays} 天
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function JumpDate({
  day,
  onJump,
  title,
}: {
  day: number;
  onJump: (day: number) => void;
  title: string;
}) {
  return (
    <button
      onClick={() => onJump(day)}
      title={title}
      className="rounded px-0.5 transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--accent)]"
    >
      {md(day)}
    </button>
  );
}
