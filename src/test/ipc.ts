/**
 * DOM 测试共用的 IPC 桩：替各文件自己的 invoke 模拟接住 `session_state`。
 *
 * 应用启动第一件事是问 Rust「现在是谁」（App.tsx），没有登录的账号就停在登录页。
 * 各测试文件的 invoke 模拟只关心自己那几条命令、其余一律回 null，那样整个应用
 * 会卡在登录页之前。这里统一给一个已登录的默认账号，和老库升级后的状态一致。
 */
export const TEST_ACCOUNT = {
  id: 1,
  uuid: "test-account",
  name: "我",
  color: "#6366f1",
  avatar: null,
  hasPassword: false,
  sortOrder: 1,
};

export const TEST_SESSION = {
  accounts: [TEST_ACCOUNT],
  current: TEST_ACCOUNT,
  lastAccountId: 1,
};

export function withSession(invoke: (...a: unknown[]) => unknown) {
  return (...a: unknown[]) =>
    a[0] === "session_state" ? Promise.resolve(TEST_SESSION) : invoke(...a);
}
