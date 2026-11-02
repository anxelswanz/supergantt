// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 插件市场：搜索 → 选中 → 安装 → 自动启用。
 *
 * Rust 侧（联网、sha256、解压）用替身；这里要证明的是界面上那几个决定：
 *   1. 搜索在本地筛，不为每次输入去联网
 *   2. 新装先弹权限确认，列出它能运行的程序；取消就什么都不装
 *   3. 确认后带着 index 里的地址和 sha256 去装，装完**自动启用**
 *   4. 连不上时用缓存，并说清楚是哪次的；插件接口对不上时不给装
 */

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", async () => {
  const { withSession } = await import("../test/ipc");
  return { invoke: withSession((...a: unknown[]) => invoke(...a)) };
});

const SHA = "b".repeat(64);
const URL_ =
  "https://github.com/anxelswanz/supergantt-plugins/releases/download/feishu-sync-v1.6.0/feishu-sync-1.6.0.zip";

const MANIFEST = JSON.stringify({
  id: "feishu-sync",
  name: "飞书同步",
  version: "1.6.0",
  apiVersion: "1.2",
  permissions: { exec: ["claude", "lark-cli"] },
});

const entry = (over: Record<string, unknown>) => ({
  version: "1.0.0",
  apiVersion: "1.2",
  permissions: {},
  skills: [],
  keywords: [],
  readme: "",
  download: { url: URL_, sha256: SHA, size: 100 },
  ...over,
});

const INDEX = JSON.stringify({
  schema: 1,
  updatedAt: "2026-10-30T00:00:00Z",
  plugins: [
    entry({
      id: "feishu-sync",
      name: "飞书同步",
      version: "1.6.0",
      description: "同步到多维表格",
      keywords: ["lark"],
      permissions: { exec: ["claude", "lark-cli"] },
      skills: ["gantt-feishu"],
      readme: "# 飞书同步\n\n## 准备\n\n装好 lark-cli",
    }),
    entry({ id: "fault-tree", name: "故障树分析", description: "把问题拆到根因", keywords: ["FTA"] }),
  ],
});

let installed: unknown[] = [];
let fetchResult: unknown;

beforeEach(() => {
  vi.resetModules();
  installed = [];
  fetchResult = { raw: INDEX, fetched_at: 1_800_000_000, from_cache: false, error: null };
  // 插件代码走 Blob URL + 动态 import；jsdom 没有 createObjectURL，换成等价的 data: URL
  URL.createObjectURL = () => `data:text/javascript,${encodeURIComponent("export function onload() {}")}`;
  URL.revokeObjectURL = () => {};
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "list_plugins":
        return installed;
      case "store_fetch_index":
        return fetchResult;
      case "store_install":
        installed = [
          {
            dir_name: "feishu-sync",
            path: "/cfg/plugins/feishu-sync",
            manifest_raw: MANIFEST,
            entry_raw: "export function onload() {}",
            css_raw: null,
            dev: false,
          },
        ];
        return MANIFEST;
      case "plugin_link_skill":
        return "/home/.claude/skills/gantt-feishu";
      default:
        return null;
    }
  });
});

afterEach(cleanup);

async function openMarket() {
  const { plugins } = await import("../plugins/registry");
  await plugins.boot();
  const { PluginMarket } = await import("../screens/PluginMarket");
  render(<PluginMarket onClose={() => {}} />);
  // 详情区默认选中第一个
  await screen.findByRole("heading", { name: "飞书同步", level: 2 });
  return plugins;
}

const list = () => within(screen.getByRole("listbox"));

describe("插件市场", () => {
  it("搜索在本地筛：名字、关键词都能搜到，不再联网", async () => {
    await openMarket();
    const fetches = invoke.mock.calls.filter(([c]) => c === "store_fetch_index").length;
    const box = screen.getByPlaceholderText(/搜索插件/);

    fireEvent.change(box, { target: { value: "fta" } });
    expect(list().queryByText("飞书同步")).toBeNull();
    expect(list().getByText("故障树分析")).toBeTruthy();
    // 选中项跟着落到搜出来的那个
    expect(screen.getByRole("heading", { name: "故障树分析", level: 2 })).toBeTruthy();

    fireEvent.change(box, { target: { value: "没有这个" } });
    expect(screen.getByText(/没有和「没有这个」匹配的插件/)).toBeTruthy();

    expect(invoke.mock.calls.filter(([c]) => c === "store_fetch_index").length).toBe(fetches);
  });

  it("详情显示 README 和权限", async () => {
    await openMarket();
    expect(screen.getByRole("heading", { name: "准备" })).toBeTruthy();
    expect(screen.getByText("运行 lark-cli")).toBeTruthy();
  });

  it("新装先确认权限，确认后安装并自动启用", async () => {
    const plugins = await openMarket();
    fireEvent.click(screen.getByRole("button", { name: "安装" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("lark-cli");
    expect(dialog.textContent).toContain("gantt-feishu");

    // 取消：什么都不装
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(invoke.mock.calls.some(([c]) => c === "store_install")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "安装" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "安装并启用" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("store_install", { id: "feishu-sync", url: URL_, sha256: SHA, mirror: null }),
    );
    expect(await screen.findByText(/已安装并启用 v1.6.0/)).toBeTruthy();
    const rec = plugins.getSnapshot().records.find((r) => r.manifest.id === "feishu-sync");
    expect(rec).toMatchObject({ enabled: true, status: "loaded" });
    // 装完：详情里给的是「停用」和「卸载」，不再有「安装」
    expect(screen.getByRole("button", { name: "停用" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "安装" })).toBeNull();
    expect(list().getByText("已启用")).toBeTruthy();
  });

  it("连不上时显示缓存是哪次的", async () => {
    fetchResult = { raw: INDEX, fetched_at: 1_800_000_000, from_cache: true, error: "连不上 GitHub" };
    await openMarket();
    expect(screen.getByText(/离线 · 显示 .* 的列表/)).toBeTruthy();
  });

  it("需要更新的插件接口时不给装", async () => {
    fetchResult = { raw: INDEX.replace('"apiVersion":"1.2"', '"apiVersion":"1.9"'), fetched_at: 1, from_cache: false, error: null };
    await openMarket();
    expect(screen.queryByRole("button", { name: "安装" })).toBeNull();
    expect(screen.getByText(/升级 SuperGantt 后才能安装/)).toBeTruthy();
    expect(list().getByText("需升级应用")).toBeTruthy();
  });
});
