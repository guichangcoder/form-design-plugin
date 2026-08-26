import React, { useEffect, useState } from 'react';
import { FormPluginConfig, CONFIG_VERSION } from '../../types';
import { useTableMeta } from '../../hooks/useTableMeta';
import { useFieldMeta } from '../../hooks/useFieldMeta';
import { metaToFieldConfig } from '../../services/baseService';
import { Input, TextArea, Select, Button, Typography } from '@douyinfe/semi-ui';
import { IconPlus } from '@douyinfe/semi-icons';
import { FieldConfigList } from './FieldConfigList';
import { SubTableConfig } from './SubTableConfig';
import { RuleEditor } from './RuleEditor';
import { toast } from '../../utils/toast';
import { DEFAULT_THEME, PRESET_COLORS, applyThemeColor } from '../../utils/theme';

interface Props {
  initialConfig: FormPluginConfig | null;
  onSave: (config: FormPluginConfig) => void;
  onCancel: () => void;
}

function defaultConfig(): FormPluginConfig {
  return {
    version: CONFIG_VERSION,
    formTitle: '新建表单',
    formDescription: '',
    themeColor: DEFAULT_THEME,
    mainTable: { tableId: '', tableName: '', fields: [] },
    subTables: [],
    conditionalRules: [],
  };
}

/** 分区卡片头：编号 + 标题 + 右侧说明 */
function SectionHead({ num, title, desc }: { num: string; title: string; desc?: string }) {
  return (
    <div className="sec-head">
      <span className="sec-num">{num}</span>
      <span className="sec-title">{title}</span>
      {desc && <span className="sec-desc">{desc}</span>}
    </div>
  );
}

export function ConfigPanel({ initialConfig, onSave, onCancel }: Props) {
  const { tables } = useTableMeta();
  const [draft, setDraft] = useState<FormPluginConfig>(() =>
    initialConfig && initialConfig.mainTable ? initialConfig : defaultConfig()
  );
  const { fields: mainFields } = useFieldMeta(draft.mainTable.tableId || undefined);

  // 主题色实时预览：draft 变化即应用到页面
  useEffect(() => {
    applyThemeColor(draft.themeColor);
  }, [draft.themeColor]);

  // 主表选择后，自动用其字段初始化表单配置
  useEffect(() => {
    if (mainFields.length && draft.mainTable.fields.length === 0 && draft.mainTable.tableId) {
      setDraft((d) => ({
        ...d,
        mainTable: { ...d.mainTable, fields: mainFields.map(metaToFieldConfig) },
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainFields]);

  const updateMainTable = (tableId: any) => {
    const t = tables.find((x) => x.id === tableId);
    setDraft((d) => ({
      ...d,
      mainTable: { tableId, tableName: t?.name ?? '', fields: [] },
    }));
  };

  const save = () => {
    if (!draft.mainTable.tableId) {
      toast('请先选择主表', 'warning');
      return;
    }
    if (!draft.mainTable.fields.some((f) => f.visible)) {
      toast('主表至少需显示一个字段', 'warning');
      return;
    }
    for (const sub of draft.subTables) {
      if (!sub.tableId) {
        toast('存在未选择数据表的子表', 'warning');
        return;
      }
      if (!sub.linkFieldId) {
        toast(`子表「${sub.tableName}」未选择指向主表的关联字段`, 'warning');
        return;
      }
    }
    console.log('[ConfigPanel] 校验通过，准备 onSave', draft);
    Promise.resolve()
      .then(async () => {
        await onSave(draft);
      })
      .catch((e) => {
        console.error('[ConfigPanel] onSave 异常:', e);
        toast(`保存失败：${(e as Error)?.message ?? String(e)}`, 'error');
      });
  };

  return (
    <div>
      {/* 01 基本信息 */}
      <div className="section-card">
        <SectionHead num="01" title="基本信息" desc="表单标题与说明" />
        <div className="sec-body">
          <div className="field-row">
            <label className="field-label">
              <span className="required-star">*</span>表单标题
            </label>
            <Input
              value={draft.formTitle}
              placeholder="例如：项目立项申请"
              onChange={(v: string) => setDraft((d) => ({ ...d, formTitle: v }))}
            />
          </div>
          <div className="field-row" style={{ marginBottom: 0 }}>
            <label className="field-label">表单描述</label>
            <TextArea
              value={draft.formDescription}
              placeholder="填写说明、注意事项（可选）"
              autosize
              rows={2}
              onChange={(v: string) => setDraft((d) => ({ ...d, formDescription: v }))}
            />
          </div>
          <div className="field-row" style={{ marginBottom: 0, marginTop: 14 }}>
            <label className="field-label">
              主题颜色
              <span
                style={{
                  fontWeight: 400,
                  color: '#6b7280',
                  fontSize: 12,
                  marginLeft: 8,
                }}
              >
                顶栏、按钮、分区徽章等将随之联动
              </span>
            </label>
            <div className="theme-picker">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`theme-swatch ${draft.themeColor === c ? 'active' : ''}`}
                  style={{ background: c }}
                  title={c}
                  onClick={() => setDraft((d) => ({ ...d, themeColor: c }))}
                />
              ))}
              <label
                className={`theme-swatch custom ${
                  PRESET_COLORS.includes(draft.themeColor ?? '') ? '' : 'active'
                }`}
                style={{ background: draft.themeColor || DEFAULT_THEME }}
                title="自定义颜色"
              >
                <input
                  type="color"
                  value={draft.themeColor || DEFAULT_THEME}
                  onChange={(e) => setDraft((d) => ({ ...d, themeColor: e.target.value }))}
                />
              </label>
            </div>
            <div className="theme-current">
              当前：<b>{draft.themeColor || DEFAULT_THEME}</b>
              {PRESET_COLORS.includes(draft.themeColor ?? '') ? '（预设）' : '（自定义）'}
            </div>
          </div>
        </div>
      </div>

      {/* 02 主表 */}
      <div className="section-card">
        <SectionHead num="02" title="主表" desc="必填 · 表单的主记录" />
        <div className="sec-body">
          <Select
            style={{ width: '100%' }}
            placeholder="选择主表"
            value={draft.mainTable.tableId || undefined}
            onChange={updateMainTable}
            optionList={tables.map((t) => ({ value: t.id, label: t.name }))}
          />
          <div style={{ marginTop: 12 }}>
            <FieldConfigList
              fields={draft.mainTable.fields}
              onChange={(f) => setDraft((d) => ({ ...d, mainTable: { ...d.mainTable, fields: f } }))}
            />
          </div>
        </div>
      </div>

      {/* 03 子表 */}
      <div className="section-card">
        <SectionHead num="03" title="子表" desc="可选 · 关联主表的明细" />
        <div className="sec-body">
          {draft.subTables.map((sub, i) => (
            <SubTableConfig
              key={i}
              index={i}
              sub={sub}
              tables={tables}
              onChange={(s) =>
                setDraft((d) => ({
                  ...d,
                  subTables: d.subTables.map((x, idx) => (idx === i ? s : x)),
                }))
              }
              onRemove={() =>
                setDraft((d) => ({ ...d, subTables: d.subTables.filter((_, idx) => idx !== i) }))
              }
            />
          ))}
          {draft.subTables.length === 0 && (
            <div className="empty-tip" style={{ marginBottom: 10 }}>
              无需子表可跳过。需要主子表联动录入时，点击下方「添加子表」（子表内需先建好指向主表的关联字段）。
            </div>
          )}
          <Button
            theme="borderless"
            icon={<IconPlus />}
            onClick={() =>
              setDraft((d) => ({
                ...d,
                subTables: [
                  ...d.subTables,
                  { tableId: '', tableName: '', linkFieldId: '', fields: [], allowMultiple: true },
                ],
              }))
            }
          >
            添加子表
          </Button>
        </div>
      </div>

      {/* 04 条件显示规则 */}
      <div className="section-card">
        <SectionHead num="04" title="条件显示规则" desc="字段值联动显隐 / 必填" />
        <div className="sec-body">
          <RuleEditor
            config={draft}
            rules={draft.conditionalRules}
            onChange={(r) => setDraft((d) => ({ ...d, conditionalRules: r }))}
          />
        </div>
      </div>

      {/* 底部操作 */}
      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
        <Button theme="solid" type="primary" className="save-config-btn" onClick={save} block>
          保存配置
        </Button>
        <Button className="save-config-btn" onClick={onCancel}>
          取消
        </Button>
      </div>
      <Typography.Text type="tertiary" style={{ display: 'block', textAlign: 'center', marginTop: 10, fontSize: 12 }}>
        保存后进入填写模式；可随时回到配置模式调整
      </Typography.Text>
    </div>
  );
}
