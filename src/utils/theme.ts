/**
 * 主题颜色工具：把用户配置的主色调应用到页面 CSS 变量，
 * 让顶栏、按钮、分区徽章、Semi 组件等整套主题色联动。
 */

/** 默认品牌蓝 */
export const DEFAULT_THEME = '#1d4ed8';

/** 预设色板（10 色） */
export const PRESET_COLORS = [
  '#1d4ed8', // 品牌蓝
  '#0891b2', // 青
  '#0f766e', // 墨绿
  '#16a34a', // 绿
  '#d97706', // 橙
  '#dc2626', // 红
  '#7c3aed', // 紫
  '#db2777', // 粉
  '#334155', // 深灰蓝
  '#111827', // 墨黑
];

/**
 * 基于 hex 生成深浅色：
 * pct > 0 向白色混（变浅），pct < 0 向黑色混（变深）。
 */
export function adjustHex(hex: string, pct: number): string {
  let h = (hex || DEFAULT_THEME).trim();
  if (!h.startsWith('#')) h = '#' + h;
  if (!/^#[0-9a-fA-F]{6}$/.test(h)) return DEFAULT_THEME;
  const n = parseInt(h.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  const target = pct < 0 ? 0 : 255;
  const p = Math.min(1, Math.abs(pct) / 100);
  r = Math.round((target - r) * p + r);
  g = Math.round((target - g) * p + g);
  b = Math.round((target - b) * p + b);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

/** 把主题色应用到根元素 CSS 变量（还原默认时传 undefined） */
export function applyThemeColor(color?: string | null) {
  const root = document.documentElement;
  const c = color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_THEME;
  const vars: Record<string, string> = {
    '--brand': c,
    '--brand-hover': adjustHex(c, -10),
    '--brand-deep': adjustHex(c, -25),
    '--brand-soft': adjustHex(c, 92),
    '--brand-line': adjustHex(c, 72),
    '--semi-color-primary': c,
    '--semi-color-primary-hover': adjustHex(c, -10),
    '--semi-color-primary-active': adjustHex(c, -25),
    '--semi-color-primary-light': adjustHex(c, 92),
    '--semi-color-primary-light-hover': adjustHex(c, 86),
    '--semi-color-primary-light-active': adjustHex(c, 72),
    '--semi-color-primary-border': adjustHex(c, 72),
  };
  Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));
}
