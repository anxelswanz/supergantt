/**
 * Canvas 内部动画用的 spring 积分器。
 * 用固定子步长积分：直接用 rAF 的 dt，掉帧时 dt 变大会让弹簧发散抖动。
 */

export interface SpringConfig {
  stiffness: number;
  damping: number;
}

export const SPRING = {
  /** 按钮、悬停、吸附反馈 */
  snappy: { stiffness: 400, damping: 30 },
  /** 面板滑出、缩放档位跳转 */
  smooth: { stiffness: 200, damping: 26 },
  /** 项目卡片展开成工作区 */
  dramatic: { stiffness: 120, damping: 20 },
  /** 滚轮缩放专用：刚度极高，跟手但松手后留一点余韵 */
  wheel: { stiffness: 900, damping: 42 },
} satisfies Record<string, SpringConfig>;

const SUB_STEP = 1 / 240;

export class Spring {
  value: number;
  target: number;
  velocity = 0;
  config: SpringConfig;

  constructor(initial: number, config: SpringConfig = SPRING.smooth) {
    this.value = initial;
    this.target = initial;
    this.config = config;
  }

  /** 推进一帧，返回是否仍在运动。 */
  step(dt: number): boolean {
    if (this.settled()) {
      this.value = this.target;
      this.velocity = 0;
      return false;
    }
    // 单帧最多推进 64ms，防止标签页切回来时一次积分跳过头
    let remaining = Math.min(dt, 0.064);
    const { stiffness, damping } = this.config;
    while (remaining > 0) {
      const h = Math.min(SUB_STEP, remaining);
      const accel =
        stiffness * (this.target - this.value) - damping * this.velocity;
      this.velocity += accel * h;
      this.value += this.velocity * h;
      remaining -= h;
    }
    return true;
  }

  settled(): boolean {
    return (
      Math.abs(this.target - this.value) < 1e-4 && Math.abs(this.velocity) < 1e-3
    );
  }

  snap(to: number) {
    this.value = this.target = to;
    this.velocity = 0;
  }
}
