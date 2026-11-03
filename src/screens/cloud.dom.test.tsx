// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 设置 → 云备份。要钉死的是：开关只有测通之后才打得开 ——
 * 配错了还开着，用户会以为一直在备份，其实一次都没传上去。
 */

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", async () => {
  const { withSession } = await import("../test/ipc");
  return { invoke: withSession((...a: unknown[]) => invoke(...a)) };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));

let settings: Record<string, string>;
let checkResult: { ok: boolean; text: string };

beforeEach(() => {
  cleanup();
  vi.resetModules();
  invoke.mockReset();
  settings = {};
  checkResult = { ok: true, text: "连接正常，云端还没有项目" };
  invoke.mockImplementation((cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
      case "get_setting":
        return Promise.resolve(settings[args.key as string] ?? null);
      case "set_setting":
        settings[args.key as string] = args.value as string;
        return Promise.resolve(null);
      case "cloud_check":
        return checkResult.ok ? Promise.resolve(checkResult.text) : Promise.reject(checkResult.text);
      case "cloud_sync":
        return Promise.resolve({
          pushed: ["P"], pulled: [], deletedLocal: [], deletedRemote: [],
          backups: [], notes: [], errors: [], at: 1_770_000_000,
        });
      default:
        return Promise.resolve(null);
    }
  });
});

async function renderPane() {
  const { CloudPane } = await import("./CloudSettings");
  render(<CloudPane />);
  return screen.findByText("开启云数据备份");
}

const fill = () => {
  fireEvent.change(screen.getByPlaceholderText("https://xxxx.supabase.co"), {
    target: { value: "https://abc.supabase.co" },
  });
  const secrets = document.querySelectorAll("input[type='password']");
  fireEvent.change(secrets[0], { target: { value: "sb_publishable_x" } });
  fireEvent.change(secrets[1], { target: { value: "k".repeat(64) } });
};

describe("云备份设置", () => {
  it("三项没填齐，开关按不下去", async () => {
    const label = await renderPane();
    expect(label.closest("button")!.disabled).toBe(true);
  });

  it("测试连接失败：开关不开，错误写出来，配置里 enabled 还是 false", async () => {
    checkResult = { ok: false, text: "同步密钥不对" };
    const label = await renderPane();
    fill();
    await act(async () => {
      fireEvent.click(label.closest("button")!);
    });
    expect(await screen.findByText("同步密钥不对")).toBeTruthy();
    expect(settings["cloud.config"]).toBeUndefined();
  });

  it("测通后打开：配置存下、立刻跑一轮同步", async () => {
    const { startCloudSync } = await import("../cloud/sync");
    const stop = startCloudSync();
    const label = await renderPane();
    fill();
    await act(async () => {
      fireEvent.click(label.closest("button")!);
    });

    const saved = JSON.parse(settings["cloud.config"]);
    expect(saved).toMatchObject({
      enabled: true,
      url: "https://abc.supabase.co",
      anonKey: "sb_publishable_x",
      intervalMin: 1,
    });
    await waitFor(() => expect(invoke.mock.calls.some(([c]) => c === "cloud_sync")).toBe(true));
    expect(await screen.findByText(/同步完成：上传 1/)).toBeTruthy();
    stop();
  });
});
