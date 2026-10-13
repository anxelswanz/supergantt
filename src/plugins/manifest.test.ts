import { describe, expect, it } from "vitest";
import { compareVersions, validateManifest } from "./manifest";

/** 1.2 新增的 manifest 字段：permissions.exec 和 skills。挡的是写错，不是作恶 */

const base = { id: "demo", name: "示例", version: "1.0.0", apiVersion: "1.2" };
const check = (extra: Record<string, unknown>) =>
  validateManifest(JSON.stringify({ ...base, ...extra }), "demo");

describe("validateManifest：权限与 Skill", () => {
  it("合法的 permissions / skills 原样带出来", () => {
    const r = check({ permissions: { exec: ["lark-cli", "claude"] }, skills: [{ dir: "skill", name: "demo-skill" }] });
    expect(r).toMatchObject({
      ok: true,
      manifest: { permissions: { exec: ["lark-cli", "claude"] }, skills: [{ dir: "skill", name: "demo-skill" }] },
    });
  });

  it("程序名不能带路径", () => {
    expect(check({ permissions: { exec: ["/bin/sh"] } }).ok).toBe(false);
  });

  it("Skill 的目录和名字都不能带路径", () => {
    expect(check({ skills: [{ dir: "../x", name: "a" }] }).ok).toBe(false);
    expect(check({ skills: [{ dir: "skill", name: "a/b" }] }).ok).toBe(false);
  });

  it("没写这两个字段时也合法，而且不凭空长出来", () => {
    const r = check({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.permissions).toBeUndefined();
      expect(r.manifest.skills).toBeUndefined();
    }
  });
});

describe("compareVersions", () => {
  it("按段比较，缺的段当 0", () => {
    expect(compareVersions("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("1.0.1", "1.0")).toBeGreaterThan(0);
    expect(compareVersions("2.0", "2.0.0")).toBe(0);
  });
});
