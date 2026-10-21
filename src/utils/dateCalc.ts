/**
 * 日期联动预填的偏移计算（纯函数，不依赖 SDK，回归测试可直接在 Node 中跑）。
 *
 * 规则：
 * - day  ：按自然日加减（setDate，自动处理跨月/跨年与闰年）
 * - month：**「期间末日」口径** —— 先按月加减（日溢出取目标月最后一天，
 *          如 1/31 +1 月 → 2/28），**再回退一天**（2026-10-21 +1 月 → 2026-11-20）
 * - year ：等价于 ±(amount×12) 个月，口径同 month（2026-10-21 +1 年 → 2027-10-20）
 * - direction=minus 时反向偏移；amount 取非负整数，非法值视为 0
 *
 * ★ 为什么月/年要「减一天」：这两个单位的业务含义是**有效期长度**。
 *   「起止日 2026-10-21，有效期一年」⇒ 到期日是**最后一天** 2027-10-20，
 *   而不是 2027-10-21（那是下一年度的第一天，等于多给了一天）。
 *   `day` 不受影响：「+30 天」就是字面的第 30 天，不涉及期间末日语义。
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
 * ★ 「N 个月 / N 年有效期」的末日：先按月偏移，再回退一天。
 *
 * 三种情形（都用 `addMonths` 先得到「名义日」）：
 * 1. **未发生月末钳制** → 名义日再回退一天。
 *    2026-10-21 +1 年 → 名义 2027-10-21 → **2027-10-20**（一年有效期的最后一天）。
 * 2. **发生了月末钳制** → 名义日已经是目标月最后一天，**本身就是期间末日，不再回退**。
 *    2024-02-29 +1 年 → 名义 2025-02-28（2025 无 2/29）→ 保持 **2025-02-28**；
 *    2026-01-31 +1 月 → 名义 2026-02-28 → 保持 **2026-02-28**。
 *    若在钳制后仍机械地减一天（→ 2/27），反而是**少给了一天**，与「有效期」语义相悖。
 * 3. **偏移量为 0** → 原样返回（「+0 个月」就是当天，回退一天会变成昨天）。
 */
export function addMonthsEndOfTerm(base: Date, months: number): Date {
  if (months === 0) return new Date(base.getTime());
  const nominal = addMonths(base, months);
  // 名义日的「日」与基准日不同 ⇒ 发生了月末钳制 ⇒ 名义日即期间末日
  if (nominal.getDate() !== base.getDate()) return nominal;
  nominal.setDate(nominal.getDate() - 1);
  return nominal;
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
      return addMonthsEndOfTerm(d, n);
    case 'year':
      return addMonthsEndOfTerm(d, n * 12);
    default:
      return addMonths(d, 0);
  }
}

/** 把日期格式化为 YYYY-MM-DD（配置面板示例文案用，保证示例与实际计算一致） */
export function formatYmd(d: Date | null | undefined): string {
  if (!d || !Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
