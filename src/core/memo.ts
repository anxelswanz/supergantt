/**
 * 「记住上一次的选择」：录入弹窗的关联任务和分类、事项页的筛选条件、插件开关。
 *
 * 存在设置表里（和外观、视图开关同一处），JSON 编码。读失败、格式坏了都当作没记过 ——
 * 这些只是便利，不能因为它们打不开弹窗。按项目分开的 key 由调用方拼上项目 id。
 */

import { api } from "../db/api";

export const memoKey = {
  composerTask: (projectId: number) => `memo.composer.task.${projectId}`,
  composerKind: (projectId: number) => `memo.composer.kind.${projectId}`,
  composerOption: (optionId: string) => `memo.composer.option.${optionId}`,
  itemsFilter: (projectId: number) => `memo.items.filter.${projectId}`,
};

export async function loadMemo<T>(key: string): Promise<T | null> {
  const raw = await api.getSetting(key).catch(() => null);
  if (raw == null || raw === "") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function saveMemo(key: string, value: unknown): void {
  void api.setSetting(key, JSON.stringify(value)).catch(() => {});
}
