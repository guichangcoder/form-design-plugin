/**
 * 日期联动预填的偏移计算（纯函数，不依赖 SDK，回归测试可直接在 Node 中跑）。
 *
 * 规则：
 * - day  ：按自然日加减（setDate，自动处理跨月/跨年与闰年）
 * - month：按月加减，日溢出取目标月最后一天（1/31 +1 月 → 2/28 或 2/29）
 * - year ：等价于 ±(amount×12) 个月，同样处理 2/29 → 次年 2/28
 * - direction=minus 时反向偏移；amount 取非负整数，非法值视为 0
 */
import { DateAutoFillConfig } from '../types';

/** 目标月的天数 */
function daysInMonth(year: number, monthIndex: number): number {
  // monthIndex 为 0-11；下个月第 0 天 = 本月最后一天
  return new Date(year, monthIndex + 1, 0).getDate();
}

/**
 * 按月加减，保留「日」不变；若目标月没有这一天（如 31 日 → 2 月），取该月最后一天。
 * 时分秒毫秒沿用原值。
 */
export function addMonths(base: Date, months: number): Date {
  const day = base.getDate();
  const y = base.getFullYear();
  const m = base.getMonth() + months;
  const target = new Date(y, m, 1);
  const last = daysInMonth(target.getFullYear(), target.getMonth());
  target.setDate(Math.min(day, last));
  target.setHours(
    base.getHours(),
    base.getMinutes(),
    base.getSeconds(),
    base.getMilliseconds()
  );
  return target;
}

/**
 * 按配置计算偏移后的日期。
 * @param base 来源日期（无效时返回 null）
 */
export function applyDateOffset(base: Date | null | undefined, cfg?: DateAutoFillConfig): Date | null {
  if (!base) return null;
  const t = base instanceof Date ? base.getTime() : new Date(base as any).getTime();
  if (!Number.isFinite(t)) return null;
  if (!cfg || !cfg.sourceFieldId) return null;

  const sign = cfg.direction === 'minus' ? -1 : 1;
  const amount = Number.isFinite(cfg.amount) ? Math.max(0, Math.floor(Number(cfg.amount))) : 0;
  const n = sign * amount;
  const d = new Date(t);

  switch (cfg.unit) {
    case 'day':
      return new Date(d.setDate(d.getDate() + n));
    case 'month':
      return addMonths(d, n);
    case 'year':
      return addMonths(d, n * 12);
    default:
      return addMonths(d, 0);
  }
}

/** 把表单态的日期值（Date / 毫秒时间戳 / 日期字符串）统一成 Date，非法返回 null */
export function toDateOrNull(v: unknown): Date | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  if (typeof v === 'number') return Number.isFinite(v) ? new Date(v) : null;
  if (typeof v === 'string' && v.trim()) {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? new Date(t) : null;
  }
  return null;
}

/** 两个日期是否同一时刻（用于判断「自动填的值是否被用户改过」） */
export function isSameInstant(a: unknown, b: unknown): boolean {
  const ta = toTime(a);
  const tb = toTime(b);
  if (ta === null || tb === null) return false;
  return ta === tb;
}

function toTime(v: unknown): number | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** 配置的偏移文案（配置面板展示用），如「+1 年」「-3 个月」 */
export function describeOffset(cfg?: DateAutoFillConfig): string {
  if (!cfg) return '';
  const unitText = cfg.unit === 'day' ? '天' : cfg.unit === 'month' ? '个月' : '年';
  const sign = cfg.direction === 'minus' ? '-' : '+';
  return `${sign}${Math.max(0, Math.floor(Number(cfg.amount) || 0))} ${unitText}`;
}
