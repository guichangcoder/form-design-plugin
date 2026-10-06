/**
 * 调试可见性判定：
 * - 本地开发（Vite 的 import.meta.env.DEV 为 true）时显示一切调试信息；
 * - 发布（生产构建）后默认隐藏，仅当 URL 带 ?debug=1 时重新显示，便于线上临时排查。
 *
 * 这样正式发布的插件画布里只剩干净的表单，没有任何诊断/调试痕迹。
 */
export function isDebugMode(): boolean {
  try {
    // @ts-ignore - import.meta.env 在 Vite 下可用
    if ((import.meta as any).env?.DEV) return true;
    return hasDebugParam();
  } catch {
    return false;
  }
}

/**
 * URL 是否显式带 ?debug=1 —— 强制显示调试信息（优先级最高）。
 * 用于在填写态（View）临时打开诊断条：填写态默认即使 dev 也不显示调试内容，
 * 只有用 ?debug=1 才能看到，保证平时看到的就是发布后的最终效果。
 */
export function hasDebugParam(): boolean {
  try {
    return new URLSearchParams(window.location.search).has('debug');
  } catch {
    return false;
  }
}
