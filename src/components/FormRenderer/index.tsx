import React, { useEffect, useState } from 'react';
import { FormPluginConfig, FormValues, FieldError } from '../../types';
import { useConditional } from '../../hooks/useConditional';
import { validateForm, isEmptyValue } from '../../utils/validator';
import { submitForm } from '../../services/recordService';
import { toast } from '../../utils/toast';
import { applyThemeColor } from '../../utils/theme';
import { Button, Typography } from '@douyinfe/semi-ui';
import { MainForm } from './MainForm';
import { SubForm } from './SubForm';
import { IconSend } from '@douyinfe/semi-icons';

interface Props {
  config: FormPluginConfig;
  onBackToConfig?: () => void;
  /**
   * 配置态实时预览模式（应用模式「左预览+右配置」布局）：
   * 隐藏配置入口、提交按钮禁用，只用于展示表单外观与条件联动效果。
   */
  preview?: boolean;
  /**
   * 表结构元数据已变化（字段被删/选项变更/权限变化，P1-5）：
   * 暂停提交并提示重新载入，不静默清空用户已填数据。
   */
  metaStale?: boolean;
  /** 元数据重新载入回调（重新 hydrate 配置） */
  onReloadMeta?: () => void;
}

function initialValues(fields: FormPluginConfig['mainTable']['fields']): FormValues {
  return fields.reduce<FormValues>((values, field) => {
    if (field.defaultValue !== undefined) {
      values[field.fieldId] = Array.isArray(field.defaultValue)
        ? [...field.defaultValue]
        : field.defaultValue;
    }
    return values;
  }, {});
}

function initMainValues(config: FormPluginConfig): FormValues {
  return initialValues(config.mainTable.fields);
}

function initSubValues(config: FormPluginConfig): Record<string, FormValues[]> {
  const o: Record<string, FormValues[]> = {};
  config.subTables.forEach((s) => {
    o[s.tableId] = [initialValues(s.fields)];
  });
  return o;
}

/** 分区卡片头（填写态不传 num/desc，只显示区块名称） */
function SectionHead({ num, title, desc }: { num?: string; title: string; desc?: string }) {
  return (
    <div className="sec-head">
      {num ? <span className="sec-num">{num}</span> : null}
      <span className="sec-title">{title}</span>
      {desc && <span className="sec-desc">{desc}</span>}
    </div>
  );
}

export function FormRenderer({ config, onBackToConfig, preview, metaStale, onReloadMeta }: Props) {
  const [mainValues, setMainValues] = useState<FormValues>(() => initMainValues(config));
  const [subValues, setSubValues] = useState<Record<string, FormValues[]>>(() =>
    initSubValues(config)
  );
  const [submitting, setSubmitting] = useState(false);
  // 提交校验后的字段级错误（字段下方红字 + 高亮待填写字段）
  const [submitErrors, setSubmitErrors] = useState<FieldError[]>([]);
  const cond = useConditional(config, mainValues, subValues);

  // 应用配置的主题色
  useEffect(() => {
    applyThemeColor(config.themeColor);
  }, [config.themeColor]);

  // 用户继续填写时，已补上值的字段即时撤掉错误提示（不清其他字段的）
  useEffect(() => {
    setSubmitErrors((errs) =>
      errs.filter((e) => {
        const v =
          e.rowIndex !== undefined
            ? subValues[e.tableId]?.[e.rowIndex]?.[e.fieldId]
            : mainValues[e.fieldId];
        return isEmptyValue(v);
      })
    );
  }, [mainValues, subValues]);

  const handleSubmit = async () => {
    if (preview) return;
    if (metaStale) {
      toast('表结构已变化，请先点击上方「重新载入」再继续', 'warning');
      return;
    }
    const res = validateForm(config, mainValues, subValues, cond);
    // 诊断日志：校验放行的排查依据（必填字段的 required/值/隐藏判定一目了然）
    console.log('[submit] 校验结果:', {
      valid: res.valid,
      errors: res.errors,
      requiredFields: [
        ...config.mainTable.fields
          .filter((f) => f.required)
          .map((f) => ({
            field: f.label || f.fieldName,
            fieldId: f.fieldId,
            required: f.required,
            value: mainValues[f.fieldId],
          })),
      ],
    });
    if (!res.valid) {
      setSubmitErrors(res.fieldErrors);
      // toast 汇总列出全部待填写字段（不只第一条），字段下方同步红字
      const summary =
        res.errors.length <= 3
          ? res.errors.join('；')
          : `${res.errors.slice(0, 3).join('；')} 等 ${res.errors.length} 项未通过`;
      toast(summary, 'error');
      return;
    }
    setSubmitErrors([]);
    setSubmitting(true);
    // ★ 传入最新条件状态：隐藏字段的值在提交前被过滤（P1-3），不入库
    const r = await submitForm(config, mainValues, subValues, cond);
    setSubmitting(false);
    if (r.success) {
      toast('提交成功', 'success');
      setMainValues(initMainValues(config));
      setSubValues(initSubValues(config));
    } else if (r.rollback === 'partial') {
      // P0-2：失败且部分已写入记录未能自动清理，必须明确告知用户人工核查
      toast(
        `提交失败：${r.error ?? '未知错误'}。部分已写入记录未能自动清理（${r.rollbackDetail ?? ''}），请到数据表中人工核查`,
        'error'
      );
    } else if (r.rollback === 'clean') {
      toast(`提交失败：${r.error ?? '未知错误'}（已写入的记录已全部自动回滚）`, 'error');
    } else {
      toast(`提交失败：${r.error ?? '未知错误'}`, 'error');
    }
  };

  return (
    <div className="fill-form">
      {/* 表单标题区：网页表单风格，居中标题 + 描述，右上角保留配置入口 */}
      <div className="fill-head">
        <div className="fill-title">{config.formTitle || '未命名表单'}</div>
        {config.formDescription && <div className="fill-desc">{config.formDescription}</div>}
        {!preview && onBackToConfig && (
          <Button theme="borderless" size="small" className="fill-config-btn" onClick={onBackToConfig}>
            ⚙ 配置
          </Button>
        )}
      </div>

      {/* P1-5：表结构元数据已变化（字段删除/选项变更/权限变化）→ 暂停提交并提示重新载入，
          不静默清空用户正在填写的数据 */}
      {!preview && metaStale && (
        <div
          style={{
            margin: '0 0 12px',
            padding: '10px 14px',
            background: '#fff7ed',
            border: '1px solid #fdba74',
            borderRadius: 6,
            color: '#9a3412',
            fontSize: 13,
            lineHeight: 1.7,
          }}
        >
          ⚠️ 数据表的字段或选项已在其他地方被修改。为避免写入失效配置，提交已暂停；
          已填写的内容不会丢失，请「重新载入」后再提交。
          {onReloadMeta && (
            <Button
              size="small"
              theme="solid"
              type="warning"
              style={{ marginLeft: 10 }}
              onClick={onReloadMeta}
            >
              重新载入
            </Button>
          )}
        </div>
      )}

      {/* 主表 */}
      <div className="section-card">
        <SectionHead title={config.mainTable.sectionName || config.mainTable.tableName || '主表信息'} />
        <div className="sec-body">
          <MainForm
            config={config}
            values={mainValues}
            onChange={setMainValues}
            cond={cond}
            errors={submitErrors}
          />
        </div>
      </div>

      {/* 子表 */}
      {config.subTables.map((sub, i) => (
        <div className="section-card" key={sub.tableId}>
          <SectionHead title={sub.sectionName || sub.tableName || `子表${i + 1}`} />
          <div className="sec-body">
            <SubForm
              sub={sub}
              rows={subValues[sub.tableId] ?? [{}]}
              onChange={(rows) => setSubValues((o) => ({ ...o, [sub.tableId]: rows }))}
              cond={cond}
              errors={submitErrors}
            />
          </div>
        </div>
      ))}

      {/* 提交（预览模式禁用，仅展示外观） */}
      <Button
        theme="solid"
        type="primary"
        className="submit-btn"
        loading={submitting}
        disabled={preview || metaStale}
        icon={!submitting ? <IconSend /> : undefined}
        onClick={handleSubmit}
      >
        {preview ? '预览模式（提交已禁用）' : submitting ? '正在提交…' : metaStale ? '请先重新载入' : '提交'}
      </Button>
      {!preview && (
        <Typography.Text type="tertiary" style={{ display: 'block', textAlign: 'center', marginTop: 10, fontSize: 12 }}>
          提交后主表与各子表将自动关联写入
        </Typography.Text>
      )}
    </div>
  );
}
