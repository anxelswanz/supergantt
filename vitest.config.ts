import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// 环境按文件顶部的 `// @vitest-environment jsdom` 注解切换：
// 纯逻辑测试跑在 node 下，只有 DOM 测试才付出启动 jsdom 的代价
export default defineConfig({
  plugins: [react()],
  test: {
    // cargo 构建会把 plugins/ 作为资源拷进 target/（含测试文件），那些副本不该再跑一遍
    exclude: [...configDefaults.exclude, "**/target/**"],
  },
});
