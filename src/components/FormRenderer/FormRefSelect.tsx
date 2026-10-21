import React, { useMemo } from 'react';
import { Select, Typography } from '@douyinfe/semi-ui';
import { FieldConfig } from '../../types';
import {
  FormScope,
  collectFormRefOptions,
  describeRefSource,
  hasFormRef,
} from '../../utils/formFieldRef';
import { fuzzyOptionFilter } from './fuzzyOptionFilter';

interface Props {
  field: FieldConfig;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  multiple?: boolean;
  /** 表单值作用域（主表 + 各子表行值）；为空时选项为空集 */
  scope: FormScope | null;
  preview?: boolean;
}

/**
 * 「表单内跨区块取值」选择器 —— 选项来自**同一张表单中另一区块已录入的值**。
 *
 * ★ 与 `RefOptionSelect`（服务端引用选项）的本质区别：
 *   - `RefOptionSelect`：选项来自源数据表的已有记录 → 读服务端、翻页穷举、受权限约束；
 *   - 本控件：选项来自**本表单当前正在填写的值**（已是内存里的数据）
 *     → **零网络请求、零等待、零权限要求、实时联动**。
 *     因此既不需要「首屏秒出 + 后台续扫」，也不需要「可能不全」的兜底提示，
 *     更不会出现「已扫描 0 条」这类加载态。
 *
 * 语义（与配置面板的说明一致）：
 *   - 来源是**子表** → 取该子表**所有行**该字段的已填值，去重、保序 → 「一条一个」；
 *   - 来源是**主表** → 取该字段的单个值；
 *   - 来源字段是**多选** → 一个单元格拆成多个独立选项（走 `extractOptionTexts`）。
 *
 * 零破坏：仅在字段配置了 `formRef` 时才会被渲染到（分流在 `FieldRenderer` 里，
 * 由 `resolveOptionMode` 决定）；未配置时本文件完全不参与渲染。
 */
export function FormRefSelect({
  field,
  value,
  onChange,
  disabled,
  multiple,
  scope,
}: Props) {
  const ref = field.formRef;
  const ok = hasFormRef(field);

  /** 已选值（用于「不在来源里也要回显」与失效提示） */
  const selectedTexts = useMemo(() => {
    const arr = multiple ? ((value as string[]) ?? []) : value ? [value as string] : [];
    return (arr as string[]).filter((x) => typeof x === 'string' && x);
  }, [value, multiple]);

  /** 选项全集（纯本地计算；来源值一变即重算，零请求） */
  const values = useMemo(
    () => (ok ? collectFormRefOptions(ref!, scope) : []),
    // scope 的身份由 FormRenderer 的签名守门保证（未被引用的输入不会换身份）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ok, ref, scope]
  );

  const sourceLabel = useMemo(() => describeRefSource(ref!, scope), [ref, scope]);

  /** 候选项 = 选项全集 ∪ 已选值（后者保证回显，Semi 多选需要 label 可见） */
  const optionList = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (t: string) => {
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    };
    values.forEach(push);
    selectedTexts.forEach(push);
    return out.map((t) => ({ value: t, label: t }));
  }, [values, selectedTexts]);

  /** 已选但已不在来源中的项（诊断线索：来源行被删/改选过） */
  const staleSelected = useMemo(
    () => selectedTexts.filter((t) => !values.includes(t)),
    [selectedTexts, values]
  );

  if (!ok) {
    return (
      <Typography.Text type="warning">
        表单取值未配置完整，请重新编辑该字段的配置
      </Typography.Text>
    );
  }

  const footerText =
    values.length > 0
      ? `来自「${sourceLabel}」已录入的 ${values.length} 个值（随填写实时更新）` +
        (staleSelected.length ? `；${staleSelected.length} 项已不在来源中` : '')
      : `「${sourceLabel}」尚未录入，请先在上面填写`;

  return (
    <Select
      style={{ width: '100%' }}
      multiple={multiple}
      filter={fuzzyOptionFilter}
      /** 选中后保留关键字，便于连续多选 */
      autoClearSearchValue={false}
      optionList={optionList}
      value={multiple ? ((value as string[]) ?? []) : ((value as string) || undefined)}
      placeholder={values.length ? '从上方已录入的值中选择' : `请先填写「${sourceLabel}」`}
      disabled={disabled}
      emptyContent={values.length ? '无匹配选项' : `「${sourceLabel}」尚未录入`}
      virtualize={{ itemSize: 32 }}
      outerBottomSlot={
        <div style={{ padding: '6px 12px', fontSize: 12, color: '#86909c' }}>{footerText}</div>
      }
      onChange={(v: any) => onChange(v)}
    />
  );
}