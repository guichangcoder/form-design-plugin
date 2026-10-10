import React, { useEffect, useRef } from 'react';
import { FieldType } from '@lark-base-open/js-sdk';
import { FieldConfig } from '../../types';
import { bitable } from '@lark-base-open/js-sdk';
import { toast } from '../../utils/toast';
import {
  Input,
  TextArea,
  InputNumber,
  Select,
  DatePicker,
  Switch,
  Upload,
  Rating,
  Typography,
} from '@douyinfe/semi-ui';

interface Props {
  field: FieldConfig;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}

const fullWidth: React.CSSProperties = { width: '100%' };

/**
 * 单字段渲染器：根据字段类型分发到对应的 Semi UI 组件。
 * 关联字段（SingleLink/DuplexLink）由提交逻辑自动维护，前端仅作只读提示。
 * 注：Semi 各组件的 onChange 签名不完全一致，这里统一用 any 接收后转交外层 onChange。
 */
export function FieldRenderer({ field, value, onChange, disabled }: Props) {
  const options = (field.options ?? []).map((o) => ({ value: o.name, label: o.name }));
  const attachmentQueue = useRef(Promise.resolve());
  const latestAttachmentValue = useRef<string[]>(Array.isArray(value) ? (value as string[]) : []);

  useEffect(() => {
    if (Array.isArray(value)) latestAttachmentValue.current = value as string[];
  }, [value]);

  const uploadAttachment = (file: File) => {
    const task = attachmentQueue.current.then(async () => {
      const tokens = await bitable.base.batchUploadFile([file]);
      const next = [...latestAttachmentValue.current, ...tokens];
      latestAttachmentValue.current = next;
      onChange(next);
    });
    attachmentQueue.current = task.then(
      () => undefined,
      () => undefined
    );
    void task.catch(() => toast('附件上传失败', 'error'));
  };

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
      return (
        <Select
          style={fullWidth}
          optionList={options}
          value={(value as string) || undefined}
          placeholder={field.placeholder ?? '请选择'}
          disabled={disabled}
          onChange={(v: any) => onChange(v)}
        />
      );

    case FieldType.MultiSelect:
      return (
        <Select
          style={fullWidth}
          multiple
          optionList={options}
          value={(value as string[]) ?? []}
          placeholder={field.placeholder ?? '请选择'}
          disabled={disabled}
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
        <Rating
          value={(value as number) ?? 0}
          disabled={disabled}
          onChange={(v: any) => onChange(v)}
        />
      );

    case FieldType.Phone:
    case FieldType.Url:
    case FieldType.Email:
    case FieldType.Location:
    case FieldType.GroupChat:
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
        <Upload
          action=""
          multiple
          disabled={disabled}
          beforeUpload={(obj: any) => {
            // Semi 传入的是 { file: FileItem }，真实 File 位于 file.fileInstance。
            const file = obj?.file?.fileInstance as File | undefined;
            if (!file) {
              toast('无法读取待上传附件', 'error');
              return false;
            }
            uploadAttachment(file);
            return false; // 阻止默认上传行为，使用 batchUploadFile
          }}
        />
      );

    case FieldType.SingleLink:
    case FieldType.DuplexLink:
      // 关联字段由提交逻辑自动写入（指向主表记录），无需用户填写
      return (
        <Typography.Text type="tertiary">系统自动关联（提交时与主表关联）</Typography.Text>
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
