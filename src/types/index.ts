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

/**
 * 暂不支持录入的字段类型（飞书官方诊断 P2-12 的群聊/地理位置部分）。
 * - 人员字段（User）已支持：以人员选择器录入，写入结构为 IOpenUser[]（open_id）。
 * - 群聊/地理位置的写入结构非简单文本（chat_id / 经纬度结构），按文本录入会写脏数据，
 *   配置阶段直接从可录入列表排除。
 */
export const UNSUPPORTED_FIELD_TYPES: FieldType[] = [
  FieldType.GroupChat,
  FieldType.Location,
];

/** 选项引用条件：源表字段 等于 固定值 / 当前记录内某字段值（联动） */
export interface OptionRefCondition {
  /** 源表过滤字段 ID */
  sourceFieldId: string;
  /**
   * ★ 源表该条件字段的字段类型（配置时由元信息记录）。
   * 服务端 filter 对「单选」的等于条件要求同时给出 fieldType 才能正确解析，
   * 多选则要用 contains 语义；缺失该类型时只能退化为纯文本等于条件。
   * 旧配置无此字段 → 兼容为「按文本处理」。
   */
  sourceFieldType?: FieldType;
  /** 值来源：static=固定值；field=当前记录（主表字段/子表同行字段）的值 */
  valueSource: 'static' | 'field';
  /** valueSource=static 时的固定值（按单元格文本比较） */
  staticValue?: string;
  /** valueSource=field 时引用的当前表单字段 ID（同区块：主表→主表字段，子表→同行字段） */
  formFieldId?: string;
}

/**
 * 选项引用配置（单选/多选字段）：从本 base 内其他数据表的字段内容动态生成选项。
 * 参考多维表格原生「引用选项」：选项 = 源表取值字段的记录值（去重），
 * conditions 全部满足的记录才纳入；条件引用表单字段时即实现「省-市」级联。
 */
export interface OptionReference {
  /** 源表 ID（可与当前表相同） */
  tableId: string;
  /** 源表取值字段 ID（其记录值去重后作为选项文本） */
  fieldId: string;
  /**
   * ★ 源表「取值字段」的字段类型（配置时由元信息记录）。
   * 用途：取值字段是**多选**时，单元格形如 `[{text:'A'},{text:'B'}]` 代表**两个独立选项**，
   * 需拆成两条选项（可被引用到单选控件）；缺失类型则只能当作整串一个选项。
   * 旧配置无此字段 → 兼容为「按单值处理」。
   */
  fieldType?: FieldType;
  /** 过滤条件（全部满足才纳入；空数组 = 不过滤，引用全部记录） */
  conditions: OptionRefCondition[];
}

/**
 * 唯一性校验配置（提交时与数据表内已有数据比对）。
 * 仅对「可转为文本比较的单值录入字段」开放（见 UNIQUE_CHECKABLE_TYPES）。
 */
export interface UniqueConfig {
  /** 是否开启查重 */
  enabled: boolean;
  /** 重复时的提示文案（可选，缺省用默认文案） */
  message?: string;
}

/**
 * 日期联动预填配置：挂在「目标日期字段」上。
 * 例：合同到期日配置 { sourceFieldId: 合同起始日, direction: plus, amount: 1, unit: year }
 *     → 选了起始日后自动预填 +1 年，用户仍可手动改（改后不再被覆盖）。
 */
export interface DateAutoFillConfig {
  /** 来源日期字段 ID（同一区块内的日期字段：主表→主表字段，子表→同行字段） */
  sourceFieldId: string;
  /** 方向：plus=之后，minus=之前 */
  direction: 'plus' | 'minus';
  /** 偏移量（非负整数） */
  amount: number;
  /** 偏移单位 */
  unit: 'day' | 'month' | 'year';
}

/**
 * ★ 表单内跨区块取值（FormFieldRef）—— 2026-10-21 新增的**可选**能力。
 *
 * 需求：某子表字段的选项，来自**同一张表单中另一个区块**（主表或另一张子表）
 * 用户**已录入**的字段值。例：合同主表下建了 3 条「产品明细」子表记录，
 * 另一张「收款计划」子表的「产品」字段，其选项只应是这 3 条明细里填过的产品。
 *
 * 与 `optionRef`（服务端引用选项）的区别：
 * - `optionRef`：选项来自**源数据表的已有记录**，需读服务端（受权限约束）；
 * - `formFieldRef`：选项来自**本表单当前正在填写的值**（内存中），
 *   **零网络请求**、实时联动、不要求填写者有源表读权限。
 *
 * 两者的关系：**互不相干、可并存**。取值时 `formFieldRef` 优先（更即时、更贴合
 * 「本次录入」语义）；未配置 `formFieldRef` 时行为与今日**完全一致**。
 */
export interface FormFieldRef {
  /** 来源区块的 tableId（主表 或 另一张子表 的表 ID） */
  sourceTableId: string;
  /** 来源区块中作为选项来源的字段 ID（通常是单选/多选/文本） */
  sourceFieldId: string;
  /**
   * 来源字段类型（配置时由元信息记录）。
   * 用途：来源是多选时一个单元格含多个选项 → 需拆成多条独立选项；
   * 缺失时按单值处理（与 `extractOptionTexts` 的约定一致）。
   */
  sourceFieldType?: FieldType;
  /**
   * 取值聚合方式：
   * - `distinctSet`（默认）＝把来源区块**所有行**的该字段值去重后作为选项集合。
   *   子表来源即「已录入的 N 条明细里出现过的所有值」，符合「一条一个/可改选」预期。
   * - `single`＝只取来源区块的单个值（主表来源时天然如此，可显式指定）。
   */
  aggregate?: 'distinctSet' | 'single';
}

/** 选项来源模式（供渲染层分流；formRef 优先于 optionRef） */
export type OptionSourceMode = 'formRef' | 'optionRef' | 'static';

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
  /** 选项引用（仅单选/多选）：配置后忽略固定 options，改为从源表动态取选项 */
  optionRef?: OptionReference;
  /**
   * ★ 表单内跨区块取值（仅单选/多选）：选项来自同一张表单里另一区块**已填写**的值。
   * 纯本地计算、零请求；配置后优先于 optionRef 与固定 options。
   * 旧配置无此字段 → 行为完全不变。
   */
  formRef?: FormFieldRef;
  /** 唯一性校验（提交时查重；仅 UNIQUE_CHECKABLE_TYPES 开放的字段类型生效） */
  unique?: UniqueConfig;
  /** 日期联动预填（仅日期字段，挂在被预填的目标字段上） */
  dateAutoFill?: DateAutoFillConfig;
  /**
   * ★ 人员字段「默认值＝当前用户」（仅 FieldType.User 生效）。
   *
   * 开启后，打开表单时该字段自动填入**当前填写者**，填写人可自行改选或删除；
   * 一旦用户改过 / 主动清空，**不再回填**（默认值只在初始化阶段生效一次）。
   *
   * ⚠️ 不能复用 `defaultValue`：`initialValues` 是**同步**求值，而当前用户 ID 只能由
   * `getBridge().getUserId()` **异步**取得。若把 userId 存进 defaultValue，存下的会是
   * **配置者**的 open_id（配置发生在配置者会话中）→ 所有填写者都被默认成同一个人。
   * 因此必须运行时动态取「打开者」身份。
   *
   * 查找引用 / 公式等只读字段的 fieldType 分别是 Lookup / Formula（≠ User），天然不生效。
   * 旧配置无此字段 → 行为完全不变。
   */
  defaultToCurrentUser?: boolean;
}

/**
 * 支持「唯一性校验」的字段类型：可转为文本做相等比较的单值录入字段。
 * 不含多选/附件/人员等结构复杂或多值字段（其单元格不是单一文本，比较语义不明确）。
 */
export const UNIQUE_CHECKABLE_TYPES: FieldType[] = [
  FieldType.Text,
  FieldType.Phone,
  FieldType.Email,
  FieldType.Url,
  FieldType.Number,
  FieldType.Currency,
];

/**
 * 子表展现形式：
 * - vertical：纵向卡片式（默认）。每条记录一张卡片，字段竖排 —— 字段少时清晰。
 * - table：横向表格式。每条记录一行、字段作列头；总宽超出容器时可左右滑动。
 */
export type SubTableLayout = 'vertical' | 'table';

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
  /**
   * 展现形式（缺省 = 'vertical'，旧配置无需迁移）。
   * ⚠️ 新增/修改此项必须同步 configSize.ts 的序列化白名单，否则保存时被瘦身剥离。
   */
  layout?: SubTableLayout;
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
  /** tableId -> 需要隐藏的 fieldId 集合（全表级：主表字段，或主表触发规则作用到子表全部行） */
  hiddenFields: Record<string, Set<string>>;
  /** tableId -> 需要强制必填的 fieldId 集合（全表级） */
  forcedRequired: Record<string, Set<string>>;
  /** tableId -> 需要取消必填的 fieldId 集合（全表级） */
  forcedUnrequired: Record<string, Set<string>>;
  /** 子表行级隐藏：subTableId -> 每行的 fieldId 集合（子表字段触发、作用于同一张子表） */
  rowHiddenFields: Record<string, Array<Set<string>>>;
  /** 子表行级强制必填 */
  rowForcedRequired: Record<string, Array<Set<string>>>;
  /** 子表行级取消必填 */
  rowForcedUnrequired: Record<string, Array<Set<string>>>;
}

/** 校验结果 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /** 字段级错误（用于在对应字段下方红字提示 + 高亮待填写字段） */
  fieldErrors: FieldError[];
}

/** 字段级校验错误：rowIndex 仅子表行存在 */
export interface FieldError {
  tableId: string;
  fieldId: string;
  rowIndex?: number;
  message: string;
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
  /**
   * ★ 应用模式：配置所属多维表格的 baseToken（保存时写入）。
   * 应用插件与多维表格是一对多关系，必须通过 Workspace.getBitable(baseToken)
   * 拿到该 base 的 base/dashboard/ui/bridge 实例后再做数据读写；
   * dataConditions 里也必须带同一个 baseToken（非空时必填，官方契约）。
   */
  baseToken?: string;
  /**
   * ★ 配置所属多维表格的 baseId（保存时写入）。
   * 读取时校验：与当前 base 不一致的配置一律丢弃 —— 防止同一插件部署在多个
   * 多维表格时互相串配置（跨 base 污染 / 新 widget 预填旧表单的根源）。
   * 旧版配置无此字段视为本 base 配置，放行兼容。
   */
  baseId?: string;
}

/** 字段级唯一性校验的实时状态（失焦校验的结果，供输入框右侧展示） */
export interface UniqueFieldState {
  /** checking=校验中；ok=无重复；dup=已存在；error=无法校验（多为权限不足） */
  status: 'checking' | 'ok' | 'dup' | 'error';
  /** 展示文案（如「已存在，请更换」） */
  message?: string;
  /** error 状态下的详细原因 */
  detail?: string;
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
