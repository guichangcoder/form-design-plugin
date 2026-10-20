/**
 * 选项引用（optionRef）的纯函数解析：从源表记录中按条件过滤并提取选项文本。
 * 纯函数、不依赖 SDK，回归测试可直接在 Node 中跑。
 *
 * 规则：
 * - 选项 = 源表取值字段（ref.fieldId）的记录值文本，去重、保序；
 * - conditions 全部满足（AND）的记录才纳入；
 * - 条件比较按「单元格文本」严格相等；
 * - 联动条件（valueSource=field）引用的表单字段未填时，该条件视为不满足
 *   → 联动父字段未选前，子字段无选项（省未选，市为空，符合原生行为）。
 */
import { FieldType } from '@lark-base-open/js-sdk';
import { FieldConfig, OptionRefCondition, OptionReference } from '../types';
import { stringifyCellValue } from './cellText';

/** 源表记录（只需要 fields 部分） */
export interface SourceRecordLite {
  fields: Record<string, unknown>;
}

/**
 * 单条源记录是否满足全部引用条件（AND）。
 * - 条件比较按「单元格文本」相等；多选单元格形如「A B」→ 按「含该选项」判定
 *   （与服务端 contains 语义、以及 tableRecordCache.recordSatisfiesCondition 保持一致）；
 * - 联动条件（valueSource=field）引用的表单字段未填时，该条件视为不满足
 *   → 联动父字段未选前，子字段无选项（省未选，市为空，符合原生行为）。
 *
 * 抽成独立导出函数：既供 resolveRefOptions 用，也供「服务端过滤失效时的本地兜底筛」复用，
 * 保证两条路径的判定完全一致（避免一处相等、一处分词导致结果不一致）。
 */
export function refRecordMatches(
  ref: OptionReference,
  fields: Record<string, unknown>,
  formValues: Record<string, unknown>
): boolean {
  return (ref?.conditions ?? []).every((c) => {
    const cellText = stringifyCellValue(fields?.[c.sourceFieldId]).trim();
    const expected =
      c.valueSource === 'field'
        ? stringifyCellValue(formValues?.[c.formFieldId ?? '']).trim()
        : (c.staticValue ?? '').trim();
    // 固定值为空（缺省）或父级未填 → 视为不满足（配置不完整时不放出全部选项，避免误导）
    if (!expected) return false;
    if (c.sourceFieldType === FieldType.MultiSelect) {
      return cellText.split(/\s+/).filter(Boolean).includes(expected);
    }
    return cellText === expected;
  });
}

export function resolveRefOptions(
  ref: OptionReference,
  records: SourceRecordLite[],
  formValues: Record<string, unknown>
): string[] {
  if (!ref?.tableId || !ref?.fieldId) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rec of records ?? []) {
    if (!refRecordMatches(ref, rec?.fields ?? {}, formValues)) continue;
    const text = stringifyCellValue((rec?.fields ?? {})[ref.fieldId]).trim();
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

/** 字段的选项引用是否已完整配置（可用于判断是否走引用选项渲染） */
export function hasOptionRef(field: FieldConfig): boolean {
  return !!field.optionRef?.tableId && !!field.optionRef?.fieldId;
}

/**
 * 把一条引用条件解析为「服务端过滤条件」（供 fetch 条件取数使用）。
 * - valueSource=static：用固定值；
 * - valueSource=field：用当前表单字段的值（父级未填 → 返回 null，子级无选项）；
 * - 固定值为空 / 配置不完整 → 返回 null（不下发，不放出全部选项）。
 *
 * 同时带上源表条件字段的字段类型（sourceFieldType）——服务端对「单选」的 is
 * 条件必须显式给出 fieldType 才能正确解析；缺失时退化为纯文本 is 条件。
 */
export function conditionSpecOf(
  c: OptionRefCondition,
  formValues: Record<string, unknown>
): { fieldId: string; text: string; fieldType?: number } | null {
  if (c.valueSource === 'field') {
    if (!c.formFieldId) return null; // 配置不完整 → 不下发
    const text = stringifyCellValue(formValues?.[c.formFieldId]).trim();
    if (!text) return null; // 父级未填 → 子级无选项（符合原生行为）
    return { fieldId: c.sourceFieldId, text, fieldType: c.sourceFieldType };
  }
  const text = (c.staticValue ?? '').trim();
  if (!text) return null; // 固定值为空 → 不下发（不放出全部选项）
  return { fieldId: c.sourceFieldId, text, fieldType: c.sourceFieldType };
}

/**
 * 该字段的选项引用依赖了哪些表单字段（valueSource=field 的 formFieldId 集合）。
 * 用于级联清空：父字段值变化时，把依赖它的字段已选值清掉。
 */
export function getOptionRefDependencies(field: FieldConfig): string[] {
  if (!hasOptionRef(field)) return [];
  return (field.optionRef!.conditions ?? [])
    .filter((c) => c.valueSource === 'field' && c.formFieldId)
    .map((c) => c.formFieldId!) as string[];
}
