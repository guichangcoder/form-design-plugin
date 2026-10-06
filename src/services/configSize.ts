/**
 * 仪表盘 widget 的 addonConfig 字段总字节上限 = 10240（10KB）。
 * 我们的 fields 里塞了 fieldName / fieldType / options / linkTableId 等元数据，
 * 而这些全部可以从 base 重取，没必要持久化。
 *
 * 本文件提供两个函数：
 *   serializeConfig(data)    保存前剥离运行时可重取的元数据
 *   hydrateConfig(thin)      加载后用 base 元数据把字段还原成 FieldConfig 完整形态
 *
 * 设计原则：内存中的 PluginData 始终是 FormPluginConfig 完整形态（组件代码 0 改动）；
 * 只有写盘/读盘穿越持久化层时才做瘦身/补全。
 *
 * 体积估算：30 字段单选列全配置 × 30 个 options → 单表约 10-15KB
 *          瘦身后单表约 2-3KB（每个字段只留几个用户决策字段：visible/required/label/placeholder/defaultValue/readonly/order）
 */
import { FieldConfig, FormPluginConfig, PluginData, SubTableConfig } from '../types';
import {
  FieldMetaLite,
  getFieldMetaList,
  getTableMetaList,
} from './baseService';

/** 需要被剥离的运行时可重取字段（瘦身：保存前从 FieldConfig 上删掉） */
const STRIP_FIELDS: ReadonlyArray<keyof FieldConfig> = [
  'fieldName',     // 来自 base field.getName()
  'fieldType',     // 来自 base field.getType()
  'options',       // 来自 base field.getProperty(Select).options
  'linkTableId',   // 来自 base field.getProperty(Link).tableId
] as const;

/** 单个字段的"用户决策"字段（保留） */
const KEEP_FIELDS: ReadonlyArray<keyof FieldConfig> = [
  'fieldId',       // 定位
  'visible',       // 用户决策
  'required',      // 用户决策
  'label',         // 用户决策
  'placeholder',   // 用户决策
  'defaultValue',  // 用户决策
  'readonly',      // 用户决策
  // 注：未来若加 order/width 等用户决策字段，记得也加进来
] as const;

/**
 * 把单个 FieldConfig 瘦身为「瘦字段」（只保留用户决策 + fieldId）。
 * 这是真正的字节数大头：一个 select 字段的 options 数组（30 项 × {id,name,color}）≈ 1.5KB。
 */
function trimField(f: FieldConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { fieldId: f.fieldId };
  for (const k of KEEP_FIELDS) {
    if (k === 'fieldId') continue;
    const v = (f as any)[k];
    if (v !== undefined) out[k] = v; // 跳过 undefined，序列化更短
  }
  return out;
}

/** 还原单个瘦字段为 FieldConfig，缺少的运行时字段留为 undefined，由 base 补齐 */
function untrimField(stub: any): FieldConfig {
  return {
    fieldId: String(stub.fieldId ?? ''),
    fieldName: stub.fieldName,
    fieldType: stub.fieldType,
    visible: stub.visible !== false, // 缺省视为可见
    required: !!stub.required,
    label: stub.label,
    placeholder: stub.placeholder,
    defaultValue: stub.defaultValue,
    readonly: !!stub.readonly,
    options: stub.options,
    linkTableId: stub.linkTableId,
  };
}

/**
 * 把整个表单配置瘦身后序列化（保存前调用）。
 * 输出结构：
 *   {
 *     forms: [{
 *       id, version, formTitle, formDescription, themeColor,
 *       mainTable: { tableId, fields: [{fieldId, visible, required, ...}] },  // 字段全瘦
 *       subTables: [{ tableId, linkFieldId, allowMultiple, maxRows, fields: [...] }], // 字段瘦，去掉 tableName/linkFieldName
 *       conditionalRules: [...]  // 全部保留
 *     }],
 *     defaultFormId
 *   }
 */
export function serializeConfig(data: PluginData): any {
  if (!data || !Array.isArray(data.forms)) return data;
  return {
    forms: data.forms.map((form) => ({
      id: form.id,
      version: form.version,
      formTitle: form.formTitle,
      formDescription: form.formDescription,
      themeColor: form.themeColor,
      mainTable: {
        tableId: form.mainTable?.tableId,
        // 区块名称是用户手填的展示文案，无法从 base 重取，必须保留。
        sectionName: form.mainTable?.sectionName,
        // 把 tableName 去掉（从 base 拿）
        fields: (form.mainTable?.fields ?? []).map(trimField),
      },
      subTables: (form.subTables ?? []).map((s) => ({
        // ★ 子表 tableId 必须保留：宿主 View 态校验「customConfig 引用的每张表
        //   都必须在 dataConditions 里」，saveConfig 会把子表一并声明进
        //   dataConditions，两边对齐才能通过（实测剥离子表 tableId 反而仍报
        //   「配置数据发生变更」→ 校验对象是「声明的数据源集合」，不是字符串扫描）。
        tableId: s.tableId,
        linkFieldId: s.linkFieldId,
        // 区块名称同样保留（用户手填，无法重取）
        sectionName: s.sectionName,
        allowMultiple: s.allowMultiple,
        maxRows: s.maxRows,
        fields: (s.fields ?? []).map(trimField),
      })),
      // 条件规则同样保留真实 tableId，与 dataConditions 声明集对齐。
      conditionalRules: (form.conditionalRules ?? []).map((r) => ({
        ruleId: r.ruleId,
        trigger: {
          tableId: r.trigger?.tableId,
          fieldId: r.trigger?.fieldId,
          operator: r.trigger?.operator,
          value: r.trigger?.value,
        },
        actions: (r.actions ?? []).map((a) => ({
          tableId: a.tableId,
          type: a.type,
          fieldIds: a.fieldIds,
        })),
      })),
    })),
    defaultFormId: data.defaultFormId,
  };
}

/**
 * 估算 PluginData 序列化为 JSON 后的字节数（仅用于诊断条显示）。
 * 使用 JSON.stringify，未压缩；飞书后端通常也会再压一次，但 10240 是压缩前/后的明文大小上限。
 */
export function estimateConfigBytes(data: PluginData): number {
  try {
    const json = JSON.stringify(data);
    return typeof TextEncoder !== 'undefined'
      ? new TextEncoder().encode(json).byteLength
      : new Blob([json]).size;
  } catch {
    return -1;
  }
}

/**
 * 加载后的 PluginData 增加 `__dataIssue` 标记位：
 *   - `__dataIssue: 'empty'` —— 加载的 customConfig 是空的 / 不含任何 forms
 *   - `__dataIssue: 'stale'`  —— 加载的表单在 base 里字段全部对不上号（base 字段被删/改名）
 *   - undefined              —— 一切正常
 *
 * App.tsx 据此判定要不要在 View 态下显示「配置数据发生变更，请重新走配置流程」的清晰提示，
 * 不要让宿主兜底（小提示+大问号占位图）。
 */
export async function hydrateConfig(thin: PluginData): Promise<PluginData & { __dataIssue?: string }> {
  if (!thin || !Array.isArray(thin.forms) || thin.forms.length === 0) {
    return { ...(thin ?? { forms: [] }), forms: thin?.forms ?? [], __dataIssue: 'empty' };
  }
  const startedAt = performance.now();
  try {
    // 表名映射只读一次表列表；字段元信息按 tableId 缓存，避免多份表单重复拉取。
    const tableNames = await safeGetTableNameMap();
    const fieldMetaCache = new Map<string, Promise<FieldMetaLite[]>>();
    const loadFieldMeta = (tableId: string): Promise<FieldMetaLite[]> => {
      let promise = fieldMetaCache.get(tableId);
      if (!promise) {
        promise = safeGetFieldMetaList(tableId);
        fieldMetaCache.set(tableId, promise);
      }
      return promise;
    };
    const hydrated = await Promise.all(
      thin.forms.map((f) => hydrateForm(f, tableNames, loadFieldMeta))
    );
    const out: any = {
      forms: hydrated,
      defaultFormId: thin.defaultFormId,
    };
    // 健康度检查：所有表单的主表字段是否能从 base 拿到任何字段（type/name）
    const anyMatched = hydrated.some(
      (f: any) =>
        (f.mainTable?.fields ?? []).some((fd: any) => fd.fieldType !== undefined) ||
        (f.subTables ?? []).some((s: any) => (s.fields ?? []).some((fd: any) => fd.fieldType !== undefined))
    );
    if (!anyMatched) out.__dataIssue = 'stale';
    if (hydrated.some((f: any) => (f.subTables ?? []).some((s: any) => !s.tableId))) {
      out.__dataIssue = 'missing-sub-table';
    }
    console.log(
      `[configSize] hydrateConfig 完成：${thin.forms.length} 份表单，耗时 ${Math.round(performance.now() - startedAt)}ms`
    );
    return out;
  } catch (e) {
    console.warn('[configSize] hydrateConfig 失败，原样返回:', e);
    return thin;
  }
}

async function hydrateForm(
  form: FormPluginConfig,
  tableNames: Map<string, string>,
  loadFieldMeta: (tableId: string) => Promise<FieldMetaLite[]>
): Promise<FormPluginConfig> {
  // 主表字段元信息里已经带有关联字段指向的表 ID，旧配置可以直接从这里恢复子表 ID，
  // 不再遍历整个 base 做字段反查。
  const mainMeta = form.mainTable?.tableId
    ? await loadFieldMeta(form.mainTable.tableId)
    : [];
  const subs: SubTableConfig[] = (form.subTables ?? []).map((s) => ({
    ...s,
    tableId:
      s.tableId ||
      mainMeta.find((m) => m.id === s.linkFieldId)?.linkTableId ||
      '',
  }));
  const subMetas: FieldMetaLite[][] = await Promise.all(
    subs.map((s) =>
      s.tableId ? loadFieldMeta(s.tableId) : Promise.resolve([] as FieldMetaLite[])
    )
  );

  // 只用主表/子表已加载的字段构建局部映射，足够恢复同一次联填内的条件规则。
  const fieldTableMap = new Map<string, string>();
  mainMeta.forEach((m) => fieldTableMap.set(m.id, form.mainTable.tableId));
  subs.forEach((s, i) => {
    if (!s.tableId) return;
    (subMetas[i] ?? []).forEach((m) => fieldTableMap.set(m.id, s.tableId!));
  });
  const rules = (form.conditionalRules ?? []).map((r) => ({
    ...r,
    trigger: {
      ...r.trigger,
      tableId: r.trigger?.tableId || fieldTableMap.get(r.trigger?.fieldId ?? '') || '',
    },
    actions: (r.actions ?? []).map((a) => ({
      ...a,
      tableId: a.tableId || fieldTableMap.get(a.fieldIds?.[0] ?? '') || '',
    })),
  }));

  const metaIdxOf = (arr: FieldMetaLite[]) => {
    const m = new Map<string, FieldMetaLite>();
    arr.forEach((x) => m.set(x.id, x));
    return m;
  };
  const mainIdx = metaIdxOf(mainMeta);
  const subIdxs = subs.map((_, i) => metaIdxOf(subMetas[i] ?? []));

  const hydrateField = (stub: any, idx: Map<string, FieldMetaLite>): FieldConfig => {
    const base = untrimField(stub);
    const m = idx.get(base.fieldId);
    if (m) {
      base.fieldName = m.name;
      base.fieldType = m.type;
      base.options = m.options;
      base.linkTableId = (m as any).linkTableId;
      // 用户若没改 label，默认用字段名
      if (!base.label) base.label = m.name;
    }
    return base;
  };

  return {
    ...form,
    mainTable: {
      tableId: form.mainTable?.tableId ?? '',
      tableName: tableNames.get(form.mainTable?.tableId ?? '') ?? '',
      sectionName: form.mainTable?.sectionName,
      fields: (form.mainTable?.fields ?? []).map((s: any) => hydrateField(s, mainIdx)),
    },
    subTables: subs.map((s: SubTableConfig, i: number) => ({
      ...s,
      tableName: tableNames.get(s.tableId) ?? '',
      linkFieldName: mainIdx.get(s.linkFieldId)?.name ?? subIdxs[i].get(s.linkFieldId)?.name,
      // 旧配置可能把 link 字段当成普通子表字段；它由提交逻辑自动维护，读取时直接剔除。
      fields: (s.fields ?? [])
        .filter((sf: any) => sf?.fieldId !== s.linkFieldId)
        .map((sf: any) => hydrateField(sf, subIdxs[i])),
    })),
    conditionalRules: rules,
  };
}

async function safeGetFieldMetaList(tableId: string): Promise<FieldMetaLite[]> {
  try {
    return await getFieldMetaList(tableId);
  } catch {
    return [];
  }
}

async function safeGetTableNameMap(): Promise<Map<string, string>> {
  try {
    const tables = await getTableMetaList();
    return new Map(tables.map((table) => [table.id, table.name]));
  } catch {
    return new Map();
  }
}
