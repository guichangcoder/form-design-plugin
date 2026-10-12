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
import { FieldConfig, OptionReference } from '../types';
import { stringifyCellValue } from './cellText';

/** 源表记录（只需要 fields 部分） */
export interface SourceRecordLite {
  fields: Record<string, unknown>;
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
    const fields = rec?.fields ?? {};
    const ok = (ref.conditions ?? []).every((c) => {
      const cellText = stringifyCellValue(fields[c.sourceFieldId]);
      const expected =
        c.valueSource === 'field'
          ? stringifyCellValue(formValues?.[c.formFieldId ?? ''])
          : (c.staticValue ?? '');
      // 固定值为空也视为不满足（配置不完整时不放出全部选项，避免误导）
      if (!expected) return false;
      return cellText === expected;
    });
    if (!ok) continue;
    const text = stringifyCellValue(fields[ref.fieldId]);
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
 * 该字段的选项引用依赖了哪些表单字段（valueSource=field 的 formFieldId 集合）。
 * 用于级联清空：父字段值变化时，把依赖它的字段已选值清掉。
 */
export function getOptionRefDependencies(field: FieldConfig): string[] {
  if (!hasOptionRef(field)) return [];
  return (field.optionRef!.conditions ?? [])
    .filter((c) => c.valueSource === 'field' && c.formFieldId)
    .map((c) => c.formFieldId!) as string[];
}
