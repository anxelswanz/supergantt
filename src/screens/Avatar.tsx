import type { Person } from "../db/api";

/**
 * 负责人头像。有照片用照片，没照片用姓名缩写（Teams / 飞书那种做法）。
 *
 * 缩写规则对中英文分别处理 —— 中文名取「首字母」是没有意义的，
 * 「张三」的首字母是 Z，读者认不出来。
 */

/** 有没有中日韩字符 */
const CJK = /[㐀-鿿豈-﫿]/;

export function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";

  if (CJK.test(trimmed)) {
    // 中文取末尾 1–2 个字：两字名整体显示（张三），
    // 三字以上取后两位（欧阳修 → 阳修），因为后面才是名、辨识度更高
    return trimmed.length <= 2 ? trimmed : trimmed.slice(-2);
  }

  // 西文取前两个词的首字母
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

/** 头像底色偏亮时用深色文字，否则用白字 */
function textOn(hex: string): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? "#0f172a" : "#ffffff";
}

interface Props {
  person: Person | null | undefined;
  size?: number;
  /** 未指派时显示一个虚线圈占位，保持行内元素对齐 */
  placeholder?: boolean;
  title?: string;
}

export function Avatar({ person, size = 18, placeholder = true, title }: Props) {
  if (!person) {
    if (!placeholder) return null;
    return (
      <span
        title={title ?? "未指派"}
        className="inline-block shrink-0 rounded-full border border-dashed border-[var(--rule)]"
        style={{ width: size, height: size }}
      />
    );
  }

  const label = title ?? person.name;

  if (person.avatar) {
    return (
      <img
        src={person.avatar}
        alt={person.name}
        title={label}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      title={label}
      className="grid shrink-0 place-items-center rounded-full font-medium leading-none"
      style={{
        width: size,
        height: size,
        background: person.color,
        color: textOn(person.color),
        // 缩写可能是两个汉字，字号要随尺寸缩，否则会溢出圆形
        fontSize: Math.max(8, Math.round(size * 0.4)),
      }}
    >
      {initialsOf(person.name)}
    </span>
  );
}

/**
 * 把用户选的图片压成小尺寸 data URI。
 *
 * 必须压：头像存在 SQLite 里（这样单文件备份才是完整的），
 * 一张没处理的手机照片有几 MB，几个人就能把数据库撑大一个量级，
 * 而且每次整项目保存都要连带写一遍。128px 足够所有显示场景。
 */
export function fileToAvatarDataUrl(file: File, size = 128): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读不出这个文件"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("这不是一张能识别的图片"));
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("无法处理图片"));

        // 居中裁成正方形，避免非等比拉伸把脸压扁
        const side = Math.min(img.width, img.height);
        ctx.drawImage(
          img,
          (img.width - side) / 2,
          (img.height - side) / 2,
          side,
          side,
          0,
          0,
          size,
          size,
        );
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}
