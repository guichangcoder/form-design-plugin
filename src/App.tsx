import React, { useEffect, useState, useRef } from 'react';
import { Button } from '@douyinfe/semi-ui';
import { IconPlus } from '@douyinfe/semi-icons';
import { dashboard, DashboardState } from '@lark-base-open/js-sdk';
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
import { getBase, getBaseToken, getBaseStrict, getDeclaredBaseToken, getDashboard, isWorkspaceAvailable, diagnoseAppContext, selectBase, AUTO_REBIND_MAX, BASE_READY_RETRY_MS, getTableStrict} from './services/appContext';
import { runRebindWithRetry } from './utils/rebindRetry';
import { getFieldMetaList } from './services/baseService';
import { collectDeclaredTableIds, buildDataConditions } from './utils/dataConditions';
import { serializeConfig } from './services/configSize';
import {
  collectBlockedTables,
  describeBlockedTables,
  findTablesOutsideActualBase,
  describeBaseMismatch,
  type TableAccessProbe,
} from './utils/scopeCheck';
import { findStaleConfiguredField, describeStaleHit } from './utils/metaStale';
import { draftMountKey, resolveDashFormId } from './utils/configDraft';
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
      const extra: string[] = [];
      if (o.phaseInfo) extra.push(`阶段=${o.phaseInfo}`);
      if (typeof o.reSaved === 'number' && o.reSaved > 0) extra.push(`补存${o.reSaved}次`);
      if (o.saveState) extra.push(`state:${o.saveState}→${o.finalState ?? '?'}`);
      if (typeof o.expectedTables === 'number') extra.push(`声明${o.expectedTables}表`);
      const extraStr = extra.length > 0 ? ` ｜ ${extra.join(' · ')}` : '';
      if (rb.err) return `上次读回失败：${rb.err}${extraStr}`;
      if (!rb.ok) return `上次读回：未拿到（可能 Create 态）${extraStr}`;
      return `上次读回 OK ｜ 宿主存 cc=${rb.ccLen}B ｜ 宿主存 dataConditions=${JSON.stringify(rb.dataConditions)}${extraStr}`;
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
  // View 态数据源可访问性自检：结论（空串 = 没问题）
  const scopeCheckDone = useRef(false);
  /** 自动补声明只做一次，避免与「保存 → 重载 → 再检查」形成循环 */
  const autoDeclareDone = useRef(false);
  const [scopeIssue, setScopeIssue] = useState<string>('');
  // 应用模式数据源（P0-1）：当前选中的多维表格 baseToken
  const [baseToken, setBaseToken] = useState<string>(() => getBaseToken());
  // 配置态「左预览」的实时草稿（ConfigPanel.onDraftChange 喂入）
  const [previewDraft, setPreviewDraft] = useState<FormPluginConfig | null>(null);
  // P1-5：监听到底表结构变化后置位，暂停提交直到用户重新载入
  const [metaStale, setMetaStale] = useState(false);
  // data 的最新引用（onDataChange 回调里要用，避免闭包过期）
  const dataRef = useRef<PluginData | null>(null);
  dataRef.current = data;
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

  /**
   * 🔴 展示态「故障面板」可见性 —— 与 showDebug 分开，**不看 dev/配置态**。
   *
   * 为什么必须独立：插件跑在飞书 iframe 里，用户**根本打不开插件的 console**
   * （打开的是飞书顶层页面的控制台，看不到 iframe 内日志）。
   * 而本项目的排错信息此前全写进 console + 只在 showDebug 下渲染的调试条
   * （`isDebugMode() && inConfig`）→ **展示态出问题时，用户眼前一片空白、
   * 反馈里也只能贴一张「0 个选项」的截图**，连续四轮排查因此都在猜。
   *
   * 所以：只要展示态出现「数据源读不到」这种会让功能整体不可用的故障，
   * 就把结论**直接画在界面上**（可折叠，不长期骚扰填写者）。
   * 纯样式问题/轻微告警仍然只留在 console，不污染发布后的画布。
   */
  const showFaultPanel = !inConfig && !!scopeIssue;

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

  // 配置加载完成后同步 baseToken（loadConfig 已通过 Workspace 绑定对应 base）
  useEffect(() => {
    if (data?.baseToken) setBaseToken(data.baseToken);
  }, [data?.baseToken]);

  /**
   * 🔴 展示态「数据源绑定自愈」（2026-10-30 第五轮）。
   *
   * 根因：SDK 的 `workspace.getBitable(baseToken)` 在宿主数据未拉完时
   * **直接返回 null 且不等待**（源码实证），所以刷新后首次加载常常绑不上，
   * 代码静默回退默认 base → 用错 base 查源表 → `msg: undefined code: 12`。
   *
   * `selectBase` 里已加了「先等 getBitableReady 再取实例」；但页面刷新存在竞态，
   * 仍可能整个 loadConfig 都跑在「尚未就绪」的窗口里。这里再兜一层：
   * 展示态一旦发现「声明了 baseToken 但没绑上」，就自动重绑 + 重新加载配置。
   *
   * ⚠️ 两处必须留在 effect 内部/本组件，不能依赖 effect 自己重跑：
   *   · 重试循环 → 用 `runRebindWithRetry` 在同一次执行里循环。若指望
   *     `[inConfig, loading, data?.baseToken]` 变化来重跑，而重绑失败时三者都不变，
   *     effect 根本不会再跑，轮数上限形同虚设。
   *   · 计数重置 → 换数据源（`want` 变了）必须清零，否则用户按提示重选后
   *     预算早已耗尽、明明能修好却再也不自愈。
   */
  const autoRebindTried = useRef(0);
  /** 上一次自愈针对的 baseToken —— 换了数据源必须重新给足重试预算 */
  const rebindTargetRef = useRef('');
  useEffect(() => {
    if (inConfig || loading) return;
    const want = data?.baseToken;
    if (!want) return; // 未声明数据源（侧边栏/旧配置）→ 无需绑定
    // 🔴 必须在「目标变了」时重置计数：否则用户按提示重新选了数据源后，
    //    自愈预算早已耗尽 → 明明能修好却再也不自愈，等于把人从坑里拉出来又推回去。
    if (rebindTargetRef.current !== want) {
      rebindTargetRef.current = want;
      autoRebindTried.current = 0;
    }
    if (getBaseToken() === want) return; // 已绑对
    if (autoRebindTried.current >= AUTO_REBIND_MAX) return;
    let alive = true;
    (async () => {
      // 重试必须在**这一次执行内部**循环，而不是指望 effect 重跑
      // （重绑失败不会改变任何依赖）。编排逻辑见 utils/rebindRetry.ts。
      const r = await runRebindWithRetry({
        maxRounds: AUTO_REBIND_MAX - autoRebindTried.current,
        retryDelayMs: 600,
        isAlive: () => alive,
        onRound: (round) => {
          autoRebindTried.current += 1;
          console.warn(
            `[appContext] 展示态发现未绑定配置声明的数据源，自动重绑（第 ${round} 轮 / 累计 ${autoRebindTried.current}）`
          );
        },
        // ⚠️ 必须用**短的**就绪预算：loadConfig 里首次绑定已经等过一轮，自愈只是补一刀。
        //    若仍用 8s，多轮累加会让用户干等十几秒还看不到界面。
        tryBind: () => selectBase(want, undefined, BASE_READY_RETRY_MS),
        onGiveUp: () => console.warn('[appContext] 自动重绑全部失败，交由故障面板提示用户'),
      });
      if (!alive || !r.ok) return;
      console.log('[appContext] 自动重绑成功，重新加载配置与数据');
      await load();
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inConfig, loading, data?.baseToken]);

  // P1-5：展示态监听底表数据/结构变化。字段被删除、选项变更或权限变化时
  // 暂停提交并提示重新载入 —— 不静默清空用户正在填写的数据，也不自动整表重载。
  useEffect(() => {
    if (context !== 'dashboard' || inConfig) return;
    let off: (() => void) | undefined;
    let checking = false;
    try {
      const b = getBase() as any;
      if (b && typeof b.onDataChange === 'function') {
        off = b.onDataChange(async () => {
          if (checking) return;
          checking = true;
          try {
            const d = dataRef.current;
            if (!d || d.forms.length === 0) return;
            // 轻量校验：配置引用的字段是否都还存在、类型是否仍可写（拿不到 meta 视为失效）
            for (const form of d.forms) {
              const tableIds = [
                form.mainTable.tableId,
                ...form.subTables.map((s) => s.tableId),
              ].filter(Boolean);
              for (const tid of tableIds) {
                const metas = await getFieldMetaList(tid);
                const configuredFields =
                  tid === form.mainTable.tableId
                    ? form.mainTable.fields
                    : (form.subTables.find((s) => s.tableId === tid)?.fields ?? []);
                /**
                 * ★ 判定交给纯函数 findStaleConfiguredField（测试可真实调用）。
                 *
                 * 原来只查「字段还在不在」，不查「类型变没变」。字段被从文本改成
                 * 公式 / 查找引用 / 自动编号 / 群聊等不可写类型后，字段 id 仍然存在，
                 * 提交按钮依旧可点，写入被宿主整条拒绝且只报一句 `not support`。
                 * 这类改动常常是临时的（改回原类型、或权限态变化导致返回 Denied），
                 * 恢复后就自动正常 —— 正好对应「别人正常、同一个人隔一会儿又正常」。
                 */
                const hit = findStaleConfiguredField(configuredFields, metas, tid);
                if (hit) {
                  console.warn(
                    `[App] 检测到表结构变化（${describeStaleHit(hit)}），暂停提交: ` +
                      `${tid}/${hit.fieldId} 当前类型=${hit.liveType}`
                  );
                  setMetaStale(true);
                  return;
                }
              }
            }
          } catch (e) {
            // 表被删除或无权限读取时 getFieldMetaList 抛错 → 视为元数据失效
            console.warn('[App] 元数据校验失败，暂停提交:', e);
            setMetaStale(true);
          } finally {
            checking = false;
          }
        });
      }
    } catch {
      /* 接口不可用则忽略 */
    }
    return () => {
      try {
        off && off();
      } catch {
        /* ignore */
      }
    };
  }, [context, inConfig, baseToken]);

  /** 元数据失效后用户点「重新载入」：重新 hydrate 配置并恢复提交 */
  const handleReloadMeta = async () => {
    await load();
    setMetaStale(false);
    toast('已重新载入最新表结构', 'success');
  };

  /**
   * 🔴 View 态数据源可访问性自检（诊断用，2026-10-30）。
   *
   * 背景：「选项选不到」有两种根因 —— ① 源表没进 dataConditions（声明范围问题）、
   * ② 当前账号对该表无权限。旧代码两者都只表现为「0 个选项」，
   * 用户和我都无法判断该改代码还是该找管理员。
   *
   * 这里在配置加载完成后，对「主表 + 子表 + 选项引用源表」逐张探测
   * meta 与 records 两条链路，把结论打到控制台 + 诊断条。
   * 只在 dev / ?debug=1 下输出，正式环境不打扰用户。
   */
  useEffect(() => {
    if (inConfig || loading || !data) return;
    if (scopeCheckDone.current) return;
    scopeCheckDone.current = true;
    let alive = true;
    (async () => {
      const tableIds = collectDeclaredTableIds(data.forms ?? []);

      // ★ 第一步：先把**宿主环境真相**打出来。
      //   上一版自检写成 `context === 'dashboard'` 才执行，结果用户复测时
      //   完全看不到任何 [scopeCheck] 日志 —— 说明宿主被判成了 bridge，
      //   而 saveConfig 里的 `if (isDashboardHost())` 是唯一写 dataConditions 的分支，
      //   若该判定为 false，声明集压根没写进宿主（这能同时解释前面几轮修复全部无效）。
      //   所以这里改为**无条件执行**，并把判定依据全部打印出来。
      let hostInfo: Record<string, unknown> = {};
      try {
        const d = dashboard as any;
        hostInfo = {
          resolvedContext: getHostContext(),
          isDashboardHost: diagnoseHost().isDashboardHost ?? undefined,
          dashboardState: d?.state,
          hasSaveConfig: typeof d?.saveConfig === 'function',
          hasGetConfig: typeof d?.getConfig === 'function',
          workspaceAvailable: isWorkspaceAvailable(),
          appCtx: diagnoseAppContext(),
        };
      } catch (e) {
        hostInfo = { hostInfoError: String((e as Error)?.message ?? e) };
      }
      console.log('[scopeCheck] 宿主环境 =', hostInfo);

      /**
       * ★ 第二步（本轮新增，最可能命中根因）：验证「读表用的 base」到底是哪一个。
       *
       * `getBase()` 实现是 `currentApp?.base ?? bitable.base` —— 若配置声明了
       * baseToken 但 `selectBase()` 失败（Workspace.getBitable 抛错/无权限/
       * 该 base 未对插件授权），就会**静默回退到宿主默认 base**。
       * 而应用模式允许「数据源 ≠ 宿主所在多维表格」（1:N 设计），
       * 此时我们拿默认 base 去 getTableById(源表id) 必然查不到，
       * 宿主返回的就是一句没有 message 的低层错误（`msg: undefined code: 12`）。
       *
       * 这是唯一能同时解释「配置态保存时正常（那时刚 selectBase 过）
       * / 刷新后进入 View 态就全空」的机制，必须显式验证并报出来。
       */
      const cfgToken = (() => {
        try {
          return getBaseToken() || '';
        } catch {
          return '';
        }
      })();
      // ★ 先看「绑定状态」这个第一判据（getTableMetaList 失败时说明不了问题：
      //   绑定错了它当然也失败，上一版据此报「无法读取数据表清单」把根因藏住了）。
      try {
        const strict = getBaseStrict();
        console.log(
          '[scopeCheck] base 绑定：声明 =',
          getDeclaredBaseToken() ? `...${getDeclaredBaseToken().slice(-6)}` : '(无)',
          '｜已绑定 =', strict.bound ? '是' : '🔴 否（正在用宿主默认 base，读源表必失败）'
        );
        if (!strict.bound) {
          setScopeIssue(
            `插件没有连上配置所指定的多维表格（数据源标记 ${
              getDeclaredBaseToken() ? `...${getDeclaredBaseToken().slice(-6)}` : '(未标记)'
            }）。请先刷新页面；若仍失败，请进入配置模式重新选择数据源并保存。`
          );
        } else {
          const metas = await strict.base!.getTableMetaList();
          const actualIds = metas.map((t) => t.id);
          const notFound = findTablesOutsideActualBase(tableIds, actualIds);
          console.log(
            '[scopeCheck] base 可见表数 =', actualIds.length,
            notFound.length ? `｜🔴 其中 ${notFound.length} 张查不到: ${notFound.join(', ')}` : '｜✅ 全部可见'
          );
          if (notFound.length > 0) {
            setScopeIssue(describeBaseMismatch(notFound, cfgToken));
          }
        }
      } catch (e) {
        console.warn('[scopeCheck] 取 base 表列表失败:', e);
      }
      console.log('[scopeCheck] 配置需要的表 =', tableIds);

      if (tableIds.length === 0) {
        console.warn('[scopeCheck] 配置里没有任何表，跳过可访问性探测');
        return;
      }

      // ★ 第二步：打印**宿主侧实际持有的 dataConditions**。
      //   应用插件 dataConditions 只授权「主表一条 + baseToken」（官方契约「仅支持一组条件」），
      //   所以这里只核对主表与 baseToken 是否就位，不再要求子表/源表也进 dataConditions
      //   （子表靠主表 link 连带授权；源表若需直读也须 link 关联，否则平台不予授权）。
      try {
        const cfg: any = await (getDashboard() as any).getConfig();
        const hostDc: any[] = cfg?.dataConditions ?? [];
        const hostIds = hostDc.map((d) => d?.tableId).filter(Boolean);
        const mainTableId = data.forms?.find((f) => f?.mainTable?.tableId)?.mainTable?.tableId;
        const curTok = getBaseToken();
        const hostTokenOk = !curTok || hostDc.some((d) => d?.baseToken === curTok);
        const mainMissing = !!mainTableId && !hostIds.includes(mainTableId);
        console.log(
          '[scopeCheck] 宿主持有 dataConditions =', hostDc,
          mainMissing ? '｜🔴 主表未声明' : (hostTokenOk ? '｜✅ 主表+baseToken 就位' : '｜🔴 缺 baseToken')
        );
        if ((mainMissing || !hostTokenOk) && !autoDeclareDone.current) {
          autoDeclareDone.current = true;
          console.warn('[scopeCheck] dataConditions 不是「主表+baseToken」正确形态，自动重建…');
          try {
            const rebuilt = buildDataConditions(data.forms ?? [], mainTableId, curTok);
            const thin = serializeConfig(data);
            await (getDashboard() as any).saveConfig({ dataConditions: rebuilt, customConfig: thin });
            console.log('[scopeCheck] 已重写 dataConditions =', rebuilt);
            setScopeIssue('');
            // ★ 等宿主消化这次声明写入，再做可访问性探测（写完立刻读会读到旧快照）。
            await new Promise((r) => setTimeout(r, 800));
          } catch (se) {
            console.warn('[scopeCheck] 自动重建 dataConditions 失败:', se);
            setScopeIssue('插件数据源声明不完整且自动修复失败，请在配置态重新保存一次。');
          }
        }
      } catch (e) {
        console.warn('[scopeCheck] 无法读取宿主 dataConditions:', e);
      }

      const probes: TableAccessProbe[] = [];
      for (const tableId of tableIds) {
        if (!alive) return;
        let metaOk = false;
        let recordsOk = false;
        let firstErr = '';
        // ★ 多方法对照：同一个表用不同调用方式各试一遍。
        //   报错 `getRecordsByPage error, msg: undefined code: 12` 的 msg 是 undefined
        //   —— 不像「权限拒绝」（那通常有明确文案），更像某个参数/能力不被支持。
        //   所以必须区分「这个表整个读不到」还是「只是某种调用方式不支持」。
        const detail: Record<string, string> = {};
        try {
          const t = await getTableStrict(tableId);
          try {
            await t.getFieldMetaList();
            metaOk = true;
            detail.meta = 'ok';
          } catch (e) {
            detail.meta = String((e as Error)?.message ?? e);
            if (!firstErr) firstErr = detail.meta;
          }
          const anyT = t as any;
          // ① 无条件、pageSize=1（最小请求）
          try {
            const r = typeof anyT.getRecordsByPage === 'function'
              ? await anyT.getRecordsByPage({ pageSize: 1 })
              : await anyT.getRecords({ pageSize: 1 });
            recordsOk = true;
            detail.plain = `ok(${(r as any)?.records?.length ?? 0}条)`;
          } catch (e) {
            detail.plain = String((e as Error)?.message ?? e);
            if (!firstErr) firstErr = detail.plain;
          }
          // ② 带 stringValue（部分宿主只支持这种）
          try {
            await anyT.getRecordsByPage({ pageSize: 1, stringValue: true });
            detail.stringValue = 'ok';
          } catch (e) {
            detail.stringValue = String((e as Error)?.message ?? e);
          }
          // ③ 带 viewId（显式传 undefined，验证是否与参数相关）
          try {
            await anyT.getRecordsByPage({ pageSize: 1, viewId: undefined });
            detail.withViewId = 'ok';
          } catch (e) {
            detail.withViewId = String((e as Error)?.message ?? e);
          }
          // ④ 旧接口 getRecords
          try {
            await anyT.getRecords({ pageSize: 1 });
            detail.legacy = 'ok';
          } catch (e) {
            detail.legacy = String((e as Error)?.message ?? e);
          }
        } catch (e) {
          firstErr = String((e as Error)?.message ?? e);
          detail.getTableById = firstErr;
        }
        console.log(`[scopeCheck] 表 ${tableId} 各调用方式结果 =`, detail);
        probes.push({ tableId, metaOk, recordsOk, error: firstErr });
      }
      if (!alive) return;
      const blocked = collectBlockedTables(probes);
      console.log(
        '[scopeCheck] View 态数据源可访问性：',
        probes.map((p) => `${p.tableId}(meta:${p.metaOk ? 'ok' : 'FAIL'},rec:${p.recordsOk ? 'ok' : 'FAIL'})`).join(' | ')
      );
      if (blocked.length > 0) {
        console.warn('[scopeCheck] 有数据表读取不到：', blocked);
        setScopeIssue(describeBlockedTables(blocked));
      } else {
        console.log('[scopeCheck] 全部数据表均可正常读取');
      }
    })();
    return () => {
      alive = false;
    };
  }, [context, inConfig, loading, data]);

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
    /**
     * ★ defaultFormId 自愈：原写法 `base.defaultFormId ?? forms2[0]?.id` 会**沿用悬空引用**
     *   （指向已删除的表单）→ 每次进配置态都回退到 forms[0]，多表单场景下表现为
     *   「配了 A、回来看到 B」。这里改为「必须指向真实存在的表单」，否则落到第一份。
     */
    const defaultFormId = resolveDashFormId(forms2, base.defaultFormId) ?? undefined;
    // ★ 应用模式：baseToken 随配置持久化（P0-1）。View 态据此用 Workspace 重新绑定。
    const next: PluginData = {
      forms: forms2,
      defaultFormId,
      baseToken: baseToken || data?.baseToken || undefined,
    };
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
          const extra: string[] = [];
          if (o.phaseInfo) extra.push(`阶段=${o.phaseInfo}`);
          if (typeof o.reSaved === 'number' && o.reSaved > 0) extra.push(`补存${o.reSaved}次`);
          if (o.saveState) extra.push(`state:${o.saveState}→${o.finalState ?? '?'}`);
          if (typeof o.expectedTables === 'number') extra.push(`声明${o.expectedTables}表`);
          const extraStr = extra.length > 0 ? ` ｜ ${extra.join(' · ')}` : '';
          if (rb.err) setLastReadback(`上次读回失败：${rb.err}${extraStr}`);
          else if (!rb.ok) setLastReadback(`上次读回：未拿到（可能 Create 态）${extraStr}`);
          else setLastReadback(`上次读回 OK ｜ 宿主存 cc=${rb.ccLen}B ｜ 宿主存 dataConditions=${JSON.stringify(rb.dataConditions)}${extraStr}`);
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

  /** 应用模式：切换数据源多维表格（P0-1）。ConfigPanel 以 baseToken 为 key 自动重挂载清空旧草稿 */
  const handleBaseChange = (token: string, _name: string) => {
    setBaseToken(token);
    setPreviewDraft(null);
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

  /**
   * 解析「配置态要编辑的那份表单」的 id。
   *
   * 🔴 不能只靠 defaultFormId：它可能是**悬空引用**（指向已删除的表单），
   * 原实现 `find(...) ?? forms[0]` 会回退到 forms[0] 显示，
   * 但保存时仍沿用那个悬空 defaultFormId → 下次又回退到 forms[0]，
   * 多表单场景下表现为「改的不是这个表单」/「配置对不上」。
   *
   * 抽成纯函数 resolveDashFormId 便于回归测试真实调用（见 F34）。
   */
  const dashFormId = resolveDashFormId(data?.forms ?? [], data?.defaultFormId);
  const dashConfigInitial = showDashConfig
    ? (data?.forms.find((f) => f.id === dashFormId) ?? null)
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
          {scopeIssue && (
            <div style={{ marginTop: 4, color: '#dc2626', whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
              ⚠️ 数据源不可读：{scopeIssue}
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
      <div className={showDashConfig ? 'plugin-content plugin-content--app-config' : 'plugin-content'}>
        {showDashConfig && (
          // ★ 应用模式配置态布局（官方 P1-4）：左侧实时表单预览 + 右侧 340px 配置区。
          // 预览随草稿实时渲染（含主题色与条件联动），提交按钮在预览中禁用。
          <div className="app-config-layout">
            <div className="app-config-preview">
              {/*
                ★ 预览优先用实时草稿；草稿还没抛上来时（刚进入配置态、用户尚未改动）
                  回退到「已保存的配置」，否则预览区会空白一片 —— 这会被误读成
                  「上次的配置没保存上」。实际上配置在，只是预览没接上初始值。
              */}
              {(previewDraft ?? dashConfigInitial)?.mainTable?.tableId ? (
                <FormRenderer config={(previewDraft ?? dashConfigInitial)!} preview />
              ) : (
                <div className="app-config-preview-empty">
                  <div style={{ fontSize: 32, marginBottom: 8 }}>👀</div>
                  <div>实时预览区</div>
                  <div style={{ fontSize: 12, color: '#86909c', marginTop: 6 }}>
                    {isWorkspaceAvailable() && !baseToken
                      ? '先在右侧「00 数据源」选择多维表格，再选主表后这里会实时显示表单效果'
                      : '在右侧选择主表后，这里会实时显示表单效果'}
                  </div>
                </div>
              )}
            </div>
            <div className="app-config-panel">
              <ConfigPanel
                /**
                 * 🔴 key 必须包含「配置内容指纹」，不能只绑 baseToken（2026-10-29 缺陷）。
                 *
                 * 原来 key 只有 baseToken：换一份表单 / 重新进入配置态时 key 不变
                 * → 组件不重挂载 → `useState` 初始化不执行 → 草稿停留在旧对象
                 * → 表现为「保存后只生效一次，再进配置态看不到上次保存的配置」。
                 * 改用内容指纹：配置一变即整体重挂载，彻底消除这类残留。
                 */
                key={`${baseToken || 'no-base'}#${draftMountKey(dashConfigInitial?.id, dashConfigInitial)}`}
                initialConfig={dashConfigInitial}
                appMode
                baseToken={baseToken}
                onBaseChange={handleBaseChange}
                onDraftChange={setPreviewDraft}
                onSave={handleSaveForm}
                onCancel={() => {
                  /* dashboard 配置态取消由宿主处理，插件侧无需操作 */
                }}
              />
            </div>
          </div>
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
            /**
             * ★ 同样是内容指纹 key（原来完全没有 key）：
             * 从列表编辑不同的表单时若不重挂载，草稿会沿用上一份表单的内容。
             */
            key={`edit#${editorTarget.id}#${draftMountKey(editorTarget.id, editorTarget)}`}
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
          <FormRenderer
            config={directForm}
            onBackToConfig={handleBack}
            metaStale={metaStale}
            onReloadMeta={handleReloadMeta}
            baseToken={baseToken}
          />
        )}

        {showFill && activeForm && (
          <FormRenderer
            config={activeForm}
            onBackToConfig={handleBack}
            metaStale={metaStale}
            onReloadMeta={handleReloadMeta}
            baseToken={baseToken}
          />
        )}

        {/* 🔴 展示态「数据源不可读」故障面板 —— 唯一不依赖 console 的排错出口。
            详见 showFaultPanel 的注释。默认折叠，只显示一句人话结论。 */}
        {showFaultPanel && (
          <div
            data-plugin-fault-panel
            style={{
              margin: '8px 12px',
              padding: '10px 12px',
              background: '#fef2f2',
              border: '1px solid #fca5a5',
              borderRadius: 6,
              fontSize: 12,
              lineHeight: 1.7,
              color: '#991b1b',
            }}
          >
            <div style={{ fontWeight: 700 }}>⚠️ 数据源读取异常，部分选项可能无法选择</div>
            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer', color: '#b91c1c' }}>
                查看详情（截图这一段发给维护者即可定位）
              </summary>
              <pre
                style={{
                  margin: '6px 0 0',
                  padding: '6px 8px',
                  background: '#fff',
                  border: '1px solid #fecaca',
                  borderRadius: 4,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  fontSize: 11,
                  color: '#7f1d1d',
                  fontFamily: 'monospace',
                }}
              >
                {scopeIssue}
              </pre>
            </details>
          </div>
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
