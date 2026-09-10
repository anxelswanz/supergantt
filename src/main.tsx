import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { IS_MAC } from "./core/keys";

// 平台标记给 CSS 用（Windows 的滚动条样式，见 styles.css）
document.documentElement.dataset.platform = IS_MAC ? "mac" : "other";

/**
 * Windows 的 WebView2 保留了浏览器的刷新快捷键：F5 / Ctrl+R 会把整个应用重新
 * 加载 —— 撤销栈清空，防抖窗口里还没落库的那一笔编辑也跟着没了。macOS 的
 * WKWebView 没有这回事，所以这个坑只在 Windows 上存在。
 *
 * 只在发布版里吞掉：开发时偶尔还需要手动刷新。
 */
if (import.meta.env.PROD && !IS_MAC) {
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "F5" || (e.ctrlKey && e.key.toLowerCase() === "r")) e.preventDefault();
    },
    true,
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
