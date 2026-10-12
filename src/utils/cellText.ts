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
