/**
 * AI 复盘的状态与流程。
 *
 * 单独一个 store，不进 useAppStore：那边管的是任务数据和命令栈（「任务数据
 * 只能经由命令栈修改」），这里的东西和它没有交集 —— 复盘只**读**项目数据，
 * 而且读的是开始那一刻冻结下来的快照。
 *
 * ## 进程在这里，不在组件里
 *
 * 一次模型调用要等十几秒到一两分钟。用户会切去看甘特、看「复盘」视图里的
 * 数字，再回来 —— 组件卸载了，调用不能跟着断。所以进程句柄和流式文本都挂在
 * 这个 store 上，结果由这里写库；组件只是它的一个观察者。
 *
 * 换项目也不中断：结果按复盘 id 写库，只是不再反映到（已经换掉的）列表里。
 */

import { create } from "zustand";
import { api } from "../db/api";
import { askClaude, type ClaudeRun } from "./claude";
import { assembleDocument } from "./facts";
import { buildAskPrompt, buildWritePrompt, extractJson, normalizeQuestions, QUESTION_SCHEMA } from "./prompts";
import {
  isAnswered,
  parseReview,
  questionsOf,
  type Answer,
  type Background,
  type Question,
  type Review,
  type Snapshot,
  type Stage,
} from "./types";

/** 一次正在跑的调用 */
export interface Running {
  /** 在干什么，给界面显示 */
  label: string;
  /** 写文档时逐字攒出来的正文；出题时一直是空的 */
  text: string;
}

interface AiReviewState {
  /** 列表属于哪个项目。null = 还没载入过 */
  projectId: number | null;
  reviews: Review[];
  loading: boolean;
  /** 本机有没有 claude。null = 还没查 */
  available: boolean | null;
  /** 正在看哪一份；"new" = 正在填背景表单；null = 什么都没选 */
  selected: number | "new" | null;
  running: Record<number, Running>;
  /** 上一次调用为什么失败。重试或成功后清掉 */
  errors: Record<number, string>;

  load(projectId: number): Promise<void>;
  select(target: number | "new" | null): void;
  /** 建一份新复盘并立刻开始出题 */
  start(projectId: number, title: string, background: Background, snapshot: Snapshot): Promise<void>;
  /** 按当前阶段做该做的那一步：出题、出追问或写文档。失败后重试也是它 */
  advance(id: number): Promise<void>;
  cancel(id: number): void;
  setAnswer(id: number, questionId: string, answer: Answer): void;
  /** 这一轮答完了，进下一步 */
  submitRound(id: number): Promise<void>;
  /** 用同一批回答重写整份文档，可以附一句要求 */
  regenerate(id: number, instruction: string): Promise<void>;
  saveDocument(id: number, document: string): Promise<void>;
  rename(id: number, title: string): Promise<void>;
  remove(id: number): Promise<void>;
}

/** 进程句柄不放进 state：它不是可序列化的数据，也不该触发重渲染 */
const handles = new Map<number, ClaudeRun>();
/** 这次会话里删掉的复盘。它们身上还在跑的调用回来时，结果直接丢掉 */
const removed = new Set<number>();

const todayIso = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const without = <T,>(map: Record<number, T>, id: number): Record<number, T> => {
  const next = { ...map };
  delete next[id];
  return next;
};

export const useAiReviewStore = create<AiReviewState>((set, get) => {
  const find = (id: number): Review | undefined => get().reviews.find((r) => r.id === id);

  /**
   * 改一份复盘并落库。界面先变、库后写：答题时每点一下都等一次往返的话，
   * 选项会有肉眼可见的迟滞。写库失败记在 errors 里，不回滚 —— 用户刚选的
   * 答案比「和库保持一致」重要，下一次保存会把它带上。
   */
  const patch = async (id: number, change: Partial<Review>): Promise<void> => {
    const before = find(id);
    if (!before) return;
    const next: Review = { ...before, ...change };
    set({ reviews: get().reviews.map((r) => (r.id === id ? next : r)) });
    await persist(next);
  };

  /** 只写库，不要求它还在当前列表里（换了项目之后跑完的调用走这条） */
  const persist = async (review: Review): Promise<void> => {
    try {
      const updatedAt = await api.saveAiReview(
        review.id,
        review.title,
        review.stage,
        JSON.stringify(review.questions),
        review.document,
      );
      set({ reviews: get().reviews.map((r) => (r.id === review.id ? { ...r, updatedAt } : r)) });
    } catch (e) {
      set({ errors: { ...get().errors, [review.id]: `保存失败：${(e as Error)?.message ?? e}` } });
    }
  };

  /**
   * 跑一次调用。同一份复盘同时只跑一个 —— 连点两下「重试」不该起两个进程
   * 再让后到的那个把先到的结果盖掉。
   *
   * 返回 null = 没成（失败、取消，或者本来就有一个在跑）；错误已经记进 errors。
   */
  const call = async (
    id: number,
    label: string,
    prompt: string,
    schema?: string,
  ): Promise<{ text: string; structured: unknown } | null> => {
    if (handles.has(id) || get().running[id]) return null;
    set({
      running: { ...get().running, [id]: { label, text: "" } },
      errors: without(get().errors, id),
    });

    let outcome: Awaited<ClaudeRun["done"]>;
    try {
      const run = await askClaude(prompt, {
        schema,
        onText: (text) => {
          // 被取消之后还会有几行在路上，别让它们把已经清掉的状态又写回来
          if (get().running[id]) set({ running: { ...get().running, [id]: { label, text } } });
        },
      });
      handles.set(id, run);
      outcome = await run.done;
    } catch (e) {
      outcome = { ok: false, error: String((e as Error)?.message ?? e), cancelled: false };
    }

    handles.delete(id);
    set({ running: without(get().running, id) });
    if (outcome.ok) return outcome;
    // 用户自己点的取消不算错误，不用再告诉他一遍
    if (!outcome.cancelled) set({ errors: { ...get().errors, [id]: outcome.error } });
    return null;
  };

  /** 出一轮题。成了就把题存下来，阶段推到「等用户答」 */
  const ask = async (review: Review, round: 1 | 2): Promise<void> => {
    const got = await call(
      review.id,
      round === 1 ? "正在阅读项目数据并准备问题…" : "正在阅读你的回答并准备追问…",
      buildAskPrompt(review, round),
      QUESTION_SCHEMA,
    );
    if (!got) return;

    const fresh = normalizeQuestions(got.structured ?? extractJson(got.text), round);
    // 调用期间用户不可能改题，但可能删掉了这份复盘
    const current = find(review.id) ?? review;
    const kept = current.questions.filter((q) => q.round < round);

    if (fresh.length === 0) {
      if (round === 1) {
        set({ errors: { ...get().errors, [review.id]: "Claude 没有给出可用的问题，请重试" } });
        return;
      }
      // 追问一道都没有：模型认为首轮已经问清楚了。那就直接去写文档
      await save(current, { stage: "write", questions: kept });
      return get().advance(review.id);
    }
    await save(current, {
      stage: round === 1 ? "answer1" : "answer2",
      questions: [...kept, ...fresh],
    });
  };

  /** 写文档。首次生成和重新生成都走它：失败时阶段和旧文档都不动 */
  const write = async (review: Review, instruction: string): Promise<void> => {
    const got = await call(review.id, "正在撰写复盘文档…", buildWritePrompt(review, instruction));
    if (!got) return;
    if (!got.text.trim()) {
      set({ errors: { ...get().errors, [review.id]: "Claude 返回了空的文档，请重试" } });
      return;
    }
    const current = find(review.id) ?? review;
    await save(current, {
      stage: "done",
      document: assembleDocument(current, got.text, todayIso()),
    });
  };

  /**
   * 在列表里就走 patch（界面跟着变），不在就只写库 —— 那是换了项目之后才跑完的调用。
   * 调用期间被删掉的那种两边都不写：库里那一行已经没了。
   */
  const save = (review: Review, change: Partial<Review>): Promise<void> => {
    if (removed.has(review.id)) return Promise.resolve();
    return find(review.id) ? patch(review.id, change) : persist({ ...review, ...change });
  };

  return {
    projectId: null,
    reviews: [],
    loading: false,
    available: null,
    selected: null,
    running: {},
    errors: {},

    async load(projectId) {
      const switched = get().projectId !== projectId;
      set({
        projectId,
        loading: true,
        // 换了项目：上一个项目的列表和选中项立刻清掉，不让它们在新项目下闪一下
        ...(switched ? { reviews: [], selected: null } : {}),
      });
      const [rows, available] = await Promise.all([
        api.listAiReviews(projectId).catch(() => []),
        api.aiReviewAvailable().catch(() => false),
      ]);
      // 等待期间又换了项目：这批结果已经不是要的了
      if (get().projectId !== projectId) return;

      const reviews = rows.map(parseReview);
      const selected = get().selected;
      const stillThere = typeof selected === "number" && reviews.some((r) => r.id === selected);
      set({
        reviews,
        available,
        loading: false,
        // 默认打开最近动过的那份；一份都没有就直接给背景表单
        selected: stillThere || selected === "new" ? selected : (reviews[0]?.id ?? "new"),
      });
    },

    select(target) {
      set({ selected: target });
    },

    async start(projectId, title, background, snapshot) {
      const row = await api.createAiReview(
        projectId,
        title,
        JSON.stringify(background),
        JSON.stringify(snapshot),
      );
      const review = parseReview(row);
      if (get().projectId === projectId) {
        set({ reviews: [review, ...get().reviews], selected: review.id });
      }
      await get().advance(review.id);
    },

    async advance(id) {
      const review = find(id);
      if (!review) return;
      const step: Partial<Record<Stage, () => Promise<void>>> = {
        ask1: () => ask(review, 1),
        ask2: () => ask(review, 2),
        write: () => write(review, ""),
      };
      await step[review.stage]?.();
    },

    cancel(id) {
      handles.get(id)?.cancel();
    },

    setAnswer(id, questionId, answer) {
      const review = find(id);
      if (!review) return;
      void patch(id, {
        questions: review.questions.map((q) => (q.id === questionId ? { ...q, answer } : q)),
      });
    },

    async submitRound(id) {
      const review = find(id);
      if (!review) return;
      const round = review.stage === "answer1" ? 1 : review.stage === "answer2" ? 2 : null;
      if (!round) return;
      // 没碰过的题一律记成跳过：进了下一步，「还没答」这个状态就不该再存在了
      const questions: Question[] = review.questions.map((q) =>
        q.round === round && !isAnswered(q) ? { ...q, answer: { picked: [], text: "", skipped: true } } : q,
      );
      await patch(id, { stage: round === 1 ? "ask2" : "write", questions });
      await get().advance(id);
    },

    async regenerate(id, instruction) {
      const review = find(id);
      if (!review || review.stage !== "done") return;
      await write(review, instruction);
    },

    async saveDocument(id, document) {
      if (find(id)?.document === document) return;
      await patch(id, { document });
    },

    async rename(id, title) {
      const next = title.trim();
      if (!next || find(id)?.title === next) return;
      await patch(id, { title: next });
    },

    async remove(id) {
      removed.add(id);
      handles.get(id)?.cancel();
      await api.deleteAiReview(id);
      const reviews = get().reviews.filter((r) => r.id !== id);
      set({
        reviews,
        running: without(get().running, id),
        errors: without(get().errors, id),
        selected: get().selected === id ? (reviews[0]?.id ?? "new") : get().selected,
      });
    },
  };
});

/* ------------------------------------------------------------------ */
/* 进度                                                                */
/* ------------------------------------------------------------------ */

/**
 * 进度条上的「第几题 / 共几题」。
 *
 * 分母在首轮期间是「首轮题数 + 预计的追问数」：追问还没出，但用户有权知道
 * 后面还有几道，而不是答完第 7 题才发现又冒出来 3 道。
 */
export function progressOf(
  review: Review,
  expectedFollowUps: number,
): { round: 1 | 2; total: number; offset: number } {
  const r1 = questionsOf(review.questions, 1).length;
  const r2 = questionsOf(review.questions, 2).length;
  return review.stage === "answer2" || r2 > 0
    ? { round: 2, total: r1 + r2, offset: r1 }
    : { round: 1, total: r1 + expectedFollowUps, offset: 0 };
}
