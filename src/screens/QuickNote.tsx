import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { useAppStore } from "../store/useAppStore";
import { resolve, type Priority } from "../gantt/model";
import { columnOf } from "../core/board";
import { today } from "../gantt/time";
import { PRIORITY_COLORS, PRIORITY_LABELS } from "../gantt/theme";
import { shortcut } from "../core/keys";
import { FilterSelect, type SelectOption } from "./FilterSelect";
import { kindColor, RISK_KIND } from "../core/items";
import { loadMemo, memoKey, saveMemo } from "../core/memo";
import { itemSnapshot } from "../plugins/registry";
import { useRegistry } from "../plugins/usePlugins";
import { GrowingTextarea, type GrowingTextareaHandle } from "./GrowingTextarea";

/**
 * 快速记录（`⌘K` / `Ctrl+K`）。
 *
 * ## 为什么是全局快捷键
 *
 * 事情不挑你在哪个视图时发生 —— 会上那句话可能在你正看甘特图时冒出来。
 * 只在事项视图里能记，等于把「快」这个唯一的核心指标让掉一半。
 *
 * ## 为什么存完不关窗
 *
 * `Enter` 保存后弹窗留着、标题清空、焦点回到标题，可以连着记五条。
 * 关窗再按一次 `⌘K` 的代价看起来很小，但它正好打断「把脑子里那一串
 * 倒出来」这个动作 —— 而那是这个功能最主要的使用场景（开完会）。
 *
 * ## 为什么不在这里选类型
 *
 * **刻意的。** 录入界面每多一个字段，记下来的概率就低一分；而「这是什么」
 * 往往要等记完才想清楚。分拣是分开的动作，在事项视图里做（设计稿 §4.2）。
 * `⌘Enter` 是给「我已经知道这是什么」准备的：存下并立刻跳过去分拣。
 */

const day = () => today();

/** ⌘K 那个：哪个视图都能唤出，小而快 */
export function QuickNote() {
  const open = useAppStore((s) => s.quickNoteOpen);
  const setOpen = useAppStore((s) => s.setQuickNoteOpen);
  return <NoteComposer open={open} onClose={() => setOpen(false)} />;
}

/**
 * 录入弹窗本体。两种尺寸，同一套逻辑、同一条写入路径（store.addItemNote）。
 *
 * - 默认：⌘K 用的紧凑版，盖在别的视图上，越小越不打扰
 * - `roomy`：事项视图里「记一条」按钮打开的那个。人已经专门来记事了，
 *   书写区就该给足 —— 一大张纸，而不是一条输入框
 */
export function NoteComposer({
  open,
  onClose,
  roomy = false,
}: {
  open: boolean;
  onClose: () => void;
  roomy?: boolean;
}) {
  const people = useAppStore((s) => s.people);
  const taskMap = useAppStore((s) => s.tasks);
  const revision = useAppStore((s) => s.revision);
  const addItemNote = useAppStore((s) => s.addItemNote);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setPendingSortNote = useAppStore((s) => s.setPendingSortNote);
  const patchItemNote = useAppStore((s) => s.patchItemNote);
  const promoteToRisk = useAppStore((s) => s.promoteToRisk);
  const project = useAppStore((s) => s.project);
  const itemKinds = useAppStore((s) => s.itemKinds);
  const { composerOptions } = useRegistry();

  const [name, setName] = useState("");
  /** 分类。null = 未分拣（记完再到事项页分拣） */
  const [kind, setKind] = useState<string | null>(null);
  /** 插件开关的开 / 关，按开关 id。宿主替插件记住 */
  const [optionOn, setOptionOn] = useState<Record<string, boolean>>({});
  /** 插件开关在 onSaved 里报的错 */
  const [optionError, setOptionError] = useState<string | null>(null);
  const [personId, setPersonId] = useState<number | null>(null);
  const [taskId, setTaskId] = useState<number | null>(null);
  const [priority, setPriority] = useState<Priority>(2);
  const [saved, setSaved] = useState(0);
  /** 负责人是手选的还是跟着任务自动填的 —— 自动填不覆盖手选 */
  const touchedPerson = useRef(false);
  /** 有下拉开着时 Enter 归它，不触发保存 */
  const dropdownOpen = useRef(0);

  const nameRef = useRef<GrowingTextareaHandle>(null);

  const tasks = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => resolve([...taskMap.values()].map((t) => ({ ...t, collapsed: false }))),
    [taskMap, revision],
  );

  /**
   * 任务下拉：**进行中的在前**，其余在后。
   *
   * 要关联的活多半是正在做的那几条。父任务也列出来 —— 事项只是「关联」到
   * 一条活上，不像阻碍那样要落到叶子上，所以这里不筛掉它们。
   */
  const taskOptions = useMemo<SelectOption<number | null>[]>(() => {
    const d = day();
    const rank = (t: (typeof tasks)[number]) => {
      const col = columnOf(t, d);
      return col === "blocked" ? 0 : col === "doing" ? 1 : col === "todo" ? 2 : 3;
    };
    const sorted = [...tasks].sort((a, b) => rank(a) - rank(b) || a.sortOrder - b.sortOrder);
    return [
      { value: null, label: "不关联任务" },
      ...sorted.map((t) => {
        const col = columnOf(t, d);
        return {
          value: t.id as number | null,
          label: `#${t.id} ${t.name || "未命名"}`,
          search: t.name,
          hint:
            col === "blocked" ? "受阻" : col === "doing" ? "进行中" : col === "done" ? "已完成" : "",
        };
      }),
    ];
  }, [tasks]);

  const personOptions = useMemo<SelectOption<number | null>[]>(
    () => [
      { value: null, label: "未指派" },
      ...people.map((p) => ({ value: p.id as number | null, label: p.name, color: p.color })),
    ],
    [people],
  );

  /**
   * 分类下拉：普通类型（代办、问题、自定义）加上风险。风险默认就有 —— 选了它
   * 必须关联任务，存下时直接建成风险（中）。阻碍要定起止和归因，仍在事项页分拣
   */
  const kindOptions = useMemo<SelectOption<string | null>[]>(
    () => [
      { value: null, label: "未分拣", hint: "记完再分" },
      { value: RISK_KIND.key, label: RISK_KIND.label, color: RISK_KIND.color, hint: "要关联任务" },
      ...itemKinds.map((k) => ({ value: k.key as string | null, label: k.label, color: kindColor(k.key, itemKinds) })),
    ],
    [itemKinds],
  );

  const priorityOptions = useMemo<SelectOption<Priority>[]>(
    () =>
      PRIORITY_LABELS.map((label, i) => ({
        value: i as Priority,
        label,
        color: PRIORITY_COLORS[i],
      })),
    [],
  );

  /**
   * 每次打开：标题、优先级是白纸；**关联任务和分类沿用上一次**（按项目记），
   * 负责人跟着那条任务的负责人走。上次那条任务删了、那个类型删了就回到空。
   * 插件开关也记住上一次的开 / 关
   */
  useEffect(() => {
    if (!open) return;
    setName("");
    setPersonId(null);
    setTaskId(null);
    setKind(null);
    setPriority(2);
    setSaved(0);
    setOptionError(null);
    touchedPerson.current = false;
    dropdownOpen.current = 0;
    const id = requestAnimationFrame(() => nameRef.current?.focus());
    let live = true;
    if (project) {
      void Promise.all([
        loadMemo<number>(memoKey.composerTask(project.id)),
        loadMemo<string>(memoKey.composerKind(project.id)),
      ]).then(([t, k]) => {
        if (!live) return;
        const st = useAppStore.getState();
        if (t != null && st.tasks.has(t)) {
          setTaskId(t);
          setPersonId(st.tasks.get(t)?.personId ?? null);
        }
        if (k != null && (k === RISK_KIND.key || st.itemKinds.some((x) => x.key === k))) setKind(k);
      });
    }
    void Promise.all(
      composerOptions.map(async (o) => [o.option.id, (await loadMemo<boolean>(memoKey.composerOption(o.option.id))) ?? false] as const),
    ).then((pairs) => live && setOptionOn(Object.fromEntries(pairs)));
    return () => {
      live = false;
      cancelAnimationFrame(id);
    };
  }, [open]);

  if (!open) return null;

  /** 选定任务时自动预选它的负责人 —— 只在用户没手选过的时候 */
  const pickTask = (id: number | null) => {
    setTaskId(id);
    if (project) saveMemo(memoKey.composerTask(project.id), id);
    if (touchedPerson.current || id == null) return;
    const owner = taskMap.get(id)?.personId ?? null;
    if (owner != null) setPersonId(owner);
  };

  const submit = async (thenSort: boolean) => {
    const text = name.trim();
    if (!text) return;
    const isRisk = kind === RISK_KIND.key;
    // 风险是挂在任务上的实体，没有任务建不出来；拦在写库之前，不留下半条
    if (isRisk && taskId == null) {
      setOptionError("风险要关联一条任务");
      return;
    }
    setOptionError(null);
    const row = await addItemNote(text, priority, personId, taskId);
    if (!row) return;
    if (isRisk) await promoteToRisk(row.id, taskId!, 1);
    else if (kind != null) await patchItemNote(row.id, { kind });

    // 插件开关：存下之后逐个通知。失败只提示，事项已经存下了
    const on = composerOptions.filter((o) => optionOn[o.option.id]);
    if (on.length > 0) {
      const item = itemSnapshot().find((i) => i.noteId === row.id);
      setOptionError(null);
      if (item) {
        for (const { option } of on) {
          void Promise.resolve()
            .then(() => option.onSaved(item))
            .catch((e: unknown) => setOptionError(`${option.label}：${(e as Error)?.message ?? e}`));
        }
      }
    }

    if (thenSort) {
      // 「存下并立刻分拣」：关窗、切到事项视图、把那一行标出来。
      // 分拣菜单本身在列表行上 —— 在这里再画一个等于同一个菜单两份实现
      onClose();
      setActiveView("items");
      setPendingSortNote(row.id);
      return;
    }

    // 存完不关窗：清标题、焦点回标题，接着记下一条。
    // 负责人/任务/优先级**留着** —— 连记的那几条多半属于同一条活
    setName("");
    setSaved((n) => n + 1);
    nameRef.current?.focus();
  };

  const onDropdown = (o: boolean) => (dropdownOpen.current += o ? 1 : -1);
  const pickKind = (k: string | null) => {
    setKind(k);
    if (project) saveMemo(memoKey.composerKind(project.id), k);
  };
  const toggleOption = (id: string) => {
    const next = !optionOn[id];
    setOptionOn((m) => ({ ...m, [id]: next }));
    saveMemo(memoKey.composerOption(id), next);
  };
  const pickPerson = (id: number | null) => {
    touchedPerson.current = true;
    setPersonId(id);
  };

  /*
    会换行、会长高的多行框。一条事项常常是一整句话，单行框里它会
    往左滚出去 —— 而这个弹窗的全部意义就是让人把那句话原样倒出来。

    键盘（紧凑版）：↵ 存下并接着记、⇧↵ 换行、⌘↵ 存下并分拣。
    键盘（大号版）：↵ 换行，靠「记下来」按钮或 ⌘↵ 保存。
    三者都在这里处理，不交给弹窗那层的 onKeyDown —— 多行框必须
    stopPropagation（工作区在 window 上监听裸 ↵「新建任务」），
    所以冒泡上去那条路在这里本来就是断的。
  */
  const textarea = (props: { placeholder: string; minHeight: number; maxHeight: number; className: string }) => (
    <GrowingTextarea
      ref={nameRef}
      value={name}
      onChange={setName}
      onSubmit={() => void submit(false)}
      enterNewline={roomy}
      onKeyDown={(e) => {
        // 书写框会拦住全部按键（不让回车漏到工作区去新建任务），Esc 得在这里接
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
          return;
        }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          // 大号版里 ⌘↵ 就是「记下来」那个按钮的快捷键：人已经在事项视图里了，
          // 不需要再跳过去分拣
          void submit(!roomy);
        }
      }}
      {...props}
    />
  );

  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Enter") return;
    // 大号版只认按钮（和 ⌘↵，在书写区里处理）：Enter 在那里是换行，
    // 在别处冒上来的也不该替人存
    if (roomy) return;
    // 下拉开着时 Enter 是「选中这一项」，不是「保存」
    if (dropdownOpen.current > 0) return;
    e.preventDefault();
    void submit(e.metaKey || e.ctrlKey);
  };

  if (roomy) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.16 }}
        className="fixed inset-0 z-[120] grid place-items-start justify-center overflow-y-auto bg-[rgba(12,20,22,0.42)] pt-[8vh] pb-8 backdrop-blur-[3px]"
        onPointerDown={onClose}
      >
        <motion.div
          role="dialog"
          aria-label="记一条事项"
          initial={{ opacity: 0, y: 14, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 340, damping: 30 }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={onPanelKeyDown}
          className="flex w-[780px] max-w-[94vw] flex-col overflow-hidden rounded-[14px] border border-[var(--rule-strong)] bg-[var(--surface)]"
          style={{ boxShadow: "var(--shadow-pop), 0 40px 80px -32px rgba(12, 20, 22, 0.45)" }}
        >
          {/* 抬头：像图纸的标题栏 —— 一句话说清这张纸是干什么的 */}
          <div className="flex items-center gap-3 px-7 pt-6 pb-4">
            <span
              aria-hidden
              className="grid size-8 shrink-0 place-items-center rounded-[9px] text-[15px] font-semibold"
              style={{ background: "color-mix(in srgb, var(--accent) 14%, transparent)", color: "var(--accent)" }}
            >
              ＋
            </span>
            <div className="min-w-0">
              <div className="text-[16px] font-semibold tracking-[0.01em] text-[var(--text)]">记一条事项</div>
              <div className="mt-0.5 text-[11.5px] text-[var(--text-dim)]">
                想到什么写什么。分类可以现在选，也可以记完再分拣
              </div>
            </div>
            <div className="ml-auto flex items-center gap-3">
              {saved > 0 && (
                <motion.span
                  key={saved}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="rounded-full px-2.5 py-1 text-[11px] font-medium"
                  style={{ background: "color-mix(in srgb, var(--ok) 13%, transparent)", color: "var(--ok)" }}
                >
                  ✓ 已记 {saved} 条
                </motion.span>
              )}
              <button
                onClick={onClose}
                title="关闭（Esc）"
                aria-label="关闭"
                className="grid size-8 place-items-center rounded-lg text-[18px] leading-none text-[var(--text-dim)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
              >
                ×
              </button>
            </div>
          </div>

          {/*
            书写区。占弹窗的大半 —— 这里只有它是必填的，其余都能不动直接存。
            横线纸底纹跟着文字一起滚（background-attachment: local），
            行距和横线间距是同一个数，字正好坐在线上
          */}
          <div className="mx-7 rounded-[11px] border border-[var(--rule)] bg-[var(--surface-alt)] transition-[border-color,box-shadow] focus-within:border-[color-mix(in_srgb,var(--accent)_55%,transparent)] focus-within:shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent)_10%,transparent)]">
            {textarea({
              placeholder: "会上提到的那件事、刚冒出来的一个担心、要找谁确认的一句话…",
              minHeight: 280,
              maxHeight: Math.round(window.innerHeight * 0.5),
              className: "note-sheet block w-full bg-transparent px-6 py-[14px] text-[16px] leading-[32px] text-[var(--text)] placeholder:text-[var(--text-dim)] placeholder:opacity-70",
            })}
            <div className="flex items-center justify-end gap-3 px-4 pb-2.5 text-[10.5px] text-[var(--text-dim)]">
              <span>
                <Key>↵</Key> 换行
              </span>
              <span className="tabular-nums">{name.length} 字</span>
            </div>
          </div>

          {/* 附加信息：三格并排，像标题栏里的签名栏。都是选填 */}
          <div className="mx-7 mt-4 grid grid-cols-[1fr_1fr_1.7fr_0.85fr] overflow-visible rounded-[11px] border border-[var(--rule)]">
            <Field label="分类">
              <FilterSelect
                value={kind}
                options={kindOptions}
                onPick={pickKind}
                onOpenChange={onDropdown}
                placeholder="未分拣"
                title="现在就分好；不选就是未分拣，记完再到事项页分。阻碍在事项页分拣；风险要先选好关联任务"
                width={124}
              />
            </Field>
            <Field label="负责人" divided>
              <FilterSelect
                value={personId}
                options={personOptions}
                onPick={pickPerson}
                onOpenChange={onDropdown}
                placeholder="未指派"
                title="负责人（单人。任务已经是单人，这里跟着一致）"
                width={132}
              />
            </Field>
            <Field label="关联任务" divided>
              <FilterSelect
                value={taskId}
                options={taskOptions}
                onPick={pickTask}
                onOpenChange={onDropdown}
                placeholder="不关联任务"
                title="关联的活，下次打开沿用这一次的。进行中的排在前面；选了会自动带上它的负责人"
                width={232}
              />
            </Field>
            <Field label="优先级" divided>
              <FilterSelect
                value={priority}
                options={priorityOptions}
                onPick={setPriority}
                onOpenChange={onDropdown}
                title="先做哪个"
                width={104}
              />
            </Field>
          </div>

          {(composerOptions.length > 0 || optionError) && (
            <div className="mx-7 mt-3 flex flex-wrap items-center gap-2">
              {composerOptions.map(({ option }) => (
                <OptionSwitch
                  key={option.id}
                  label={option.label}
                  hint={option.hint}
                  on={!!optionOn[option.id]}
                  onToggle={() => toggleOption(option.id)}
                />
              ))}
              {optionError && <span className="text-[11px] text-[var(--danger)]">{optionError}</span>}
            </div>
          )}

          <div className="mt-6 flex items-center gap-4 border-t border-[var(--rule)] bg-[var(--surface-alt)] px-7 py-3.5 text-[11px] text-[var(--text-dim)]">
            <span>点「记下来」保存，弹窗留着可以接着记</span>
            <span>
              <Key>{shortcut("mod", "↵")}</Key> 也能保存
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={onClose}
                className="h-9 rounded-lg px-4 text-[12.5px] text-[var(--text-dim)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
              >
                {saved > 0 ? "完成" : "取消"}
              </button>
              <button
                onClick={() => void submit(false)}
                disabled={!name.trim()}
                className="flex h-9 items-center gap-2 rounded-lg px-5 text-[12.5px] font-medium text-[var(--on-accent)] transition-[opacity,transform] hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: "var(--accent)" }}
              >
                记下来
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[120] grid place-items-start justify-center bg-black/30 pt-[14vh] backdrop-blur-[1px]"
      onPointerDown={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: -8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={onPanelKeyDown}
        className="w-[480px] max-w-[92vw] overflow-hidden rounded-xl border border-[var(--rule)] bg-[var(--surface)] shadow-2xl"
      >
        <div className="px-3.5 pt-3">
          <div className="mb-2 flex items-baseline gap-2">
            <span className="text-xs font-semibold text-[var(--text)]">快速记录</span>
            <span className="text-[10px] text-[var(--text-dim)]">
              分类可以现在选，也可以记完再分拣
            </span>
            {saved > 0 && (
              <span className="ml-auto text-[10px] font-medium text-[var(--ok)]">
                已记 {saved} 条
              </span>
            )}
          </div>

          {textarea({
            placeholder: "会上提到的那件事…",
            minHeight: 56,
            maxHeight: 168,
            className:
              "w-full rounded-lg border border-[var(--rule)] bg-[var(--surface-alt)] px-3 py-2.5 text-[14px] leading-relaxed text-[var(--text)] focus:border-[var(--accent)]",
          })}

          {/* Tab 顺序就是这个顺序：标题 → 分类 → 负责人 → 任务 → 优先级 */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5 pb-3">
            <FilterSelect
              value={kind}
              options={kindOptions}
              onPick={pickKind}
              onOpenChange={onDropdown}
              placeholder="未分拣"
              title="现在就分好；不选就是未分拣，记完再分。阻碍在事项页分拣；风险要先选好关联任务"
              width={92}
            />
            <FilterSelect
              value={personId}
              options={personOptions}
              onPick={pickPerson}
              onOpenChange={onDropdown}
              placeholder="未指派"
              title="负责人（单人。任务已经是单人，这里跟着一致）"
              width={104}
            />
            <FilterSelect
              value={taskId}
              options={taskOptions}
              onPick={pickTask}
              onOpenChange={onDropdown}
              placeholder="不关联任务"
              title="关联的活，下次打开沿用这一次的。进行中的排在前面；选了会自动带上它的负责人"
              width={152}
            />
            <FilterSelect
              value={priority}
              options={priorityOptions}
              onPick={setPriority}
              onOpenChange={onDropdown}
              title="先做哪个"
              width={84}
            />
          </div>
          {(composerOptions.length > 0 || optionError) && (
            <div className="-mt-1 flex flex-wrap items-center gap-2 pb-3">
              {composerOptions.map(({ option }) => (
                <OptionSwitch
                  key={option.id}
                  small
                  label={option.label}
                  hint={option.hint}
                  on={!!optionOn[option.id]}
                  onToggle={() => toggleOption(option.id)}
                />
              ))}
              {optionError && <span className="text-[10px] text-[var(--danger)]">{optionError}</span>}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-[var(--rule)] bg-[var(--surface-alt)] px-3.5 py-2 text-[10px] text-[var(--text-dim)]">
          <span>
            <Key>↵</Key> 保存并继续
          </span>
          <span>
            <Key>⇧↵</Key> 换行
          </span>
          <span>
            <Key>{shortcut("mod", "↵")}</Key> 存下并分拣
          </span>
          <span className="ml-auto">
            <Key>Esc</Key> 关闭
          </span>
        </div>
      </motion.div>
    </div>
  );
}

/**
 * 插件注册的录入开关（例如「加入飞书队列」）。一个小拨动开关 + 文字，整块可点；
 * 开 / 关由宿主按开关 id 记住
 */
function OptionSwitch({
  label,
  hint,
  on,
  onToggle,
  small = false,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onToggle: () => void;
  small?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      title={hint}
      onClick={onToggle}
      className={`flex items-center gap-2 rounded-full border px-2.5 transition-colors ${
        small ? "h-6 text-[10.5px]" : "h-7 text-[11.5px]"
      } ${
        on
          ? "border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-[var(--text)]"
          : "border-[var(--rule)] text-[var(--text-dim)] hover:text-[var(--text)]"
      }`}
    >
      <span
        aria-hidden
        className="relative inline-block h-3 w-[22px] shrink-0 rounded-full transition-colors"
        style={{ background: on ? "var(--accent)" : "var(--rule-strong)" }}
      >
        <span
          className="absolute top-[2px] size-2 rounded-full bg-white shadow-sm transition-[left]"
          style={{ left: on ? 12 : 2 }}
        />
      </span>
      {label}
    </button>
  );
}

/** 附加信息栏里的一格：小标签在上，控件在下 */
function Field({ label, divided, children }: { label: string; divided?: boolean; children: React.ReactNode }) {
  return (
    <div className={`min-w-0 px-4 pt-2.5 pb-3 ${divided ? "border-l border-[var(--rule)]" : ""}`}>
      <div className="mb-1.5 text-[10.5px] font-medium tracking-[0.06em] text-[var(--text-dim)]">{label}</div>
      {children}
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-[var(--rule)] bg-[var(--surface)] px-1 font-mono text-[9px] text-[var(--text)]">
      {children}
    </kbd>
  );
}
