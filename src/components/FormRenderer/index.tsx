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
  applyUserDefaults,
  formHasAnyUserDefault,
  resetUserDefaultDone,
} from '../../utils/userDefault';
import { loadCurrentUserId } from '../../utils/currentUser';
import {
  FormScope,
  buildFormScope,
  formHasAnyFormRef,
  formRefValuesSignature,
} from '../../utils/formFieldRef';
import { toast } from '../../utils/toast';
import { applyThemeColor } from '../../utils/theme';
import { hasTableLayoutSub } from '../../utils/subTableLayout';
import {
  DraftPayload,
  draftHasContent,
  formSchemaSignature,
  mergeDraftRow,
  serializeDraftRow,
} from '../../utils/formDraft';
import {
  clearDraft,
  draftMainValues,
  draftSubValues,
  isDraftStorageAvailable,
  loadDraft,
  saveDraft,
} from '../../services/draftService';
import { Button, Typography } from '@douyinfe/semi-ui';
import { MainForm } from './MainForm';
import { SubForm } from './SubForm';
import { IconSend, IconSave } from '@douyinfe/semi-icons';

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
  /**
   * ★ 草稿归属的 baseToken（草稿按 base + 表单 + 用户三重隔离）。
   * 缺省（侧边栏 / dev）用 'nobase' 占位，仍能正常存取，只是不跨 base 区分。
   */
  baseToken?: string;
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

export function FormRenderer({ config, onBackToConfig, preview, metaStale, onReloadMeta, baseToken }: Props) {
  const [mainValues, setMainValues] = useState<FormValues>(() => initMainValues(config));
  const [subValues, setSubValues] = useState<Record<string, FormValues[]>>(() =>
    initSubValues(config)
  );
  const [submitting, setSubmitting] = useState(false);
  /**
   * ★ 提交闸门（同步 ref）：state 是异步的，挡不住同一帧内的第二次点击。
   * 与 submitting 配套：state 负责 UI，ref 负责并发控制。
   */
  const submittingRef = useRef(false);
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

  /**
   * ★ 人员字段「默认值＝当前用户」。
   *
   * 与日期联动的区别：这是**一次性初始化**（不是持续联动）。
   * - 打开表单时取一次当前用户身份（utils/currentUser.ts 共享缓存），把配置了开关的人员字段填成当前用户；
   * - 之后**绝不再插手**：用户改选/删除都尊重（由 userDefaultDone 集合守门）；
   * - 没配置该开关 → 本 effect 直接 return，**一次请求都不发**（零破坏）。
   *
   * ⚠️ 不能把 userId 存进 `defaultValue`：那会在配置者会话里被写死成配置者本人，
   *    导致所有填写者都被默认成同一个人。必须运行时取「打开者」身份。
   */
  const hasUserDefaultFeature = useMemo(
    () => formHasAnyUserDefault(config.mainTable.fields, config.subTables),
    [config.mainTable.fields, config.subTables]
  );
  /** 已处理过的「默认当前用户」字段集合（改过 / 清空后不再回填） */
  const userDefaultDone = useRef<Set<string>>(new Set());
  /** 当前用户 open_id（取一次复用；取不到为空串，后续不重试） */
  const meIdRef = useRef<string | null>(null);
  /** 提交成功后自增，用于触发「重新默认当前用户」effect 重跑（否则重新渲染不会重跑） */
  const [submitSeq, setSubmitSeq] = useState(0);
  /**
   * 各子表行数签名：用户「添加一行 / 删除一行」时变化 → 触发默认值 effect 重跑，
   * 让**新增的行**也自动默认当前用户（已有行已登记 done，不受影响）。
   */
  const subRowSig = config.subTables
    .map((s) => `${s.tableId}:${(subValues[s.tableId] ?? []).length}`)
    .join('|');

  useEffect(() => {
    if (preview || !hasUserDefaultFeature) return;
    let alive = true;

    (async () => {
      // 取当前用户（走全表单共享缓存 utils/currentUser.ts：与 PersonSelector 共用一次请求；
      // 该函数内部已兜异常，不会抛，失败时返回空串）
      if (meIdRef.current === null) {
        const id = await loadCurrentUserId();
        if (!alive) return;
        meIdRef.current = id || '';
      }
      const meId = meIdRef.current;
      if (!meId) return;

      // ⚠️ 这里用 ref 读当前值 + 直接 setState，而不是 setState(updater)。
      //    因为 applyUserDefaults 会**就地修改** done 集合（登记「已处理」），
      //    属于副作用；React StrictMode 会双调用 updater 函数来检测非纯函数，
      //    第二次调用时 done 里已有该 key → 返回 null → 默认值被吞掉。
      //    ref 在 render 后即最新，effect 紧随 commit 执行，读到的一定是最新值。

      // 主表
      const nextMain = applyUserDefaults(
        configRef.current.mainTable.fields,
        mainValuesRef.current,
        meId,
        userDefaultDone.current,
        mainKey
      );
      if (nextMain) setMainValues(nextMain);

      // 子表（逐行）
      const curSubs = subValuesRef.current;
      let changedAny = false;
      const nextSubs: Record<string, FormValues[]> = { ...curSubs };
      for (const sub of configRef.current.subTables) {
        const rows = curSubs[sub.tableId] ?? [];
        let rowChanged = false;
        const newRows = rows.map((row, idx) => {
          const next = applyUserDefaults(
            sub.fields,
            row,
            meId,
            userDefaultDone.current,
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
    })();

    return () => {
      alive = false;
    };
    // 依赖：字段配置（开关变化）+ submitSeq（提交后重新默认下一条记录）
    //      + subRowSig（新增子表行时给新行补默认值）。
    // 中途改值不重跑（meIdRef / userDefaultDone 已守门，避免与用户输入打架）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, hasUserDefaultFeature, submitSeq, subRowSig, config.mainTable.fields, config.subTables]);

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
    userTouched.current = true; // 用户已动过表单 → 放弃后续的草稿自动恢复
    setDraftDirty(true); // 用户改过值 → 触发防抖自动暂存
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
    userTouched.current = true; // 用户已动过表单 → 放弃后续的草稿自动恢复
    setDraftDirty(true); // 用户改过值 → 触发防抖自动暂存
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
    /**
     * ★ 防重入（并发写保护）。
     *
     * Semi 的 Button 只在 `disabled` 时阻止点击，`loading` **不会**吞掉 onClick，
     * 所以「点一下没反应再点一下」或快速双击会并发跑两次 submitForm →
     * 同一张数据表被并发 addRecord → 命中官方限制
     * 「1254291 Write conflict：同一个数据表不支持并发调用写接口」。
     *
     * 这里用同步 ref 做闸门（state 更新是异步的，挡不住同一帧内的第二次点击）。
     */
    if (submittingRef.current) {
      toast('正在提交，请稍候…', 'info');
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
    submittingRef.current = true;

    try {
      // ★ 唯一性校验（提交时查重）：与数据表已有数据 + 本次提交多行之间比对。
      //   必填/格式校验先做，避免无谓读表。
      let dup: Awaited<ReturnType<typeof checkDuplicates>> = { errors: [], failures: [] };
      try {
        dup = await checkDuplicates(config, mainValues, subValues, cond);
      } catch (e) {
        toast(`唯一性校验出错：${(e as Error)?.message ?? String(e)}`, 'error');
        return;
      }
      // 读不到已有数据（通常是权限不足）→ 阻断，不能静默放行，否则唯一性形同虚设
      if (dup.failures.length > 0) {
        toast(
          `无法完成唯一性校验：${dup.failures.map((f) => `「${f.label}」`).join('、')} 读取已有数据失败（${dup.failures[0].reason}）。请确认你有该数据表的查看权限，或联系配置者关闭这些字段的唯一性校验。`,
          'error'
        );
        return;
      }
      if (dup.errors.length > 0) {
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
      if (r.success) {
        toast('提交成功', 'success');
        // ★ 正式写入成功 → 草稿使命完成，立即清除（否则下次打开还会「恢复」出已提交的内容）
        clearDraft(draftBase, configRef.current.id, draftUserId || 'anonymous');
        setDraftSavedAt(null);
        setDraftDirty(false);
        draftRestored.current = true; // 已提交，本次会话不再尝试恢复草稿
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
        // 重置「默认当前用户」的处理标记，并触发 effect 重跑 → 新一条记录重新默认当前用户
        resetUserDefaultDone(userDefaultDone.current);
        setSubmitSeq((s) => s + 1);
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
    } finally {
      // ★ 无论走哪条出口都必须释放闸门，否则一次异常会让「提交」永久失效
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  /**
   * ★ 含横向表格子表 → 表单放宽到视口宽度（减少左右滑动）。
   * 纵向卡片形态不需要：表单越窄越好读，保持原 720px。
   */
  const hasWideSub = useMemo(
    () => hasTableLayoutSub(config.subTables ?? []),
    [config.subTables]
  );

  // ============ 草稿：暂存 / 恢复 / 提交后清空 ============
  /**
   * 草稿是**纯本地**的未提交内容（localStorage），绝不写服务端、绝不进数据表。
   *
   * 三重隔离（base + 表单 + 用户）见 utils/formDraft.ts::draftStorageKey ——
   * localStorage 在插件域名下是所有 base / 所有填写者共用的，不隔离会串号。
   */
  const draftBase = baseToken || 'nobase';
  /** 当前用户 ID（草稿隔离用；取不到时用 'anonymous'，与 currentUser 共享缓存） */
  const [draftUserId, setDraftUserId] = useState('');
  /**
   * ★ 身份「已询问过」标记（与「取到了 ID」是两件事）。
   *   `getUserId` 在无身份环境（纯浏览器预览 / 权限缺失）会返回空串，
   *   若只靠 `draftUserId !== ''` 判断，状态不变 → 恢复 effect 永不重跑 → 草稿静默不恢复。
   *   这里用独立布尔量驱动「可以读草稿了」。
   */
  const [draftIdReady, setDraftIdReady] = useState(false);
  /** 草稿的保存时间（有草稿时展示「草稿保存于 …」） */
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  /** 草稿是否处于「脏」状态（用户改过值但尚未落盘） */
  const [draftDirty, setDraftDirty] = useState(false);
  /** 首次挂载时是否已尝试恢复草稿（保证只恢复一次，不覆盖用户后续输入） */
  const draftRestored = useRef(false);
  /**
   * ★ 用户是否已经动过表单（改过任意字段）。
   *   身份是异步拿的，极端情况下（bridge 慢）用户可能在身份到位前就开始输入；
   *   此时再「恢复草稿」会把他刚敲的内容覆盖掉 → 一旦动过就彻底放弃自动恢复。
   */
  const userTouched = useRef(false);
  /** 草稿存储是否可用（不可用时整个草稿 UI 隐藏，不留死按钮） */
  const draftAvailable = useMemo(() => isDraftStorageAvailable(), []);

  /** 字段结构指纹：配置改动（字段增删）后旧草稿可能对不上号 */
  const schemaSig = useMemo(
    () =>
      formSchemaSignature(
        config.mainTable.fields.map((f) => f.fieldId),
        Object.fromEntries(
          config.subTables.map((s) => [s.tableId, s.fields.map((f) => f.fieldId)])
        )
      ),
    [config.mainTable.fields, config.subTables]
  );

  // 取当前用户 ID（草稿隔离键需要它；复用 utils/currentUser.ts 的共享缓存，不发第二次请求）
  useEffect(() => {
    if (preview || !draftAvailable) return;
    let alive = true;
    loadCurrentUserId()
      .then((id) => {
        if (!alive) return;
        setDraftUserId(id || '');
        setDraftIdReady(true); // ★ 无论有没有身份，都标记「已询问」→ 让恢复流程继续
      })
      .catch(() => {
        /* 取不到身份 → 用 anonymous 兜底，草稿仍可用（只是不与他人区分） */
        if (alive) setDraftIdReady(true);
      });
    return () => {
      alive = false;
    };
  }, [preview, draftAvailable]);

  /**
   * 挂载后恢复草稿（**只做一次**）。
   *
   * ⚠️ 时机很重要：必须等身份询问完成（draftIdReady）后再读，否则会读到 'anonymous' 那份空草稿。
   * ⚠️ 用「合并」而非「整体替换」：配置里新增的字段要保留其 defaultValue，
   *    草稿只覆盖它真实存过的 key（见 mergeDraftRow）。
   * ⚠️ 恢复完必须把 userDefaultDone 全部登记为「已处理」，否则「默认当前用户」effect
   *    会在恢复之后把草稿值覆盖成当前用户 —— 用户的草稿就白存了。
   */
  useEffect(() => {
    if (preview || !draftAvailable || draftRestored.current) return;
    if (!draftIdReady) return;
    draftRestored.current = true;
    // 身份就绪前用户已开始输入 → 尊重用户的当前输入，不恢复旧草稿（否则等于把他刚敲的抹掉）
    if (userTouched.current) return;
    const d = loadDraft(draftBase, config.id, draftUserId || 'anonymous');
    if (!d || !draftHasContent(d.main ?? {}, d.subs ?? {})) return;
    // 结构指纹不一致 → 字段增删过，草稿仍尽量恢复（按 fieldId 对得上的生效），
    // 但给出提示让用户知道可能不完整。
    const sigMismatch = !!d.schemaSig && d.schemaSig !== schemaSig;
    const dMain = draftMainValues(d);
    const dSubs = draftSubValues(d);
    // ★ 草稿有值 → 把该字段登记进 manualEdited / userDefaultDone，
    //   让日期联动与「默认当前用户」都不再插手（草稿内容优先于任何自动填充）
    for (const [k, v] of Object.entries(dMain)) {
      if (v === undefined || v === null || v === '') continue;
      manualEdited.current.add(mainKey(k));
      userDefaultDone.current.add(mainKey(k));
    }
    for (const [tid, rows] of Object.entries(dSubs)) {
      rows.forEach((row, i) => {
        for (const [k, v] of Object.entries(row)) {
          if (v === undefined || v === null || v === '') continue;
          manualEdited.current.add(`sub:${tid}:${i}:${k}`);
          userDefaultDone.current.add(`sub:${tid}:${i}:${k}`);
        }
      });
    }
    setMainValues((cur) => mergeDraftRow(cur, dMain) as FormValues);
    setSubValues((cur) => {
      const next: Record<string, FormValues[]> = { ...cur };
      for (const sub of config.subTables) {
        const rows = dSubs[sub.tableId];
        if (!rows || rows.length === 0) continue;
        const base0 = cur[sub.tableId] ?? [];
        // 草稿行数可能多于配置初始行（用户之前加了行）→ 以草稿为准，逐行合并初值
        next[sub.tableId] = rows.map((r, i) =>
          mergeDraftRow(base0[i] ?? {}, r) as FormValues
        );
      }
      return next;
    });
    setDraftSavedAt(d.savedAt ?? null);
    toast(
      sigMismatch
        ? '已恢复上次草稿（表单字段有调整，可能部分内容未恢复）'
        : '已恢复上次未提交的草稿',
      sigMismatch ? 'warning' : 'info'
    );
    // 只在身份就绪那一刻执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, draftAvailable, draftIdReady, draftUserId, draftBase, config.id]);

  /** 收集当前值 → 草稿载荷（序列化：Date 转标记对象，附件等不可存值丢弃） */
  const buildDraftPayload = useCallback((): DraftPayload => {
    const subs: Record<string, Array<Record<string, unknown>>> = {};
    for (const sub of configRef.current.subTables) {
      const rows = subValuesRef.current[sub.tableId] ?? [];
      subs[sub.tableId] = rows.map(serializeDraftRow);
    }
    return {
      formId: configRef.current.id,
      savedAt: Date.now(),
      main: serializeDraftRow(mainValuesRef.current),
      subs,
      schemaSig,
    };
  }, [schemaSig]);

  /** 手动保存草稿（用户点「保存草稿」） */
  const handleSaveDraft = useCallback(() => {
    if (preview) return;
    /**
     * ⚠️ 必须等身份就绪再存：身份未就绪时落盘会用 'anonymous' 兜底，
     *    而下次打开恢复时用的是真实 userId → 草稿 key 不同，存了也读不回来。
     *    同时这也避免「抢先置位 draftRestored」把恢复流程顶掉。
     */
    if (!draftIdReady) {
      toast('正在确认当前用户身份，请稍候一两秒再保存草稿', 'warning');
      return;
    }
    draftRestored.current = true; // 用户已明确保存 → 本次会话不再自动恢复旧草稿覆盖它
    const payload = buildDraftPayload();
    if (!draftHasContent(payload.main, payload.subs)) {
      toast('当前还没有填写任何内容，无需保存草稿', 'warning');
      return;
    }
    const ok = saveDraft(draftBase, configRef.current.id, draftUserId || 'anonymous', payload);
    if (ok) {
      setDraftSavedAt(payload.savedAt);
      setDraftDirty(false);
      toast('草稿已保存，本页面内容不会写入数据表', 'success');
    } else {
      toast('草稿保存失败（浏览器存储不可用或已满）', 'error');
    }
  }, [preview, draftIdReady, buildDraftPayload, draftBase, draftUserId]);

  /** 丢弃草稿：清空本地草稿并重置表单 */
  const handleDiscardDraft = useCallback(() => {
    if (draftIdReady) {
      clearDraft(draftBase, configRef.current.id, draftUserId || 'anonymous');
    }
    setMainValues(initMainValues(configRef.current));
    setSubValues(initSubValues(configRef.current));
    manualEdited.current = new Set();
    autoFilled.current = new Set();
    resetUserDefaultDone(userDefaultDone.current);
    setSubmitSeq((s) => s + 1);
    setUniqueState({});
    setSubmitErrors([]);
    draftRestored.current = true;
    setDraftSavedAt(null);
    setDraftDirty(false);
    toast('已丢弃草稿', 'info');
  }, [draftBase, draftUserId, draftIdReady]);

  /**
   * ★ 自动暂存（防意外关闭页面丢失内容）。
   *
   * 只在**用户改过值之后**触发（draftDirty），且**防抖 800ms** ——
   * 每敲一个字都写 localStorage 会拖慢输入，也让存储写入过于频繁。
   * 全空内容不落盘（否则每次打开都提示「有草稿」，反而打扰）。
   */
  useEffect(() => {
    if (preview || !draftAvailable || !draftRestored.current) return;
    if (!draftIdReady) return; // 同上：身份未就绪时落盘会写到 'anonymous' 的错误 key 上
    if (!draftDirty) return;
    const t = setTimeout(() => {
      const payload = buildDraftPayload();
      if (!draftHasContent(payload.main, payload.subs)) {
        /**
         * ★ 内容被清空 → **必须删除**已有草稿，而不是「跳过写入」。
         *   否则用户恢复草稿后把内容全删掉，本地那份旧草稿还在，
         *   下次打开又会「恢复」出他明明已经删掉的内容（真实踩过的坑）。
         */
        clearDraft(draftBase, configRef.current.id, draftUserId || 'anonymous');
        setDraftSavedAt(null);
        setDraftDirty(false);
        return;
      }
      const ok = saveDraft(draftBase, configRef.current.id, draftUserId || 'anonymous', payload);
      if (ok) {
        setDraftSavedAt(payload.savedAt);
        setDraftDirty(false);
      }
    }, 800);
    return () => clearTimeout(t);
  }, [preview, draftAvailable, draftIdReady, draftDirty, buildDraftPayload, draftBase, draftUserId, mainValues, subValues]);

  return (
    <div className={`fill-form${hasWideSub ? ' fill-form--wide' : ''}`}>
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

      {/* 草稿状态条：用户填过内容后出现，说明「当前内容不会进数据表」并提供手动保存 */}
      {!preview && draftAvailable && draftSavedAt && (
        <div className="draft-bar">
          <span className="draft-bar-text">
            📝 已暂存草稿（{new Date(draftSavedAt).toLocaleString()}）
            ｜ 内容<b>尚未提交</b>，不会写入数据表
          </span>
          <span className="draft-bar-actions">
            <Button size="small" theme="borderless" icon={<IconSave />} onClick={handleSaveDraft}>
              保存草稿
            </Button>
            <Button size="small" theme="borderless" type="danger" onClick={handleDiscardDraft}>
              丢弃草稿
            </Button>
          </span>
        </div>
      )}

      {/* 提交（预览模式禁用，仅展示外观） */}
      <div className="submit-row">
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
        {/* 保存草稿：正式提交前的「留一手」，切页/刷新后可继续填 */}
        {!preview && draftAvailable && (
          <Button
            className="draft-btn"
            icon={<IconSave />}
            disabled={metaStale}
            onClick={handleSaveDraft}
          >
            保存草稿
          </Button>
        )}
      </div>
      {!preview && (
        <Typography.Text type="tertiary" style={{ display: 'block', textAlign: 'center', marginTop: 10, fontSize: 12 }}>
          提交后主表与各子表将自动关联写入{draftAvailable ? '；草稿仅存本地，随时可回来继续填' : ''}
        </Typography.Text>
      )}
    </div>
  );
}
