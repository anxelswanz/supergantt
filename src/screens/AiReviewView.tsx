/**
 * AI 复盘视图。
 *
 * 「复盘」视图回答**差在哪**（算出来的），这里回答**为什么、下次怎么办**
 * （问出来、写出来的）：Claude 读项目数据，问十道题，把回答写成一份可以
 * 发给团队的复盘文档 —— 目标与结果、过程回顾、根因分析、经验沉淀。
 *
 * 这个文件只管摆出来。流程和进程在 aiReview/store.ts（切走视图不中断调用），
 * 数据怎么取、题怎么出、文档怎么拼都在 aiReview/ 下面的纯函数里。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../db/api";
import { resolve } from "../gantt/model";
import { today } from "../gantt/time";
import { useAppStore } from "../store/useAppStore";
import { exportAiReview } from "../export/run";
import { Markdown } from "../aiReview/MarkdownView";
import { maskPlaceholder } from "../aiReview/prompts";
import { buildSnapshot, omittedNote } from "../aiReview/snapshot";
import { progressOf, useAiReviewStore, type Running } from "../aiReview/store";
import {
  EMPTY_BACKGROUND,
  isAnswered,
  questionsOf,
  REVIEW_KIND_LABEL,
  ROUND2_COUNT,
  type Answer,
  type Background,
  type Question,
  type Review,
  type ReviewKind,
  type Stage,
} from "../aiReview/types";
import { ExportButton } from "./ExportButton";
import { Popover } from "./Popover";

const STAGE_LABEL: Record<Stage, string> = {
  ask1: "待出题",
  answer1: "答题中",
  ask2: "待追问",
  answer2: "答题中",
  write: "待生成",
  done: "已完成",
};

const dateOf = (unix: number): string => {
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const PRIMARY =
  "rounded-lg bg-[var(--accent)] px-4 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40";
const GHOST =
  "rounded-lg border border-[var(--rule)] px-3 py-1.5 text-xs text-[var(--text-dim)] transition-colors hover:text-[var(--text)] disabled:pointer-events-none disabled:opacity-40";
const FIELD =
  "w-full rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-3 py-2 text-[13px] leading-relaxed text-[var(--text)] outline-none focus:border-[var(--accent)]";

export function AiReviewView() {
  const project = useAppStore((s) => s.project);
  const reviews = useAiReviewStore((s) => s.reviews);
  const selected = useAiReviewStore((s) => s.selected);
  const loading = useAiReviewStore((s) => s.loading);
  const running = useAiReviewStore((s) => s.running);
  const load = useAiReviewStore((s) => s.load);
  const select = useAiReviewStore((s) => s.select);

  useEffect(() => {
    if (project) void load(project.id);
  }, [project, load]);

  if (!project) return null;
  const current = typeof selected === "number" ? reviews.find((r) => r.id === selected) : undefined;

  return (
    <div className="flex min-h-0 flex-1">
      {/* 历次复盘
          阶段复盘和结项复盘并存，所以是一张清单而不是「当前这一份」 */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-[var(--rule)]">
        <div className="p-3">
          <button
            onClick={() => select("new")}
            className={`w-full rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              selected === "new"
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-[var(--rule)] text-[var(--text)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
            }`}
          >
            + 新的复盘
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {reviews.map((r) => (
            <button
              key={r.id}
              onClick={() => select(r.id)}
              className={`block w-full rounded-lg px-2.5 py-2 text-left transition-colors ${
                selected === r.id ? "bg-[var(--surface-alt)]" : "hover:bg-[var(--row-hover)]"
              }`}
            >
              <div className="truncate text-xs font-medium text-[var(--text)]">{r.title}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--text-dim)]">
                <span>{dateOf(r.createdAt)}</span>
                <span>·</span>
                <span style={r.stage === "done" ? undefined : { color: "var(--accent)" }}>
                  {running[r.id] ? "生成中…" : STAGE_LABEL[r.stage]}
                </span>
              </div>
            </button>
          ))}
          {!loading && reviews.length === 0 && (
            <div className="px-2.5 py-2 text-[10px] leading-relaxed text-[var(--text-dim)]">
              还没有复盘。阶段复盘和结项复盘可以各做一份，互不覆盖。
            </div>
          )}
        </div>
      </aside>

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[820px] p-6">
          {current ? (
            // key：换一份复盘时把答到第几题、编辑框里的草稿这些本地状态一起换掉
            <ReviewPane key={current.id} review={current} projectName={project.name} />
          ) : selected === "new" ? (
            <BackgroundForm projectId={project.id} projectName={project.name} />
          ) : null}
        </div>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 开始前：背景表单                                                    */
/* ------------------------------------------------------------------ */

function BackgroundForm({ projectId, projectName }: { projectId: number; projectName: string }) {
  const reviews = useAiReviewStore((s) => s.reviews);
  const available = useAiReviewStore((s) => s.available);
  const start = useAiReviewStore((s) => s.start);
  const taskCount = useAppStore((s) => s.tasks.size);

  // 目标是项目的属性，不是某一次复盘的 —— 上次填过就带出来，不让人再写一遍。
  // 结果和补充说明不带：那是「这一次」的事
  const [bg, setBg] = useState<Background>(() => ({
    ...EMPTY_BACKGROUND,
    goal: reviews[0]?.background.goal ?? "",
  }));
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const defaultTitle = `${REVIEW_KIND_LABEL[bg.kind]} ${dateOf(Date.now() / 1000)}`;
  const set = (change: Partial<Background>) => setBg((b) => ({ ...b, ...change }));

  if (taskCount === 0) {
    return (
      <div className="grid place-items-center py-24 text-sm text-[var(--text-dim)]">
        还没有任务，复盘无从谈起
      </div>
    );
  }

  const begin = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const app = useAppStore.getState();
      // 落库是防抖的，刚拖完的那一下可能还没写进去 —— 和导出同一个规矩
      await app.persistence?.flush();
      // 折叠是浏览状态，不是项目内容：快照一律展开
      const tasks = resolve([...app.tasks.values()].map((t) => ({ ...t, collapsed: false })));
      // 风险、记录、事项都直接从库里查：事项只有进过事项视图才在 store 里
      const [risks, dailyNotes, itemNotes, itemKinds] = await Promise.all([
        api.loadProjectRisks(projectId),
        api.loadDailyNotes(projectId),
        api.loadItemNotes(projectId),
        api.listItemKinds().catch(() => app.itemKinds),
      ]);
      const snapshot = buildSnapshot({
        projectName,
        tasks,
        people: app.people,
        risks,
        dailyNotes,
        itemNotes,
        itemKinds,
        today: today(),
      });
      await start(projectId, title.trim() || defaultTitle, bg, snapshot);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-[var(--text)]">AI 复盘</h2>
        <p className="mt-1 text-xs leading-relaxed text-[var(--text-dim)]">
          Claude 读完项目的排期、受阻、风险和记录后问你 10 道题，再写成一份复盘文档。
        </p>
      </div>

      {available === false && (
        <Notice tone="warn">
          没有找到 <code>claude</code>。安装并登录 Claude Code 后重新打开这个视图。已有的复盘仍可查看和导出。
        </Notice>
      )}

      <Field label="复盘类型">
        <div className="inline-flex gap-1 rounded-full bg-[var(--surface-alt)] p-1">
          {(["final", "stage"] as ReviewKind[]).map((k) => (
            <button
              key={k}
              onClick={() => set({ kind: k })}
              className={`rounded-[var(--r-m)] px-3 py-1 text-xs transition-colors ${
                bg.kind === k
                  ? "bg-[var(--surface)] font-medium text-[var(--text)] shadow-sm"
                  : "text-[var(--text-dim)] hover:text-[var(--text)]"
              }`}
            >
              {REVIEW_KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <Hint>
          {bg.kind === "stage"
            ? "项目还在进行：没做完的任务不算失败，文档会侧重下一阶段怎么调整。"
            : "项目已经结束：文档会侧重目标达成了多少、哪些经验能带到下一个项目。"}
        </Hint>
      </Field>

      <Field label="项目目标与成功标准" required>
        <textarea
          value={bg.goal}
          onChange={(e) => set({ goal: e.target.value })}
          rows={3}
          placeholder="这个项目原本要达成什么？怎样算成功？例：9 月底前新产线投产，良率不低于 95%，预算不超 300 万。"
          className={FIELD}
        />
        <Hint>排期数据里没有「目标」，这一项只有你知道。复盘的第一章就是拿结果对照它。</Hint>
      </Field>

      <Field label="实际结果">
        <textarea
          value={bg.outcome}
          onChange={(e) => set({ outcome: e.target.value })}
          rows={3}
          placeholder="到现在为止实际达成了什么？例：10 月 12 日投产，晚了两周；良率 93%；预算持平。"
          className={FIELD}
        />
      </Field>

      <Field label="补充说明">
        <textarea
          value={bg.extra}
          onChange={(e) => set({ extra: e.target.value })}
          rows={2}
          placeholder="可选。想重点聊哪一段、有什么背景是数据里看不出来的。"
          className={FIELD}
        />
      </Field>

      <Field label="标题">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={defaultTitle}
          className={FIELD}
        />
      </Field>

      {error && <Notice tone="error">{error}</Notice>}

      <div className="flex items-center gap-3">
        <button
          onClick={() => void begin()}
          disabled={busy || available === false || bg.goal.trim() === ""}
          className={PRIMARY}
        >
          {busy ? "正在准备…" : "开始复盘"}
        </button>
        <span className="text-[10px] leading-relaxed text-[var(--text-dim)]">
          项目数据（任务名、负责人、记录内容）会经由本机登录的 Claude Code 发送给 Anthropic，
          用于出题和撰写文档。
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 一份复盘                                                            */
/* ------------------------------------------------------------------ */

function ReviewPane({ review, projectName }: { review: Review; projectName: string }) {
  const run = useAiReviewStore((s) => s.running[review.id]);
  const error = useAiReviewStore((s) => s.errors[review.id]);
  const advance = useAiReviewStore((s) => s.advance);
  const available = useAiReviewStore((s) => s.available);

  const omitted = omittedNote(review.snapshot);
  const waiting = review.stage === "ask1" || review.stage === "ask2" || review.stage === "write";

  return (
    <div className="space-y-5">
      <PaneHeader review={review} />

      {omitted && review.stage !== "done" && (
        <Notice tone="info">
          这个项目的记录比较多，分析时只带入了最重要的部分（未带入：{omitted}）。
          汇总数字仍按全量计算。
        </Notice>
      )}

      {error && <Notice tone="error">{error}</Notice>}

      {run ? (
        <RunningPane id={review.id} run={run} />
      ) : waiting ? (
        // 调用失败、被取消，或者上次关应用时正跑到一半：都停在这里，原地再来一次
        <div className="rounded-xl border border-dashed border-[var(--rule)] px-4 py-8 text-center">
          <div className="text-xs text-[var(--text-dim)]">
            {review.stage === "write" ? "题目已经答完，文档还没生成。" : "这一步还没完成。"}
            已经填写和回答的内容都保存着。
          </div>
          <button
            onClick={() => void advance(review.id)}
            disabled={available === false}
            className={`${PRIMARY} mt-3`}
          >
            {review.stage === "write" ? "生成文档" : review.stage === "ask2" ? "继续：准备追问" : "继续：准备问题"}
          </button>
        </div>
      ) : review.stage === "done" ? (
        <DocumentPane review={review} projectName={projectName} />
      ) : (
        <QuestionPane review={review} />
      )}
    </div>
  );
}

function PaneHeader({ review }: { review: Review }) {
  const rename = useAiReviewStore((s) => s.rename);
  const remove = useAiReviewStore((s) => s.remove);
  const [title, setTitle] = useState(review.title);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (title.trim()) void rename(review.id, title);
            else setTitle(review.title);
          }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="w-full truncate bg-transparent text-lg font-semibold text-[var(--text)] outline-none"
        />
        <div className="mt-0.5 text-[10px] text-[var(--text-dim)]">
          {REVIEW_KIND_LABEL[review.background.kind]}，数据截至 {review.snapshot.takenOn}，共{" "}
          {review.snapshot.summary.leafCount} 条任务
        </div>
      </div>
      {confirming ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-[10px] text-[var(--text-dim)]">问答和文档都会删掉</span>
          <button
            onClick={() => void remove(review.id)}
            className="rounded-lg bg-[var(--danger)] px-2.5 py-1 text-[11px] font-medium text-white"
          >
            确认删除
          </button>
          <button onClick={() => setConfirming(false)} className={GHOST}>
            取消
          </button>
        </div>
      ) : (
        <button onClick={() => setConfirming(true)} className={`${GHOST} shrink-0`}>
          删除
        </button>
      )}
    </div>
  );
}

function RunningPane({ id, run }: { id: number; run: Running }) {
  const cancel = useAiReviewStore((s) => s.cancel);
  const bottom = useRef<HTMLDivElement>(null);

  // 文档一边写一边跟到底。测试环境（jsdom）没有 scrollIntoView
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [run.text]);

  return (
    <div>
      <div className="flex items-center gap-3 rounded-xl border border-[var(--rule)] bg-[var(--surface-alt)] px-4 py-3">
        <span className="size-2 shrink-0 animate-pulse rounded-full bg-[var(--accent)]" />
        <span className="flex-1 text-xs text-[var(--text)]">{run.label}</span>
        <span className="text-[10px] text-[var(--text-dim)]">可以先去别的视图，这里会继续</span>
        <button onClick={() => cancel(id)} className={GHOST}>
          取消
        </button>
      </div>
      {run.text && (
        <div className="mt-5 opacity-80">
          <Markdown source={maskPlaceholder(run.text)} />
          <div ref={bottom} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 答题                                                                */
/* ------------------------------------------------------------------ */

const EMPTY_ANSWER: Answer = { picked: [], text: "", skipped: false };

function QuestionPane({ review }: { review: Review }) {
  const setAnswer = useAiReviewStore((s) => s.setAnswer);
  const submitRound = useAiReviewStore((s) => s.submitRound);

  const { round, total, offset } = progressOf(review, ROUND2_COUNT);
  const list = useMemo(() => questionsOf(review.questions, round), [review.questions, round]);

  // 回来接着答：从第一道没答的开始；都答了就停在最后一道（那里有提交按钮）
  const [index, setIndex] = useState(() => {
    const first = list.findIndex((q) => !isAnswered(q));
    return first < 0 ? Math.max(0, list.length - 1) : first;
  });
  const q: Question | undefined = list[Math.min(index, list.length - 1)];

  // 输入框的字先留在本地：每敲一个字就写一次库没有意义。离开这道题时再存
  const [draft, setDraft] = useState(q?.answer?.text ?? "");
  useEffect(() => {
    setDraft(q?.answer?.text ?? "");
    // 只在换题时重置。同一题内 answer 会随点选变化，那时不能把正在打的字冲掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q?.id]);

  if (!q) return null;

  const answer = q.answer ?? EMPTY_ANSWER;
  const last = index >= list.length - 1;
  const number = offset + index + 1;

  const commit = (change: Partial<Answer>) =>
    setAnswer(review.id, q.id, { ...answer, text: draft, skipped: false, ...change });

  const toggle = (i: number) => {
    const has = answer.picked.includes(i);
    const picked = q.multi
      ? has
        ? answer.picked.filter((p) => p !== i)
        : [...answer.picked, i].sort((a, b) => a - b)
      : has
        ? []
        : [i];
    commit({ picked });
  };

  const saveDraft = () => {
    if (draft !== answer.text) commit({});
  };

  const go = (to: number) => {
    saveDraft();
    setIndex(Math.max(0, Math.min(list.length - 1, to)));
  };

  const next = () => {
    saveDraft();
    if (last) void submitRound(review.id);
    else setIndex(index + 1);
  };

  const skip = () => {
    setAnswer(review.id, q.id, { picked: [], text: "", skipped: true });
    setDraft("");
    if (last) void submitRound(review.id);
    else setIndex(index + 1);
  };

  const hasContent = answer.picked.length > 0 || draft.trim() !== "";

  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="text-xs font-medium tabular-nums text-[var(--text)]">
          {number} / {total}
        </span>
        <div className="h-1 flex-1 overflow-hidden rounded-[var(--r-m)] bg-[var(--surface-alt)]">
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
            style={{ width: `${(number / total) * 100}%` }}
          />
        </div>
        <span className="text-[10px] text-[var(--text-dim)]">
          {round === 1 ? "首轮" : "追问"}：{q.topic}
        </span>
      </div>

      <div className="mt-6">
        <h3 className="text-base leading-snug font-semibold text-[var(--text)] select-text">{q.title}</h3>
        {q.why && <p className="mt-1.5 text-xs leading-relaxed text-[var(--text-dim)] select-text">{q.why}</p>}
        <div className="mt-1 text-[10px] text-[var(--text-dim)]">
          {q.multi ? "可多选" : "单选"}，也可以不选、直接在下面写
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {q.options.map((opt, i) => {
          const on = answer.picked.includes(i);
          return (
            <button
              key={i}
              onClick={() => toggle(i)}
              aria-pressed={on}
              className="flex w-full items-start gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors"
              style={
                on
                  ? {
                      borderColor: "var(--accent)",
                      background: "color-mix(in srgb, var(--accent) 8%, transparent)",
                    }
                  : { borderColor: "var(--rule)" }
              }
            >
              <span
                className={`mt-[3px] grid size-3.5 shrink-0 place-items-center border text-[9px] leading-none text-white ${
                  q.multi ? "rounded-[3px]" : "rounded-full"
                }`}
                style={
                  on
                    ? { borderColor: "var(--accent)", background: "var(--accent)" }
                    : { borderColor: "var(--text-dim)" }
                }
              >
                {on ? "✓" : ""}
              </span>
              <span className="text-[13px] leading-relaxed text-[var(--text)]">{opt}</span>
            </button>
          );
        })}
      </div>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={saveDraft}
        rows={3}
        placeholder={
          answer.picked.length > 0 ? "补充一句：具体是什么情况、有什么前提（可选）" : "都不准确？直接写你的答案"
        }
        className={`${FIELD} mt-3`}
      />

      <div className="mt-4 flex items-center gap-2">
        <button onClick={() => go(index - 1)} disabled={index === 0} className={GHOST}>
          上一题
        </button>
        <button onClick={skip} className={GHOST} title="文档里会如实写成「未回答」，不会替你编">
          跳过
        </button>
        <span className="flex-1" />
        {answer.skipped && !hasContent && (
          <span className="text-[10px] text-[var(--text-dim)]">这题已跳过</span>
        )}
        <button onClick={next} disabled={!hasContent && !answer.skipped} className={PRIMARY}>
          {!last ? "下一题" : round === 1 ? "提交，看追问" : "提交，生成文档"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 文档                                                                */
/* ------------------------------------------------------------------ */

function DocumentPane({ review, projectName }: { review: Review; projectName: string }) {
  const saveDocument = useAiReviewStore((s) => s.saveDocument);
  const regenerate = useAiReviewStore((s) => s.regenerate);
  const available = useAiReviewStore((s) => s.available);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(review.document);
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenAnchor, setRegenAnchor] = useState<HTMLElement | null>(null);
  const [instruction, setInstruction] = useState("");

  // 重新生成之后文档整个换了，编辑框里那份旧草稿不能留着
  useEffect(() => {
    setDraft(review.document);
  }, [review.document]);

  const dirty = draft !== review.document;
  const finishEdit = () => {
    void saveDocument(review.id, draft);
    setEditing(false);
  };

  // 导出的是眼前这一版：正在编辑就是编辑框里的，不是上次存的
  const exportAs = (format: "md" | "docx") => () =>
    exportAiReview(format, { projectName, title: review.title, markdown: editing ? draft : review.document });

  return (
    <div>
      <div className="sticky top-0 z-10 -mx-6 flex items-center gap-2 border-b border-[var(--rule)] bg-[var(--surface)] px-6 py-2">
        {editing ? (
          <>
            <button onClick={finishEdit} className={PRIMARY}>
              完成编辑
            </button>
            <span className="text-[10px] text-[var(--text-dim)]">
              {dirty ? "有未保存的修改，离开输入框或点「完成编辑」时保存" : "Markdown 源码，改完即存"}
            </span>
          </>
        ) : (
          <>
            <button onClick={() => setEditing(true)} className={GHOST}>
              编辑
            </button>
            <button
              ref={setRegenAnchor}
              onClick={() => setRegenOpen((v) => !v)}
              disabled={available === false}
              className={GHOST}
            >
              重新生成
            </button>
          </>
        )}
        <span className="flex-1" />
        <ExportButton
          label="下载"
          title="把这份复盘文档存到本地"
          formats={[
            { label: "Word 文档 (.docx)", hint: "发给别人、打印", run: exportAs("docx") },
            { label: "Markdown (.md)", hint: "放进知识库、继续编辑", run: exportAs("md") },
          ]}
        />
      </div>

      <Popover anchor={regenAnchor} open={regenOpen} onClose={() => setRegenOpen(false)} width={320}>
        <div className="space-y-2 p-3">
          <div className="text-xs font-medium text-[var(--text)]">用同一批回答重写整份文档</div>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={3}
            autoFocus
            placeholder="可选：对这一版有什么要求？例：失败归因写短一点；SOP 部分再具体些。"
            className={FIELD}
          />
          <div className="text-[10px] leading-relaxed text-[var(--danger)]">
            会覆盖现在这份文档，包括你手动改过的地方。要留底请先下载。
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setRegenOpen(false)} className={GHOST}>
              取消
            </button>
            <button
              onClick={() => {
                setRegenOpen(false);
                void regenerate(review.id, instruction);
                setInstruction("");
              }}
              className={PRIMARY}
            >
              重新生成
            </button>
          </div>
        </div>
      </Popover>

      <div className="pt-5">
        {editing ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void saveDocument(review.id, draft)}
            spellCheck={false}
            className={`${FIELD} min-h-[60vh] resize-y font-mono text-xs`}
          />
        ) : (
          <Markdown source={review.document} />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 小零件                                                              */
/* ------------------------------------------------------------------ */

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-[var(--text)]">
        {label}
        {required && <span className="ml-1 text-[var(--danger)]">*</span>}
      </div>
      {children}
    </div>
  );
}

const Hint = ({ children }: { children: React.ReactNode }) => (
  <div className="mt-1.5 text-[10px] leading-relaxed text-[var(--text-dim)]">{children}</div>
);

function Notice({ tone, children }: { tone: "info" | "warn" | "error"; children: React.ReactNode }) {
  const color = tone === "error" ? "var(--danger)" : tone === "warn" ? "#f59e0b" : "var(--text-dim)";
  return (
    <div
      className="rounded-lg border px-3 py-2 text-xs leading-relaxed select-text"
      style={{
        borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
        background: `color-mix(in srgb, ${color} 7%, transparent)`,
        color: tone === "info" ? "var(--text-dim)" : color,
      }}
    >
      {children}
    </div>
  );
}
