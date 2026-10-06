import React, { useEffect, useState, useRef } from 'react';
import { Button } from '@douyinfe/semi-ui';
import { IconPlus } from '@douyinfe/semi-icons';
import { bitable, dashboard, DashboardState } from '@lark-base-open/js-sdk';
import { useForms } from './hooks/useForms';
import { ConfigPanel } from './components/ConfigPanel';
import { FormRenderer } from './components/FormRenderer';
import { FormManager } from './components/FormManager';
import { FormPicker } from './components/FormPicker';
import { AddToAppHint } from './components/AddToAppHint';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FormPluginConfig, PluginData, genId, CONFIG_VERSION } from './types';
import { DEFAULT_THEME } from './utils/theme';
import { toast } from './utils/toast';
import { isDebugMode, hasDebugParam } from './utils/debug';
import {
  getHostContext,
  diagnoseHost,
  isHostConfigState,
  normalizeDashboardState,
  HostContext,
  repairDashboardConfigFromLastSave,
} from './services/configService';
import { probeHost, probeOneLine } from './services/probe';
import { exportDiagnosticBundle } from './services/diagExport';

/** 新建一份空白表单（带唯一 ID） */
function newForm(): FormPluginConfig {
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

type View = 'list' | 'edit' | 'fill';

/** 品牌顶栏：插件名 + 当前模式 + （侧边栏填写态）添加应用到应用模式入口 */
function PluginHeader({
  inConfig,
  context,
  onAddToApp,
}: {
  inConfig: boolean;
  context: HostContext;
  onAddToApp?: () => void;
}) {
  const inApp = context === 'dashboard';
  return (
    <div className="plugin-header">
      <div className="logo">📋</div>
      <div className="title-box">
        <h1>多表联填</h1>
        <div className="sub">
          {inApp ? '应用模式 · 仪表盘页面插件' : '主表 + 多子表 · 一次录入 · 条件联动'}
        </div>
      </div>
      {!inConfig && onAddToApp && !inApp && (
        <Button
          theme="solid"
          size="small"
          icon={<IconPlus />}
          className="header-add-app-btn"
          onClick={onAddToApp}
        >
          添加到应用
        </Button>
      )}
      <span className={`mode-badge ${!inConfig ? 'mode-fill' : ''}`}>
        {!inConfig ? '● 填写模式' : '⚙ 配置模式'}
      </span>
    </div>
  );
}

export default function App() {
  const { data, loading, load, save } = useForms();
  // 保存成功后展示「添加到应用模式」引导卡（仅侧边栏模式需要）
  const [showAppHint, setShowAppHint] = useState(false);
  // 宿主上下文：dashboard（应用模式仪表盘页面）/ bridge（普通侧边栏扩展）
  const [context] = useState<HostContext>(() => getHostContext());
  // URL 显式带 ?debug=1 时强制显示调试信息（优先级最高，填写态也可看）
  const debugForced = hasDebugParam();
  // 最近一次保存的结果（显示在页面顶部诊断条上，方便不用开 Console 就能定位问题）
  const [saveDiag, setSaveDiag] = useState<string>('');
  // 宿主诊断信息（用于飞书内加载后定位"为什么不进画布"）
  const [diag] = useState<Record<string, unknown>>(() => diagnoseHost());
  // 启动探测：在加载时主动把环境信息全部拉一遍（异步跑，不阻塞渲染）
  const [probe, setProbe] = useState<Awaited<ReturnType<typeof probeHost>> | null>(null);
  // dashboard 宿主在保存后是否真的发来了"已接受配置"的信号（onConfigChange）
  const [configChangeSeen, setConfigChangeSeen] = useState<number>(0);
  // 最近一次保存 payload 的摘要（从 localStorage 读取，配置态可见）
  const [lastPayload, setLastPayload] = useState<string>(() => {
    try {
      const raw = localStorage.getItem('__plugin_last_save_payload__');
      if (!raw) return '';
      const o = JSON.parse(raw);
      return `上次保存 ${new Date(o.time).toLocaleTimeString()} ｜ dataConditions=${JSON.stringify(o.payload?.dataConditions)} ｜ customConfig=${o.payload?.customConfigLength ?? '?'}B`;
    } catch {
      return '';
    }
  });
  // 最近一次保存后立即读回 getConfig 的结果（看宿主实际存进去的是什么）
  const [lastReadback, setLastReadback] = useState<string>(() => {
    try {
      const raw = localStorage.getItem('__plugin_last_save_readback__');
      if (!raw) return '';
      const o = JSON.parse(raw);
      const rb = o.readback ?? {};
      if (rb.err) return `上次读回失败：${rb.err}`;
      if (!rb.ok) return '上次读回：未拿到（可能 Create 态）';
      return `上次读回 OK ｜ 宿主存 cc=${rb.ccLen}B ｜ 宿主存 dataConditions=${JSON.stringify(rb.dataConditions)}`;
    } catch {
      return '';
    }
  });
  // 侧边栏模式下的配置/使用大模式（dashboard 模式由宿主 state 决定）
  const [outerMode, setOuterMode] = useState<'config' | 'fill'>('config');
  // 当前子视图：list（管理/选择列表） / edit（编辑单个表单） / fill（填写某个表单）
  const [inner, setInner] = useState<View>('list');
  const [editorTarget, setEditorTarget] = useState<FormPluginConfig | null>(null);
  const [activeFormId, setActiveFormId] = useState<string | null>(null);
  const inited = useRef(false);
  const bootMeasured = useRef(false);
  // dev 模式下宿主配置可能未被稳定持久化；View 态只尝试重放一次
  const repairAttempted = useRef(false);
  const [repairDiag, setRepairDiag] = useState<string>('');
  // dashboard View 态可能在首次 load 后再走一次配置重放；期间保持 loading 屏，
  // 避免把“尚未读取完成”误报成“配置数据发生变更”。
  const [repairing, setRepairing] = useState(context === 'dashboard');

  // dashboard 宿主状态（轮询同步，飞书切换配置/预览时通知插件重渲染）
  const [dashState, setDashState] = useState<DashboardState | undefined>(undefined);
  useEffect(() => {
    if (context !== 'dashboard') return;
    const sync = () => {
      try {
        setDashState(normalizeDashboardState((dashboard as any).state));
      } catch {
        /* ignore */
      }
    };
    sync();
    const timer = setInterval(sync, 600);
    return () => clearInterval(timer);
  }, [context]);

  const inConfig =
    context === 'dashboard'
      ? // 双保险：SDK 的 dashboard.state 只解析 hash 里的参数，这里再用 URL searchParams 兜底一次
        //（对齐官方 Count-Down 插件写法，详见 isHostConfigState 注释）
        dashState === DashboardState.Create ||
        dashState === DashboardState.Config ||
        (!dashState && isHostConfigState())
      : outerMode === 'config';

  // 调试内容可见性：填写态（View）永远干净（所见即发布后效果）；
  // 配置态下 dev 显示诊断条便于排错；?debug=1 强制任何态都显示。
  const showDebug = debugForced || (isDebugMode() && inConfig);

  // dashboard：宿主状态变化 → 回到对应列表（打断编辑/填写，避免界面与宿主不一致）
  useEffect(() => {
    if (context !== 'dashboard') return;
    setInner('list');
    setEditorTarget(null);
    setActiveFormId(null);
  }, [context, dashState]);

  useEffect(() => {
    if (context !== 'dashboard' || inConfig) setRepairing(false);
  }, [context, inConfig]);

  useEffect(() => {
    (window as any).__pluginBoot = {
      ...((window as any).__pluginBoot ?? {}),
      appStartAt: new Date().toISOString(),
      loadStartedAtMs: performance.now(),
    };
    load().finally(() => {
      if (bootMeasured.current) return;
      bootMeasured.current = true;
      (window as any).__pluginBoot = {
        ...(window as any).__pluginBoot,
        firstLoadDoneAtMs: performance.now(),
      };
    });
  }, [load]);

  // 启动诊断：把宿主环境打印到 Console，方便在飞书里加载后直接截图定位
  useEffect(() => {
    console.log('[App] 宿主诊断:', diag);
    if (context === 'dashboard') {
      console.log('[App] 当前 dashboard state:', (dashboard as any).state);
    }
    probeHost().then((p) => {
      console.log('[App] 启动探测:', p);
      setProbe(p);
    });
  }, [diag, context]);

  // 持有最新的 load，避免 onConfigChange 监听因 load 引用变化而反复注册
  const loadRef = useRef(load);
  loadRef.current = load;

  // dashboard 宿主：监听配置变化（用户在配置面板保存后），实时同步到组件
  useEffect(() => {
    if (context !== 'dashboard') return;
    let off: (() => void) | undefined;
    try {
      const d = dashboard as any;
      if (d && typeof d.onConfigChange === 'function') {
        off = d.onConfigChange((r: any) => {
          console.log('[App] dashboard.onConfigChange', r?.data);
          setConfigChangeSeen((n) => n + 1);
          loadRef.current();
        });
      }
    } catch {
      /* 非 dashboard 宿主或接口不可用 */
    }
    return () => {
      try {
        off && off();
      } catch {
        /* ignore */
      }
    };
  }, [context]);

  // bridge：首次加载完成后决定初始大模式（有表单→使用态，无→配置态）；之后由用户手动切换
  useEffect(() => {
    if (loading || context !== 'bridge' || inited.current) return;
    inited.current = true;
    setOuterMode(data && data.forms.length ? 'fill' : 'config');
    setInner('list');
  }, [loading, context, data]);

  // View 态自动修复（dev 模式）：F5 刷新后宿主 widget 配置可能丢失，导致弹
  // 「配置数据发生变更，请重新配置」。这里用最近一次成功保存的 payload 原样重放写回宿主，
  // 最多 2 轮（每轮内部再试 3 次），兜底宿主写入时序抖动。
  useEffect(() => {
    if (context !== 'dashboard' || loading || inConfig || repairAttempted.current) return;
    repairAttempted.current = true;
    setRepairing(true);
    let alive = true;
    (async () => {
      let lastReason = '';
      for (let round = 0; round < 2 && alive; round += 1) {
        const r = await repairDashboardConfigFromLastSave();
        if (!alive) return;
        if (r.repaired) {
          setRepairDiag(`🔁 已自动重放保存配置（${r.reason}）`);
          // 等宿主消化写入，再读回
          await new Promise((res) => setTimeout(res, 700));
          if (!alive) return;
          await load();
          break;
        }
        lastReason = r.detail?.lastErr
          ? `${r.reason}｜宿主报错: ${r.detail.lastErr}`
          : r.reason;
      }
      if (alive) {
        if (lastReason && !lastReason.startsWith('replayed')) {
          setRepairDiag(`autoRepair: ${lastReason}`);
        }
        setRepairing(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [context, loading, inConfig, load]);

  /** 保存单个表单（新建或更新），合并进多表单数据 */
  const handleSaveForm = async (form: FormPluginConfig) => {
    const base = data ?? { forms: [] };
    const exists = base.forms.some((f) => f.id === form.id);
    const forms2 = exists
      ? base.forms.map((f) => (f.id === form.id ? form : f))
      : [...base.forms, form];
    const defaultFormId = base.defaultFormId ?? forms2[0]?.id;
    const next: PluginData = { forms: forms2, defaultFormId };
    try {
      const r = await save(next);
      repairAttempted.current = false;
      // dashboard 宿主：saveConfig resolve 后，宿主应该已经（异步）把 widget 插入画布
      // 并把 state 从 Config → View。读一次 state，把这个"接受信号"暴露给用户看。
      // 同时把"序列化字节数 / 10240 上限"打到诊断条上 —— 这是上次 [page-service]
      // create widget failed: addonConfig exceeded maximum length limit [10240] 的直接修复反馈。
      let stateSignal = '';
      const sizeLine = (r as any).warning ? ` ｜ customConfig字节:<b>${(r as any).warning}</b>` : '';
      if (context === 'dashboard') {
        try {
          const nowState = String((dashboard as any).state);
          stateSignal = ` ｜ saveConfig后state:<b>${nowState}</b>`;
          // 等 1.5 秒后再读一次（有些宿主异步切状态）
          await new Promise((r) => setTimeout(r, 1500));
          const nowState2 = String((dashboard as any).state);
          if (nowState2 !== nowState) {
            stateSignal += ` → <b>${nowState2}</b>(已切换)`;
            setDashState(normalizeDashboardState((dashboard as any).state));
          } else {
            stateSignal += ` → <b>${nowState2}</b>(未切换 → 宿主可能已丢弃此次保存)`;
          }
        } catch {
          /* ignore */
        }
      }
      setSaveDiag(
        `✅ 保存成功（写入位置：${r.storage}）${stateSignal}${sizeLine}`
      );
      try {
        const raw = localStorage.getItem('__plugin_last_save_payload__');
        if (raw) {
          const o = JSON.parse(raw);
          setLastPayload(
            `上次保存 ${new Date(o.time).toLocaleTimeString()} ｜ dataConditions=${JSON.stringify(o.payload?.dataConditions)} ｜ customConfig=${o.payload?.customConfigLength ?? '?'}B`
          );
        }
      } catch {
        /* ignore */
      }
      // 同步读回诊断
      try {
        const rawRb = localStorage.getItem('__plugin_last_save_readback__');
        if (rawRb) {
          const o = JSON.parse(rawRb);
          const rb = o.readback ?? {};
          if (rb.err) setLastReadback(`上次读回失败：${rb.err}`);
          else if (!rb.ok) setLastReadback('上次读回：未拿到（可能 Create 态）');
          else setLastReadback(`上次读回 OK ｜ 宿主存 cc=${rb.ccLen}B ｜ 宿主存 dataConditions=${JSON.stringify(rb.dataConditions)}`);
        }
      } catch {
        /* ignore */
      }
      toast(
        r.storage === 'local' ? '表单已保存到本地（开发模式）' : '表单已保存',
        r.storage === 'local' ? 'warning' : 'success'
      );
      // dashboard 宿主：saveConfig 成功后飞书自动关闭配置弹窗并切到 View 状态，
      // 插件侧不需要手动切换视图（避免闪烁）
      if (context !== 'dashboard') {
        setEditorTarget(null);
        setInner('list');
        setOuterMode('fill');
        setShowAppHint(true);
      }
    } catch (e) {
      console.error('[App] 保存表单失败:', e);
      const msg = (e as Error)?.message ?? String(e);
      setSaveDiag(`❌ 保存失败：${msg}`);
      toast(`保存失败：${msg}`, 'error');
    }
  };

  /** 保存整体数据（设默认 / 删除等） */
  const handleSaveData = async (d: PluginData): Promise<void> => {
    try {
      await save(d);
    } catch (e) {
      toast(`保存失败：${(e as Error)?.message ?? String(e)}`, 'error');
      throw e;
    }
  };

  const handleEditForm = (form: FormPluginConfig | null) => {
    setEditorTarget(form ?? newForm());
    setInner('edit');
  };

  const handlePick = (formId: string) => {
    setActiveFormId(formId);
    setInner('fill');
  };

  const handleBack = () => {
    setActiveFormId(null);
    setInner('list');
  };

  const handleManage = () => {
    setOuterMode('config');
    setInner('list');
  };

  const activeForm = data?.forms.find((f) => f.id === activeFormId) ?? null;

  // dashboard 宿主：仅在展示态（View/FullScreen）通知宿主渲染完成，用于截图/缩略图。
  // 配置态（Create/Config）不调用 setRendered —— 否则宿主可能提前尝试渲染挂载 widget，
  // 与尚未完成的 create/save 事务冲突，触发 "cant start cmd transaction" / "create widget failed"。
  useEffect(() => {
    if (context !== 'dashboard' || inner === 'edit' || loading) return;
    if (inConfig) return;
    const t = setTimeout(() => {
      try {
        (dashboard as any).setRendered();
      } catch {
        /* 忽略：非仪表盘宿主或接口暂不可用 */
      }
    }, 60);
    return () => clearTimeout(t);
  }, [context, inner, loading, inConfig]);

  // View 态配置为空时只展示诊断信息，不自动写回。
  // 上一次保存摘要无法恢复字段、子表和条件规则，自动保存会覆盖用户的完整配置；
  // 这类问题应通过重新配置处理。

  if (loading) {
    return (
      <div>
        <PluginHeader inConfig={true} context={context} />
        <div className="page-loading">正在初始化…</div>
      </div>
    );
  }

  if (repairing) {
    return (
      <div>
        <PluginHeader inConfig={false} context={context} />
        <div className="page-loading">加载中…</div>
      </div>
    );
  }

  // 使用态智能显示：dashboard 宿主下，若仅一个表单或已设默认，组件直接显示该表单（不必先选）
  const usableForms = data?.forms ?? [];
  const directForm =
    context === 'dashboard' && !inConfig && inner === 'list' && usableForms.length > 0
      ? data!.forms.find((f) => f.id === data!.defaultFormId) ??
        (usableForms.length === 1 ? usableForms[0] : null)
      : null;

  // dashboard 配置态：直接显示单表单配置面板（不走 FormManager 多表单管理中转）
  // 首次 Create 时用空表单；已有保存数据时回填默认表单
  const showDashConfig =
    context === 'dashboard' && inConfig;
  const dashConfigInitial = showDashConfig
    ? (data?.forms.find((f) => f.id === data?.defaultFormId) ?? data?.forms[0] ?? null)
    : null;

  const showManager = !showDashConfig && inConfig && inner === 'list';
  const showEdit = !showDashConfig && inConfig && inner === 'edit' && !!editorTarget;
  // 有 directForm 时直接显示表单；多表单且无默认时才显示选择列表
  const showDirect = !inConfig && !!directForm;
  const showPicker = !inConfig && inner === 'list' && !!data && !directForm;
  const showFill = !inConfig && inner === 'fill' && !!activeForm;

  // 仪表盘填写态：隐藏品牌顶栏，画布上只呈现表单本身（干净的网页表单风格）
  const showHeader = !(context === 'dashboard' && !inConfig);

  return (
    <div style={{ height: '100%' }}>
      {showHeader && (
        <PluginHeader inConfig={inConfig} context={context} onAddToApp={() => setShowAppHint(true)} />
      )}
      <ErrorBoundary
        hint={
          context === 'dashboard' && !inConfig
            ? '你在 View 态看到这行，说明插件渲染时挂了。下面异常消息就是宿主显示原生占位的真实原因。'
            : '渲染时抛错。'
        }
      >
        {/* 诊断条：不用开 Console 就能看到宿主环境 / 状态 / 保存结果，便于定位"进不了画布"。
            仅开发态（或 ?debug=1）显示，发布后画布里完全干净。 */}
        {showDebug ? (
        <div
          data-plugin-diag
          style={{
            padding: '8px 12px',
            fontSize: 11,
            lineHeight: 1.7,
            background: '#f4f5f7',
            borderBottom: '1px solid #e5e6eb',
            color: '#1d2129',
            fontFamily: 'monospace',
            wordBreak: 'break-all',
          }}
        >
        {/* Create / Config 态引导：飞书宿主会同时在画布里显示一个 widget placeholder
            （未命名插件 + 📦+❗的原生占位，不是我们插件的错误状态）。
            用户经常误以为这是 bug。这是引导条。 */}
        {context === 'dashboard' && inConfig && (
          <div
            style={{
              margin: '6px 12px 8px',
              padding: '10px 14px',
              background: '#ecfeff',
              border: '1px solid #67e8f9',
              borderRadius: 4,
              color: '#155e75',
              fontSize: 12,
              lineHeight: 1.7,
            }}
          >
            <b>📘 当前在{String(dashState)}态（配置面板）</b> —
            右上角点「配置模式」也能进入。<br />
            ✅ 正常流程：
            <ol style={{ margin: '4px 0 0 16px', padding: 0 }}>
              <li>在这个弹窗里选主表 + 字段，<b>点最下面的「保存配置」</b></li>
              <li>保存成功后，飞书会<b>自动</b>关闭这个弹窗 + 在画布里显示你的插件</li>
            </ol>
            ⚠️ 画布里那个📦+❗的原生占位，是<b>飞书容器在保存前的原生 placeholder</b>，
            跟你的配置无关。点击「保存配置」后它会变成你的表单。
          </div>
        )}
        <div>
          宿主：<b>{context}</b> ｜ state：<b>{String(dashState ?? 'n/a')}</b> ｜ 模式：
          <b style={{ color: inConfig ? '#d97706' : '#059669' }}>
            {inConfig ? '配置' : '展示'}
          </b>
          {context === 'dashboard' && (
            <span style={{ marginLeft: 12 }}>
              hostConfigState(state/哈希/查询)：
              <b>{String(dashState)}</b>/<b>{probe?.dashboardStateFromHash ? 'Y' : 'n'}</b>/<b>{probe?.dashboardStateFromQuery ? 'Y' : 'n'}</b>
              {' ｜ '}onConfigChange收到：
              <b style={{ color: configChangeSeen ? '#059669' : '#dc2626' }}>{configChangeSeen}</b>次
            </span>
          )}
          <span style={{ marginLeft: 12, color: saveDiag?.startsWith('✅') ? '#059669' : saveDiag?.startsWith('❌') ? '#dc2626' : '#86909c' }}>
            ｜ {saveDiag || '（尚未保存）'}
          </span>
          {lastPayload && (
            <div style={{ marginTop: 4, color: '#4e5969' }}>
              {lastPayload}
            </div>
          )}
          {lastReadback && (
            <div style={{ marginTop: 2, color: '#4e5969' }}>
              {lastReadback}
            </div>
          )}
          {repairDiag && (
            <div style={{ marginTop: 2, color: repairDiag.startsWith('🔁') ? '#059669' : '#4e5969' }}>
              {repairDiag}
            </div>
          )}
          <button
            data-plugin-diag-export
            type="button"
            onClick={async () => {
              try {
                const snap = await exportDiagnosticBundle({
                  saveDiag,
                  repairDiag,
                  dashState,
                  inConfig,
                  context,
                  dataFormsCount: data?.forms?.length ?? -1,
                  dataIssue: (data as any)?.__dataIssue ?? null,
                  bootMetrics: (window as any).__pluginBoot ?? null,
                  probeOneLine: probe ? probeOneLine(probe) : null,
                });
                console.log('[plugin-diag] 诊断包已导出', snap);
              } catch (e) {
                console.error('[plugin-diag] 导出诊断包失败', e);
                alert(`导出失败：${(e as Error)?.message ?? String(e)}`);
              }
            }}
            style={{
              marginLeft: 12,
              padding: '2px 8px',
              fontSize: 11,
              cursor: 'pointer',
              border: '1px solid #c9cdd4',
              borderRadius: 4,
              background: '#fff',
            }}
            title="点击下载 JSON 诊断包（包含 URL、宿主状态、customConfig 预览等），把文件发我可一键定位"
          >
            📥 导出诊断包
          </button>
        </div>
        {probe && (
          <details style={{ marginTop: 4 }}>
            <summary style={{ cursor: 'pointer', color: '#4e5969' }}>
              📋 启动探测（点击展开）：{probeOneLine(probe)}
            </summary>
            <div style={{ marginTop: 4, padding: '6px 8px', background: '#fff', borderRadius: 4 }}>
              <div>URL：<span style={{ color: '#4e5969' }}>{probe.url || '(空)'}</span></div>
              <div>URL-hash：<span style={{ color: '#4e5969' }}>{probe.hash || '(空)'}</span></div>
              <div>
                URL-query(状态参数)：
                isCreate=<b>{String(probe.query.isCreate ?? 'null')}</b>,
                isConfig=<b>{String(probe.query.isConfig ?? 'null')}</b>,
                isFullScreen=<b>{String(probe.query.isFullScreen ?? 'null')}</b>
              </div>
              <div>
                dashboard.state 属性值：<b>{String(probe.dashboardStateProp ?? 'undefined')}</b>
              </div>
              <div>
                base.getTableList()：
                {probe.baseGetTableList.ok
                  ? <span style={{ color: '#059669' }}>OK，共 <b>{probe.baseGetTableList.count}</b> 张表</span>
                  : <span style={{ color: '#dc2626' }}>失败: {probe.baseGetTableList.err}</span>}
                {probe.baseGetTableList.firstId && (
                  <span>（首表ID 末段: ...{String(probe.baseGetTableList.firstId).slice(-6)}）</span>
                )}
              </div>
              <div>
                dashboard.getConfig()：
                {probe.dashboardGetConfig.expectedBlocked ? (
                  <span style={{ color: '#1e40af' }}>Create态禁用(正常)</span>
                ) : probe.dashboardGetConfig.ok ? (
                  <span style={{ color: '#059669' }}>OK</span>
                ) : (
                  <span style={{ color: '#dc2626' }}>失败: {probe.dashboardGetConfig.err}</span>
                )}
                {probe.dashboardGetConfig.ok && (
                  <span> ｜ customConfig 存在: <b>{String(probe.dashboardGetConfig.hasCustomConfig)}</b> ｜ 自定义配置字节: <b>{probe.dashboardGetConfig.ccLen}</b></span>
                )}
              </div>
              <div>
                iframe 父上下文：<b>{probe.iframeContext}</b> ｜ 父页面同源：<b>{probe.topSameOrigin}</b>
              </div>
              <div>referrer: <span style={{ color: '#4e5969' }}>{probe.referrer}</span></div>
              <div style={{ marginTop: 6, padding: '6px 8px', background: '#fffbe6', border: '1px dashed #f59e0b', borderRadius: 4, color: '#92400e' }}>
                <b>怎样读这条诊断</b>：
                <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                  <li>state=View，但 hostConfigState=Create/Config → 飞书宿主把状态参数放到了 search（不是 hash），双保险已生效，OK</li>
                  <li>base.getTableList() 失败 → base 不可达，与本插件无关，是宿主问题</li>
                  <li>dashboard.getConfig() 失败 → 宿主 RPC 不通，留给宿主处理</li>
                  <li>上下文=standalone 或 unknown → 你可能没在飞书仪表盘宿主里加载，请确认插件开放平台的"应用模式 / 仪表盘插件"配置</li>
                </ul>
              </div>
            </div>
          </details>
        )}
      </div>
        ) : null}
      {/* ----- 开始：被 ErrorBoundary 包裹的所有内容 ----- */}
      <div className="plugin-content">
        {showDashConfig && (
          <ConfigPanel
            initialConfig={dashConfigInitial}
            onSave={handleSaveForm}
            onCancel={() => {
              /* dashboard 配置态取消由宿主处理，插件侧无需操作 */
            }}
          />
        )}

        {showManager && (
          <FormManager
            data={data}
            context={context}
            onEditForm={handleEditForm}
            onSaveData={handleSaveData}
          />
        )}

        {showEdit && editorTarget && (
          <ConfigPanel
            initialConfig={editorTarget}
            onSave={handleSaveForm}
            onCancel={() => {
              setEditorTarget(null);
              setInner('list');
            }}
          />
        )}

        {showPicker && data && (
          <>
            {showAppHint && context !== 'dashboard' && (
              <AddToAppHint onDismiss={() => setShowAppHint(false)} />
            )}
            <FormPicker data={data} context={context} onPick={handlePick} onManage={handleManage} />
          </>
        )}

        {showDirect && directForm && (
          <FormRenderer config={directForm} onBackToConfig={handleBack} />
        )}

        {showFill && activeForm && (
          <FormRenderer config={activeForm} onBackToConfig={handleBack} />
        )}

        {/* View 态空数据诊断：开发态展示完整排查信息；发布态只给一条干净指引 */}
        {context === 'dashboard' && !inConfig && (data == null || data.forms.length === 0 || (data as any).__dataIssue) && (
          showDebug ? (
          <div
            data-plugin-diag-view-empty
            style={{
              padding: 24,
              margin: 12,
              background: '#fff7ed',
              border: '1px dashed #f97316',
              borderRadius: 6,
              fontFamily: 'monospace',
              fontSize: 12,
              color: '#7c2d12',
              lineHeight: 1.7,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 8, color: '#9a3412' }}>
              ⚠️ 配置校验未通过
            </div>
            {(data as any)?.__dataIssue === 'empty' && (
              <>表单配置为空：插件已成功插入画布，但 customConfig 里没有表单数据。通常是第一次保存就空，或在仪表盘页面外手工改过 widget 配置，需要重新保存表单配置。</>
            )}
            {(data as any)?.__dataIssue === 'stale' && (
              <>表单字段已失效：保存的字段 ID 在当前数据表里已全部对不上号。字段改名不影响，但字段被删除时需要重新配置。</>
            )}
            {(data as any)?.__dataIssue === 'missing-sub-table' && (
              <>子表配置缺失：旧版配置没有保存子表 ID，运行时也未能恢复。请进入配置模式重新保存一次。</>
            )}
            {!((data as any)?.__dataIssue) && (
              <>表单配置读取失败：插件没有读出表单数据。请导出诊断包发我。</>
            )}
            <br />
            排查清单：
            <ol style={{ margin: '4px 0 0 16px', padding: 0 }}>
              <li>截图这一段发我</li>
              <li>截图上面诊断条（点 📋 展开）</li>
              <li>检查仪表盘侧 widget 的"数据源"配置 —— 宿主兜底最常见的元凶是它</li>
            </ol>
            <button
              type="button"
              onClick={async () => {
                setRepairDiag('手动触发修复中…');
                const r = await repairDashboardConfigFromLastSave();
                setRepairDiag(
                  r.repaired
                    ? `🔁 已重放（${r.reason}）`
                    : `autoRepair: ${
                        (r as any).detail?.lastErr
                          ? `${r.reason}｜宿主报错: ${(r as any).detail.lastErr}`
                          : r.reason
                      }`
                );
                await load();
              }}
              style={{
                marginTop: 10,
                padding: '6px 14px',
                cursor: 'pointer',
                border: '1px solid #fb923c',
                borderRadius: 4,
                background: '#fff',
                color: '#9a3412',
                fontFamily: 'inherit',
                fontSize: 12,
              }}
            >
              🔄 重新加载配置（手动修复）
            </button>
          </div>
          ) : (
            <div
              data-plugin-diag-view-empty
              style={{
                padding: 24,
                margin: 12,
                background: '#fff7ed',
                border: '1px dashed #f97316',
                borderRadius: 6,
                fontSize: 13,
                color: '#7c2d12',
                lineHeight: 1.7,
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 8, color: '#9a3412' }}>
                ⚠️ 表单配置需要重新保存
              </div>
              请通过插件右上角「配置模式」进入，确认配置无误后点击「保存配置」即可恢复。
            </div>
          )
        )}

        {/* View 态下还展示加载到的数据形态，便于对照「配置数据发生变更」判断是哪个字段出问题。
            仅开发态可见。 */}
        {showDebug && context === 'dashboard' && !inConfig && data && data.forms.length > 0 && (
          <div
            style={{
              padding: '6px 12px',
              fontSize: 11,
              fontFamily: 'monospace',
              color: '#4e5969',
              background: '#f9fafb',
              borderTop: '1px solid #e5e7eb',
            }}
          >
            📊 View态表单数据：
            {data.forms.length}份；
            主表ID=<b>{String(directForm?.mainTable.tableId ?? activeForm?.mainTable.tableId ?? '').slice(-8) || '空'}</b>，
            主表字段数=<b>{directForm?.mainTable.fields.length ?? activeForm?.mainTable.fields.length ?? 0}</b>，
            子表数=<b>{directForm?.subTables.length ?? activeForm?.subTables.length ?? 0}</b>，
            渲染路径=<b>
              {showDirect ? 'directForm' : showFill ? 'activeForm' : showPicker ? 'picker' : '未知'}
            </b>
            ，数据问题=<b>{String((data as any)?.__dataIssue ?? '无')}</b>
          </div>
        )}

        {showDebug && (
          <div className="diag-bar">
            宿主诊断：context=<b>{String(diag.resolvedContext ?? context)}</b> · state=
            <b>{String(diag.state ?? '-')}</b> · getConfig={String(diag.hasGetConfig)} · setRendered=
            {String(diag.hasSetRendered)}
          </div>
        )}
      </div>
      </ErrorBoundary>
    </div>
  );
}
