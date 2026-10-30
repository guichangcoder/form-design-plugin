import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FormPluginConfig, CONFIG_VERSION, genId, FieldConfig } from '../../types';
import { useTableMeta } from '../../hooks/useTableMeta';
import { useFieldMeta } from '../../hooks/useFieldMeta';
import { getLinkTargetTableId, metaToFieldConfig } from '../../services/baseService';
import { Input, TextArea, Select, Button, Typography } from '@douyinfe/semi-ui';
import { IconPlus } from '@douyinfe/semi-icons';
import { FieldConfigList } from './FieldConfigList';
import { SubTableConfig } from './SubTableConfig';
import { RuleEditor } from './RuleEditor';
import { BasePicker } from './BasePicker';
import { toast } from '../../utils/toast';
import { DEFAULT_THEME, PRESET_COLORS, applyThemeColor } from '../../utils/theme';
import { canListBases } from '../../services/appContext';
import { MAIN_COLUMNS_OPTIONS, resolveMainColumns } from '../../utils/mainLayout';
import { draftMountKey, shouldAdoptIncoming } from '../../utils/configDraft';

interface Props {
  initialConfig: FormPluginConfig | null;
  onSave: (config: FormPluginConfig) => void;
  onCancel: () => void;
  /** 应用模式：显示数据源（多维表格）选择器 */
  appMode?: boolean;
  /** 当前已选 baseToken（配置回填用） */
  baseToken?: string;
  /** 数据源切换回调：父级需要记录 baseToken 并清空旧草稿 */
  onBaseChange?: (baseToken: string, baseName: string) => void;
  /** 草稿实时变化回调：应用模式「左预览」用它渲染实时表单预览 */
  onDraftChange?: (draft: FormPluginConfig) => void;
}

function defaultConfig(): FormPluginConfig {
  return {
    id: genId(),
    version: CONFIG_VERSION,
    formTitle: '新建表单',
    formDescription: '',
    themeColor: DEFAULT_THEME,
    mainTable: { tableId: '', tableName: '', sectionName: '', fields: [] },
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

export function ConfigPanel({ initialConfig, onSave, onCancel, appMode, baseToken, onBaseChange, onDraftChange }: Props) {
  const { tables } = useTableMeta();
  const [draft, setDraft] = useState<FormPluginConfig>(() =>
    initialConfig && initialConfig.mainTable ? initialConfig : defaultConfig()
  );
  const { fields: mainFields } = useFieldMeta(draft.mainTable.tableId || undefined);

  /**
   * 🔴 外部配置变化时同步草稿（2026-10-29 线上缺陷修复）。
   *
   * 背景：`useState` 的初始化函数**只在首次挂载执行一次**，之后 `initialConfig`
   * 怎么变都不会再进 draft。于是「保存后只生效一次、再进配置态看不到上次配置、
   * 刷新后配置像丢了」——根因就在这一行没有监听。
   *
   * 修法：用「内容指纹」判定是否换了一份配置；只有真的换了才覆盖草稿，
   * 否则用户每敲一个字都会被外部旧对象冲回去（半受控频闪）。
   * 判定逻辑抽在 utils/configDraft.ts::shouldAdoptIncoming，可被测试真实调用。
   */
  const adoptedKeyRef = useRef<string | null>(null);
  const draftRef = useRef<FormPluginConfig>(draft);
  draftRef.current = draft;
  // 首次挂载即记录当前指纹：避免挂载后立刻把自己覆盖一遍
  if (adoptedKeyRef.current === null) {
    adoptedKeyRef.current = draftMountKey(initialConfig?.id, initialConfig);
  }
  useEffect(() => {
    const incomingKey = draftMountKey(initialConfig?.id, initialConfig);
    const should = shouldAdoptIncoming(incomingKey, adoptedKeyRef.current, false);
    if (!should) return;
    if (initialConfig && initialConfig.mainTable) {
      console.log('[ConfigPanel] 检测到外部配置变化，同步草稿', incomingKey);
      setDraft(initialConfig);
      adoptedKeyRef.current = incomingKey;
    }
  }, [initialConfig]);

  // 应用模式必须显式选择数据源后才能继续配置（P0-1：不混用默认 base）
  const needBase = !!appMode && canListBases();
  const baseReady = !needBase || !!baseToken;

  // 主题色实时预览：draft 变化即应用到页面
  useEffect(() => {
    applyThemeColor(draft.themeColor);
  }, [draft.themeColor]);

  // 草稿实时外抛（左预览布局用）
  useEffect(() => {
    onDraftChange?.(draft);
  }, [draft, onDraftChange]);

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

  /**
   * ★ 「表单取值」的来源候选区块 = 本表单的全部区块（主表 + 各子表）。
   * 调用方按需过滤掉「当前区块」（编辑器内也会再兜一层，避免自引用）。
   * 仅影响配置面板的可选项，不参与任何持久化。
   */
  const refBlocks = useMemo(() => {
    const out: { tableId: string; label: string; fields: FieldConfig[] }[] = [];
    if (draft.mainTable.tableId) {
      out.push({
        tableId: draft.mainTable.tableId,
        label: `${draft.mainTable.sectionName || draft.mainTable.tableName || '主表信息'}（主表）`,
        fields: draft.mainTable.fields,
      });
    }
    draft.subTables.forEach((s, i) => {
      if (!s.tableId) return;
      out.push({
        tableId: s.tableId,
        label: `${s.sectionName || s.tableName || `子表${i + 1}`}（子表）`,
        fields: s.fields,
      });
    });
    return out;
  }, [draft.mainTable, draft.subTables]);

  const updateMainTable = (tableId: any) => {
    const t = tables.find((x) => x.id === tableId);
    const newName = t?.name ?? '';
    setDraft((d) => {
      if (d.mainTable.tableId === tableId) return d;
      const prevSection = d.mainTable.sectionName ?? '';
      const prevName = d.mainTable.tableName;
      // 区块名称：未自定义（为空 或 仍等于旧表名）时，跟随新表名自动填充；
      // 已手动改过则保留用户的文字。
      const newSection = !prevSection || prevSection === prevName ? newName : prevSection;
      return {
        ...d,
        mainTable: { ...d.mainTable, tableId, tableName: newName, sectionName: newSection, fields: [] },
        // 主表变化后，旧子表关联和规则可能指向另一张主表，必须重新配置。
        subTables: [],
        conditionalRules: [],
      };
    });
  };

  const save = async () => {
    if (needBase && !baseToken) {
      toast('请先选择数据源多维表格', 'warning');
      return;
    }
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
    // 保存前用宿主元数据校验一次，避免旧配置/表结构变更后仍能进入填写态。
    const invalidLinks: string[] = [];
    for (const sub of draft.subTables) {
      try {
        const target = await getLinkTargetTableId(sub.tableId, sub.linkFieldId);
        if (target !== draft.mainTable.tableId) {
          invalidLinks.push(sub.tableName || sub.tableId);
        }
      } catch {
        invalidLinks.push(sub.tableName || sub.tableId);
      }
    }
    if (invalidLinks.length) {
      toast(`请重新选择关联字段：${invalidLinks.join('、')} 未指向主表`, 'error');
      return;
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
      {/* 00 数据源（应用模式必选，官方 P0-1：Workspace 绑定） */}
      {needBase && (
        <div className="section-card">
          <SectionHead num="00" title="数据源" desc="必填 · 选择本表单要写入的多维表格" />
          <div className="sec-body">
            <BasePicker
              value={baseToken}
              onChange={(token, name) => onBaseChange?.(token, name)}
            />
            {!baseToken && (
              <Typography.Text type="warning" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
                请先选择数据源多维表格，再配置主表/子表
              </Typography.Text>
            )}
          </div>
        </div>
      )}

      {/* 未选数据源时，后续配置区锁定（防止把默认 base 的表配进来）。
          fieldset disabled 只能禁原生控件，Semi 组件需配合 pointerEvents 拦截 */}
      <fieldset
        disabled={!baseReady}
        style={{
          border: 'none',
          padding: 0,
          margin: 0,
          minWidth: 0,
          opacity: baseReady ? 1 : 0.55,
          pointerEvents: baseReady ? 'auto' : 'none',
        }}
      >
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
          <div className="field-row">
            <label className="field-label">区块名称</label>
            <Input
              value={draft.mainTable.sectionName ?? ''}
              placeholder="默认与表格名称一致，可手动修改"
              onChange={(v: string) => setDraft((d) => ({ ...d, mainTable: { ...d.mainTable, sectionName: v } }))}
            />
          </div>
          <Select
            style={{ width: '100%' }}
            placeholder="选择主表"
            value={draft.mainTable.tableId || undefined}
            onChange={updateMainTable}
            optionList={tables.map((t) => ({ value: t.id, label: t.name }))}
            filter
            searchPlaceholder="搜索数据表"
          />

          {/* 排布列数：默认单列（纵向），可选双列 / 三列让短控件并排 */}
          <div className="subcfg-row" style={{ marginTop: 12 }}>
            <Typography.Text type="tertiary" style={{ fontSize: 12, minWidth: 64 }}>
              排布列数
            </Typography.Text>
            <div className="layout-choice">
              {MAIN_COLUMNS_OPTIONS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`layout-choice-btn ${
                    resolveMainColumns(draft.mainTable.columns) === n ? 'active' : ''
                  }`}
                  onClick={() =>
                    setDraft((d) => ({ ...d, mainTable: { ...d.mainTable, columns: n } }))
                  }
                >
                  <span className={`lcb-icon lcb-icon--cols lcb-icon--cols${n}`} />
                  <span className="lcb-text">
                    <b>{n === 1 ? '单列' : n === 2 ? '双列' : '三列'}</b>
                    <i>
                      {n === 1 ? '每行一个字段（默认）' : '短控件并排，减少滚动'}
                    </i>
                  </span>
                </button>
              ))}
            </div>
          </div>
          <Typography.Text
            type="tertiary"
            style={{ display: 'block', marginTop: 6, fontSize: 12, lineHeight: 1.7 }}
          >
            多列时，多行文本、附件、关联记录会自动跨满整行（这些控件压在半栏里会难以使用）；
            窄屏会自动降回单列。
          </Typography.Text>

          <div style={{ marginTop: 12 }}>
            <FieldConfigList
              fields={draft.mainTable.fields}
              onChange={(f) => setDraft((d) => ({ ...d, mainTable: { ...d.mainTable, fields: f } }))}
              currentTableId={draft.mainTable.tableId}
              otherBlocks={refBlocks}
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
            mainTableId={draft.mainTable.tableId}
            otherBlocks={refBlocks}
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
                  { tableId: '', tableName: '', sectionName: '', linkFieldId: '', fields: [], allowMultiple: true },
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
      </fieldset>
    </div>
  );
}
