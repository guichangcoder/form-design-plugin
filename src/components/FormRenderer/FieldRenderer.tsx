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
  /** 失焦回调（唯一性校验在此时触发） */
  onBlur?: () => void;
  /** 唯一性校验状态；undefined / 'idle' 时右侧不显示任何提示 */
  uniqueStatus?: 'idle' | 'checking' | 'ok' | 'dup' | 'error';
  /** 状态附带说明（如「无法校验」的详细原因） */
  uniqueHint?: string;
  /** 配置态实时预览：数据驱动控件（人员/关联/引用选项）不发起任何加载请求 */
  preview?: boolean;
  /**
   * 横向表格模式：唯一性校验徽标改为「控件下方紧凑小字」。
   * 表格列宽有限，原来的右侧 84px 竖排文字会把列撑爆；hover 时通过 title 显示原因。
   */
  uniqueCompact?: boolean;
  /**
   * 横向表格模式：控件紧凑化。
   * 文本字段由两行 TextArea 压成单行 Input，使表格行高一致、视觉更整齐。
   */
  compact?: boolean;
}

const fullWidth: React.CSSProperties = { width: '100%' };

/** 输入框右侧的唯一性校验提示（仅配置了唯一性校验的字段出现） */
function UniqueBadge({ status, hint }: { status: string; hint?: string }) {
  const map: Record<string, { text: string; type: 'success' | 'danger' | 'warning' | 'tertiary' }> = {
    checking: { text: '校验中…', type: 'tertiary' },
    ok: { text: '✓ 可用', type: 'success' },
    dup: { text: '✗ 已存在，请更换', type: 'danger' },
    error: { text: '⚠ 无法校验', type: 'warning' },
  };
  const conf = map[status];
  if (!conf) return null;
  return (
    <div
      className="unique-badge"
      title={status === 'error' ? hint : undefined}
      style={{
        flexShrink: 0,
        minWidth: 84,
        paddingTop: 4,
        fontSize: 12,
        lineHeight: 1.5,
        textAlign: 'right',
        whiteSpace: 'nowrap',
      }}
    >
      <Typography.Text type={conf.type} size="small">
        {conf.text}
      </Typography.Text>
    </div>
  );
}

/**
 * 横向表格模式下的紧凑唯一性提示：控件下方一行小字，不占横向空间。
 * 完整原因（如权限不足）通过 title 悬浮展示，避免把列撑宽。
 */
function UniqueBadgeCompact({ status, hint }: { status: string; hint?: string }) {
  const map: Record<string, { text: string; type: 'success' | 'danger' | 'warning' | 'tertiary' }> = {
    checking: { text: '校验中…', type: 'tertiary' },
    ok: { text: '✓ 可用', type: 'success' },
    dup: { text: '✗ 已存在', type: 'danger' },
    error: { text: '⚠ 无法校验', type: 'warning' },
  };
  const conf = map[status];
  if (!conf) return null;
  return (
    <div className="unique-badge-compact" title={hint} style={{ marginTop: 3, lineHeight: 1.4 }}>
      <Typography.Text type={conf.type} size="small" style={{ fontSize: 11 }}>
        {conf.text}
      </Typography.Text>
    </div>
  );
}

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
export function FieldRenderer({
  field,
  value,
  onChange,
  disabled,
  tableId,
  formValues,
  onBlur,
  uniqueStatus,
  uniqueHint,
  preview,
  uniqueCompact,
  compact,
}: Props) {
  const options = (field.options ?? []).map((o) => ({ value: o.name, label: o.name }));

  // ★ 配置态实时预览：人员/关联/引用选项控件都要拉表数据，配置页一打开就并发一堆请求 → 卡顿。
  //   预览只展示控件形态即可，数据加载留给真正的填写态（且填写态也是下拉展开才加载）。
  if (
    preview &&
    (field.fieldType === FieldType.User ||
      field.fieldType === FieldType.SingleLink ||
      field.fieldType === FieldType.DuplexLink ||
      hasOptionRef(field))
  ) {
    return <Input style={fullWidth} disabled placeholder="预览模式不加载数据" />;
  }

  const control = ((): React.ReactNode => {
    switch (field.fieldType) {
      case FieldType.Text:
        // 横向表格模式：压成单行输入（TextArea 两行会把表格行撑高、行高不齐）
        if (compact) {
          return (
            <Input
              style={fullWidth}
              value={(value as string) ?? ''}
              placeholder={field.placeholder}
              disabled={disabled}
              onChange={(v: any) => onChange(v)}
              onBlur={onBlur}
            />
          );
        }
        return (
          <TextArea
            style={fullWidth}
            autosize
            rows={2}
            value={(value as string) ?? ''}
            placeholder={field.placeholder}
            disabled={disabled}
            onChange={(v: any) => onChange(v)}
            onBlur={onBlur}
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
          onBlur={onBlur as any}
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
          onBlur={onBlur as any}
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
            preview={preview}
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
            preview={preview}
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
          preview={preview}
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
          onBlur={onBlur}
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
          preview={preview}
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
          onBlur={onBlur}
        />
      );
  }
  })();

  // 未配置唯一性校验的字段：保持原来的单控件布局（零改动风险）
  if (!uniqueStatus || uniqueStatus === 'idle') return <>{control}</>;
  // 横向表格模式：徽标放控件下方，避免占横向空间撑宽列
  if (uniqueCompact) {
    return (
      <div style={{ width: '100%' }}>
        {control}
        <UniqueBadgeCompact status={uniqueStatus} hint={uniqueHint} />
      </div>
    );
  }
  // 配置了唯一性校验：控件占满剩余宽度，右侧固定显示校验结果
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%' }}>
      <div style={{ flex: 1, minWidth: 0 }}>{control}</div>
      <UniqueBadge status={uniqueStatus} hint={uniqueHint} />
    </div>
  );
}
