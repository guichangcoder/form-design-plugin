/**
 * 把单元格值转为可展示文本（纯函数，Node 可测）。
 * 覆盖：文本段数组（IOpenSegment[]）、人员（{id,name}[]）、关联（{text}）、
 * 数字/布尔/时间戳（毫秒）、超链接（{link,text}）、地理位置（{full_address}）等常见形态。
 */
export function stringifyCellValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') {
    // 看起来像毫秒时间戳的数字按日期展示（主字段若是日期类型）
    return v > 946684800000 && v < 4102444800000
      ? new Date(v).toLocaleDateString()
      : String(v);
  }
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (Array.isArray(v)) {
    return v
      .map((item) => stringifyCellValue(item))
      .filter(Boolean)
      .join(' ');
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string' && o.text) return o.text;
    if (typeof o.name === 'string' && o.name) return o.name;
    if (typeof o.full_address === 'string') return o.full_address;
    if (typeof o.link === 'string') return o.link;
    return '';
  }
  return '';
}

/**
 * ★ 把单元格拆成「选项文本」列表（引用选项专用）。
 *
 * 语义差异（关键）：
 * - 多选字段单元格形如 `[{id,text:'A'},{id,text:'B'}]`，代表**两个独立选项**；
 *   若用 `stringifyCellValue` 会 join 成 `"A B"`，被当成**一个**选项 →
 *   引用到单选控件后无法单独选中。
 * - 单选/其它字段 → 单个文本。
 *
 * 只在**显式知道是多选**（fieldType === 4）时才拆分：人员/附件/关联等也是数组，
 * 但它们是「一个值由多项组成」，语义上不应拆成多个选项，故要求类型显式匹配，
 * 旧配置（无类型）保持原行为，避免误拆。
 *
 * @param cell 单元格原始值
 * @param fieldType 取值字段的 FieldType（缺省 = 不拆，按单值处理）
 */
export function extractOptionTexts(cell: unknown, fieldType?: number): string[] {
  const isMultiSelect = fieldType === 4; // FieldType.MultiSelect
  if (isMultiSelect && Array.isArray(cell)) {
    const out: string[] = [];
    for (const item of cell) {
      const t = stringifyCellValue(item).trim();
      if (t) out.push(t);
    }
    return out;
  }
  const t = stringifyCellValue(cell).trim();
  return t ? [t] : [];
}
