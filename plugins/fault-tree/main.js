/**
 * 故障树分析（Fault Tree Analysis）插件。
 *
 * 事项页里一条问题 / 阻碍 →「建故障树分析」→ 它成为一棵树的**顶事件**，
 * 用户在画布上一层层往下拆：
 *
 *     顶事件（不希望发生的那件事）
 *       └ 门：或门 = 任一输入发生就导致上层；与门 = 所有输入同时发生才导致
 *           ├ 中间事件（还能继续拆）
 *           ├ 基本事件 ○（拆到底了，可以直接验证）
 *           └ 未展开事件 ◇（暂时不拆：信息不够，或不值得拆）
 *
 * 光画出来不够 —— 故障树的价值在于**推**：
 *
 *   · 基本事件逐个标「已确认 / 已排除」，按门的逻辑往上推，画布直接染出
 *     哪条因果链成立（红），哪些分支已经被排除（淡）。
 *   · 最小割集：能单独导致顶事件的最小基本事件组合。排查顺序就从这里来 ——
 *     先查一阶割集（单点原因），再查组合。
 *
 * 数据存在插件自己的 data/trees.json，按项目分开。一棵树引用事项用的是
 * noteId（和飞书同步插件同一个认法）：事项从「问题」改分拣成「阻碍」，
 * 行 key 会变，但还是同一条。
 *
 * 单文件、无 import：宿主从 Blob URL 加载插件（见 registry.ts 的
 * assertSelfContained）。React 用宿主给的 api.react。
 */

/* ------------------------------------------------------------------ */
/* 数据 —— 纯函数，单测直接 import                                       */
/* ------------------------------------------------------------------ */

export const STORE_FILE = "trees.json";

export const KIND_LABELS = {
  top: "顶事件",
  intermediate: "中间事件",
  basic: "基本事件",
  undeveloped: "未展开事件",
};
export const GATE_LABELS = { or: "或门", and: "与门" };
export const STATUS_LABELS = { open: "待验证", confirmed: "已确认", ruled: "已排除" };

export const isLeaf = (n) => n.kind === "basic" || n.kind === "undeveloped";

export function emptyStore() {
  return { version: 1, trees: [] };
}

export function parseStore(text) {
  if (!text) return emptyStore();
  try {
    const s = JSON.parse(text);
    if (s && Array.isArray(s.trees)) return s;
  } catch {
    /* 坏文件当空的，不让整个页面打不开 */
  }
  return emptyStore();
}

/** 认一条事项：有 noteId 用 note:<id>，分拣改类型也认得出来 */
export const itemRef = (item) => (item.noteId != null ? `note:${item.noteId}` : item.key);

const node = (id, over = {}) => ({
  id,
  label: "",
  kind: "basic",
  gate: "or",
  status: "open",
  note: "",
  children: [],
  itemRef: null,
  ...over,
});

export function newTree({ id, projectId, label = "", ref = null, now }) {
  return {
    id,
    projectId,
    createdAt: now,
    updatedAt: now,
    seq: 1,
    root: "n1",
    nodes: { n1: node("n1", { label, kind: "top", itemRef: ref }) },
  };
}

export const treeTitle = (tree) => tree.nodes[tree.root]?.label || "未命名的顶事件";

export function parentOf(tree, id) {
  for (const n of Object.values(tree.nodes)) if (n.children.includes(id)) return n;
  return null;
}

const withNodes = (tree, nodes, extra = {}) => ({ ...tree, ...extra, nodes });

/**
 * 加一个子事件，返回 { tree, id }。
 * 往基本 / 未展开事件下面加，它就变成中间事件 —— 能往下拆就说明它不是「底」。
 */
export function addChild(tree, parentId, init = {}, index = null) {
  const parent = tree.nodes[parentId];
  if (!parent) return { tree, id: null };
  const seq = tree.seq + 1;
  const id = `n${seq}`;
  const children = [...parent.children];
  children.splice(index ?? children.length, 0, id);
  const nextParent = {
    ...parent,
    children,
    ...(isLeaf(parent) ? { kind: "intermediate", status: "open" } : {}),
  };
  return {
    tree: withNodes(
      tree,
      { ...tree.nodes, [parentId]: nextParent, [id]: node(id, init) },
      { seq },
    ),
    id,
  };
}

/** 在 id 后面加一个同级事件。顶事件没有同级，退化成加子事件 */
export function addSibling(tree, id, init = {}) {
  const parent = parentOf(tree, id);
  if (!parent) return addChild(tree, id, init);
  return addChild(tree, parent.id, init, parent.children.indexOf(id) + 1);
}

export function updateNode(tree, id, patch) {
  const n = tree.nodes[id];
  if (!n) return tree;
  const next = { ...n, ...patch };
  // 有子事件的不能改成叶子；顶事件永远是顶事件
  if (n.kind === "top") next.kind = "top";
  else if (n.children.length > 0) next.kind = "intermediate";
  else if (next.kind === "intermediate" || next.kind === "top") next.kind = "basic";
  return withNodes(tree, { ...tree.nodes, [id]: next });
}

/** 这个事件和它下面的全部 id */
export function subtreeIds(tree, id) {
  const out = [];
  const walk = (x) => {
    const n = tree.nodes[x];
    if (!n) return;
    out.push(x);
    n.children.forEach(walk);
  };
  walk(id);
  return out;
}

/** 删掉一个事件连同它下面的整枝。删空了的中间事件变回基本事件 */
export function removeNode(tree, id) {
  if (id === tree.root || !tree.nodes[id]) return tree;
  const parent = parentOf(tree, id);
  const nodes = { ...tree.nodes };
  for (const x of subtreeIds(tree, id)) delete nodes[x];
  if (parent) {
    const children = parent.children.filter((c) => c !== id);
    nodes[parent.id] = {
      ...parent,
      children,
      ...(children.length === 0 && parent.kind === "intermediate" ? { kind: "basic" } : {}),
    };
  }
  return withNodes(tree, nodes);
}

/** 同级之间挪一位。delta = -1 往左，+1 往右 */
export function moveNode(tree, id, delta) {
  const parent = parentOf(tree, id);
  if (!parent) return tree;
  const i = parent.children.indexOf(id);
  const j = i + delta;
  if (j < 0 || j >= parent.children.length) return tree;
  const children = [...parent.children];
  [children[i], children[j]] = [children[j], children[i]];
  return withNodes(tree, { ...tree.nodes, [parent.id]: { ...parent, children } });
}

/**
 * 按门的逻辑把叶子的验证状态往上推。返回 { [id]: "confirmed" | "ruled" | "open" }。
 *
 *   或门：任一输入成立 → 成立；全部输入都排除 → 排除
 *   与门：全部输入成立 → 成立；任一输入排除   → 排除
 *
 * 还没往下拆的门（没有子事件）就是待验证 —— 没拆不等于没问题。
 */
export function evaluate(tree) {
  const out = {};
  const walk = (id) => {
    const n = tree.nodes[id];
    if (!n) return "open";
    let s;
    if (isLeaf(n) || n.children.length === 0) {
      s = isLeaf(n) ? n.status : "open";
    } else {
      const kids = n.children.map(walk);
      const all = (v) => kids.every((k) => k === v);
      const any = (v) => kids.some((k) => k === v);
      s =
        n.gate === "and"
          ? all("confirmed") ? "confirmed" : any("ruled") ? "ruled" : "open"
          : any("confirmed") ? "confirmed" : all("ruled") ? "ruled" : "open";
    }
    out[id] = s;
    return s;
  };
  walk(tree.root);
  return out;
}

/**
 * 最小割集：能单独导致顶事件发生的、不可再少的叶子组合。
 *
 * 自上而下展开（MOCUS 的思路）：或门把输入的割集并起来，与门把输入的割集
 * 两两拼起来。这里的树里每个事件只出现一次，展开出来的割集本来就互不包含；
 * 最后那道「去掉被包含的」是防御 —— 以后要是支持同一事件挂在多处，
 * 结果仍然是最小的。与门多的树组合会爆炸，超过
 * limit 就截断并告诉调用方 —— 屏幕上列出几百个割集本来也没人看。
 *
 * 返回 { sets: string[][], truncated }，按阶数（割集大小）从小到大。
 */
export function minimalCutSets(tree, limit = 200) {
  let truncated = false;
  const cap = (sets) => {
    if (sets.length > limit * 4) {
      truncated = true;
      return sets.slice(0, limit * 4);
    }
    return sets;
  };
  const walk = (id) => {
    const n = tree.nodes[id];
    if (!n) return [];
    if (isLeaf(n) || n.children.length === 0) return [[id]];
    const kids = n.children.map(walk);
    if (n.gate === "and") {
      return kids.reduce(
        (acc, sets) => cap(acc.flatMap((a) => sets.map((b) => [...new Set([...a, ...b])]))),
        [[]],
      );
    }
    return cap(kids.flat());
  };

  // 顶事件自己还没拆，就没有割集可言
  const root = tree.nodes[tree.root];
  if (!root || root.children.length === 0) return { sets: [], truncated: false };

  const order = Object.fromEntries(Object.keys(tree.nodes).map((id, i) => [id, i]));
  const raw = walk(tree.root).map((s) => [...s].sort((a, b) => order[a] - order[b]));
  const uniq = [...new Map(raw.map((s) => [s.join(","), s])).values()].sort(
    (a, b) => a.length - b.length || order[a[0]] - order[b[0]],
  );
  const minimal = uniq.filter(
    (s, i) => !uniq.some((o, j) => j !== i && o.length < s.length && o.every((x) => s.includes(x))),
  );
  if (minimal.length > limit) truncated = true;
  return { sets: minimal.slice(0, limit), truncated };
}

/** 一个割集现在的处境：含已排除的叶子就不成立了；全部已确认就是坐实了 */
export function cutSetStatus(tree, set) {
  const st = set.map((id) => tree.nodes[id]?.status ?? "open");
  if (st.includes("ruled")) return "ruled";
  if (st.every((s) => s === "confirmed")) return "confirmed";
  return "open";
}

/** 树 → 缩进大纲，复制出去贴进周报、邮件 */
export function outline(tree) {
  const lines = [];
  const walk = (id, prefix, last, depth) => {
    const n = tree.nodes[id];
    if (!n) return;
    const head = depth === 0 ? "" : `${prefix}${last ? "└─ " : "├─ "}`;
    const kind = isLeaf(n) ? (n.kind === "basic" ? "○" : "◇") : `[${GATE_LABELS[n.gate]}]`;
    const status = isLeaf(n) && n.status !== "open" ? `（${STATUS_LABELS[n.status]}）` : "";
    const label = n.label || "（未填写）";
    lines.push(
      depth === 0
        ? `${KIND_LABELS.top}：${label}  ${kind}`
        : `${head}${isLeaf(n) ? `${kind} ${label}` : `${label}  ${kind}`}${status}`,
    );
    if (n.note) lines.push(`${prefix}${depth === 0 ? "" : last ? "   " : "│  "}  备注：${n.note}`);
    const next = depth === 0 ? "" : prefix + (last ? "   " : "│  ");
    n.children.forEach((c, i) => walk(c, next, i === n.children.length - 1, depth + 1));
  };
  walk(tree.root, "", true, 0);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* 布局 —— 也是纯函数                                                   */
/* ------------------------------------------------------------------ */

export const NODE_W = 176;
export const BOX_H = 66;
/** 事件框底到符号顶的短竖线 */
const STEM = 8;
const SYMBOL_H = 22;
export const LEVEL_H = 140;
const H_GAP = 28;
const PAD = 48;

/**
 * 自上而下的树形布局：叶子从左到右排开，父节点居中在首尾两个子节点上方。
 * 返回每个节点框的**顶边中点**。
 */
export function layoutTree(tree) {
  const pos = {};
  let cursor = 0;
  let maxDepth = 0;
  const place = (id, depth) => {
    const n = tree.nodes[id];
    maxDepth = Math.max(maxDepth, depth);
    const y = PAD + depth * LEVEL_H;
    const kids = n.children.filter((c) => tree.nodes[c]);
    if (kids.length === 0) {
      const x = PAD + cursor + NODE_W / 2;
      cursor += NODE_W + H_GAP;
      pos[id] = { x, y };
      return x;
    }
    const xs = kids.map((c) => place(c, depth + 1));
    const x = (xs[0] + xs[xs.length - 1]) / 2;
    pos[id] = { x, y };
    return x;
  };
  if (tree.nodes[tree.root]) place(tree.root, 0);
  return {
    pos,
    width: Math.max(cursor - H_GAP, NODE_W) + PAD * 2,
    height: PAD * 2 + maxDepth * LEVEL_H + BOX_H + STEM + SYMBOL_H,
  };
}

/* ------------------------------------------------------------------ */
/* 视图                                                                */
/* ------------------------------------------------------------------ */

const uid = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 门 / 事件符号的 SVG 路径。(cx, t) 是符号顶边中点 */
function symbolPath(kind, gate, cx, t) {
  if (kind === "basic") return null; // 圆，单独画
  if (kind === "undeveloped") {
    return `M${cx},${t} L${cx + 12},${t + 11} L${cx},${t + 22} L${cx - 12},${t + 11} Z`;
  }
  return gate === "and"
    ? `M${cx - 12},${t + 22} L${cx - 12},${t + 11} A12,11 0 0 1 ${cx + 12},${t + 11} L${cx + 12},${t + 22} Z`
    : `M${cx - 13},${t + 22} Q${cx - 12},${t + 8} ${cx},${t} Q${cx + 12},${t + 8} ${cx + 13},${t + 22} Q${cx},${t + 15} ${cx - 13},${t + 22} Z`;
}

/** 门的输入从哪里伸出去：或门是凹进去的底，与门是平底 */
const gateBottom = (gate, t) => t + (gate === "and" ? 22 : 18);

export function onload(api) {
  const React = api.react;
  const h = React.createElement;
  const { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } = React;

  /* ---------------- 共享状态：事项页的菜单/徽标和本页面共用 ---------------- */

  const state = { store: emptyStore(), activeTree: null, loaded: false, version: 0 };
  const subs = new Set();
  const notify = () => {
    state.version += 1;
    for (const fn of subs) fn();
    api.itemBadges.refresh();
  };
  const subscribe = (fn) => {
    subs.add(fn);
    return () => subs.delete(fn);
  };
  const useShared = () => useSyncExternalStore(subscribe, () => state.version);

  /**
   * 内存里那份是准的，落盘防抖 —— 改一个字就写一次文件没有必要，
   * 而等写完再刷新界面会让打字和拖动发涩。
   */
  let saveTimer = null;
  let saving = Promise.resolve();
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const text = JSON.stringify(state.store, null, 2);
      saving = saving
        .then(() => api.storage.write(STORE_FILE, text))
        .catch((e) => api.log("写入故障树失败", e));
    }, 300);
  };

  /** 撤销 / 重做：只管本次会话里对树的改动 */
  const undo = [];
  const redo = [];
  const setStore = (next, { record = true } = {}) => {
    if (next === state.store) return;
    if (record) {
      undo.push(state.store);
      if (undo.length > 100) undo.shift();
      redo.length = 0;
    }
    state.store = next;
    notify();
    save();
  };
  const step = (from, to) => {
    const prev = from.pop();
    if (!prev) return false;
    to.push(state.store);
    state.store = prev;
    if (state.activeTree && !prev.trees.some((t) => t.id === state.activeTree)) {
      state.activeTree = prev.trees[0]?.id ?? null;
    }
    notify();
    save();
    return true;
  };

  const mutateTree = (treeId, fn) => {
    const now = new Date().toISOString();
    let changed = false;
    const trees = state.store.trees.map((t) => {
      if (t.id !== treeId) return t;
      const next = fn(t);
      if (next === t) return t;
      changed = true;
      return { ...next, updatedAt: now };
    });
    if (changed) setStore({ ...state.store, trees });
  };

  const treesOf = (projectId) => state.store.trees.filter((t) => t.projectId === projectId);
  const treeWithTop = (ref, projectId) =>
    treesOf(projectId).find((t) => t.nodes[t.root]?.itemRef === ref) ?? null;

  const createTree = (label, ref) => {
    const project = api.data.project();
    if (!project) return null;
    const tree = newTree({ id: uid(), projectId: project.id, label, ref, now: new Date().toISOString() });
    state.activeTree = tree.id;
    setStore({ ...state.store, trees: [...state.store.trees, tree] });
    return tree;
  };

  void api.storage
    .read(STORE_FILE)
    .then((text) => {
      state.store = parseStore(text);
      state.loaded = true;
      notify();
    })
    .catch((e) => {
      api.log("读取故障树失败", e);
      state.loaded = true;
      notify();
    });

  /* ---------------- 事项页：分拣菜单 + 徽标 ---------------- */

  api.itemActions.register({
    id: "fault-tree.open",
    hint: "以这条事项为顶事件，在「故障树」页一层层拆到基本原因",
    label: (item) => {
      const project = api.data.project();
      return treeWithTop(itemRef(item), project?.id) ? "打开故障树分析" : "建故障树分析";
    },
    run: (item) => {
      const project = api.data.project();
      const existing = treeWithTop(itemRef(item), project?.id);
      if (existing) {
        state.activeTree = existing.id;
        notify();
      } else {
        createTree(item.title, itemRef(item));
      }
      api.act.setActiveView("fault-tree.view");
    },
  });

  api.itemBadges.register({
    id: "fault-tree.badge",
    render: (item) => {
      const project = api.data.project();
      if (!project) return null;
      const ref = itemRef(item);
      for (const t of treesOf(project.id)) {
        const hit = Object.values(t.nodes).find((n) => n.itemRef === ref);
        if (!hit) continue;
        const top = hit.id === t.root;
        return {
          text: top ? "故障树" : "故障树·原因",
          title: top
            ? `「${treeTitle(t)}」的顶事件`
            : `是「${treeTitle(t)}」里的一个${KIND_LABELS[hit.kind]}`,
          color: "#d97706",
        };
      }
      return null;
    },
  });

  /* ---------------- 小部件 ---------------- */

  function Seg({ options, value, onChange, disabled }) {
    return h(
      "div",
      { className: "ft-seg", role: "radiogroup" },
      options.map((o) =>
        h(
          "button",
          {
            key: o.value,
            role: "radio",
            "aria-checked": value === o.value,
            disabled,
            title: o.title,
            className: `ft-seg-btn${value === o.value ? " ft-on" : ""}`,
            style: value === o.value && o.color ? { color: o.color } : undefined,
            onClick: () => onChange(o.value),
          },
          o.label,
        ),
      ),
    );
  }

  /** 失焦才提交的输入框 —— 打字过程中不写盘、不进撤销栈 */
  function DraftText({ value, onCommit, placeholder, rows = 2, className = "ft-input", autoFocus }) {
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);
    return h("textarea", {
      className,
      rows,
      value: draft,
      placeholder,
      autoFocus,
      spellCheck: false,
      onChange: (e) => setDraft(e.target.value),
      onBlur: () => draft !== value && onCommit(draft),
      onKeyDown: (e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          setDraft(value);
          e.currentTarget.blur();
        }
      },
    });
  }

  /* ---------------- 画布 ---------------- */

  function Canvas({ tree, selected, onSelect, editing, setEditing, highlight, ops }) {
    const box = useRef(null);
    const [view, setView] = useState({ x: 0, y: 0, k: 1 });
    const drag = useRef(null);
    const layout = useMemo(() => layoutTree(tree), [tree]);
    const ev = useMemo(() => evaluate(tree), [tree]);

    const fit = () => {
      const el = box.current;
      if (!el) return;
      const w = el.clientWidth || 800;
      const hgt = el.clientHeight || 600;
      const k = Math.min(1, Math.max(0.3, Math.min(w / layout.width, hgt / layout.height)));
      setView({ k, x: (w - layout.width * k) / 2, y: Math.max(0, (hgt - layout.height * k) / 2) * 0.4 });
    };
    // 换一棵树就重新摆到中间；同一棵树里加减节点不动视角，免得一编辑就跳
    useLayoutEffect(fit, [tree.id]);

    // 选中的节点跑出可视区了就把它拉回来（键盘导航、新建子事件时）
    useEffect(() => {
      const el = box.current;
      const p = selected && layout.pos[selected];
      if (!el || !p) return;
      setView((v) => {
        const sx = v.x + p.x * v.k;
        const sy = v.y + p.y * v.k;
        const half = (NODE_W / 2) * v.k;
        const m = 24;
        let { x, y } = v;
        if (sx - half < m) x += m - (sx - half);
        if (sx + half > el.clientWidth - m) x -= sx + half - (el.clientWidth - m);
        if (sy < m) y += m - sy;
        if (sy + (BOX_H + 40) * v.k > el.clientHeight - m) y -= sy + (BOX_H + 40) * v.k - (el.clientHeight - m);
        return x === v.x && y === v.y ? v : { ...v, x, y };
      });
    }, [selected, layout]);

    const zoomAt = (factor, cx, cy) =>
      setView((v) => {
        const k = Math.min(2, Math.max(0.25, v.k * factor));
        const f = k / v.k;
        return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
      });

    useEffect(() => {
      const el = box.current;
      if (!el) return;
      // 要 preventDefault，React 的 onWheel 是 passive 的，只能自己挂
      const onWheel = (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          const r = el.getBoundingClientRect();
          zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
        } else {
          setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
        }
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      return () => el.removeEventListener("wheel", onWheel);
    }, []);

    const onPointerDown = (e) => {
      if (e.button !== 0 || e.target.closest?.(".ft-node, .ft-tools, .ft-zoom")) return;
      drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e) => {
      const d = drag.current;
      if (!d) return;
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
      setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
    };
    const onPointerUp = () => {
      const d = drag.current;
      drag.current = null;
      // 点空白处（没拖动）= 取消选中
      if (d && !d.moved) onSelect(null);
    };

    const onKeyDown = (e) => {
      if (editing || e.target.closest?.("textarea, input, select")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? ops.redo() : ops.undo();
        return;
      }
      if (!selected) {
        if (e.key === "Enter" || e.key === "ArrowDown") {
          e.preventDefault();
          onSelect(tree.root);
        }
        return;
      }
      const n = tree.nodes[selected];
      const parent = parentOf(tree, selected);
      const sib = (d) => {
        if (!parent) return;
        const i = parent.children.indexOf(selected) + d;
        if (parent.children[i]) onSelect(parent.children[i]);
      };
      const keys = {
        Tab: () => ops.addChild(selected),
        Enter: () => ops.addSibling(selected),
        Backspace: () => ops.remove(selected),
        Delete: () => ops.remove(selected),
        F2: () => setEditing(selected),
        " ": () => setEditing(selected),
        Escape: () => onSelect(null),
        ArrowUp: () => parent && onSelect(parent.id),
        ArrowDown: () => n.children[0] && onSelect(n.children[0]),
        ArrowLeft: () => (e.altKey ? ops.move(selected, -1) : sib(-1)),
        ArrowRight: () => (e.altKey ? ops.move(selected, 1) : sib(1)),
      };
      if (keys[e.key]) {
        e.preventDefault();
        keys[e.key]();
      }
    };

    const color = (s) => (s === "confirmed" ? "var(--ft-hot)" : s === "ruled" ? "var(--ft-dim)" : "var(--ft-line)");
    const hl = highlight ? new Set(highlight) : null;

    // 连线：父的门底 → 汇流横线 → 子框顶。成立的那几条后画，压在上面
    const edges = [];
    for (const n of Object.values(tree.nodes)) {
      const p = layout.pos[n.id];
      if (!p) continue;
      const from = gateBottom(n.gate, p.y + BOX_H + STEM);
      const bus = p.y + LEVEL_H - 20;
      for (const c of n.children) {
        const q = layout.pos[c];
        if (!q) continue;
        edges.push({
          key: `${n.id}-${c}`,
          d: `M${p.x},${from} V${bus} H${q.x} V${q.y}`,
          s: ev[c],
          dim: hl && !(hl.has(c) || subtreeIds(tree, c).some((x) => hl.has(x))),
        });
      }
    }
    const rank = { ruled: 0, open: 1, confirmed: 2 };
    edges.sort((a, b) => rank[a.s] - rank[b.s]);

    const nodes = Object.values(tree.nodes).filter((n) => layout.pos[n.id]);
    const r = box.current?.getBoundingClientRect();

    return h(
      "div",
      {
        ref: box,
        className: "ft-canvas",
        tabIndex: 0,
        "aria-label": "故障树画布",
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onKeyDown,
      },
      h(
        "div",
        {
          className: "ft-stage",
          style: {
            width: layout.width,
            height: layout.height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          },
        },
        h(
          "svg",
          { className: "ft-svg", width: layout.width, height: layout.height, "aria-hidden": true },
          edges.map((e) =>
            h("path", {
              key: e.key,
              d: e.d,
              fill: "none",
              stroke: color(e.s),
              strokeWidth: e.s === "confirmed" ? 2 : 1.25,
              strokeDasharray: e.s === "ruled" ? "4 3" : undefined,
              opacity: e.dim ? 0.25 : 1,
            }),
          ),
          nodes.map((n) => {
            const p = layout.pos[n.id];
            const t = p.y + BOX_H + STEM;
            const s = ev[n.id];
            const c = color(s);
            const dim = hl && !hl.has(n.id);
            const path = symbolPath(n.kind, n.gate, p.x, t);
            const fill = s === "confirmed" ? "var(--ft-hot-soft)" : "var(--surface)";
            return h(
              "g",
              { key: n.id, opacity: dim ? 0.3 : 1 },
              h("line", { x1: p.x, y1: p.y + BOX_H, x2: p.x, y2: t, stroke: c, strokeWidth: 1.25 }),
              path
                ? h("path", { d: path, fill, stroke: c, strokeWidth: 1.5, strokeLinejoin: "round" })
                : h("circle", { cx: p.x, cy: t + 11, r: 10, fill, stroke: c, strokeWidth: 1.5 }),
              !isLeaf(n) &&
                h(
                  "text",
                  {
                    x: p.x,
                    y: t + (n.gate === "and" ? 17 : 15),
                    textAnchor: "middle",
                    className: "ft-gate-text",
                    fill: c,
                  },
                  n.gate === "and" ? "与" : "或",
                ),
              n.kind === "basic" &&
                s !== "open" &&
                h(
                  "text",
                  { x: p.x, y: t + 15, textAnchor: "middle", className: "ft-gate-text", fill: c },
                  s === "confirmed" ? "✓" : "✕",
                ),
            );
          }),
        ),
        nodes.map((n) =>
          h(NodeCard, {
            key: n.id,
            tree,
            n,
            pos: layout.pos[n.id],
            status: ev[n.id],
            selected: selected === n.id,
            editing: editing === n.id,
            dim: hl && !hl.has(n.id),
            onSelect,
            setEditing,
            ops,
          }),
        ),
      ),
      h(
        "div",
        { className: "ft-zoom" },
        h("button", { title: "缩小", onClick: () => zoomAt(1 / 1.2, (r?.width ?? 800) / 2, (r?.height ?? 600) / 2) }, "−"),
        h("span", { className: "ft-zoom-k" }, `${Math.round(view.k * 100)}%`),
        h("button", { title: "放大", onClick: () => zoomAt(1.2, (r?.width ?? 800) / 2, (r?.height ?? 600) / 2) }, "+"),
        h("button", { title: "整棵树放进视野", onClick: fit }, "适应"),
      ),
      h(
        "div",
        { className: "ft-keys" },
        "Tab 子原因 · ↵ 同级 · 空格 改名 · ⌫ 删除 · ⌥←→ 调顺序 · ⌘Z 撤销 · 拖空白处平移 · ⌘ + 滚轮缩放",
      ),
    );
  }

  function NodeCard({ tree, n, pos, status, selected, editing, dim, onSelect, setEditing, ops }) {
    const top = n.kind === "top";
    const cls = [
      "ft-node",
      top && "ft-node-top",
      selected && "ft-sel",
      status === "confirmed" && "ft-hot",
      status === "ruled" && "ft-ruled",
      dim && "ft-faded",
    ]
      .filter(Boolean)
      .join(" ");
    const tag = top ? KIND_LABELS.top : isLeaf(n) ? KIND_LABELS[n.kind] : `${KIND_LABELS.intermediate}`;
    return h(
      "div",
      {
        className: cls,
        style: { left: pos.x - NODE_W / 2, top: pos.y, width: NODE_W, height: BOX_H },
        onPointerDown: (e) => e.stopPropagation(),
        onClick: (e) => {
          e.stopPropagation();
          onSelect(n.id);
        },
        onDoubleClick: (e) => {
          e.stopPropagation();
          onSelect(n.id);
          setEditing(n.id);
        },
        "data-node": n.id,
      },
      h(
        "div",
        { className: "ft-node-head" },
        h("span", { className: "ft-node-kind" }, tag),
        n.itemRef && h("span", { className: "ft-node-link", title: "关联了一条事项" }, "事项"),
        status !== "open" &&
          h("span", { className: `ft-node-st ft-st-${status}` }, STATUS_LABELS[status]),
      ),
      editing
        ? h(DraftText, {
            value: n.label,
            className: "ft-node-edit",
            autoFocus: true,
            placeholder: top ? "不希望发生的那件事" : "这个原因是什么？",
            onCommit: (label) => ops.update(n.id, { label }),
            rows: 2,
          })
        : h(
            "div",
            { className: `ft-node-label${n.label ? "" : " ft-empty"}` },
            n.label || (top ? "写下顶事件…" : "双击写下这个原因…"),
          ),
      editing && h(EditCloser, { onDone: () => setEditing(null) }),
      selected &&
        !editing &&
        h(
          "div",
          { className: "ft-tools", onClick: (e) => e.stopPropagation() },
          h("button", { title: "往下拆一层（Tab）", onClick: () => ops.addChild(n.id) }, "＋ 子原因"),
          !top && h("button", { title: "加一个并列的原因（↵）", onClick: () => ops.addSibling(n.id) }, "＋ 同级"),
          !top && h("button", { className: "ft-danger", title: "删掉这个事件和它下面的整枝（⌫）", onClick: () => ops.remove(n.id) }, "删除"),
        ),
    );
  }

  /** 编辑框失焦（提交或取消）后退出编辑态 */
  function EditCloser({ onDone }) {
    useEffect(() => {
      const onFocusOut = (e) => {
        if (e.target?.classList?.contains("ft-node-edit")) setTimeout(onDone, 0);
      };
      document.addEventListener("focusout", onFocusOut);
      return () => document.removeEventListener("focusout", onFocusOut);
    }, [onDone]);
    return null;
  }

  /* ---------------- 右栏：属性 + 分析 ---------------- */

  function Inspector({ tree, selected, items, onSelect, setHighlight, ops }) {
    const n = selected ? tree.nodes[selected] : null;
    const ev = useMemo(() => evaluate(tree), [tree]);
    const cuts = useMemo(() => minimalCutSets(tree), [tree]);
    const byRef = useMemo(() => new Map(items.map((it) => [itemRef(it), it])), [items]);
    const usedRefs = new Set(Object.values(tree.nodes).map((x) => x.itemRef).filter(Boolean));

    const leaves = Object.values(tree.nodes).filter(isLeaf);
    const counts = { open: 0, confirmed: 0, ruled: 0 };
    for (const l of leaves) counts[l.status] += 1;
    const topState = ev[tree.root];
    const verdict =
      tree.nodes[tree.root].children.length === 0
        ? { text: "还没开始拆。选中顶事件按 Tab，写下第一层可能的原因。", tone: "" }
        : topState === "confirmed"
          ? { text: "因果链已经成立：红色那条路就是顶事件发生的原因。", tone: "hot" }
          : topState === "ruled"
            ? { text: "所有分支都被排除了 —— 真正的原因还不在这棵树上，回到上层补分支。", tone: "warn" }
            : { text: `还有 ${counts.open} 个基本 / 未展开事件待验证。先查阶数低的割集。`, tone: "" };

    const linked = n?.itemRef ? byRef.get(n.itemRef) : null;
    const candidates = items.filter((it) => !usedRefs.has(itemRef(it)));

    return h(
      "aside",
      { className: "ft-side" },
      n
        ? h(
            "section",
            { className: "ft-card" },
            h(
              "div",
              { className: "ft-card-head" },
              h("span", { className: "ft-card-title" }, n.kind === "top" ? KIND_LABELS.top : isLeaf(n) ? KIND_LABELS[n.kind] : KIND_LABELS.intermediate),
              h("span", { className: `ft-pill ft-st-${ev[n.id]}` }, STATUS_LABELS[ev[n.id]]),
            ),
            h(DraftText, {
              key: `label-${n.id}`,
              value: n.label,
              rows: 3,
              placeholder: n.kind === "top" ? "不希望发生的那件事" : "这个原因是什么？",
              onCommit: (label) => ops.update(n.id, { label }),
            }),

            !isLeaf(n) && n.children.length > 0 &&
              h(
                Field,
                { label: "门", hint: n.gate === "and" ? "所有输入同时发生，才导致这一层" : "任一输入发生，就导致这一层" },
                h(Seg, {
                  value: n.gate,
                  onChange: (gate) => ops.update(n.id, { gate }),
                  options: [
                    { value: "or", label: "或门 OR" },
                    { value: "and", label: "与门 AND" },
                  ],
                }),
              ),

            isLeaf(n) &&
              h(
                Field,
                { label: "事件类型", hint: n.kind === "basic" ? "拆到底了，可以直接去验证" : "暂时不往下拆：信息不够，或者不值得拆" },
                h(Seg, {
                  value: n.kind,
                  onChange: (kind) => ops.update(n.id, { kind }),
                  options: [
                    { value: "basic", label: "○ 基本事件" },
                    { value: "undeveloped", label: "◇ 未展开" },
                  ],
                }),
              ),

            isLeaf(n) &&
              h(
                Field,
                { label: "验证", hint: "确认或排除后，上层按门的逻辑自动推出结论" },
                h(Seg, {
                  value: n.status,
                  onChange: (status) => ops.update(n.id, { status }),
                  options: [
                    { value: "open", label: "待验证" },
                    { value: "confirmed", label: "已确认", color: "var(--ft-hot)" },
                    { value: "ruled", label: "已排除" },
                  ],
                }),
              ),

            h(
              Field,
              { label: "证据 / 验证方法" },
              h(DraftText, {
                key: `note-${n.id}`,
                value: n.note,
                rows: 3,
                placeholder: "怎么验证的、看到了什么、谁确认的",
                onCommit: (note) => ops.update(n.id, { note }),
              }),
            ),

            h(
              Field,
              { label: "关联事项" },
              n.itemRef
                ? h(
                    "div",
                    { className: "ft-linked" },
                    h(
                      "span",
                      { className: "ft-linked-text" },
                      linked
                        ? h(React.Fragment, null, h("b", null, linked.kindLabel), " ", linked.title, linked.closed ? "（已关闭）" : "")
                        : "那条事项已经不在了",
                    ),
                    h("button", { className: "ft-link-btn", onClick: () => ops.update(n.id, { itemRef: null }) }, "解除"),
                  )
                : h(ItemPicker, {
                    items: candidates,
                    placeholder: "把一条事项关联到这个事件…",
                    onPick: (it) => ops.update(n.id, { itemRef: itemRef(it), label: n.label || it.title }),
                  }),
            ),

            h(
              "div",
              { className: "ft-actions" },
              h("button", { onClick: () => ops.addChild(n.id) }, "＋ 子原因"),
              n.kind !== "top" && h("button", { onClick: () => ops.addSibling(n.id) }, "＋ 同级"),
              n.kind !== "top" && h("button", { className: "ft-danger", onClick: () => ops.remove(n.id) }, "删除"),
              h(ItemPicker, {
                items: candidates,
                placeholder: "＋ 从事项添加子原因…",
                onPick: (it) => ops.addChild(n.id, { label: it.title, itemRef: itemRef(it) }),
              }),
            ),
          )
        : h(
            "section",
            { className: "ft-card ft-card-hint" },
            "点选一个事件编辑它。双击直接改名，Tab 往下拆一层。",
          ),

      h(
        "section",
        { className: "ft-card" },
        h("div", { className: "ft-card-head" }, h("span", { className: "ft-card-title" }, "分析")),
        h("p", { className: `ft-verdict${verdict.tone ? ` ft-verdict-${verdict.tone}` : ""}` }, verdict.text),
        h(
          "div",
          { className: "ft-tally" },
          h("span", null, h("b", null, leaves.length), " 个叶子事件"),
          h("span", { className: "ft-st-confirmed" }, `已确认 ${counts.confirmed}`),
          h("span", { className: "ft-st-ruled" }, `已排除 ${counts.ruled}`),
          h("span", null, `待验证 ${counts.open}`),
        ),
        h(
          "div",
          { className: "ft-sub" },
          "最小割集",
          h("span", { className: "ft-sub-hint" }, "能单独导致顶事件的最小原因组合，阶数越低越该先查"),
        ),
        cuts.sets.length === 0
          ? h("p", { className: "ft-muted" }, "拆出第一层原因之后，这里列出割集。")
          : h(
              "ol",
              { className: "ft-cuts", onPointerLeave: () => setHighlight(null) },
              cuts.sets.map((set) => {
                const st = cutSetStatus(tree, set);
                return h(
                  "li",
                  {
                    key: set.join(","),
                    className: `ft-cut ft-cut-${st}`,
                    onPointerEnter: () => setHighlight(set),
                    onClick: () => onSelect(set[0]),
                    title: "悬停在画布上高亮，点一下选中",
                  },
                  h("span", { className: "ft-cut-order" }, `${set.length} 阶`),
                  h(
                    "span",
                    { className: "ft-cut-body" },
                    set.map((id, j) =>
                      h(
                        React.Fragment,
                        { key: id },
                        j > 0 && h("span", { className: "ft-cut-and" }, " + "),
                        h("span", { className: `ft-cut-ev ft-st-${tree.nodes[id].status}` }, tree.nodes[id].label || "（未填写）"),
                      ),
                    ),
                  ),
                  h("span", { className: "ft-cut-st" }, st === "confirmed" ? "成立" : st === "ruled" ? "排除" : "待查"),
                );
              }),
            ),
        cuts.truncated && h("p", { className: "ft-muted" }, `组合太多，只列出前 ${cuts.sets.length} 个。`),
      ),

      h(
        "section",
        { className: "ft-card ft-legend" },
        h(Legend, { kind: "gate-or", text: "或门：任一输入发生即导致上层" }),
        h(Legend, { kind: "gate-and", text: "与门：所有输入同时发生才导致" }),
        h(Legend, { kind: "basic", text: "基本事件：拆到底、可直接验证" }),
        h(Legend, { kind: "undeveloped", text: "未展开事件：暂不往下拆" }),
      ),
    );
  }

  function Field({ label, hint, children }) {
    return h(
      "div",
      { className: "ft-field" },
      h("div", { className: "ft-field-label" }, label, hint && h("span", { className: "ft-field-hint" }, hint)),
      children,
    );
  }

  function ItemPicker({ items, onPick, placeholder }) {
    return h(
      "select",
      {
        className: "ft-picker",
        value: "",
        disabled: items.length === 0,
        title: items.length === 0 ? "这个项目里没有还没用上的事项" : undefined,
        onChange: (e) => {
          const it = items.find((x) => x.key === e.target.value);
          if (it) onPick(it);
        },
      },
      h("option", { value: "" }, items.length === 0 ? "（没有可关联的事项）" : placeholder),
      items.map((it) =>
        h("option", { key: it.key, value: it.key }, `[${it.kindLabel}] ${it.title}${it.closed ? "（已关闭）" : ""}`),
      ),
    );
  }

  function Legend({ kind, text }) {
    const path =
      kind === "gate-or"
        ? symbolPath("intermediate", "or", 13, 1)
        : kind === "gate-and"
          ? symbolPath("intermediate", "and", 13, 1)
          : kind === "undeveloped"
            ? symbolPath("undeveloped", null, 13, 1)
            : null;
    return h(
      "div",
      { className: "ft-legend-row" },
      h(
        "svg",
        { width: 26, height: 24, "aria-hidden": true },
        path
          ? h("path", { d: path, fill: "none", stroke: "currentColor", strokeWidth: 1.4 })
          : h("circle", { cx: 13, cy: 12, r: 10, fill: "none", stroke: "currentColor", strokeWidth: 1.4 }),
      ),
      h("span", null, text),
    );
  }

  /* ---------------- 整页 ---------------- */

  function FaultTreeView() {
    useShared();
    const [itemsVersion, setItemsVersion] = useState(0);
    useEffect(() => api.data.items.subscribe(() => setItemsVersion((v) => v + 1)), []);
    const items = useMemo(() => api.data.items.list(), [itemsVersion]);

    const [selected, setSelected] = useState(null);
    const [editing, setEditing] = useState(null);
    const [highlight, setHighlight] = useState(null);
    const [copied, setCopied] = useState(false);

    const project = api.data.project();
    const trees = project ? treesOf(project.id) : [];
    const tree = trees.find((t) => t.id === state.activeTree) ?? trees[0] ?? null;

    // 换树时清掉选中
    useEffect(() => {
      setSelected(tree ? tree.root : null);
      setEditing(null);
      setHighlight(null);
    }, [tree?.id]);
    // 选中的节点被删 / 被撤销掉了
    useEffect(() => {
      if (tree && selected && !tree.nodes[selected]) setSelected(tree.root);
    }, [tree, selected]);

    const canvasFocus = () =>
      setTimeout(() => document.querySelector('[data-plugin="fault-tree"] .ft-canvas, .ft-canvas')?.focus(), 0);

    const ops = useMemo(() => {
      if (!tree) return null;
      const id = tree.id;
      const current = () => state.store.trees.find((t) => t.id === id);
      const addWith = (fn) => {
        const t = current();
        if (!t) return;
        const r = fn(t);
        if (!r.id) return;
        mutateTree(id, () => r.tree);
        setSelected(r.id);
        if (!r.tree.nodes[r.id].label) setEditing(r.id);
      };
      return {
        addChild: (nid, init) => addWith((t) => addChild(t, nid, init)),
        addSibling: (nid, init) => addWith((t) => addSibling(t, nid, init)),
        update: (nid, patch) => mutateTree(id, (t) => updateNode(t, nid, patch)),
        move: (nid, d) => mutateTree(id, (t) => moveNode(t, nid, d)),
        remove: (nid) => {
          const t = current();
          if (!t || nid === t.root) return;
          const parent = parentOf(t, nid);
          const sibs = parent?.children ?? [];
          const i = sibs.indexOf(nid);
          mutateTree(id, (x) => removeNode(x, nid));
          setSelected(sibs[i + 1] ?? sibs[i - 1] ?? parent?.id ?? t.root);
          canvasFocus();
        },
        undo: () => step(undo, redo),
        redo: () => step(redo, undo),
      };
    }, [tree?.id]);

    if (!project) {
      return h("div", { className: "ft-root ft-center" }, "先打开一个项目。");
    }
    if (!state.loaded) {
      return h("div", { className: "ft-root ft-center" }, "正在读取…");
    }

    const header = h(
      "header",
      { className: "ft-bar" },
      h("span", { className: "ft-h1" }, "故障树"),
      h(
        "div",
        { className: "ft-tabs", role: "tablist" },
        trees.map((t) => {
          const ev = evaluate(t)[t.root];
          return h(
            "button",
            {
              key: t.id,
              role: "tab",
              "aria-selected": tree?.id === t.id,
              className: `ft-tab${tree?.id === t.id ? " ft-on" : ""}`,
              title: treeTitle(t),
              onClick: () => {
                state.activeTree = t.id;
                notify();
              },
            },
            h("span", { className: `ft-tab-dot ft-dot-${ev}` }),
            h("span", { className: "ft-tab-text" }, treeTitle(t)),
          );
        }),
        h(
          "button",
          {
            className: "ft-tab ft-tab-new",
            title: "不从事项出发，直接写一个顶事件",
            onClick: () => {
              createTree("", null);
            },
          },
          "＋ 新建",
        ),
      ),
      tree &&
        h(
          "div",
          { className: "ft-bar-right" },
          h(
            "button",
            {
              className: "ft-btn",
              title: "把整棵树复制成缩进大纲，贴进周报或邮件",
              onClick: async () => {
                try {
                  await navigator.clipboard.writeText(outline(tree));
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch (e) {
                  api.log("复制失败", e);
                }
              },
            },
            copied ? "✓ 已复制" : "复制大纲",
          ),
          h(
            "button",
            {
              className: "ft-btn ft-danger",
              onClick: () => {
                if (!window.confirm(`删除故障树「${treeTitle(tree)}」？关联的事项不受影响。`)) return;
                setStore({ ...state.store, trees: state.store.trees.filter((t) => t.id !== tree.id) });
                state.activeTree = null;
                notify();
              },
            },
            "删除这棵树",
          ),
        ),
    );

    if (!tree) {
      return h(
        "div",
        { className: "ft-root" },
        header,
        h(
          "div",
          { className: "ft-empty-state" },
          h(EmptyArt),
          h("h2", null, "从一个问题出发，往下问「为什么」"),
          h(
            "p",
            null,
            "在「事项」页对一条问题或阻碍点 ⋯ →「建故障树分析」，它就成为顶事件。",
            h("br"),
            "然后用或门、与门一层层拆到基本事件，逐个确认或排除。",
          ),
          h("button", { className: "ft-btn ft-primary", onClick: () => createTree("", null) }, "直接新建一棵"),
        ),
      );
    }

    const topRef = tree.nodes[tree.root].itemRef;
    const topItem = topRef ? items.find((it) => itemRef(it) === topRef) : null;

    return h(
      "div",
      { className: "ft-root" },
      header,
      topItem &&
        h(
          "div",
          { className: "ft-source" },
          "顶事件来自事项 ",
          h("b", null, topItem.kindLabel),
          ` · ${topItem.day}`,
          topItem.taskName ? ` · 任务：${topItem.taskName}` : "",
          topItem.personName ? ` · ${topItem.personName}` : "",
          topItem.closed ? " · 已关闭" : "",
        ),
      h(
        "div",
        { className: "ft-body" },
        h(Canvas, {
          tree,
          selected,
          onSelect: (id) => {
            setSelected(id);
            setEditing(null);
          },
          editing,
          setEditing: (id) => {
            setEditing(id);
            if (id == null) canvasFocus();
          },
          highlight,
          ops,
        }),
        h(Inspector, {
          tree,
          selected,
          items,
          onSelect: setSelected,
          setHighlight,
          ops,
        }),
      ),
    );
  }

  function EmptyArt() {
    // 一棵小故障树：顶事件 → 或门 → 两个基本事件
    return h(
      "svg",
      { width: 120, height: 92, viewBox: "0 0 120 92", className: "ft-empty-art", "aria-hidden": true },
      h("rect", { x: 30, y: 2, width: 60, height: 20, rx: 4, fill: "none", stroke: "currentColor" }),
      h("line", { x1: 60, y1: 22, x2: 60, y2: 28, stroke: "currentColor" }),
      h("path", { d: symbolPath("intermediate", "or", 60, 28), fill: "none", stroke: "currentColor" }),
      h("path", { d: "M60,46 V58 H28 V66 M60,58 H92 V66", fill: "none", stroke: "currentColor" }),
      h("circle", { cx: 28, cy: 77, r: 10, fill: "none", stroke: "currentColor" }),
      h("circle", { cx: 92, cy: 77, r: 10, fill: "var(--ft-hot)", stroke: "var(--ft-hot)" }),
    );
  }

  api.views.register(
    {
      type: "fault-tree.view",
      label: "故障树",
      hint: "这个问题到底是怎么发生的 —— 从顶事件拆到基本原因，逐个验证、排除",
    },
    FaultTreeView,
  );
}

export function onunload() {}
