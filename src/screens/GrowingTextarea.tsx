import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";

/**
 * 跟着内容长高的多行输入框。
 *
 * 为什么不是 `<input>`：一条事项、一条风险、一句评论都经常是一整句话。
 * 单行输入框里只看得见光标附近那一小段 —— 文字往左滚出去，写到一半就
 * 无法回头检查自己写了什么。而固定高度的 `<textarea>` 又反过来：
 * 一条「打电话确认交期」会白占三行。
 *
 * 所以高度跟着内容走，夹在 `[minHeight, maxHeight]` 之间：短的紧凑，
 * 长的铺开，超过上限才出现滚动条。
 *
 * ## 键盘约定
 *
 * `Enter` 提交、`⇧Enter` 换行。两者的分工是定过的：事项和风险的录入都以
 * 「连着记好几条」为主场景，把提交让给 `⌘Enter` 会让每一条都多一个修饰键。
 * 想换行的人按 `⇧Enter`，提示文案里写明。
 *
 * **keydown 一律 `stopPropagation`。** 工作区在 window 上监听裸 `Enter`
 * 「新建任务」、`Backspace`「删除任务」—— 不拦住的话，在这里敲完回车会
 * 顺手建出一条空任务，而且用户完全看不出那是怎么发生的。
 */

export interface GrowingTextareaHandle {
  focus: () => void;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  /**
   * 在内置的 Enter 处理**之前**调用，用来接 `⌘Enter` 这类变体。
   * 处理掉了就 `preventDefault()`，内置逻辑据此让路。
   */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  minHeight?: number;
  maxHeight?: number;
  className?: string;
  autoFocus?: boolean;
}

export const GrowingTextarea = forwardRef<GrowingTextareaHandle, Props>(
  function GrowingTextarea(
    {
      value,
      onChange,
      onSubmit,
      onKeyDown,
      placeholder,
      minHeight = 0,
      maxHeight = 120,
      className = "",
      autoFocus,
    },
    ref,
  ) {
    const el = useRef<HTMLTextAreaElement>(null);

    useImperativeHandle(ref, () => ({ focus: () => el.current?.focus() }), []);

    useLayoutEffect(() => {
      const node = el.current;
      if (!node) return;
      // 先归零再读 scrollHeight：不归零的话 scrollHeight 永远不会小于
      // 当前高度，删掉几行之后框子不会收回去
      node.style.height = "0px";
      node.style.height = `${Math.max(minHeight, Math.min(node.scrollHeight, maxHeight))}px`;
    }, [value, minHeight, maxHeight]);

    return (
      <textarea
        ref={el}
        value={value}
        rows={1}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit?.();
          }
        }}
        className={`resize-none overflow-y-auto outline-none ${className}`}
      />
    );
  },
);
