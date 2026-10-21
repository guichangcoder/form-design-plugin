/**
 * 表单内跨区块取值（formFieldRef）的纯函数解析。
 *
 * 与 `optionRef`（服务端引用选项）并列但**完全独立**：
 * - optionRef：选项来自**源数据表已有记录** → 需要读服务端、受权限约束；
 * - formFieldRef：选项来自**本表单当前正在填写的值**（内存中）→ **零网络请求**、
 *   实时联动、不要求填写者有源表读权限。
 *
 * ★ 零破坏保证：本文件全是纯函数，且**不改动 optionRef 的任何既有逻辑**。
 *   只有在字段配置了 `formRef` 时才会走到这里；未配置时行为与今日完全一致。
 *
 * 规则：
 * - 选项 = 来源区块**所有行**该字段的已填值（去重、保序）；
 * - 空值跳过；来源是多选时一个单元格拆成多个独立选项（与 extractOptionTexts 一致）；
 * - `aggregate='single'` 时只取单个值（主表来源天然如此）。
 */
import { FieldType } from '@lark-base-open/js-sdk';
import { FieldConfig, FormFieldRef, FormValues, OptionSourceMode } from '../types';
import { extractOptionTexts, stringifyCellValue } from './cellText';

/** 表单的全局值作用域：主表值 + 各子表行值 */
export interface FormScope {
  mainTableId: string;
  mainValues: FormValues;
  /** tableId -> 行值数组 */
  subValues: Record<string, FormValues[]>;
  /** tableId -> 该区块的字段配置（用于按 fieldId 找 label/类型） */
  subTables: { tableId: string; fields: FieldConfig[] }[];
  /** 主表字段配置（用于按 fieldId 找 label/类型） */
  mainFields?: FieldConfig[];
  /** tableId -> 区块显示名（仅用于 UI 提示文案） */
  blockLabels?: Record<string, string>;
}

/** 构造表单作用域（纯函数） */
export function buildFormScope(
  mainTableId: string,
  mainValues: FormValues,
  subValues: Record<string, FormValues[]>,
  subTables: { tableId: string; fields: FieldConfig[] }[],
  extras?: { mainFields?: FieldConfig[]; blockLabels?: Record<string, string> }
): FormScope {
  return {
    mainTableId,
    mainValues,
    subValues,
    subTables,
    mainFields: extras?.mainFields,
    blockLabels: extras?.blockLabels,
  };
}

/**
 * 来源的可读描述，如「合同产品明细·产品」。仅用于 UI 提示文案（不参与任何判定）。
 * 拿不到配置时回落成中性文案，绝不抛错。
 */
export function describeRefSource(ref: FormFieldRef, scope: FormScope | null): string {
  if (!ref?.sourceTableId || !ref?.sourceFieldId) return '未配置来源';
  const isMain = ref.sourceTableId === scope?.mainTableId;
  const block =
    scope?.blockLabels?.[ref.sourceTableId] ?? (isMain ? '主表' : '另一区块');
  const fields = isMain
    ? scope?.mainFields
    : scope?.subTables?.find((s) => s.tableId === ref.sourceTableId)?.fields;
  const f = (fields ?? []).find((x) => x.fieldId === ref.sourceFieldId);
  const fieldLabel = f ? f.label || f.fieldName || '该字段' : '该字段';
  return `${block}·${fieldLabel}`;
}

/**
 * 表单内所有 formRef **实际读取到的值**的签名（纯函数）。
 *
 * ★ 用途：FormRenderer 用它做「作用域对象身份」的守门员。
 *   若不加这一层，作用域对象每次输入都会换身份 → 下传给 React.memo 的
 *   MainForm / SubForm → memo 被穿透 → 失去「在主表打字不影响子表区块重渲染」的收益
 *   （这是本项目反复强调的 memo 保命线）。
 *   只把**被引用的**取值纳入签名，未被引用的输入完全不触发重建 → 身份保持稳定。
 */
export function formRefValuesSignature(
  mainTableId: string,
  mainFields: FieldConfig[],
  mainValues: FormValues,
  subTables: { tableId: string; fields: FieldConfig[] }[],
  subValues: Record<string, FormValues[]>
): string {
  const refs: FormFieldRef[] = [];
  const seen = new Set<string>();
  const collect = (fields: FieldConfig[]) => {
    for (const f of fields ?? []) {
      if (!hasFormRef(f)) continue;
      const r = f.formRef!;
      const key = `${r.sourceTableId}:${r.sourceFieldId}:${r.aggregate ?? 'distinctSet'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(r);
    }
  };
  collect(mainFields);
  (subTables ?? []).forEach((s) => collect(s.fields));
  if (refs.length === 0) return '';

  const parts: string[] = [];
  for (const r of refs) {
    parts.push(`${r.sourceTableId}:${r.sourceFieldId}`);
    if (r.sourceTableId === mainTableId) {
      parts.push(stringifyCellValue(mainValues?.[r.sourceFieldId]));
      continue;
    }
    const rows = subValues?.[r.sourceTableId] ?? [];
    if ((r.aggregate ?? 'distinctSet') === 'single') {
      // 单值模式只读「第一条非空」——后面的行改了也不该触发重建
      let v = '';
      for (const row of rows) {
        const t = stringifyCellValue(row?.[r.sourceFieldId]).trim();
        if (t) {
          v = t;
          break;
        }
      }
      parts.push(v);
    } else {
      parts.push(rows.map((row) => stringifyCellValue(row?.[r.sourceFieldId])).join('\u0001'));
    }
  }
  return JSON.stringify(parts);
}

/** 该字段是否配置了「表单内跨区块取值」 */
export function hasFormRef(field: FieldConfig): boolean {
  return !!field.formRef?.sourceTableId && !!field.formRef?.sourceFieldId;
}

/**
 * 解析字段的选项来源模式。
 * ★ formRef 优先（更即时、更贴合「本次录入」语义）；未配置则回落 optionRef；再回落固定选项。
 * 这是渲染层唯一的判断入口，保证三条路径互斥且优先级确定。
 */
export function resolveOptionMode(field: FieldConfig): OptionSourceMode {
  if (hasFormRef(field)) return 'formRef';
  if (field.optionRef?.tableId && field.optionRef?.fieldId) return 'optionRef';
  return 'static';
}

/**
 * 从作用域里收集某字段的选项文本（去重、保序）。
 *
 * ★ aggregate='distinctSet'（默认）：遍历来源区块的全部行，去重取值
 *   —— 即「已录入的 N 条明细里出现过的所有值」。
 * ★ aggregate='single'：只取来源区块的单个值（主表来源天然如此）。
 */
export function collectFormRefOptions(ref: FormFieldRef, scope: FormScope | null): string[] {
  if (!ref?.sourceTableId || !ref?.sourceFieldId || !scope) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    for (const t of extractOptionTexts(raw, ref.sourceFieldType)) {
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  };

  const single = ref.aggregate === 'single';
  const isMain = ref.sourceTableId === scope.mainTableId;

  if (isMain) {
    // 主表：只有一个值（single 与 distinctSet 行为一致）
    push(scope.mainValues?.[ref.sourceFieldId]);
    return out;
  }

  const rows = scope.subValues?.[ref.sourceTableId] ?? [];
  if (rows.length === 0) return out;
  if (single) {
    // 单值模式：取第一条非空值
    for (const row of rows) {
      const before = out.length;
      push(row?.[ref.sourceFieldId]);
      if (out.length > before) break;
    }
    return out;
  }
  for (const row of rows) push(row?.[ref.sourceFieldId]);
  return out;
}

/**
 * 收集某区块的「可被引用字段」列表（配置面板用）。
 * 排除：只读类型字段由调用方过滤；此处只做「有值意义」的粗筛。
 */
export function collectRefSourceCandidates(
  fields: FieldConfig[],
  excludeFieldId?: string
): FieldConfig[] {
  return (fields ?? []).filter((f) => f.visible && f.fieldId !== excludeFieldId);
}

/**
 * 该表单里是否存在任何配置了 formRef 的字段。
 * ★ FormRenderer 据此决定「是否构建并下传作用域」——不存在时完全不传，
 *   保证未使用该功能的表单渲染路径与今日**完全一致**（零额外开销、零 memo 穿透）。
 */
export function formHasAnyFormRef(
  mainFields: FieldConfig[],
  subTables: { fields: FieldConfig[] }[]
): boolean {
  if ((mainFields ?? []).some(hasFormRef)) return true;
  return (subTables ?? []).some((s) => (s.fields ?? []).some(hasFormRef));
}

/**
 * 该区块内是否有字段引用了「指定的来源区块」。
 * 用于精确下传：只有真正被引用的区块才需要 scope（避免无谓重渲染）。
 */
export function blockReferencesSource(
  fields: FieldConfig[],
  sourceTableId: string
): boolean {
  return (fields ?? []).some(
    (f) => hasFormRef(f) && f.formRef?.sourceTableId === sourceTableId
  );
}

/** 由 FieldType 判断能否作为「选项来源字段」（选项类或文本类均可） */
export function canBeRefSource(fieldType: FieldType): boolean {
  return (
    fieldType === FieldType.SingleSelect ||
    fieldType === FieldType.MultiSelect ||
    fieldType === FieldType.Text ||
    fieldType === FieldType.Number ||
    fieldType === FieldType.Currency ||
    fieldType === FieldType.Phone ||
    fieldType === FieldType.Email ||
    fieldType === FieldType.Url
  );
}