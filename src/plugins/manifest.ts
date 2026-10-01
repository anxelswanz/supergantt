/**
 * manifest.json 的校验。
 *
 * 纯函数，不碰 IO —— 这样每一条规则都能在 vitest 里直接测，不用起 Tauri。
 * 拆出来的另一个理由：错误信息是给插件作者看的，必须说清楚「哪个字段、
 * 什么问题、应该是什么」。一个「manifest 无效」的笼统报错会让人在
 * 一个 20 行的 JSON 里逐字对比半小时。
 */

import type { PluginManifest, PluginViewDeclaration, Version } from "./types";
import { APP_VIEWS } from "../core/views";

/**
 * 宿主当前提供的 API 版本。
 *
 * 规则（与项目文件格式一致，DESIGN.md 变更 5）：
 *   - 删字段、改语义 → major + 1，旧插件拒绝加载
 *   - 只加新方法 → minor + 1，旧插件照常跑
 */
export const HOST_API_VERSION: Version = { major: 1, minor: 0 };

/**
 * 内置视图的 key。插件视图不能用这些，否则会把甘特图顶掉。
 *
 * 直接从 core/views.ts 读，不再抄一份 ——
 * 抄一份的后果是加了第五个内置视图之后，插件仍然能注册 "items" 把它顶掉，
 * 而那种冲突只在「装了那个插件」的机器上复现。
 */
const RESERVED_VIEW_TYPES = new Set<string>(APP_VIEWS.map((v) => v.key));

/**
 * 插件 id 的形状：小写字母、数字、连字符，字母开头。
 *
 * 这么严是因为 id 会出现在三个地方：目录名、settings 表的 key 前缀、
 * 视图 type 的前缀。任何一处出现空格、斜杠或点都会各自出一种 bug ——
 * 在入口处拦住比在三处分别转义省事得多。
 */
const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

export type ValidationResult =
  | { ok: true; manifest: PluginManifest; warnings: string[] }
  | { ok: false; error: string };

/** "1.2" → {1, 2}。只认两段，第三段（patch）有也忽略 */
export function parseVersion(raw: string): Version | null {
  const m = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/**
 * 校验 manifest。
 *
 * @param raw     manifest.json 的原文；null 表示文件不存在
 * @param dirName 所在目录名，id 必须和它一致
 * @param host    宿主 API 版本，测试时可以注入
 */
export function validateManifest(
  raw: string | null,
  dirName: string,
  host: Version = HOST_API_VERSION,
): ValidationResult {
  if (raw == null) {
    return { ok: false, error: "缺少 manifest.json" };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    // 把 JSON.parse 的原始报错带出来 —— 它通常会说是第几个字符出的问题
    return { ok: false, error: `manifest.json 不是合法的 JSON：${(e as Error).message}` };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { ok: false, error: "manifest.json 的顶层必须是一个对象" };
  }
  const m = json as Record<string, unknown>;
  const warnings: string[] = [];

  /* ---------------- 必填字段 ---------------- */

  for (const key of ["id", "name", "version", "apiVersion"] as const) {
    if (!str(m[key])) {
      return { ok: false, error: `manifest.json 缺少 "${key}" 字段，或者它不是非空字符串` };
    }
  }
  const id = m.id as string;

  if (!ID_PATTERN.test(id)) {
    return {
      ok: false,
      error: `id "${id}" 不合法：只能用小写字母、数字和连字符，字母开头，2–64 个字符`,
    };
  }
  if (id !== dirName) {
    return {
      ok: false,
      error: `id "${id}" 和所在目录名 "${dirName}" 不一致 —— 把目录改名成 "${id}"，或者把 id 改成 "${dirName}"`,
    };
  }

  /* ---------------- 版本兼容 ---------------- */

  const need = parseVersion(m.apiVersion as string);
  if (!need) {
    return {
      ok: false,
      error: `apiVersion "${m.apiVersion}" 看不懂，应该写成 "1.0" 这样的形式`,
    };
  }
  if (need.major !== host.major) {
    return {
      ok: false,
      error: `插件需要宿主 API ${need.major}.x，当前是 ${host.major}.${host.minor} —— 主版本不同，接口可能已经变了`,
    };
  }
  if (need.minor > host.minor) {
    // 插件用了比宿主新的 minor —— 它可能调用宿主还没有的方法。
    // 不拒绝：大部分插件只用到老方法，拒绝的话宿主一落后就全挂。
    // 但必须说出来，否则某个按钮点了没反应时没人会想到是版本问题
    warnings.push(
      `插件按宿主 API ${need.major}.${need.minor} 写的，当前是 ${host.major}.${host.minor}，新接口可能不可用`,
    );
  }

  /* ---------------- 可选字段 ---------------- */

  if (m.main !== undefined) {
    if (!str(m.main)) return { ok: false, error: `"main" 必须是非空字符串` };
    // 只允许插件目录下的一层文件名。允许 "../" 等于允许读任意文件
    if (/[\\/]|\.\./.test(m.main as string)) {
      return { ok: false, error: `"main" 只能是插件目录里的文件名，不能带路径：${m.main}` };
    }
  }

  const views: PluginViewDeclaration[] = [];
  if (m.views !== undefined) {
    if (!Array.isArray(m.views)) return { ok: false, error: `"views" 必须是数组` };
    const seen = new Set<string>();
    for (const [i, v] of m.views.entries()) {
      const at = `views[${i}]`;
      if (typeof v !== "object" || v === null) return { ok: false, error: `${at} 必须是对象` };
      const vv = v as Record<string, unknown>;
      for (const key of ["type", "label", "hint"] as const) {
        if (!str(vv[key])) return { ok: false, error: `${at} 缺少 "${key}"` };
      }
      const type = vv.type as string;
      if (RESERVED_VIEW_TYPES.has(type)) {
        return { ok: false, error: `${at}.type "${type}" 是内置视图的名字，换一个` };
      }
      if (seen.has(type)) return { ok: false, error: `${at}.type "${type}" 重复了` };
      seen.add(type);
      if (!type.startsWith(`${id}.`)) {
        // 不强制，但强烈建议 —— 两个插件都注册 "notes" 视图时只有前缀能救
        warnings.push(`视图 "${type}" 没有用 "${id}." 作前缀，可能和别的插件撞名`);
      }
      views.push({ type, label: vv.label as string, hint: vv.hint as string });
    }
  }

  return {
    ok: true,
    warnings,
    manifest: {
      id,
      name: (m.name as string).trim(),
      version: (m.version as string).trim(),
      apiVersion: (m.apiVersion as string).trim(),
      author: str(m.author) ? m.author : undefined,
      description: str(m.description) ? m.description : undefined,
      main: str(m.main) ? m.main : undefined,
      views,
    },
  };
}
