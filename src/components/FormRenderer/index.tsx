import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FieldType } from '@lark-base-open/js-sdk';
import {
  ConditionalState,
  FieldConfig,
  FormPluginConfig,
  FormValues,
  FieldError,
  UniqueFieldState,
  UNIQUE_CHECKABLE_TYPES,
} from '../../types';
import { useConditional } from '../../hooks/useConditional';
import { validateForm, isEmptyValue } from '../../utils/validator';
import { submitForm } from '../../services/recordService';
import {
  checkDuplicates,
  checkOneValue,
  loadAllExistingValues,
  noteSubmittedValues,
  FULL_SCAN_TOTAL_LIMIT,
} from '../../services/uniqueCheck';
import { resolveAutoFill, markManualEdits } from '../../utils/dateAutoFill';
import {
  FormScope,
  buildFormScope,
  formHasAnyFormRef,
  formRefValuesSignature,
} from '../../utils/formFieldRef';
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

/** 日期联动 manual/auto 集合的主表 key（模块级纯函数：引用恒定，避免下游 memo 穿透） */
const mainKey = (fieldId: string) => `main:${fieldId}`;

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
  /**
   * 日期联动的「手动改过」标记（manualEdited）与「本次自动填的」标记（autoFilled）。
   * key 规则：主表 `main:<fieldId>`；子表 `sub:<tableId>:<rowIndex>:<fieldId>`。
   * 用户手动改过之后即加入 manualEdited，自动预填不再覆盖他的值。
   */
  const manualEdited = useRef<Set<string>>(new Set());
  const autoFilled = useRef<Set<string>>(new Set());

  /**
   * ★ 传给 MainForm / SubForm 的回调必须保持引用稳定，否则 React.memo 每次都会被穿透。
   * 这里用 ref 持有最新值，让下方 useCallback([]) 里的逻辑读到最新数据。
   */
  const configRef = useRef(config);
  configRef.current = config;
  const mainValuesRef = useRef(mainValues);
  mainValuesRef.current = mainValues;
  const subValuesRef = useRef(subValues);
  subValuesRef.current = subValues;

  /**
   * 唯一性校验的实时状态：
   * key = `main:<fieldId>`（主表）/ `sub:<tableId>:<rowIndex>:<fieldId>`（子表）
   */
  const [uniqueState, setUniqueState] = useState<Record<string, UniqueFieldState>>({});
  // 失焦校验的序号：只采用最后一次失焦的结果，避免连续修改导致的竞态覆盖
  const blurSeq = useRef(0);

  /** 收集配置了唯一性校验的字段（主表 + 子表） */
  const uniqueFields = useMemo(
    () => {
      const out: { tableId: string; fieldId: string; label: string; message?: string }[] = [];
      const push = (tableId: string, f: FieldConfig) => {
        if (!f.unique?.enabled) return;
        if (!UNIQUE_CHECKABLE_TYPES.includes(f.fieldType)) return;
        out.push({ tableId, fieldId: f.fieldId, label: f.label || f.fieldName || f.fieldId, message: f.unique.message });
      };
      config.mainTable.fields.forEach((f) => push(config.mainTable.tableId, f));
      config.subTables.forEach((s) => s.fields.forEach((f) => push(s.tableId, f)));
      return out;
    },
    [config]
  );

  // ★ 后台静默预加载：小表直接把已有取值全量拉好并缓存（第一次失焦秒出）；
  //   大表（超过阈值）不预拉，避免上百次翻页卡页面 —— 判重改由服务端过滤完成，同样准确。
  //   配置态预览不预加载（预览不填数据，加载纯属浪费且拖慢配置页）。
  useEffect(() => {
    if (preview) return;
    uniqueFields.forEach((x) => {
      loadAllExistingValues(x.tableId, x.fieldId, x.label, {
        totalLimit: FULL_SCAN_TOTAL_LIMIT,
      }).catch(() => {
        /* 预加载失败不影响使用，失焦时会再次尝试并提示 */
      });
    });
  }, [uniqueFields, preview]);

  /** 失焦校验单个字段（主表 / 子表共用） */
  const runUniqueCheck = (
    key: string,
    tableId: string,
    fieldId: string,
    raw: unknown,
    message?: string,
    fieldType?: FieldType
  ) => {
    if (isEmptyValue(raw)) {
      // 清空后不显示任何提示
      setUniqueState((s) => {
        if (!(key in s)) return s;
        const n = { ...s };
        delete n[key];
        return n;
      });
      return;
    }
    const seq = (blurSeq.current += 1);
    setUniqueState((s) => ({ ...s, [key]: { status: 'checking' } }));
    checkOneValue(tableId, fieldId, raw, message, fieldType)
      .then((res) => {
        if (seq !== blurSeq.current) return; // 已有更新的失焦，丢弃本次结果
        console.log(
          `[uniqueCheck] ${tableId}/${fieldId} 判定「${String(raw).slice(0, 30)}」→ ${res.status}${res.detail ? `（${res.detail}）` : ''}`
        );
        setUniqueState((s) => ({
          ...s,
          [key]: { status: res.status, message: res.message, detail: res.detail },
        }));
      })
      .catch((e) => {
        if (seq !== blurSeq.current) return;
        setUniqueState((s) => ({
          ...s,
          [key]: { status: 'error', message: '无法校验', detail: (e as Error)?.message ?? String(e) },
        }));
      });
  };

  const handleMainBlur = useCallback((fieldId: string) => {
    const cfg = configRef.current;
    const f = cfg.mainTable.fields.find((x) => x.fieldId === fieldId);
    if (!f || !f.unique?.enabled) return;
    runUniqueCheck(
      mainKey(fieldId),
      cfg.mainTable.tableId,
      fieldId,
      mainValuesRef.current[fieldId],
      f.unique.message,
      f.fieldType
    );
  }, []);

  const handleSubBlur = useCallback((tableId: string) => (fieldId: string, rowIndex: number) => {
    const sub = configRef.current.subTables.find((s) => s.tableId === tableId);
    const f = sub?.fields.find((x) => x.fieldId === fieldId);
    if (!f || !f.unique?.enabled) return;
    const row = (subValuesRef.current[tableId] ?? [])[rowIndex] ?? {};
    runUniqueCheck(
      `sub:${tableId}:${rowIndex}:${fieldId}`,
      tableId,
      fieldId,
      row[fieldId],
      f.unique.message,
      f.fieldType
    );
  }, []);

  // 把统一 key 的校验状态拆成 MainForm / SubForm 各自的小 map
  const { mainUnique, subUnique } = useMemo(() => {
    const mainUnique: Record<string, UniqueFieldState> = {};
    const subUnique: Record<string, Record<string, UniqueFieldState>> = {};
    for (const [k, v] of Object.entries(uniqueState)) {
      if (k.startsWith('main:')) {
        mainUnique[k.slice(5)] = v;
        continue;
      }
      const m = /^sub:([^:]+):(\d+):(.+)$/.exec(k);
      if (m) {
        const [, tid, idx, fid] = m;
        (subUnique[tid] = subUnique[tid] || {})[`${idx}:${fid}`] = v;
      }
    }
    return { mainUnique, subUnique };
  }, [uniqueState]);

  // —— 日期联动预填：主表 ——
  // ★ 用 resolveAutoFill 在一个同步循环内迭代到收敛，只 setState 一次。
  //   旧写法「跑一轮就 setState，依赖值再跑下一轮」在长链配置下会连续写回多次，
  //   每写一次受控的 DatePicker 面板就被重置一次 → 用户看到频闪、点不中日期。
  useEffect(() => {
    const next = resolveAutoFill(
      config.mainTable.fields,
      mainValues,
      manualEdited.current,
      autoFilled.current,
      mainKey
    );
    if (next) setMainValues(next);
    // mainKey 是每次渲染重建的内联函数，不列入依赖；靠 mainValues 触发重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainValues, config.mainTable.fields]);

  // —— 日期联动预填：子表（逐行，与同行其他字段联动） ——
  useEffect(() => {
    let changedAny = false;
    const nextSubs: Record<string, FormValues[]> = { ...subValues };
    for (const sub of config.subTables) {
      const rows = subValues[sub.tableId] ?? [];
      let rowChanged = false;
      const newRows = rows.map((row, idx) => {
        const next = resolveAutoFill(
          sub.fields,
          row,
          manualEdited.current,
          autoFilled.current,
          (fid) => `sub:${sub.tableId}:${idx}:${fid}`
        );
        if (next) {
          rowChanged = true;
          return next;
        }
        return row;
      });
      if (rowChanged) {
        nextSubs[sub.tableId] = newRows;
        changedAny = true;
      }
    }
    if (changedAny) setSubValues(nextSubs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subValues, config.subTables]);

  /** 主表值变化（用户交互入口）：识别日期联动目标字段是否被手动修改 */
  const handleMainChange = useCallback((next: FormValues) => {
    markManualEdits(
      configRef.current.mainTable.fields,
      mainValuesRef.current,
      next,
      manualEdited.current,
      autoFilled.current,
      mainKey
    );
    setMainValues(next);
  }, []);

  /** 子表值变化（用户交互入口） */
  const handleSubChange = useCallback((tableId: string, rows: FormValues[]) => {
    const sub = configRef.current.subTables.find((s) => s.tableId === tableId);
    if (sub) {
      const before = subValuesRef.current[tableId] ?? [];
      rows.forEach((row, idx) => {
        markManualEdits(
          sub.fields,
          before[idx] ?? {},
          row,
          manualEdited.current,
          autoFilled.current,
          (fid) => `sub:${tableId}:${idx}:${fid}`
        );
      });
    }
    setSubValues((o) => ({ ...o, [tableId]: rows }));
  }, []);

  /**
   * 每张子表一个「引用恒定」的 onChange：直接传 handleSubChange.bind 会每次产生新函数，
   * 导致 React.memo 失效。这里按子表 ID 缓存回调，只有子表集合变化时才重建。
   */
  const subTableIds = config.subTables.map((s) => s.tableId).join('|');
  const subChangeHandlers = useMemo(() => {
    const map: Record<string, (rows: FormValues[]) => void> = {};
    for (const s of configRef.current.subTables) {
      map[s.tableId] = (rows: FormValues[]) => handleSubChange(s.tableId, rows);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subTableIds]);

  /**
   * ★ 表单内跨区块取值（formRef）的作用域。
   *
   * 三道保险，确保「零破坏 + 不穿透 memo」：
   *  ① `formHasAnyFormRef` 为假（旧配置 / 未使用该功能）→ **完全不构建、不传**，
   *     下游 MainForm / SubForm 收到的 prop 与今日完全一致 → 渲染路径零变化；
   *  ② 依赖里放的是 `formRefValuesSignature`（**只含被引用字段的实际取值**），
   *     而不是 `mainValues` / `subValues` 本身 —— 在没被引用的字段里打字不会换 scope 身份，
   *     因此不会穿透 React.memo 引发整树重渲染；
   *  ③ 主表字段配置按引用静态（字段配置是低频变更），不参与签名。
   */
  const hasFormRefFeature = useMemo(
    () => formHasAnyFormRef(config.mainTable.fields, config.subTables),
    [config.mainTable.fields, config.subTables]
  );
  const formRefSig = useMemo(
    () =>
      hasFormRefFeature
        ? formRefValuesSignature(
            config.mainTable.tableId,
            config.mainTable.fields,
            mainValues,
            config.subTables,
            subValues
          )
        : '',
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasFormRefFeature, config.mainTable.tableId, mainValues, config.subTables, subValues]
  );
  const formScope: FormScope | null = useMemo(() => {
    if (!hasFormRefFeature) return null;
    const blockLabels: Record<string, string> = {
      [config.mainTable.tableId]:
        config.mainTable.sectionName || config.mainTable.tableName || '主表信息',
    };
    config.subTables.forEach((s, i) => {
      blockLabels[s.tableId] = s.sectionName || s.tableName || `子表${i + 1}`;
    });
    return buildFormScope(config.mainTable.tableId, mainValues, subValues, config.subTables, {
      mainFields: config.mainTable.fields,
      blockLabels,
    });
    // ★ 依赖 formRefSig 而非 mainValues/subValues：身份只在「被引用字段的值」变化时更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    hasFormRefFeature,
    formRefSig,
    config.mainTable.tableId,
    config.mainTable.fields,
    config.subTables,
  ]);

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

  /** 字段级错误 → 可读定位（区块·第N条·字段名） */
  const labelOfError = (e: FieldError): string => {
    const inMain = e.tableId === config.mainTable.tableId;
    const sub = config.subTables.find((s) => s.tableId === e.tableId);
    const f = (inMain ? config.mainTable.fields : sub?.fields ?? []).find(
      (x) => x.fieldId === e.fieldId
    );
    const sec = inMain
      ? config.mainTable.sectionName || config.mainTable.tableName || '主表'
      : sub?.sectionName || sub?.tableName || '子表';
    const row = e.rowIndex !== undefined ? `第${e.rowIndex + 1}条` : '';
    return [sec, row, f?.label || f?.fieldName || e.fieldId].filter(Boolean).join('·');
  };

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

    // ★ 唯一性校验（提交时查重）：与数据表已有数据 + 本次提交多行之间比对。
    //   必填/格式校验先做，避免无谓读表。
    let dup: Awaited<ReturnType<typeof checkDuplicates>> = { errors: [], failures: [] };
    try {
      dup = await checkDuplicates(config, mainValues, subValues, cond);
    } catch (e) {
      setSubmitting(false);
      toast(`唯一性校验出错：${(e as Error)?.message ?? String(e)}`, 'error');
      return;
    }
    // 读不到已有数据（通常是权限不足）→ 阻断，不能静默放行，否则唯一性形同虚设
    if (dup.failures.length > 0) {
      setSubmitting(false);
      toast(
        `无法完成唯一性校验：${dup.failures.map((f) => `「${f.label}」`).join('、')} 读取已有数据失败（${dup.failures[0].reason}）。请确认你有该数据表的查看权限，或联系配置者关闭这些字段的唯一性校验。`,
        'error'
      );
      return;
    }
    if (dup.errors.length > 0) {
      setSubmitting(false);
      setSubmitErrors(dup.errors);
      const names = dup.errors.map(labelOfError).join('、');
      toast(
        dup.errors.length <= 3
          ? `以下字段与已有数据重复：${names}`
          : `${names.slice(0, 60)}… 等 ${dup.errors.length} 项与已有数据重复`,
        'error'
      );
      return;
    }

    // ★ 传入最新条件状态：隐藏字段的值在提交前被过滤（P1-3），不入库
    const r = await submitForm(config, mainValues, subValues, cond);
    setSubmitting(false);
    if (r.success) {
      toast('提交成功', 'success');
      // ★ 把本次写入的值并入查重缓存：同一会话内再填相同值也能判重
      config.mainTable.fields
        .filter((f) => f.unique?.enabled && UNIQUE_CHECKABLE_TYPES.includes(f.fieldType))
        .forEach((f) => {
          const v = mainValues[f.fieldId];
          if (!isEmptyValue(v)) noteSubmittedValues(config.mainTable.tableId, f.fieldId, [v]);
        });
      config.subTables.forEach((sub) => {
        const rows = subValues[sub.tableId] ?? [];
        sub.fields
          .filter((f) => f.unique?.enabled && UNIQUE_CHECKABLE_TYPES.includes(f.fieldType))
          .forEach((f) => {
            const vals = rows.map((row) => row[f.fieldId]).filter((v) => !isEmptyValue(v));
            if (vals.length) noteSubmittedValues(sub.tableId, f.fieldId, vals);
          });
      });
      setMainValues(initMainValues(config));
      setSubValues(initSubValues(config));
      // 重置日期联动的「手动改过 / 自动填过」标记，下一轮填写重新自动预填
      manualEdited.current = new Set();
      autoFilled.current = new Set();
      // 清空唯一性校验提示
      setUniqueState({});
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
            onChange={handleMainChange}
            cond={cond}
            errors={submitErrors}
            uniqueState={mainUnique}
            onFieldBlur={handleMainBlur}
            preview={preview}
            formScope={formScope || undefined}
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
              onChange={subChangeHandlers[sub.tableId] ?? ((rows) => handleSubChange(sub.tableId, rows))}
              cond={cond}
              errors={submitErrors}
              uniqueState={subUnique[sub.tableId]}
              onFieldBlur={handleSubBlur(sub.tableId)}
              preview={preview}
              formScope={formScope || undefined}
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
