import { describe, expect, it } from "vitest";
import {
  incompatibility,
  mirrorProblem,
  parseIndex,
  permissionAsk,
  rowState,
  searchPlugins,
  type StoreEntry,
} from "./store";

const SHA = "a".repeat(64);

const entry = (over: Partial<StoreEntry> = {}): StoreEntry => ({
  id: "feishu-sync",
  name: "飞书同步",
  version: "1.6.0",
  apiVersion: "1.2",
  keywords: [],
  readme: "",
  exec: ["claude", "lark-cli"],
  ai: false,
  skills: ["gantt-feishu"],
  download: { url: "https://github.com/x/y/releases/download/feishu-sync-v1.6.0/f.zip", sha256: SHA, size: 1 },
  ...over,
});

const index = (plugins: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ schema: 1, updatedAt: "2026-10-30T00:00:00Z", plugins, ...extra });

describe("parseIndex", () => {
  it("读出插件，权限和 Skill 拍平成列表", () => {
    const got = parseIndex(
      index([
        {
          id: "feishu-sync",
          name: "飞书同步",
          version: "1.6.0",
          apiVersion: "1.2",
          permissions: { exec: ["claude"] },
          skills: ["gantt-feishu"],
          download: { url: "https://x", sha256: SHA.toUpperCase(), size: 10 },
        },
      ]),
    );
    expect(got.plugins).toHaveLength(1);
    expect(got.plugins[0]).toMatchObject({ exec: ["claude"], skills: ["gantt-feishu"] });
    // sha 统一成小写，和 Rust 侧算出来的比
    expect(got.plugins[0].download.sha256).toBe(SHA);
    expect(got.updatedAt).toBe("2026-10-30T00:00:00Z");
  });

  it("坏一条只跳过那一条", () => {
    const good = { id: "a-b", name: "A", version: "1.0.0", apiVersion: "1.0", download: { url: "u", sha256: SHA } };
    const got = parseIndex(index([good, { ...good, id: "Bad Id" }, { ...good, id: "no-sha", download: { url: "u" } }]));
    expect(got.plugins.map((p) => p.id)).toEqual(["a-b"]);
    expect(got.skipped).toEqual(["Bad Id", "no-sha"]);
  });

  it("整体不对就报错：不是 JSON、没有 plugins、格式版本不认识", () => {
    expect(() => parseIndex("<html>")).toThrow(/JSON/);
    expect(() => parseIndex("{}")).toThrow(/plugins/);
    expect(() => parseIndex(index([], { schema: 2 }))).toThrow(/升级应用/);
  });
});

describe("兼容性：下载比加载严", () => {
  const host = { major: 1, minor: 2 };
  it("主版本不同、或者要的次版本比应用新，都不让装", () => {
    expect(incompatibility(entry({ apiVersion: "1.2" }), host)).toBeNull();
    expect(incompatibility(entry({ apiVersion: "1.0" }), host)).toBeNull();
    expect(incompatibility(entry({ apiVersion: "1.3" }), host)).toMatch(/升级 SuperGantt/);
    expect(incompatibility(entry({ apiVersion: "2.0" }), host)).toMatch(/升级 SuperGantt/);
    expect(incompatibility(entry({ apiVersion: "x" }), host)).toMatch(/看不懂/);
  });
});

describe("rowState", () => {
  const host = { major: 1, minor: 2 };
  it("没装 → 安装；旧了 → 更新；一样 → 已安装；本机更新 → newer", () => {
    expect(rowState(entry(), undefined, host)).toEqual({ kind: "install" });
    expect(rowState(entry(), { version: "1.5.0", dev: false }, host)).toEqual({ kind: "update", from: "1.5.0" });
    expect(rowState(entry(), { version: "1.6.0", dev: false }, host)).toEqual({ kind: "current" });
    expect(rowState(entry(), { version: "1.7.0", dev: false }, host)).toEqual({ kind: "newer", installed: "1.7.0" });
  });

  it("新版本不兼容时，已安装的也不给「更新」", () => {
    expect(rowState(entry({ apiVersion: "1.9" }), { version: "1.5.0", dev: false }, host).kind).toBe("incompatible");
    // 已经是这个版本就不用管兼容
    expect(rowState(entry({ apiVersion: "1.9" }), { version: "1.6.0", dev: false }, host).kind).toBe("current");
  });

  it("开发目录里有同 id 的：不提供在线安装", () => {
    expect(rowState(entry(), { version: "0.0.1", dev: true }, host)).toEqual({ kind: "dev" });
  });
});

describe("permissionAsk", () => {
  it("新装：列出全部", () => {
    expect(permissionAsk(entry(), null)).toEqual({
      exec: ["claude", "lark-cli"],
      skills: ["gantt-feishu"],
      ai: false,
      added: false,
    });
    // 没有任何程序权限也要问：插件能读全部数据
    expect(permissionAsk(entry({ exec: [], skills: [] }), null)).toEqual({ exec: [], skills: [], ai: false, added: false });
  });

  it("更新：权限没变就不问，变多了只列新增的", () => {
    const had = { permissions: { exec: ["claude", "lark-cli"] }, skills: [{ dir: "skill", name: "gantt-feishu" }] };
    expect(permissionAsk(entry(), had)).toBeNull();
    expect(permissionAsk(entry({ exec: ["claude", "lark-cli", "gantt"] }), had)).toEqual({
      exec: ["gantt"],
      skills: [],
      ai: false,
      added: true,
    });
    // 更新后开始用 Claude：也要问
    expect(permissionAsk(entry({ ai: true }), had)).toMatchObject({ ai: true, added: true, exec: [] });
    // 变少不问
    expect(permissionAsk(entry({ exec: ["claude"] }), had)).toBeNull();
  });
});

it("下载加速前缀：空的或 https 开头", () => {
  expect(mirrorProblem("")).toBeNull();
  expect(mirrorProblem("https://ghproxy.net/")).toBeNull();
  expect(mirrorProblem("http://ghproxy.net/")).not.toBeNull();
  expect(mirrorProblem("ghproxy.net")).not.toBeNull();
});

describe("searchPlugins", () => {
  const list = [
    { id: "daily-report", name: "日报", description: "按今天记下的问题和风险生成日报", keywords: ["report"] },
    { id: "fault-tree", name: "故障树分析", description: "把问题拆到根因", keywords: ["FTA", "根因"] },
    { id: "feishu-sync", name: "飞书同步", description: "同步到飞书多维表格", keywords: ["lark"], author: "Ronghui" },
  ];
  const ids = (q: string) => searchPlugins(list, q).map((p) => p.id);

  it("空查询原样返回", () => {
    expect(ids("  ")).toEqual(["daily-report", "fault-tree", "feishu-sync"]);
  });

  it("名字、id、关键词、描述都能搜到，大小写不敏感", () => {
    expect(ids("飞书")).toEqual(["feishu-sync"]);
    expect(ids("fta")).toEqual(["fault-tree"]);
    expect(ids("LARK")).toEqual(["feishu-sync"]);
    expect(ids("tree")).toEqual(["fault-tree"]);
  });

  it("名字命中排在只有描述命中的前面", () => {
    // 「问题」只在两条的描述里；「根因」在故障树的关键词里、日报里没有
    expect(ids("问题")).toEqual(["daily-report", "fault-tree"]);
    expect(ids("日报")).toEqual(["daily-report"]);
  });

  it("多个词都要命中", () => {
    expect(ids("问题 根因")).toEqual(["fault-tree"]);
    expect(ids("飞书 根因")).toEqual([]);
  });

  it("parseIndex 读出 readme 和关键词", () => {
    const got = parseIndex(
      index([
        {
          id: "a-b",
          name: "A",
          version: "1.0.0",
          apiVersion: "1.0",
          keywords: ["x", 3],
          readme: "# A",
          download: { url: "u", sha256: SHA },
        },
      ]),
    );
    expect(got.plugins[0]).toMatchObject({ keywords: ["x"], readme: "# A" });
  });
});
