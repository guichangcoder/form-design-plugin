import { bitable, dashboard, DashboardState } from '@lark-base-open/js-sdk';
import { CONFIG_STORAGE_KEY, FormPluginConfig, PluginData } from '../types';
import {
  serializeConfig,
  hydrateConfig,
  estimateConfigBytes,
} from './configSize';

/** dev 模式下宿主 widget 配置可能在 F5 后丢失；用飞书 base 做一份持久化备份，
 *  刷新后即使宿主读不到配置，也能从 base 捞回并重新写回宿主。base 不受页面刷新影响。 */
const BACKUP_KEY = 'form_design_plugin_backup_v1';

/**
 * 宿主上下文探测：
 * - 'dashboard'：运行在应用模式的「仪表盘页面」宿主里（即飞书里那些"像其他插件一样"的页面组件）。
 *   此时用 dashboard 模块（`state` / `getConfig` / `saveConfig` / `setRendered`）。
 * - 'bridge'：运行在普通多维表格侧边栏/扩展脚本里，用 bitable.bridge 存储。
 *
 * 说明：dashboard 模块是 SDK 始终导出的对象，但只有身处仪表盘页面宿主时，
 * 其 `state` 才是合法的 DashboardState 值；否则为 undefined。据此区分两种宿主。
 */
export type HostContext = 'dashboard' | 'bridge';

/**
 * dashboard 宿主下 state 的合法枚举值（不区分大小写匹配）。
 * 仅当 dashboard.state 是这些合法值之一时，才判定为 dashboard 宿主，
 * 避免纯浏览器（state=undefined）或其他非页面宿主被误判，导致逻辑错乱。
 */
const DASHBOARD_STATES = ['create', 'config', 'view', 'fullscreen'];

/** 将 SDK/宿主可能返回的大小写不同的 state 统一成 SDK 枚举值。 */
export function normalizeDashboardState(value: unknown): DashboardState | undefined {
  const state = String(value ?? '').trim().toLowerCase();
  switch (state) {
    case 'create':
      return DashboardState.Create;
    case 'config':
      return DashboardState.Config;
    case 'view':
      return DashboardState.View;
    case 'fullscreen':
      return DashboardState.FullScreen;
    default:
      return undefined;
  }
}

/**
 * 是否为仪表盘页面宿主（运行在飞书应用模式仪表盘里）。
 * 必须同时满足：dashboard 模块存在且 saveConfig/getConfig 可用，且 state 为合法枚举。
 * 注意：dev 本地（localhost）下 dashboard.state 会返回 'view'（URL 无 isCreate/isConfig），
 * 因此也会被判定为 dashboard —— 这是预期的，saveConfig 分支会按 dev 降级到本地存储。
 */
export function isDashboardHost(): boolean {
  try {
    const d = dashboard as any;
    if (
      d &&
      typeof d.saveConfig === 'function' &&
      typeof d.getConfig === 'function'
    ) {
      const s = d.state;
      return typeof s === 'string' && DASHBOARD_STATES.includes(s.toLowerCase());
    }
  } catch {
    /* 非 dashboard 宿主，忽略 */
  }
  return false;
}

export function getHostContext(): HostContext {
  return isDashboardHost() ? 'dashboard' : 'bridge';
}

/**
 * 插件当前是否处于「配置态」（Create / Config）。
 *
 * 对齐官方 Count-Down 插件的双保险做法：
 *   const isConfig = dashboard.state === DashboardState.Config
 *     || !!url.searchParams.get('isConfig');
 *
 * 原因（SDK 源码实证）：dashboard.state 的参数解析函数只取
 * `new URL(href).hash.slice(hash.indexOf("?"))` —— 即**仅解析 hash 里 ? 之后的参数**。
 * 若宿主把 isConfig / isCreate 放在查询串（search）而非 hash 中，state 会错误地回落为 View，
 * 插件就会渲染成「填写态」而不是「配置面板」，用户看不到配置 UI。
 * 因此这里在 state 之外，再兜底检查一次 URL searchParams。
 */
export function isHostConfigState(): boolean {
  try {
    const s = normalizeDashboardState((dashboard as any).state);
    if (s === DashboardState.Config || s === DashboardState.Create) return true;
  } catch {
    /* 非 dashboard 宿主，继续走 URL 兜底 */
  }
  try {
    const q = new URL(window.location.href).searchParams;
    if (q.get('isConfig') === '1' || q.get('isCreate') === '1') return true;
  } catch {
    /* URL 解析失败则忽略 */
  }
  return false;
}

/** 宿主诊断信息：用于在飞书内加载后快速定位"为什么不进画布" */
export function diagnoseHost(): Record<string, unknown> {
  try {
    const d = dashboard as any;
    const hasDash = !!d;
    const state = hasDash ? d.state : 'n/a';
    return {
      hasDashboardObj: hasDash,
      hasGetConfig: hasDash && typeof d.getConfig === 'function',
      hasSaveConfig: hasDash && typeof d.saveConfig === 'function',
      hasSetRendered: hasDash && typeof d.setRendered === 'function',
      state,
      resolvedContext: getHostContext(),
    };
  } catch (e) {
    return { diagnoseError: String(e) };
  }
}

/** 单份表单配置形态校验 */
function isValidConfig(d: unknown): d is FormPluginConfig {
  if (!d || typeof d !== 'object') return false;
  const c = d as Record<string, unknown>;
  return (
    !!c.mainTable &&
    typeof c.mainTable === 'object' &&
    Array.isArray(c.subTables) &&
    Array.isArray(c.conditionalRules)
  );
}

/** 多表单数据形态校验 */
function isValidData(d: unknown): d is PluginData {
  if (!d || typeof d !== 'object') return false;
  const c = d as Record<string, unknown>;
  return Array.isArray(c.forms) && (c.forms as unknown[]).every((f) => isValidConfig(f));
}

/**
 * 解析存储值为 PluginData；兼容宿主把 customConfig 返回为 JSON 字符串，
 * 以及旧版单份配置（自动包成 forms[0]）。
 */
function asData(value: unknown): PluginData | null {
  let d = value;
  // dashboard.getConfig 在不同宿主版本中可能返回对象或 JSON 字符串。
  // 最多解析两层，兼容历史上被重复 JSON.stringify 的配置，同时避免无限递归。
  for (let i = 0; i < 2 && typeof d === 'string'; i += 1) {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  if (isValidData(d)) return d as PluginData;
  if (isValidConfig(d)) return { forms: [d as FormPluginConfig] };
  return null;
}

/** localStorage 是否可用（部分 webview 沙箱可能禁用） */
function lsAvailable(): boolean {
  try {
    localStorage.setItem('__cfg_probe__', '1');
    localStorage.removeItem('__cfg_probe__');
    return true;
  } catch {
    return false;
  }
}
const LS_OK = lsAvailable();

/**
 * 当前多维表格的 baseId（结果缓存）。
 * 用于给配置打上「所属 base」标记：同一插件被部署到多个多维表格时，
 * localStorage / 宿主 KV 等存储是跨 base 共享的（云端部署下所有 base 的 widget
 * 加载同一 origin），不隔离会互相串配置 → 新 widget 预填别的表的配置、
 * dataConditions 指向别的 base 的表 → 宿主校验失败「配置数据发生变更」。
 */
let baseIdCache: Promise<string> | null = null;
export function getBaseId(): Promise<string> {
  if (!baseIdCache) {
    baseIdCache = (async () => {
      try {
        const b = bitable.base as any;
        if (b && typeof b.getBaseId === 'function') {
          return String((await b.getBaseId()) ?? '');
        }
      } catch {
        /* 非 base 宿主或接口不可用 */
      }
      return '';
    })();
  }
  return baseIdCache;
}

/** 是否本地开发环境（localhost）。所有「备份恢复 / 配置重放」只允许在 dev 生效。 */
function isLocalDevHost(): boolean {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  } catch {
    return false;
  }
}

/**
 * 校验配置是否属于另一个多维表格（跨 base 脏配置）。
 * 规则：配置没写 baseId（旧版）→ 放行兼容；当前环境拿不到 baseId → 放行；
 * 否则 baseId 不一致即视为脏配置，调用方应丢弃（返回 null），绝不写回宿主。
 */
async function isForeignConfig(parsed: PluginData | null): Promise<boolean> {
  if (!parsed) return false;
  const stored = (parsed as any).baseId as string | undefined;
  if (!stored) return false;
  const current = await getBaseId();
  return !!current && stored !== current;
}

/** 保存结果：标识实际写入位置（用于 UI 提示） */
export interface SaveResult {
  storage: 'dashboard' | 'bridge' | 'local';
  warning?: string;
}

/**
 * 读取插件数据（多表单）。
 * 优先级：dashboard（若在仪表盘页面宿主）→ bridge → localStorage。
 * 兼容旧版单份配置自动升级。
 * 读到的数据会经过 hydrateConfig：用 base 元信息补回字段的 fieldName/fieldType/options/linkTableId
 * （持久化层已剥离这些冗余元数据以避免触发飞书 widget addonConfig 10240 字节上限）。
 */
export async function loadConfig(): Promise<PluginData | null> {
  const startedAt = performance.now();
  let source: 'dashboard' | 'bridge' | 'local' | null = null;
  if (getHostContext() === 'dashboard') {
    try {
      const cfg = await (dashboard as any).getConfig();
      const data = cfg && cfg.customConfig;
      const parsed = asData(data);
      if (parsed) {
        // ★ 跨 base 防污染：宿主 KV / localStorage 在云端部署下跨多维表格共享，
        //   读到别的 base 的配置必须丢弃（否则配置面板预填别的表的表单、
        //   dataConditions 指向别的 base → 宿主校验失败「配置数据发生变更」）。
        if (await isForeignConfig(parsed)) {
          console.warn('[config] getConfig 返回的是其他多维表格的配置（baseId 不匹配），已丢弃');
          return null;
        }
        source = 'dashboard';
        const result = await hydrateConfig(parsed);
        console.log(`[config] loadConfig 完成（${source}），耗时 ${Math.round(performance.now() - startedAt)}ms`);
        return result;
      }
      // ★ dev 模式宿主配置可能在 F5 后丢失（getConfig 返回空）。从 base 备份捞回并写回宿主，
      //   否则宿主会一直弹「配置数据发生变更，请重新配置」。
      console.warn('[config] dashboard.getConfig 返回空，尝试从 base 备份恢复');
      const restored = await tryRestoreFromBaseBackup();
      if (restored) {
        source = 'dashboard';
        console.log(`[config] loadConfig 完成（${source}·base备份恢复），耗时 ${Math.round(performance.now() - startedAt)}ms`);
        return restored;
      }
    } catch (e) {
      console.warn('[config] dashboard.getConfig 失败，回退 bridge/localStorage:', e);
      const restored = await tryRestoreFromBaseBackup();
      if (restored) {
        source = 'dashboard';
        return restored;
      }
    }
  }

  try {
    let data: unknown = await bitable.bridge.getData(CONFIG_STORAGE_KEY);
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        data = undefined;
      }
    }
    const parsed = asData(data);
    if (parsed) {
      if (await isForeignConfig(parsed)) {
        console.warn('[config] bridge 存的是其他多维表格的配置（baseId 不匹配），已忽略');
      } else {
        source = 'bridge';
        const result = await hydrateConfig(parsed);
        console.log(`[config] loadConfig 完成（${source}），耗时 ${Math.round(performance.now() - startedAt)}ms`);
        return result;
      }
    }
  } catch (e) {
    console.warn('[config] bridge.getData 失败，将回退到本地存储:', e);
  }

  if (LS_OK) {
    try {
      const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
      if (raw) {
        const parsed = asData(JSON.parse(raw));
        if (parsed) {
          if (await isForeignConfig(parsed)) {
            console.warn('[config] localStorage 存的是其他多维表格的配置（baseId 不匹配），已忽略');
          } else {
            source = 'local';
            const result = await hydrateConfig(parsed);
            console.log(`[config] loadConfig 完成（${source}），耗时 ${Math.round(performance.now() - startedAt)}ms`);
            return result;
          }
        }
      }
    } catch (e) {
      console.warn('[config] localStorage 读取失败:', e);
    }
  }
  return null;
}

/**
 * 保存插件数据（多表单）。
 * - 仪表盘页面宿主：dashboard.saveConfig({ customConfig })（页面实例级）。
 *   这是通知飞书宿主「配置已保存」的唯一方式 —— 宿主收到后会：① 关闭配置弹窗
 *   ② 将插件以 View 状态插入仪表盘画布。saveConfig 必须 resolve，弹窗才会关闭；
 *   若抛错则弹窗不关闭，因此真实宿主下必须向上抛出错误，绝不能静默回退到 bridge/localStorage。
 * - 否则（侧边栏扩展 / dev 本地）：优先 bridge，失败回退 localStorage。
 *
 * dataConditions 是应用插件实例声明的数据源列表。表单会直接引用主表和各子表，
 * 因此必须把配置中实际引用的所有表都声明出来；customConfig 中也必须保留这些表 ID。
 * 只声明主表会让宿主在 View 态发现子表引用不在数据源列表中，随后显示
 * 「配置数据发生变更，请重新配置」。
 */
export async function saveConfig(data: PluginData): Promise<SaveResult> {
  // 估算"完整"形态字节数，用于诊断条展示压缩效果
  const fullBytes = estimateConfigBytes(data);
  if (isDashboardHost()) {
    // ⚠️ 飞书仪表盘 widget 的 addonConfig 字段总上限 10240 字节；
    // 完整 PluginData 经常超（fields.name/type/options 是大头），会触发
    //   [page-service] create widget failed: addonConfig exceeded maximum length limit [10240]
    // 把运行时可重取的元数据（fieldName/fieldType/options/linkTableId/tableName/linkFieldName）
    // 全部剥离，只保存用户的"决策字段"（visible/required/label/placeholder/defaultValue/readonly）。
    const thinBase: any = serializeConfig(data);
    // ★ 配置打上「所属 base」标记：读取侧（loadConfig）据此识别并丢弃
    //   其他多维表格串进来的配置（跨 base 污染防线，见 isForeignConfig）。
    try {
      const baseId = await getBaseId();
      if (baseId) thinBase.baseId = baseId;
    } catch {
      /* 拿不到 baseId 则不写标记（读取侧对无标记配置放行兼容） */
    }
    const thin = thinBase;
    const thinBytes = estimateConfigBytes(thin) || -1;
    try {
      // ★ dataConditions = 「主表 + 所有子表」完整声明集。
      //   宿主 View 态校验：customConfig 引用的每张表都必须在 dataConditions 里，
      //   缺哪张就报「配置数据发生变更，请重新配置」（2026-10-06 实测：
      //   只声明主表 + 剥离子表 tableId 仍失败 → 校验的是声明集，不是字符串扫描）。
      //   历史踩坑记录（留档，均已实测）：
      //   - 传 0 个（SDK 兜底取 base 第一张表）→ 与用户主表不一致 → 配置变更报错
      //   - 只传 1 个主表 → 纯主表表单可用，但带子表必失败
      //   - 早年「传 N 个 → create widget failed」的结论疑似被当时的 10KB 超限
      //     问题污染（两种错在宿主侧同报 create widget failed），体积受控后需重测。
      //   每个条目用 SDK genDefaultConfig() 同款结构：{tableId, dataRange:{type:'ALL'}}，
      //   宿主保存时会自动补全 groups/series。
      const firstForm = data?.forms?.find((f) => f?.mainTable?.tableId);
      const mainTableId = firstForm?.mainTable?.tableId;
      const subTableIds = (firstForm?.subTables ?? [])
        .map((s) => s?.tableId)
        .filter((id): id is string => !!id);
      const allTableIds = Array.from(
        new Set([mainTableId, ...subTableIds].filter((id): id is string => !!id))
      );
      // ★ dataConditions 格式：每项 tableId + dataRange + groups + series
      //   宿主 dataConditions 是类图表数据配置格式，缺 groups/series 会被过滤。
      const buildDataConditions = (tableIds: string[]) => tableIds.map((tableId) => ({
        tableId,
        dataRange: { type: 'ALL' },
        groups: [],
        series: 'COUNTA',
      }));
      const fullDataConditions = buildDataConditions(allTableIds);

      // 先探测当前宿主状态（Create / Config）
      let saveState = 'unknown';
      try {
        saveState = String((dashboard as any).state ?? 'unknown');
      } catch { /* ignore */ }
      console.log('[config] 保存前 dashboard.state =', saveState, '，声明表数 =', allTableIds.length);

      const fullPayload: Record<string, unknown> = {
        customConfig: thin,
        dataConditions: fullDataConditions,
      };
      const payloadLog = {
        customConfigLength: JSON.stringify(thin).length,
        dataConditions: fullDataConditions,
        declaredTables: allTableIds,
        saveState,
      };
      // 把本次保存 payload 写到 localStorage：配置态若保存成功但 View 态失败，
      // 用户刷新回配置态后仍能看到上一次保存的真实参数，便于排查。
      try {
        const payloadBaseId = await getBaseId();
        localStorage.setItem(
          '__plugin_last_save_payload__',
          JSON.stringify({
            schemaVersion: 1,
            time: new Date().toISOString(),
            // 保留完整 thin payload；dev 模式宿主丢配置时可在 View 态重放
            payload: payloadLog,
            customConfig: thin,
            fullBytes,
            thinBytes,
            // ★ 关键：保存时把主表 ID 和表单 ID 一起存，View 态自动修复时要用
            mainTableId,
            formId: data?.forms?.find((f) => f?.mainTable?.tableId)?.id ?? null,
            // ★ base 隔离：localStorage 按插件域名存储、跨所有多维表格共享，
            //   重放前必须校验 baseId，防止把别的 base 的配置重放到当前 base。
            baseId: payloadBaseId || undefined,
          })
        );
      } catch {
        /* ignore */
      }
      console.log(
        '[config] 调用 dashboard.saveConfig，thin字节数:',
        thinBytes,
        '（完整形态原本:',
        fullBytes,
        'B）payload:',
        JSON.stringify(payloadLog)
      );

      // ★ 两阶段保存策略（解决 Create 态多表 dataConditions 丢失问题）
      //
      // 背景：飞书仪表盘页面插件在 Create 态首次 saveConfig 创建 widget 时，
      // dataConditions 的多表声明可能不被完整接受，导致 View 态校验失败
      // （customConfig 引用的表不在 dataConditions 中 → 「配置数据发生变更」）。
      // 而 Config 态下保存，dataConditions 能被完整接受。
      //
      // 策略：
      // 1. Create 态 + 多表：先存主表创建 widget → 等状态切 Config → 再存全表
      // 2. Config 态 + 多表：直接存全表（Config 态能正确接受多表）
      // 3. 单表：直接存（无此问题）
      //
      // 验证：getConfig 不可靠（永远只返回主数据源），改用 dashboard.state 判断
      // 阶段切换是否完成。最终用一次 getConfig 做记录（不做成败判断）。
      let reSaved = 0;
      let phaseInfo = '';
      let finalState = saveState;

      const hasMultipleTables = allTableIds.length > 1;

      // ★ 保存策略（2024-10-09 调整：基于用户反馈"再存一次就好"）
      //
      // 背景：飞书仪表盘页面插件 Create 态首次保存时，多表 dataConditions 可能
      // 不被完整接受，导致 View 态显示「配置数据发生变更」。第二次在 Config 态
      // 保存就能正常显示。
      //
      // 策略：
      // 1. 先探测 dashboard.state 的实际值（做诊断用）
      // 2. 直接保存完整配置（不再分两阶段，避免主表-only配置的中间状态）
      // 3. 多表情况下，连续补存 2 次，每次间隔 800ms，模拟"再存一次就好"的效果
      // 4. 等待宿主状态稳定（从 Create 切走）后再补存一次做最终保险
      phaseInfo = hasMultipleTables ? '多次补存策略' : '单阶段(单表)';

      // 先探测初始 state
      let stateBefore = 'unknown';
      try {
        stateBefore = String((dashboard as any).state ?? 'unknown');
      } catch { /* ignore */ }
      saveState = stateBefore;
      console.log('[config] 保存前 dashboard.state =', stateBefore, '，声明表数 =', allTableIds.length);

      // —— 第一次保存（完整配置）——
      console.log('[config] 第1次保存（完整配置）…');
      const firstSuccess = await (dashboard as any).saveConfig(fullPayload);
      console.log('[config] 第1次 saveConfig 返回:', firstSuccess);
      if (firstSuccess === false) {
        throw new Error('首次保存失败：dashboard.saveConfig 返回 false');
      }

      // —— 多表情况下连续补存 ——
      if (hasMultipleTables) {
        // 第 1 次补存（模拟"再存一次就好"）
        await new Promise((r) => setTimeout(r, 800));
        try {
          const s2 = await (dashboard as any).saveConfig(fullPayload);
          reSaved += 1;
          console.log('[config] 第2次 saveConfig 返回:', s2);
        } catch (e2) {
          console.warn('[config] 第2次 saveConfig 失败:', e2);
        }

        // 等状态从 Create 切走后，再补存第 3 次（Config 态下的补存）
        let waited = 0;
        let curState = stateBefore;
        const maxWait = 4000;
        const pollInterval = 200;
        while (waited < maxWait) {
          await new Promise((r) => setTimeout(r, pollInterval));
          waited += pollInterval;
          try {
            curState = String((dashboard as any).state ?? 'unknown');
          } catch { /* ignore */ }
          if (!/create/i.test(curState)) break;
        }
        finalState = curState;
        console.log(`[config] 状态等待 ${waited}ms 后 state = ${curState}`);

        // 状态切走了（到 Config 或 View），再补存一次
        if (!/create/i.test(curState)) {
          await new Promise((r) => setTimeout(r, 300));
          try {
            const s3 = await (dashboard as any).saveConfig(fullPayload);
            reSaved += 1;
            console.log('[config] 第3次 saveConfig（状态切走后）返回:', s3);
            phaseInfo = '状态切换后补存成功';
          } catch (e3) {
            console.warn('[config] 第3次 saveConfig（状态切走后）失败:', e3);
            phaseInfo = '状态切换后补存失败';
          }
        } else {
          console.warn('[config] 等待超时，状态仍为 Create');
          phaseInfo = '状态未切换(超时)';
        }
      } else {
        // 单表：保存后也读一下 state
        await new Promise((r) => setTimeout(r, 300));
        try {
          finalState = String((dashboard as any).state ?? 'unknown');
        } catch { /* ignore */ }
      }

      // 更新 finalState
      try {
        finalState = String((dashboard as any).state ?? finalState);
      } catch { /* ignore */ }

      // ★ base 持久化备份：dev 模式下宿主 widget 配置不保证跨 F5 持久化，
      //   把 thin + dataConditions 备份到飞书 base（setData 按 base 维度持久化，
      //   不受页面刷新影响）。刷新后 loadConfig 会自动从这里捞回并写回宿主。
      //   备份同样带 baseId —— bridge 数据按 base 隔离，但多打一层标记双保险。
      try {
        const backupBaseId = await getBaseId();
        await bitable.bridge.setData(
          BACKUP_KEY,
          JSON.stringify({
            time: new Date().toISOString(),
            baseId: backupBaseId || undefined,
            customConfig: thin,
            dataConditions: fullDataConditions,
          })
        );
        console.log('[config] base 备份写入成功');
      } catch (be) {
        console.warn('[config] base 备份写入失败（可忽略，非致命）:', be);
      }

      // ★ 最终读回 getConfig（仅做诊断记录，不做成败判断）
      // getConfig 可能只返回主数据源，不能真实反映多表是否保存成功。
      // 这里只把结果存下来供诊断条展示，判断是否成功用 dashboard.state 切换。
      let finalReadback: { ok: boolean; ccLen: number; dataConditions: unknown; err?: string } = {
        ok: false,
        ccLen: 0,
        dataConditions: null,
      };
      try {
        const cfg: any = await (dashboard as any).getConfig();
        const cc = cfg?.customConfig;
        const dc: any[] = cfg?.dataConditions ?? [];
        finalReadback = {
          ok: true,
          ccLen: typeof cc === 'string' ? cc.length : cc ? JSON.stringify(cc).length : 0,
          dataConditions: dc,
        };
        console.log('[config] 最终读回 getConfig:', finalReadback);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        finalReadback = { ok: false, ccLen: 0, dataConditions: null, err: msg };
        console.log('[config] 最终读回 getConfig 失败:', msg);
      }
      try {
        localStorage.setItem(
          '__plugin_last_save_readback__',
          JSON.stringify({
            time: new Date().toISOString(),
            readback: finalReadback,
            reSaved,
            phaseInfo,
            saveState,
            finalState,
            expectedTables: allTableIds.length,
          })
        );
      } catch {
        /* ignore */
      }

      const parts: string[] = [];
      if (thinBytes >= 0) parts.push(`序列化后 ${thinBytes} B`);
      if (phaseInfo) parts.push(phaseInfo);
      if (reSaved > 0) parts.push(`补存${reSaved}次`);
      parts.push(`state:${saveState}→${finalState}`);
      return { storage: 'dashboard', warning: parts.join(' · ') };
    } catch (e) {
      const errMsg = (e as Error)?.message ?? String(e);
      console.error('[config] dashboard.saveConfig 失败，完整错误:', e);
      // 不根据 import.meta.env.DEV 静默回退 —— 用户可能通过 dev server 地址
      // 加载到真实仪表盘宿主中（此时 DEV=true 但确实有真实宿主）。
      // 统一抛出错误，由 UI 层展示给用户；仅在明确无宿主 API 时才降级。
      const isNoHostError =
        errMsg.includes('not available') ||
        errMsg.includes('not a function') ||
        errMsg.includes('undefined');
      if (isNoHostError) {
        console.warn('[config] 宿主 API 不可用（非真实仪表盘环境），降级到 bridge/localStorage');
      } else {
        // 真实宿主但 saveConfig 调用失败（参数错/权限/网络等），必须向上抛出
        throw new Error(`dashboard.saveConfig 失败：${errMsg}`);
      }
    }
  }

  try {
    // bridge 没有 10240 字节限制，但为保持持久化层一致，也用瘦身形态写入
    const thinBridge: any = serializeConfig(data);
    try {
      const baseId = await getBaseId();
      if (baseId) thinBridge.baseId = baseId;
    } catch {
      /* ignore */
    }
    await bitable.bridge.setData(CONFIG_STORAGE_KEY, JSON.stringify(thinBridge));
    return { storage: 'bridge' };
  } catch (e) {
    console.warn('[config] bridge.setData 失败，回退到本地存储:', e);
  }

  if (LS_OK) {
    try {
      // localStorage 直接存完整 data（dev 调试用，不考虑大小），方便人肉 inspect
      let dataWithBase: PluginData = data;
      try {
        const baseId = await getBaseId();
        if (baseId) dataWithBase = { ...data, baseId };
      } catch {
        /* ignore */
      }
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(dataWithBase));
      return {
        storage: 'local',
        warning: '开发模式：bridge.setData 不可用，已保存到本地存储（iframe localStorage）。正式发布后会自动使用云端存储。',
      };
    } catch (e) {
      console.error('[config] localStorage 写入失败:', e);
      throw new Error(`保存失败：bridge 与本地存储均不可用 (${(e as Error)?.message ?? String(e)})`);
    }
  }
  throw new Error('保存失败：bridge 不可用且当前环境不支持 localStorage');
}

/**
 * dev 模式修复：飞书 dev 插件的 dashboard 配置有时只在会话层生效，
 * 刷新/重新进入 View 后宿主读不到稳定持久化数据，于是显示
 * 「配置数据发生变更」。这里用最近一次真实保存的 thin payload 做一次重放。
 *
 * 只允许 localhost 触发，并且只在宿主 dataConditions/customConfig 与上次保存
 * 不一致时才写；避免影响生产环境或覆盖用户在宿主侧主动调整的数据源。
 */
export async function repairDashboardConfigFromLastSave(
  maxAttempts = 3
): Promise<{ repaired: boolean; reason: string; detail?: Record<string, unknown> }> {
  if (!isLocalDevHost()) return { repaired: false, reason: 'not-local-dev' };
  if (!isDashboardHost()) return { repaired: false, reason: 'not-dashboard' };

  const saved = await loadSavedPayload();
  const dataConditions = saved?.payload?.dataConditions ?? saved?.dataConditions;
  const customConfig = saved?.customConfig;
  if (!dataConditions || !customConfig) {
    return { repaired: false, reason: 'no-replay-payload' };
  }

  // ★ 关键改动：不再先调 getConfig 判断"是否一致"。错误态下 getConfig 可能抛错/返回空，
  // 反而让重放分支走不到。直接把上次成功保存的 payload 原样重放（幂等），带重试应对时序抖动。
  let lastErr = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const success = await (dashboard as any).saveConfig({ dataConditions, customConfig });
      if (success !== false) {
        return { repaired: true, reason: `replayed-attempt-${attempt}`, detail: { dataConditions } };
      }
      lastErr = 'saveConfig returned false';
    } catch (e) {
      lastErr = String((e as Error)?.message ?? e);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { repaired: false, reason: 'repair-failed-after-retries', detail: { lastErr } };
}

/** 读取最近一次保存的 payload：先 localStorage，再 base 备份。
 *  ★ base 隔离：两路来源都必须校验 baseId —— localStorage 按插件域名存储
 *  （云端部署下跨所有多维表格共享），不校验会把别的 base 的配置重放到当前 base，
 *  导致「在 B 表配置后，A 表的 widget 也坏了」这类跨表污染。 */
async function loadSavedPayload(): Promise<any> {
  const currentBaseId = await getBaseId();
  const foreign = (v: any) => !!v?.baseId && !!currentBaseId && v.baseId !== currentBaseId;
  try {
    const raw = localStorage.getItem('__plugin_last_save_payload__');
    if (raw) {
      const o = JSON.parse(raw);
      if (o?.customConfig) {
        if (foreign(o)) {
          console.warn('[config] 跳过其他多维表格的重放 payload（baseId 不匹配）');
        } else {
          return o;
        }
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const b = await bitable.bridge.getData(BACKUP_KEY);
    if (b) {
      const obj = typeof b === 'string' ? JSON.parse(b) : b;
      if (obj?.customConfig && !foreign(obj)) {
        return { customConfig: obj.customConfig, payload: { dataConditions: obj.dataConditions } };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** dev 模式宿主配置丢失时，从 base 备份捞回并写回宿主。
 *  ★ 仅限本地开发环境：生产环境宿主 KV 持久可靠，getConfig 为空就意味着
 *  「新 widget 尚未配置」——此时从备份恢复会把旧 widget / 其他表单的配置注入进来，
 *  正是「云端部署后每次进配置都保留上次配置」和「跨多维表格串配置」的根源。 */
async function tryRestoreFromBaseBackup(): Promise<PluginData | null> {
  if (!isLocalDevHost()) return null;
  try {
    const b = await bitable.bridge.getData(BACKUP_KEY);
    if (!b) return null;
    const obj = typeof b === 'string' ? JSON.parse(b) : b;
    if (!obj?.customConfig) return null;
    // base 隔离双保险（bridge 数据本身按 base 隔离，这里防异常共享场景）
    try {
      const current = await getBaseId();
      if (obj.baseId && current && obj.baseId !== current) {
        console.warn('[config] base 备份属于其他多维表格（baseId 不匹配），跳过恢复');
        return null;
      }
    } catch {
      /* ignore */
    }
    const reparsed = asData(obj.customConfig);
    if (!reparsed) return null;
    // 写回宿主，触发宿主重新校验（这次配置是从上次成功保存完整保留的）
    try {
      await (dashboard as any).saveConfig({
        dataConditions: obj.dataConditions,
        customConfig: obj.customConfig,
      });
    } catch (e) {
      console.warn('[config] 从 base 恢复时写回宿主失败（继续尝试返回数据）:', e);
    }
    return await hydrateConfig(reparsed);
  } catch {
    return null;
  }
}

/** 清空配置（dashboard + bridge + localStorage 都清） */
export async function clearConfig(): Promise<void> {
  if (isDashboardHost()) {
    try {
      // 同样只传 customConfig，dataConditions 交给 SDK 兜底
      await (dashboard as any).saveConfig({ dataConditions: [], customConfig: { forms: [] } });
    } catch {
      /* ignore */
    }
  }
  try {
    await bitable.bridge.setData(CONFIG_STORAGE_KEY, null);
  } catch {
    /* ignore */
  }
  if (LS_OK) {
    try {
      localStorage.removeItem(CONFIG_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
}
