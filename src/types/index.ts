import { FieldType } from '@lark-base-open/js-sdk';

/** 系统自动生成、不可由用户录入的字段类型 */
export const READONLY_FIELD_TYPES: FieldType[] = [
  FieldType.Formula,
  FieldType.Lookup,
  FieldType.CreatedTime,
  FieldType.ModifiedTime,
  FieldType.CreatedUser,
  FieldType.ModifiedUser,
  FieldType.AutoNumber,
  FieldType.Barcode,
];

/** 单个字段在表单中的配置 */
export interface FieldConfig {
  fieldId: string;
  fieldName: string;
  fieldType: FieldType;
  /** 是否在表单中显示 */
  visible: boolean;
  /** 是否必填 */
  required: boolean;
  /** 显示标签（可自定义，默认用字段名） */
  label?: string;
  /** 占位提示文字 */
  placeholder?: string;
  /** 默认值 */
  defaultValue?: unknown;
  /** 是否只读 */
  readonly?: boolean;
  /** 单选/多选的可选项（从字段元信息提取：{id,name,color}） */
  options?: { id: string; name: string; color?: string }[];
  /** 关联字段指向的表 ID（仅关联类型） */
  linkTableId?: string;
}

/** 子表配置 */
export interface SubTableConfig {
  tableId: string;
  tableName: string;
  /** 子表区块在表单中的展示名称（默认取子表名或「子表 N」） */
  sectionName?: string;
  /** 子表中指向主表的关联字段 ID（SingleLink / DuplexLink） */
  linkFieldId: string;
  linkFieldName?: string;
  /** 子表表单字段 */
  fields: FieldConfig[];
  /** 是否允许添加多条子表记录 */
  allowMultiple: boolean;
  /** 最多允许添加多少条（allowMultiple 时生效） */
  maxRows?: number;
}

/** 条件显示规则 */
export interface ConditionalRule {
  ruleId: string;
  /** 触发条件 */
  trigger: {
    tableId: string;
    fieldId: string;
    operator: 'equals' | 'notEquals' | 'contains' | 'isEmpty' | 'isNotEmpty';
    value: unknown;
  };
  /** 满足条件时的动作 */
  actions: {
    type: 'show' | 'hide' | 'require' | 'unrequire';
    tableId: string;
    fieldIds: string[];
  }[];
}

/** 插件完整配置（持久化到 bridge / dashboard） */
export interface FormPluginConfig {
  /** 表单唯一 ID（多表单场景下用于区分与关联） */
  id: string;
  version: string;
  formTitle: string;
  formDescription?: string;
  /** 主题色（hex，如 #1d4ed8）；缺省用默认品牌蓝 */
  themeColor?: string;
  mainTable: {
    tableId: string;
    tableName: string;
    /** 主表区块在表单中的展示名称（默认「主表信息」） */
    sectionName?: string;
    fields: FieldConfig[];
  };
  subTables: SubTableConfig[];
  conditionalRules: ConditionalRule[];
}

/** 表单填写态：值映射，key 为 fieldId */
export type FormValues = Record<string, unknown>;

/** 条件引擎计算结果 */
export interface ConditionalState {
  /** tableId -> 需要隐藏的 fieldId 集合 */
  hiddenFields: Record<string, Set<string>>;
  /** tableId -> 需要强制必填的 fieldId 集合 */
  forcedRequired: Record<string, Set<string>>;
  /** tableId -> 需要取消必填的 fieldId 集合 */
  forcedUnrequired: Record<string, Set<string>>;
}

/** 校验结果 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * 插件数据（页面资产模型）：承载多个相互独立的表单。
 * - dashboard 宿主：整个对象存进 dashboard.saveConfig({ dataConditions, customConfig })，
 *   其中 dataConditions 由配置引用的主表/子表真实 ID 自动构造（见 configService）。
 * - bridge 宿主：整个对象存进 bitable.bridge.setData
 * 因此「多表单相互独立、互不干扰」，且配置按页面/实例持久化，多人共享同一批表单。
 */
export interface PluginData {
  forms: FormPluginConfig[];
  /** 使用态默认展示的表单 ID */
  defaultFormId?: string;
}

/** 生成唯一 ID（优先 crypto.randomUUID，回退时间戳+随机） */
export function genId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function') {
      return (crypto as any).randomUUID();
    }
  } catch {
    /* ignore */
  }
  return 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export const CONFIG_STORAGE_KEY = 'formDesignPluginConfig';
export const CONFIG_VERSION = '1.0.0';
