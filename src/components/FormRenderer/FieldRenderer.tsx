import React, { useRef } from 'react';
import { FieldType } from '@lark-base-open/js-sdk';
import { FieldConfig } from '../../types';
import {
  Input,
  TextArea,
  InputNumber,
  Select,
  DatePicker,
  Switch,
  Rating,
  Typography,
  Button,
  Tag,
  Space,
} from '@douyinfe/semi-ui';
import { IconUpload } from '@douyinfe/semi-icons';
import { PersonSelector, BitableUser } from './PersonSelector';
import { LinkSelector } from './LinkSelector';
import { RefOptionSelect } from './RefOptionSelect';
import { fuzzyOptionFilter } from './fuzzyOptionFilter';
import { hasOptionRef } from '../../utils/optionRef';
import { FormValues } from '../../types';

interface Props {
  field: FieldConfig;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  /** 字段所属表 ID（人员选择器用于加载候选人员） */
  tableId: string;
  /** 当前记录值（主表值 / 子表当前行值）：引用选项的联动条件据此实时过滤 */
  formValues?: FormValues;
}

const fullWidth: React.CSSProperties = { width: '100%' };

/**
 * 附件上传器：表单内持有 File[]，提交时由 valueConverter 统一调 batchUploadFile 上传
 * 并包裹为 { name,size,type,token,timeStamp } 写入（避免渲染期异步上传导致的状态错乱）。
 * 列表展示已选文件，支持逐个移除。
 */
function AttachmentUploader({
  value,
  onChange,
  disabled,
}: {
  value: File[];
  onChange: (v: File[]) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const files: File[] = Array.isArray(value) ? value : [];

  const pick = () => inputRef.current?.click();
  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []);
    if (picked.length) onChange([...files, ...picked]);
    e.target.value = ''; // 允许再次选择同一文件
  };
  const removeAt = (i: number) => onChange(files.filter((_, idx) => idx !== i));

  return (
    <div>
      <input ref={inputRef} type="file" multiple style={{ display: 'none' }} onChange={onPick} />
      <Space wrap style={{ marginBottom: 8 }}>
        {files.map((f, i) => (
          <Tag
            key={`${f.name}-${i}`}
            type="light"
            closable={!disabled}
            onClose={() => removeAt(i)}
          >
            {f.name}（{Math.max(1, Math.round(f.size / 1024))} KB）
          </Tag>
        ))}
        {files.length === 0 && <Typography.Text type="tertiary">尚未上传附件</Typography.Text>}
      </Space>
      <Button icon={<IconUpload />} disabled={disabled} onClick={pick}>
        选择文件
      </Button>
    </div>
  );
}

/**
 * 单字段渲染器：根据字段类型分发到对应的 Semi UI 组件。
 * 关联字段（SingleLink/DuplexLink）由 LinkSelector 让用户从目标表选记录；
 * 仅子表中指向主表的关联字段例外（SubForm 不渲染，提交逻辑自动注入主表 recordId）。
 */
export function FieldRenderer({ field, value, onChange, disabled, tableId, formValues }: Props) {
  const options = (field.options ?? []).map((o) => ({ value: o.name, label: o.name }));

  switch (field.fieldType) {
    case FieldType.Text:
      return (
        <TextArea
          style={fullWidth}
          autosize
          rows={2}
          value={(value as string) ?? ''}
          placeholder={field.placeholder}
          disabled={disabled}
          onChange={(v: any) => onChange(v)}
        />
      );

    case FieldType.Number:
    case FieldType.Currency:
      return (
        <InputNumber
          style={fullWidth}
          value={(value as number) ?? undefined}
          placeholder={field.placeholder}
          disabled={disabled}
          onChange={(v: any) => onChange(v)}
        />
      );

    case FieldType.Progress:
      return (
        <InputNumber
          style={fullWidth}
          min={0}
          max={100}
          value={(value as number) ?? undefined}
          disabled={disabled}
          onChange={(v: any) => onChange(v)}
        />
      );

    case FieldType.SingleSelect:
      // 配置了引用选项：选项从源表动态取（支持条件过滤与省-市级联）
      if (hasOptionRef(field)) {
        return (
          <RefOptionSelect
            field={field}
            value={value}
            onChange={onChange}
            disabled={disabled}
            formValues={formValues ?? {}}
          />
        );
      }
      return (
        <Select
          style={fullWidth}
          optionList={options}
          value={(value as string) || undefined}
          placeholder={field.placeholder ?? '请选择（输入可搜索）'}
          disabled={disabled}
          filter={fuzzyOptionFilter}
          emptyContent="无匹配选项"
          onChange={(v: any) => onChange(v)}
        />
      );

    case FieldType.MultiSelect:
      if (hasOptionRef(field)) {
        return (
          <RefOptionSelect
            field={field}
            value={value}
            onChange={onChange}
            disabled={disabled}
            multiple
            formValues={formValues ?? {}}
          />
        );
      }
      return (
        <Select
          style={fullWidth}
          multiple
          optionList={options}
          value={(value as string[]) ?? []}
          placeholder={field.placeholder ?? '请选择（输入可搜索）'}
          disabled={disabled}
          filter={fuzzyOptionFilter}
          emptyContent="无匹配选项"
          onChange={(v: any) => onChange(v)}
        />
      );

    case FieldType.DateTime:
      return (
        <div style={fullWidth}>
          <DatePicker
            value={(value as Date) ?? undefined}
            disabled={disabled}
            onChange={(v: any) => onChange(v)}
          />
        </div>
      );

    case FieldType.Checkbox:
      return <Switch checked={!!value} disabled={disabled} onChange={(v: any) => onChange(v)} />;

    case FieldType.Rating:
      return (
        <Rating value={(value as number) ?? 0} disabled={disabled} onChange={(v: any) => onChange(v)} />
      );

    case FieldType.User:
      // 人员字段：以人员选择器形式录入（候选来自本字段历史人员 + 当前用户）
      return (
        <PersonSelector
          tableId={tableId}
          fieldId={field.fieldId}
          value={(value as BitableUser[]) || []}
          onChange={onChange}
          disabled={disabled}
        />
      );

    case FieldType.Phone:
    case FieldType.Url:
    case FieldType.Email:
      return (
        <Input
          style={fullWidth}
          value={(value as string) ?? ''}
          placeholder={field.placeholder}
          disabled={disabled}
          prefix={field.fieldType === FieldType.Url ? 'https://' : undefined}
          onChange={(v: any) => onChange(v)}
        />
      );

    case FieldType.Attachment:
      return (
        <AttachmentUploader
          value={(value as File[]) || []}
          onChange={onChange}
          disabled={disabled}
        />
      );

    case FieldType.SingleLink:
    case FieldType.DuplexLink:
      // 关联字段：以「关联目标表记录选择器」形式录入，选项为目标表记录（主字段内容）。
      // 表单态保存 recordId 数组，提交时由 valueConverter 包裹为 IOpenLink 写入。
      // 注意：子表中指向主表的关联字段不会走到这里（SubForm 已排除，提交逻辑自动注入）。
      return (
        <LinkSelector
          tableId={tableId}
          fieldId={field.fieldId}
          linkTableId={field.linkTableId}
          value={Array.isArray(value) ? (value as string[]) : []}
          onChange={onChange}
          disabled={disabled}
        />
      );

    case FieldType.GroupChat:
    case FieldType.Location:
      // 群聊/地理位置的写入结构非简单文本（chat_id / 经纬度结构），按文本录入会写脏数据
      return (
        <Typography.Text type="warning">
          「{field.fieldName}」类型暂不支持录入，请在多维表格中直接填写，或在配置中隐藏该字段
        </Typography.Text>
      );

    default:
      return (
        <Input
          style={fullWidth}
          value={(value as string) ?? ''}
          placeholder={field.placeholder}
          disabled={disabled}
          onChange={(v: any) => onChange(v)}
        />
      );
  }
}
