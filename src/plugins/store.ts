/**
 * 在线插件：解析 GitHub 上 supergantt-plugins 仓库的 index.json，
 * 决定每一行显示「安装 / 更新 / 已安装 / 需要升级应用」，以及装之前要不要确认权限。
 *
 * 纯函数、不碰 IO。联网、校验 sha256、解压在 Rust 侧（src-tauri/src/plugin_store.rs）。
 *
 * index.json 由插件仓库的 CI 生成（scripts/build-index.mjs），每个插件只列最新版。
 */

import type { PluginManifest, Version } from "./types";
import { HOST_API_VERSION, compareVersions, parseVersion } from "./manifest";

export interface StoreEntry {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  author?: string;
  description?: string;
  /** 搜索用的关键词（manifest 的 keywords） */
  keywords: string[];
  /** 插件目录的 README.md，市场详情页显示。没有为空串 */
  readme: string;
  /** 能运行的本机程序（manifest 的 permissions.exec） */
  exec: string[];
  /** 会把项目数据发给 Claude（manifest 的 permissions.ai） */
  ai: boolean;
  /** 启用时要链接进 ~/.claude/skills 的 Skill 名 */
  skills: string[];
  download: { url: string; sha256: string; size: number };
}

export interface StoreIndex {
  updatedAt: string | null;
  plugins: StoreEntry[];
  /** 认不出、被跳过的条目，给开发者排查用 */
  skipped: string[];
}

const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const SHA256 = /^[0-9a-f]{64}$/i;

const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter(str) : []);

/**
 * 解析 index.json。整体格式不对就抛错；单个条目不对只跳过它 ——
 * 一个插件发坏了，不该让其余的也装不了
 */
export function parseIndex(raw: string): StoreIndex {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("插件列表不是合法的 JSON");
  }
  const root = json as Record<string, unknown> | null;
  if (!root || typeof root !== "object" || !Array.isArray(root.plugins)) {
    throw new Error("插件列表格式不对：缺少 plugins");
  }
  if (root.schema !== 1) {
    throw new Error(`插件列表的格式版本是 ${String(root.schema)}，这个版本的应用只认 1 —— 升级应用后再试`);
  }

  const plugins: StoreEntry[] = [];
  const skipped: string[] = [];
  for (const item of root.plugins as unknown[]) {
    const p = (item ?? {}) as Record<string, unknown>;
    const d = (p.download ?? {}) as Record<string, unknown>;
    const perms = (p.permissions ?? {}) as Record<string, unknown>;
    const ok =
      str(p.id) &&
      ID_PATTERN.test(p.id) &&
      str(p.name) &&
      str(p.version) &&
      str(p.apiVersion) &&
      str(d.url) &&
      str(d.sha256) &&
      SHA256.test(d.sha256);
    if (!ok) {
      skipped.push(str(p.id) ? p.id : "（没有 id）");
      continue;
    }
    plugins.push({
      id: p.id as string,
      name: p.name as string,
      version: p.version as string,
      apiVersion: p.apiVersion as string,
      author: str(p.author) ? p.author : undefined,
      description: str(p.description) ? p.description : undefined,
      keywords: strList(p.keywords),
      readme: typeof p.readme === "string" ? p.readme : "",
      exec: strList(perms.exec),
      ai: perms.ai === true,
      skills: strList(p.skills),
      download: {
        url: d.url as string,
        sha256: (d.sha256 as string).toLowerCase(),
        size: typeof d.size === "number" ? d.size : 0,
      },
    });
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return { updatedAt: str(root.updatedAt) ? root.updatedAt : null, plugins, skipped };
}

/**
 * 这个版本的应用能不能装它。
 *
 * 比加载时（validateManifest）严：加载时插件要的次版本比宿主新只是警告，
 * 因为插件已经在机器上了，能跑多少算多少；下载是还没装，装上一个注定缺接口的版本
 * 不如直接告诉人「先升级应用」。
 */
export function incompatibility(entry: StoreEntry, host: Version = HOST_API_VERSION): string | null {
  const need = parseVersion(entry.apiVersion);
  if (!need) return `插件的 apiVersion「${entry.apiVersion}」看不懂`;
  if (need.major !== host.major || need.minor > host.minor) {
    return `需要插件接口 ${need.major}.${need.minor}，当前应用是 ${host.major}.${host.minor} —— 升级 SuperGantt 后才能安装`;
  }
  return null;
}

export type RowState =
  | { kind: "install" }
  | { kind: "update"; from: string }
  | { kind: "current" }
  /** 本机装的比列表里的还新（开发中、或者列表还没更新） */
  | { kind: "newer"; installed: string }
  | { kind: "incompatible"; reason: string }
  /** 同 id 在开发目录里：在线安装会被源码那份盖住，不提供 */
  | { kind: "dev" };

export interface Installed {
  version: string;
  dev: boolean;
}

export function rowState(
  entry: StoreEntry,
  installed: Installed | undefined,
  host: Version = HOST_API_VERSION,
): RowState {
  if (installed?.dev) return { kind: "dev" };
  if (installed) {
    const d = compareVersions(entry.version, installed.version);
    if (d === 0) return { kind: "current" };
    if (d < 0) return { kind: "newer", installed: installed.version };
  }
  // 已安装的也要先过兼容检查：「更新」到一个跑不起来的版本等于卸载
  const reason = incompatibility(entry, host);
  if (reason) return { kind: "incompatible", reason };
  return installed ? { kind: "update", from: installed.version } : { kind: "install" };
}

export interface PermissionAsk {
  /** 要列出来请用户确认的程序 */
  exec: string[];
  skills: string[];
  /** 会把项目数据发给 Claude */
  ai: boolean;
  /** 是更新时新增的（而不是新装时的全部） */
  added: boolean;
}

/**
 * 装之前要不要确认、确认什么。
 *
 * - 新装：总要确认（插件能读全部数据），列出它全部的程序和 Skill
 * - 更新：只有程序或 Skill 变多了才确认，只列新增的；没变就直接更新
 *
 * 返回 null = 不用问
 */
export function permissionAsk(
  entry: StoreEntry,
  installed: Pick<PluginManifest, "permissions" | "skills"> | null,
): PermissionAsk | null {
  if (!installed) return { exec: entry.exec, skills: entry.skills, ai: entry.ai, added: false };
  const hadExec = new Set(installed.permissions?.exec ?? []);
  const hadSkills = new Set((installed.skills ?? []).map((s) => s.name));
  const exec = entry.exec.filter((p) => !hadExec.has(p));
  const skills = entry.skills.filter((s) => !hadSkills.has(s));
  const ai = entry.ai && !installed.permissions?.ai;
  return exec.length || skills.length || ai ? { exec, skills, ai, added: true } : null;
}

/** 设置里存下载加速前缀的 key */
export const MIRROR_SETTING = "plugin_store.mirror";

/** 前缀要么空，要么 https:// 开头。Rust 侧还会再查一次 */
export function mirrorProblem(raw: string): string | null {
  const m = raw.trim();
  if (!m) return null;
  if (!/^https:\/\/[^\s/]+/.test(m)) return "要以 https:// 开头，例如 https://ghproxy.net/";
  return null;
}

/* ------------------------------------------------------------------ */
/* 搜索                                                                */
/* ------------------------------------------------------------------ */

/** 能被搜到的字段。已安装但不在列表里的插件也走这个形状 */
export interface Searchable {
  id: string;
  name: string;
  description?: string;
  keywords?: string[];
  author?: string;
}

/**
 * 本地搜索：插件全在 index.json 里，打开市场时拉一次，之后边打边筛，不再联网。
 *
 * 空格分开的每个词都要命中（与）。按命中位置排：名字 > id / 关键词 > 描述 > 作者，
 * 同分保持原顺序。大小写不敏感
 */
export function searchPlugins<T extends Searchable>(list: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return list;

  const scored: { item: T; score: number; i: number }[] = [];
  list.forEach((item, i) => {
    const name = item.name.toLowerCase();
    const id = item.id.toLowerCase();
    const kw = (item.keywords ?? []).map((k) => k.toLowerCase());
    const desc = (item.description ?? "").toLowerCase();
    const author = (item.author ?? "").toLowerCase();
    let score = 0;
    for (const w of words) {
      const s = name.startsWith(w)
        ? 100
        : name.includes(w)
          ? 80
          : id.includes(w) || kw.some((k) => k.includes(w))
            ? 50
            : desc.includes(w)
              ? 20
              : author.includes(w)
                ? 10
                : 0;
      if (s === 0) return;
      score += s;
    }
    scored.push({ item, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.item);
}
