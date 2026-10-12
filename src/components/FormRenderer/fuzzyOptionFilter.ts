/**
 * 选项模糊搜索：不区分大小写的子串匹配 + 子序列匹配。
 * 传给 Semi Select 的 filter 属性，作用于本地 optionList。
 *
 * - 子串命中：label 中包含输入的任意连续片段（常规模糊搜索，如 "北京" 输入 "北" 命中）
 * - 子序列命中：输入的字符按顺序出现即可（如 "ab" 命中 "a-x-b"）
 */
export function fuzzyOptionFilter(
  input: string,
  option: { label?: unknown }
): boolean {
  const q = (input || '').trim().toLowerCase();
  if (!q) return true;
  const label = String(option?.label ?? '').toLowerCase();
  if (!label) return false;
  // 子串命中
  if (label.includes(q)) return true;
  // 子序列命中
  let i = 0;
  for (const ch of label) {
    if (ch === q[i]) i++;
    if (i >= q.length) return true;
  }
  return i >= q.length;
}
