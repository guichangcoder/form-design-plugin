/**
 * 飞书官方诊断修复项的内存回归测试（不触网、不碰真实 Base）。
 * 覆盖：
 *  - P0-2 子表部分成功后失败 → 回滚补偿（F02/F03 复现用例）
 *  - P1-3 条件隐藏的旧值不提交（F04/F05）
 *  - P2-9 子表条件规则逐行生效（F06）
 *  - P2-8 无效日期本地校验（F11）
 */
import { FieldType } from '@lark-base-open/js-sdk';
import { computeConditionalState } from '../src/hooks/useConditional';
import { validateForm } from '../src/utils/validator';
import { submitForm } from '../src/services/recordService';
import { __setAppForTest as selectBaseForTest } from '../src/services/appContext';
import { serializeConfig, hydrateConfig } from '../src/services/configSize';
import { resolveRefOptions, getOptionRefDependencies, hasOptionRef, conditionSpecOf } from '../src/utils/optionRef';
import { extractOptionTexts } from '../src/utils/cellText';
import { applyDateOffset, isSameInstant, describeOffset, toDateOrNull } from '../src/utils/dateCalc';
import { applyAutoFill, markManualEdits, resolveAutoFill, findAutoFillCycles, wouldCreateAutoFillCycle } from '../src/utils/dateAutoFill';
import {
  resolveSubLayout,
  suggestColumnWidth,
  buildSubColumns,
  defaultRowValues,
  applyRowFieldChange,
  updateRowAt,
  removeRowAt,
  appendRow,
  canAppendRow,
  isCellHidden,
  SUB_ROW_INDEX_WIDTH,
  SUB_ROW_ACTION_WIDTH,
} from '../src/utils/subTableLayout';
import {
  checkDuplicates,
  checkOneValue,
  loadAllExistingValues,
  normalizeForCompare,
  invalidateExistingCache,
  noteSubmittedValues,
} from '../src/services/uniqueCheck';
import { classifySdkError } from '../src/utils/permError';
import {
  loadHeadColumn,
  loadHeadRows,
  loadRowsByConditions,
  scanRowsByConditionsLocal,
  scanDistinctValues,
  searchAllPages,
  searchAllRows,
  getHeadCache,
  invalidateTableRecords,
  taskKey,
  loadFieldSelectOptions,
  probeOptionExists,
  enumerateOptionsByProbe,
  enumerateFieldValuesByColumn,
  enumerateRefOptions,
  MAX_PROBE_OPTIONS,
  DISTINCT_SCAN_MAX_PAGES,
} from '../src/services/tableRecordCache';

const results = [];
function log(line) { process.stdout.write(line + '\n'); }
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra });
  log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' | ' + JSON.stringify(extra) : ''}`);
}

const MAIN = 'tblMain';
const SUB1 = 'tblSub1';
const SUB2 = 'tblSub2';

/** 日期格式化（F15 / F21 共用）：Date → YYYY-MM-DD，空值 → 'null' */
const fmt = (x) =>
  x
    ? `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
    : 'null';
/** 构造本地零点的 Date（F15 / F21 共用） */
const d = (s) => new Date(`${s}T00:00:00`);

/** 构造内存 base：recordCalls 记录所有写/删调用 */
function makeMockBase({ failSub1AtBatch = -1, failSub2 = false } = {}) {
  const calls = [];
  let sub1AddCount = 0;
  const tables = {
    [MAIN]: {
      addRecord: async () => {
        calls.push(['main-add']);
        return 'recMain1';
      },
      deleteRecords: async (ids) => {
        calls.push(['main-del', ids]);
      },
      getField: async (fid) => ({ getMeta: async () => ({ type: FieldType.Text }) }),
      getFieldMetaById: async () => ({ type: FieldType.Text }),
    },
    [SUB1]: {
      addRecords: async (batch) => {
        sub1AddCount += 1;
        if (failSub1AtBatch > 0 && sub1AddCount === failSub1AtBatch) {
          calls.push(['sub1-add-fail', batch.length]);
          throw new Error('模拟子表1第二批写入失败');
        }
        const ids = batch.map((_, i) => `sub1rec_${sub1AddCount}_${i}`);
        calls.push(['sub1-add', batch.length]);
        return ids;
      },
      deleteRecords: async (ids) => {
        calls.push(['sub1-del', ids.length]);
      },
      getField: async (fid) => ({ getMeta: async () => ({ type: FieldType.Text }) }),
      getFieldMetaById: async (fid) =>
        fid === 'fldLink1'
          ? { type: FieldType.SingleLink, property: { tableId: MAIN } }
          : { type: FieldType.Text },
    },
    [SUB2]: {
      addRecords: async (batch) => {
        if (failSub2) {
          calls.push(['sub2-add-fail', batch.length]);
          throw new Error('模拟子表2写入失败');
        }
        const ids = batch.map((_, i) => `sub2rec_${i}`);
        calls.push(['sub2-add', batch.length]);
        return ids;
      },
      deleteRecords: async (ids) => {
        calls.push(['sub2-del', ids.length]);
      },
      getField: async (fid) => ({ getMeta: async () => ({ type: FieldType.Text }) }),
      getFieldMetaById: async (fid) =>
        fid === 'fldLink2'
          ? { type: FieldType.SingleLink, property: { tableId: MAIN } }
          : { type: FieldType.Text },
    },
  };
  return {
    calls,
    base: {
      getTableById: async (id) => {
        if (!tables[id]) throw new Error('表不存在 ' + id);
        return tables[id];
      },
      getTableMetaList: async () => [
        { id: MAIN, name: '主表' },
        { id: SUB1, name: '子表1' },
        { id: SUB2, name: '子表2' },
      ],
    },
  };
}

function makeConfig({ subCount = 1 } = {}) {
  const subs = [
    {
      tableId: SUB1,
      tableName: '子表1',
      linkFieldId: 'fldLink1',
      fields: [
        { fieldId: 'fldS1', fieldName: '明细', fieldType: FieldType.Text, visible: true, required: false },
      ],
      allowMultiple: true,
    },
  ];
  if (subCount > 1) {
    subs.push({
      tableId: SUB2,
      tableName: '子表2',
      linkFieldId: 'fldLink2',
      fields: [
        { fieldId: 'fldS2', fieldName: '明细2', fieldType: FieldType.Text, visible: true, required: false },
      ],
      allowMultiple: true,
    });
  }
  return {
    id: 'form1',
    version: '1.0.0',
    formTitle: '测试',
    mainTable: {
      tableId: MAIN,
      tableName: '主表',
      fields: [
        { fieldId: 'fldM1', fieldName: '标题', fieldType: FieldType.Text, visible: true, required: true },
        { fieldId: 'fldM2', fieldName: '备注', fieldType: FieldType.Text, visible: true, required: false },
      ],
    },
    subTables: subs,
    conditionalRules: [],
  };
}

async function run() {
  // —— F02：201 条同一子表，第一批 200 成功、第二批失败 → 回滚子记录+主记录 ——
  {
    const { base, calls } = makeMockBase({ failSub1AtBatch: 2 });
    selectBaseForTest({ base });
    const config = makeConfig();
    const rows = Array.from({ length: 201 }, (_, i) => ({ fldS1: 'v' + i }));
    const r = await submitForm(config, { fldM1: 't' }, { [SUB1]: rows });
    const sub1Del = calls.find((c) => c[0] === 'sub1-del');
    const mainDel = calls.find((c) => c[0] === 'main-del');
    check('F02 提交失败', r.success === false);
    check('F02 已写入的 200 条子记录被回滚删除', sub1Del && sub1Del[1] === 200, sub1Del);
    check('F02 主表记录被回滚删除', !!mainDel);
    check('F02 回滚标记为 clean', r.rollback === 'clean', r.rollback);
  }

  // —— F03：子表1成功1条，子表2失败 → 子表1记录也被回滚 ——
  {
    const { base, calls } = makeMockBase({ failSub2: true });
    selectBaseForTest({ base });
    const config = makeConfig({ subCount: 2 });
    const r = await submitForm(
      config,
      { fldM1: 't' },
      { [SUB1]: [{ fldS1: 'a' }], [SUB2]: [{ fldS2: 'b' }] }
    );
    const sub1Del = calls.find((c) => c[0] === 'sub1-del');
    const mainDel = calls.find((c) => c[0] === 'main-del');
    check('F03 提交失败', r.success === false);
    check('F03 子表1已写入记录被回滚删除', sub1Del && sub1Del[1] === 1, sub1Del);
    check('F03 主表记录被回滚删除', !!mainDel);
    check('F03 回滚标记为 clean', r.rollback === 'clean', r.rollback);
  }

  // —— F04/F05：条件隐藏的字段旧值不提交 ——
  {
    const { base, calls } = makeMockBase();
    selectBaseForTest({ base });
    const config = makeConfig();
    // 规则：当 fldM1 等于 'hide' 时隐藏 fldM2
    config.conditionalRules = [
      {
        ruleId: 'r1',
        trigger: { tableId: MAIN, fieldId: 'fldM1', operator: 'equals', value: 'hide' },
        actions: [{ type: 'hide', tableId: MAIN, fieldIds: ['fldM2'] }],
      },
    ];
    const mainValues = { fldM1: 'hide', fldM2: '旧值不应提交' };
    const cond = computeConditionalState(config, mainValues, { [SUB1]: [] });
    check('F04 条件引擎把 fldM2 标记为隐藏', cond.hiddenFields[MAIN]?.has('fldM2'));
    // 劫持主表 addRecord 看实际写入的字段
    const mainTable = await base.getTableById(MAIN);
    let writtenFields = null;
    const origAdd = mainTable.addRecord;
    mainTable.addRecord = async (rec) => {
      writtenFields = rec.fields;
      return origAdd(rec);
    };
    const r = await submitForm(config, mainValues, { [SUB1]: [] }, cond);
    check('F05 提交成功', r.success === true);
    check(
      'F05 隐藏字段 fldM2 的旧值未写入',
      writtenFields && !('fldM2' in writtenFields) && 'fldM1' in writtenFields,
      writtenFields
    );
  }

  // —— F06：子表条件规则逐行生效 ——
  {
    const config = makeConfig();
    config.subTables[0].fields.push({
      fieldId: 'fldS1Extra',
      fieldName: '额外',
      fieldType: FieldType.Text,
      visible: true,
      required: true,
    });
    // 规则：当子表1的 fldS1 等于 'x' 时，隐藏同行的 fldS1Extra
    config.conditionalRules = [
      {
        ruleId: 'r2',
        trigger: { tableId: SUB1, fieldId: 'fldS1', operator: 'equals', value: 'x' },
        actions: [{ type: 'hide', tableId: SUB1, fieldIds: ['fldS1Extra'] }],
      },
    ];
    const subValues = { [SUB1]: [{ fldS1: 'no', fldS1Extra: '' }, { fldS1: 'x', fldS1Extra: '' }] };
    const cond = computeConditionalState(config, {}, subValues);
    check(
      'F06 第2行命中规则被隐藏、第1行未命中不隐藏',
      !cond.rowHiddenFields[SUB1]?.[0]?.has('fldS1Extra') &&
        cond.rowHiddenFields[SUB1]?.[1]?.has('fldS1Extra'),
      {
        row0: cond.rowHiddenFields[SUB1]?.[0] ? [...cond.rowHiddenFields[SUB1][0]] : [],
        row1: cond.rowHiddenFields[SUB1]?.[1] ? [...cond.rowHiddenFields[SUB1][1]] : [],
      }
    );
    // 校验：第1行 fldS1Extra 必填但为空 → 应报错；第2行被隐藏 → 不报错
    const v = validateForm(config, { fldM1: 't' }, subValues, cond);
    check(
      'F06 仅第1行报必填错误，第2行隐藏不报',
      !v.valid && v.errors.length === 1 && v.errors[0].includes('第 1 行'),
      v.errors
    );
  }

  // —— F11：无效日期本地校验 ——
  {
    const config = makeConfig();
    config.mainTable.fields.push({
      fieldId: 'fldDate',
      fieldName: '日期',
      fieldType: FieldType.DateTime,
      visible: true,
      required: false,
    });
    const cond = computeConditionalState(config, {}, { [SUB1]: [] });
    const v = validateForm(config, { fldM1: 't', fldDate: 'not-a-date' }, { [SUB1]: [] }, cond);
    check('F11 无效日期被本地拦截', !v.valid && v.errors.some((e) => e.includes('日期格式无效')), v.errors);
    const v2 = validateForm(config, { fldM1: 't', fldDate: '2026-10-12' }, { [SUB1]: [] }, cond);
    check('F11 合法日期通过', v2.valid, v2.errors);
  }

  // —— F12：必填配置全链路（serialize → JSON 存取 → hydrate → 空值提交拦截）——
  {
    // 模拟配置态产物：用户在配置面板把「客户名称」设为必填、「是否老客户」非必填
    const fullConfig = {
      id: 'form1',
      version: '1.0.0',
      formTitle: '客户档案',
      mainTable: {
        tableId: MAIN,
        tableName: '主表',
        fields: [
          { fieldId: 'fldM1', fieldName: '客户名称', fieldType: FieldType.Text, visible: true, required: true, label: '客户名称' },
          { fieldId: 'fldM2', fieldName: '是否老客户', fieldType: FieldType.SingleSelect, visible: true, required: false, label: '是否老客户', options: [{ id: 'o1', name: '是' }, { id: 'o2', name: '否' }] },
        ],
      },
      subTables: [],
      conditionalRules: [],
    };
    const thin = serializeConfig({ forms: [fullConfig], defaultFormId: 'form1' });
    check('F12 序列化保留 required=true', thin.forms[0].mainTable.fields.find((f) => f.fieldId === 'fldM1')?.required === true, thin.forms[0].mainTable.fields);
    // 模拟宿主存取（JSON 序列化往返，宿主存的就是这个 JSON）
    const stored = JSON.parse(JSON.stringify(thin));
    // mock base 带字段元数据（hydrate 恢复 fieldName/fieldType/options 用）
    const metaBase = {
      getTableById: async () => ({
        getFieldMetaList: async () => [
          { id: 'fldM1', name: '客户名称', type: FieldType.Text },
          { id: 'fldM2', name: '是否老客户', type: FieldType.SingleSelect, property: { options: [{ id: 'o1', name: '是' }, { id: 'o2', name: '否' }] } },
        ],
      }),
      getTableMetaList: async () => [{ id: MAIN, name: '主表' }],
    };
    selectBaseForTest({ base: metaBase });
    const hydrated = await hydrateConfig(stored);
    const form = hydrated.forms[0];
    const f1 = form.mainTable.fields.find((f) => f.fieldId === 'fldM1');
    check('F12 hydrate 后 required 保留', f1?.required === true, f1);
    check('F12 hydrate 后 fieldName/fieldType 恢复', f1?.fieldName === '客户名称' && f1?.fieldType === FieldType.Text, f1);
    // 用户留空直接提交（initMainValues 全空）
    const cond = computeConditionalState(form, {}, {});
    const res = validateForm(form, {}, {}, cond);
    check('F12 空值提交被拦截', res.valid === false);
    check('F12 报错指向「客户名称」', res.errors.some((e) => e.includes('客户名称')), res.errors);
    check('F12 字段级错误定位到 fldM1', res.fieldErrors.some((e) => e.fieldId === 'fldM1' && e.rowIndex === undefined), res.fieldErrors);
    // 填上值后放行
    const res2 = validateForm(form, { fldM1: 'ABC公司' }, {}, cond);
    check('F12 填值后校验通过', res2.valid === true, res2.errors);
  }

  // —— F13：子表必填整表必录（空子表 + 部分填写 + 无必填子表豁免 + hydrate 往返）——
  {
    // 子表字段「明细」必填
    const fullConfig = {
      id: 'form1',
      version: '1.0.0',
      formTitle: '主子联填',
      mainTable: {
        tableId: MAIN,
        tableName: '主表',
        fields: [
          { fieldId: 'fldM1', fieldName: '标题', fieldType: FieldType.Text, visible: true, required: true, label: '标题' },
        ],
      },
      subTables: [
        {
          tableId: SUB1,
          tableName: '子表1',
          linkFieldId: 'fldLink1',
          fields: [
            { fieldId: 'fldS1', fieldName: '明细', fieldType: FieldType.Text, visible: true, required: true, label: '明细' },
          ],
          allowMultiple: true,
        },
      ],
      conditionalRules: [],
    };
    // 序列化 → 宿主存取 → hydrate（模拟真实加载链路，确认 required 不丢）
    const thin = serializeConfig({ forms: [fullConfig], defaultFormId: 'form1' });
    const stored = JSON.parse(JSON.stringify(thin));
    const metaBase = {
      getTableById: async (id) => ({
        getFieldMetaList: async () =>
          id === MAIN
            ? [{ id: 'fldM1', name: '标题', type: FieldType.Text }]
            : [{ id: 'fldS1', name: '明细', type: FieldType.Text }],
      }),
      getTableMetaList: async () => [
        { id: MAIN, name: '主表' },
        { id: SUB1, name: '子表1' },
      ],
    };
    selectBaseForTest({ base: metaBase });
    const hydrated = await hydrateConfig(stored);
    const form = hydrated.forms[0];
    const sf = form.subTables[0].fields.find((f) => f.fieldId === 'fldS1');
    check('F13 hydrate 后子表 required 保留', sf?.required === true, sf);

    const cond = computeConditionalState(form, {}, { [SUB1]: [{}] });
    // a) 子表整行为空 + 子表有必填字段 → 必须拦截（本轮回填的缺口）
    const v1 = validateForm(form, { fldM1: 't' }, { [SUB1]: [{}] }, cond);
    check('F13 空子表（有必填字段）被拦截', v1.valid === false, v1.errors);
    check(
      'F13 报错指向子表第 1 行必填字段',
      v1.errors.some((e) => e.includes('第 1 行') && e.includes('明细')),
      v1.errors
    );
    check(
      'F13 字段级错误定位到子表 fldS1 第 0 行',
      v1.fieldErrors.some((e) => e.tableId === SUB1 && e.fieldId === 'fldS1' && e.rowIndex === 0),
      v1.fieldErrors
    );
    // b) 子表部分填写（别的字段有值、必填为空）→ 拦截
    const form2 = JSON.parse(JSON.stringify(form));
    form2.subTables[0].fields.push({
      fieldId: 'fldS2x', fieldName: '备注', fieldType: FieldType.Text, visible: true, required: false,
    });
    const cond2 = computeConditionalState(form2, {}, { [SUB1]: [{}] });
    const v2 = validateForm(form2, { fldM1: 't' }, { [SUB1]: [{ fldS2x: 'x' }] }, cond2);
    check('F13 子表部分填写但必填为空被拦截', v2.valid === false, v2.errors);
    // c) 子表无必填字段 + 整行为空 → 放行（保持「允许只提交主表」语义）
    const form3 = JSON.parse(JSON.stringify(form));
    form3.subTables[0].fields[0].required = false;
    const cond3 = computeConditionalState(form3, {}, { [SUB1]: [{}] });
    const v3 = validateForm(form3, { fldM1: 't' }, { [SUB1]: [{}] }, cond3);
    check('F13 无必填字段的空子表仍放行', v3.valid === true, v3.errors);
    // d) 必填填上 → 放行
    const v4 = validateForm(form, { fldM1: 't' }, { [SUB1]: [{ fldS1: 'v' }] }, cond);
    check('F13 子表必填填值后通过', v4.valid === true, v4.errors);
  }

  // —— F14：选项引用（resolveRefOptions 过滤/去重/联动 + 序列化往返 + 依赖提取）——
  {
    // 源表：城市表（fldCity=城市名，fldProv=所属省）
    const records = [
      { fields: { fldCity: '杭州', fldProv: '浙江' } },
      { fields: { fldCity: '宁波', fldProv: '浙江' } },
      { fields: { fldCity: '杭州', fldProv: '浙江' } }, // 重复值 → 去重
      { fields: { fldCity: '南京', fldProv: '江苏' } },
      { fields: { fldCity: '', fldProv: '江苏' } },    // 空取值 → 跳过
    ];
    // a) 无条件 → 全部城市去重
    const refAll = { tableId: 'tblCity', fieldId: 'fldCity', conditions: [] };
    const o1 = resolveRefOptions(refAll, records, {});
    check('F14 无条件引用全量去重', o1.join(',') === '杭州,宁波,南京', o1);
    // b) 静态条件：仅浙江省
    const refZhejiang = {
      tableId: 'tblCity', fieldId: 'fldCity',
      conditions: [{ sourceFieldId: 'fldProv', valueSource: 'static', staticValue: '浙江' }],
    };
    const o2 = resolveRefOptions(refZhejiang, records, {});
    check('F14 静态条件过滤（仅浙江）', o2.join(',') === '杭州,宁波', o2);
    // c) 联动条件：源表 fldProv = 当前表单 fldMProv 的值（省-市级联）
    const refCascade = {
      tableId: 'tblCity', fieldId: 'fldCity',
      conditions: [{ sourceFieldId: 'fldProv', valueSource: 'field', formFieldId: 'fldMProv' }],
    };
    const o3 = resolveRefOptions(refCascade, records, { fldMProv: '江苏' });
    check('F14 联动条件按表单值过滤（江苏）', o3.join(',') === '南京', o3);
    const o4 = resolveRefOptions(refCascade, records, { fldMProv: '浙江' });
    check('F14 联动条件随表单值变化（浙江）', o4.join(',') === '杭州,宁波', o4);
    // d) 联动父字段未填 → 无选项（省未选，市为空）
    const o5 = resolveRefOptions(refCascade, records, {});
    check('F14 联动父字段未填时无选项', o5.length === 0, o5);
    // e) hasOptionRef / getOptionRefDependencies
    const fCascade = { fieldId: 'fldMCity', optionRef: refCascade };
    check('F14 hasOptionRef 识别完整配置', hasOptionRef(fCascade) === true);
    check('F14 不完整的 optionRef 不算启用', hasOptionRef({ fieldId: 'x', optionRef: { tableId: '', fieldId: '', conditions: [] } }) === false);
    check('F14 依赖提取返回联动字段', getOptionRefDependencies(fCascade).join(',') === 'fldMProv', getOptionRefDependencies(fCascade));
    check('F14 静态条件不产生依赖', getOptionRefDependencies({ fieldId: 'y', optionRef: refZhejiang }).length === 0);
    // f) 序列化 → 宿主存取 → hydrate：optionRef 完整保留
    const cfg = {
      id: 'form1', version: '1.0.0', formTitle: '引用选项',
      mainTable: {
        tableId: MAIN, tableName: '主表',
        fields: [
          { fieldId: 'fldMProv', fieldName: '省', fieldType: FieldType.SingleSelect, visible: true, required: false, label: '省' },
          { fieldId: 'fldMCity', fieldName: '市', fieldType: FieldType.SingleSelect, visible: true, required: false, label: '市', optionRef: refCascade },
        ],
      },
      subTables: [],
      conditionalRules: [],
    };
    const thin = serializeConfig({ forms: [cfg], defaultFormId: 'form1' });
    const stored = JSON.parse(JSON.stringify(thin));
    check(
      'F14 序列化保留 optionRef',
      JSON.stringify(stored.forms[0].mainTable.fields.find((f) => f.fieldId === 'fldMCity')?.optionRef) === JSON.stringify(refCascade),
      stored.forms[0].mainTable.fields
    );
    const metaBase = {
      getTableById: async () => ({
        getFieldMetaList: async () => [
          { id: 'fldMProv', name: '省', type: FieldType.SingleSelect },
          { id: 'fldMCity', name: '市', type: FieldType.SingleSelect },
        ],
      }),
      getTableMetaList: async () => [{ id: MAIN, name: '主表' }],
    };
    selectBaseForTest({ base: metaBase });
    const hydrated = await hydrateConfig(stored);
    const hf = hydrated.forms[0].mainTable.fields.find((f) => f.fieldId === 'fldMCity');
    check('F14 hydrate 后 optionRef 保留', JSON.stringify(hf?.optionRef) === JSON.stringify(refCascade), hf);
    check('F14 hydrate 后 fieldType 恢复', hf?.fieldType === FieldType.SingleSelect, hf);
  }

  // —— F15：日期联动预填（偏移计算 + 自动填/手动改后不覆盖/清空重填）——
  {
    const plus1y = { sourceFieldId: 'fStart', direction: 'plus', amount: 1, unit: 'year' };

    check('F15 +1 年末日口径（2026-03-01→2027-02-28）', fmt(applyDateOffset(d('2026-03-01'), plus1y)) === '2027-02-28');
    check(
      'F15 用户原例 +1 年（2026-10-21→2027-10-20）',
      fmt(applyDateOffset(d('2026-10-21'), plus1y)) === '2027-10-20'
    );
    check(
      'F15 -1 年末日口径（2026-03-01→2025-02-28）',
      fmt(applyDateOffset(d('2026-03-01'), { ...plus1y, direction: 'minus' })) === '2025-02-28'
    );
    check(
      'F15 +1 个月末日口径（2026-10-21→2026-11-20）',
      fmt(applyDateOffset(d('2026-10-21'), { ...plus1y, amount: 1, unit: 'month' })) === '2026-11-20'
    );
    check(
      'F15 月偏移日溢出取月末且不再减一天（1/31 +1 月→2/28）',
      fmt(applyDateOffset(d('2026-01-31'), { ...plus1y, amount: 1, unit: 'month' })) === '2026-02-28'
    );
    check(
      'F15 闰年 2/29 +1 年→次年 2/28（钳制后不重复减一天）',
      fmt(applyDateOffset(d('2024-02-29'), plus1y)) === '2025-02-28'
    );
    check(
      'F15 偏移量为 0 时原样返回（不减一天）',
      fmt(applyDateOffset(d('2026-03-01'), { ...plus1y, amount: 0 })) === '2026-03-01'
    );
    check(
      'F15 按天偏移不受末日口径影响（+30 天）',
      fmt(applyDateOffset(d('2026-01-01'), { ...plus1y, amount: 30, unit: 'day' })) === '2026-01-31'
    );
    check('F15 来源为空返回 null', applyDateOffset(null, plus1y) === null);
    check('F15 非法来源值返回 null', applyDateOffset(new Date('bad'), plus1y) === null);
    check('F15 未配置 sourceFieldId 返回 null', applyDateOffset(d('2026-01-01'), { ...plus1y, sourceFieldId: '' }) === null);
    check('F15 描述文案', describeOffset(plus1y) === '+1 年' && describeOffset({ ...plus1y, direction: 'minus', amount: 3, unit: 'month' }) === '-3 个月');
    check('F15 isSameInstant 同刻判定', isSameInstant(d('2026-03-01'), new Date('2026-03-01T00:00:00')) === true);
    check('F15 isSameInstant 不同刻判定', isSameInstant(d('2026-03-01'), d('2026-03-02')) === false);
    check('F15 toDateOrNull 支持时间戳', fmt(toDateOrNull(d('2026-05-06').getTime())) === '2026-05-06');

    // 组件语义：自动预填 / 手动改后不覆盖 / 清空重填 / 来源清空清值
    const fields = [
      { fieldId: 'fStart', fieldName: '合同起始日', fieldType: FieldType.DateTime, visible: true, required: false },
      {
        fieldId: 'fEnd', fieldName: '合同到期日', fieldType: FieldType.DateTime, visible: true, required: false,
        dateAutoFill: plus1y,
      },
    ];
    const manual = new Set();
    const auto = new Set();
    const keyOf = (fid) => `main:${fid}`;

    const v0 = { fStart: d('2026-03-01') };
    const n1 = applyAutoFill(fields, v0, manual, auto, keyOf);
    check('F15 来源有值时自动预填', n1 && fmt(n1.fEnd) === '2027-02-28', n1 && fmt(n1.fEnd));
    check('F15 预填后标记为自动值', auto.has('main:fEnd'));
    check('F15 值已正确时不重复写入', applyAutoFill(fields, n1, manual, auto, keyOf) === null);

    const v2 = { ...n1, fStart: d('2027-05-06') };
    const n2 = applyAutoFill(fields, v2, manual, auto, keyOf);
    check('F15 未手动改过时来源变化会重算', n2 && fmt(n2.fEnd) === '2028-05-05', n2 && fmt(n2.fEnd));

    const userEdited = { ...n2, fEnd: d('2027-12-31') };
    markManualEdits(fields, n2, userEdited, manual, auto, keyOf);
    check('F15 用户手动改后进入 manual', manual.has('main:fEnd'));
    const v3 = { ...userEdited, fStart: d('2029-01-01') };
    check(
      'F15 手动改过后不再被覆盖',
      applyAutoFill(fields, v3, manual, auto, keyOf) === null && fmt(v3.fEnd) === '2027-12-31',
      fmt(v3.fEnd)
    );

    const cleared = { ...v3, fEnd: undefined };
    markManualEdits(fields, v3, cleared, manual, auto, keyOf);
    check('F15 清空目标字段撤销手动标记', !manual.has('main:fEnd'));
    const n4 = applyAutoFill(fields, cleared, manual, auto, keyOf);
    check('F15 清空后重新自动预填', n4 && fmt(n4.fEnd) === '2029-12-31', n4 && fmt(n4.fEnd));

    const noSrc = { ...n4, fStart: undefined };
    const n5 = applyAutoFill(fields, noSrc, manual, auto, keyOf);
    check('F15 来源清空后清掉自动值', n5 && n5.fEnd === undefined, n5 && fmt(n5.fEnd));
  }

  // —— F21：日期联动「环检测 + 有界收敛」（防受控控件频闪）——
  {
    const y = (src, dir, amt, unit = 'year') => ({
      sourceFieldId: src, direction: dir, amount: amt, unit,
    });
    const dtf = (id, af) => ({
      fieldId: id, fieldName: id, fieldType: FieldType.DateTime, visible: true, required: false,
      ...(af ? { dateAutoFill: af } : {}),
    });
    const keyOf = (fid) => `main:${fid}`;

    // 1) 自引用 → 识别为环
    const selfCycle = findAutoFillCycles([dtf('X', y('X', 'plus', 1))]);
    check('F21 自引用被识别为环', selfCycle.has('X'), [...selfCycle]);

    // 2) 互引用 → 双方都在环上
    const mutual = findAutoFillCycles([dtf('A', y('B', 'plus', 1)), dtf('B', y('A', 'plus', 1))]);
    check('F21 互引用双方都在环上', mutual.has('A') && mutual.has('B'), [...mutual]);

    // 3) 三元环 A→B→C→A（来源链）
    const tri = findAutoFillCycles([
      dtf('A', y('C', 'plus', 1, 'month')),
      dtf('B', y('A', 'plus', 1, 'month')),
      dtf('C', y('B', 'plus', 1, 'month')),
    ]);
    check('F21 三元环全部识别', tri.has('A') && tri.has('B') && tri.has('C'), [...tri]);

    // 4) 无环长链不应误报
    const chain = findAutoFillCycles([
      dtf('A'), dtf('B', y('A', 'plus', 1)), dtf('C', y('B', 'plus', 1)), dtf('D', y('C', 'plus', 1)),
    ]);
    check('F21 无环长链不误报', chain.size === 0, [...chain]);

    // 5) 环下游被连带排除（A↔B 成环，C 依赖 A）
    const downstream = findAutoFillCycles([
      dtf('A', y('B', 'plus', 1)), dtf('B', y('A', 'plus', 1)), dtf('C', y('A', 'plus', 1)),
    ]);
    check('F21 环的下游一并排除', downstream.has('A') && downstream.has('B') && downstream.has('C'), [...downstream]);

    // 6) 发散环上字段不再被写入（否则每帧 setState → 频闪）
    const divFields = [dtf('A', y('B', 'plus', 1)), dtf('B', y('A', 'plus', 1))];
    const divAuto = new Set();
    check(
      'F21 发散环不产生任何写回',
      applyAutoFill(divFields, { A: new Date('2026-03-01T00:00:00') }, new Set(), divAuto, keyOf) === null
        && divAuto.size === 0
    );

    // 7) resolveAutoFill：长链一次求解到收敛，只返回一次结果
    const chainFields = [
      dtf('A'), dtf('B', y('A', 'plus', 1)), dtf('C', y('B', 'plus', 1)),
      dtf('D', y('C', 'plus', 1)), dtf('E', y('D', 'plus', 1)),
    ];
    const chainAuto = new Set();
    const r1 = resolveAutoFill(
      chainFields, { A: new Date('2026-03-01T00:00:00') }, new Set(), chainAuto, keyOf
    );
    check(
      'F21 长链一次收敛到最终值（末日口径，逐环 -1 天）',
      r1 && fmt(r1.B) === '2027-02-28' && fmt(r1.C) === '2028-02-27'
        && fmt(r1.D) === '2029-02-26' && fmt(r1.E) === '2030-02-25',
      r1 && [fmt(r1.B), fmt(r1.C), fmt(r1.D), fmt(r1.E)]
    );
    check('F21 收敛后再求解返回 null（不重复写回）', resolveAutoFill(chainFields, r1, new Set(), chainAuto, keyOf) === null);

    // 8) 发散环经 resolveAutoFill 也不会无限迭代（熔断上限）
    const rDiv = resolveAutoFill(
      divFields, { A: new Date('2026-03-01T00:00:00') }, new Set(), new Set(), keyOf
    );
    check('F21 发散环被环检测挡住（resolve 返回 null）', rDiv === null);

    // 9) 配置侧预防：wouldCreateAutoFillCycle
    const cfgFields = [dtf('A', y('B', 'plus', 1)), dtf('B')];
    check('F21 配置侧：A←B 已存在时 B 选 A 成环', wouldCreateAutoFillCycle(cfgFields, 'B', 'A') === true);
    check('F21 配置侧：自选自身成环', wouldCreateAutoFillCycle([dtf('A'), dtf('B')], 'B', 'B') === true);
    check('F21 配置侧：无环选择放行', wouldCreateAutoFillCycle([dtf('A'), dtf('B')], 'B', 'A') === false);
    check('F21 配置侧：长链末端放行', wouldCreateAutoFillCycle(
      [dtf('A'), dtf('B', y('A', 'plus', 1)), dtf('C', y('B', 'plus', 1)), dtf('D')], 'D', 'C'
    ) === false);
  }

  // —— F16：唯一性校验（提交时查重：表内已有值 + 本次多行互查 + 权限失败不静默放行）——
  {
    const NO_PERM = 'tblNoPerm';
    // 分页 mock：第 1 页 2 条 + hasMore，第 2 页 2 条（含跨页重复值）
    const page1 = [{ fields: { fldM1: '已存在A' } }, { fields: { fldM1: '已存在B' } }];
    const page2 = [{ fields: { fldM1: '跨页值C' } }, { fields: { fldM1: '已存在A' } }];
    let readCalls = 0; // 全量分页调用次数
    let filterCalls = 0; // 服务端过滤调用次数
    const allRows = [...page1, ...page2];

    /**
     * 构造测试用 base：
     * - supportFilter=true：getRecords 支持 filter（模拟服务端过滤可用，主路径）
     * - supportFilter=false：filter 直接抛错 / 返回无关记录（模拟旧宿主，需回退整列分页）
     */
    const makeDupBase = ({ supportFilter = true, total } = {}) => ({
      getTableById: async (id) => {
        if (id === NO_PERM) throw new Error('permission denied: no access to this table');
        return {
          // 整列取值（兜底路径首选）：第 1 页 2 条 + hasMore，第 2 页 2 条
          getField: async (fid) => ({
            getFieldValueListByPage: async ({ pageToken } = {}) => {
              readCalls += 1;
              const rows = pageToken === undefined ? page1 : page2;
              return {
                fieldValues: rows.map((r, i) => ({ recordId: `r${i}`, value: r.fields[fid] })),
                hasMore: pageToken === undefined,
                pageToken: pageToken === undefined ? 1 : undefined,
                total: total ?? allRows.length,
              };
            },
          }),
          getRecords: async (params = {}) => {
            if (params.filter) {
              filterCalls += 1;
              if (!supportFilter) {
                // 模拟过滤未生效：返回与本值无关的记录（应被自证逻辑识别并回退全量）
                return { records: page1, hasMore: false, total: allRows.length };
              }
              const c = (params.filter.conditions ?? [])[0];
              const target = String(c?.value ?? '').trim().toLowerCase();
              const hits = allRows.filter(
                (r) => String(r.fields[c.fieldId] ?? '').trim().toLowerCase() === target
              );
              return { records: hits, hasMore: false, total: hits.length };
            }
            readCalls += 1;
            if (id === MAIN) {
              if (!params.pageToken) {
                return { records: page1, hasMore: true, pageToken: 'tok2', total: total ?? allRows.length };
              }
              return { records: page2, hasMore: false, total: total ?? allRows.length };
            }
            return { records: [], hasMore: false };
          },
        };
      },
      getTableMetaList: async () => [{ id: MAIN, name: '主表' }],
    });

    selectBaseForTest({ base: makeDupBase() });
    // 唯一性校验现在有模块级缓存，测试之间必须显式清空，否则会命中上一个用例的缓存
    invalidateExistingCache();

    const emptyCond = {
      hiddenFields: {}, forcedRequired: {}, forcedUnrequired: {},
      rowHiddenFields: {}, rowForcedRequired: {}, rowForcedUnrequired: {},
    };
    const cfgDup = {
      id: 'f1', version: '1.0.0', formTitle: '查重',
      mainTable: {
        tableId: MAIN, tableName: '主表',
        fields: [
          { fieldId: 'fldM1', fieldName: '合同号', fieldType: FieldType.Text, visible: true, required: false, unique: { enabled: true } },
          { fieldId: 'fldM2', fieldName: '备注', fieldType: FieldType.Text, visible: true, required: false },
        ],
      },
      subTables: [
        {
          tableId: SUB1, tableName: '子表1', linkFieldId: 'fldLink1',
          fields: [
            { fieldId: 'fldS1', fieldName: '子编号', fieldType: FieldType.Text, visible: true, required: false, unique: { enabled: true } },
          ],
          allowMultiple: true,
        },
      ],
      conditionalRules: [],
    };

    const r1 = await checkDuplicates(cfgDup, { fldM1: '已存在A' }, { [SUB1]: [{}] }, emptyCond);
    check('F16 与表内已有数据重复被拦截', r1.errors.length === 1 && r1.errors[0].fieldId === 'fldM1', r1.errors);

    const r2 = await checkDuplicates(cfgDup, { fldM1: '  已存在a  ' }, { [SUB1]: [{}] }, emptyCond);
    check('F16 忽略大小写与首尾空格后仍判重', r2.errors.length === 1, r2.errors);

    const r3 = await checkDuplicates(cfgDup, { fldM1: 'NEW-001' }, { [SUB1]: [{}] }, emptyCond);
    check('F16 未重复的值放行', r3.errors.length === 0 && r3.failures.length === 0, r3);

    const r4 = await checkDuplicates(cfgDup, { fldM2: '已存在A' }, { [SUB1]: [{}] }, emptyCond);
    check('F16 未开启查重的字段不校验', r4.errors.length === 0, r4.errors);

    const r5 = await checkDuplicates(
      cfgDup,
      { fldM1: 'NEW-002' },
      { [SUB1]: [{ fldS1: 'X-1' }, { fldS1: 'X-1' }, { fldS1: 'X-2' }] },
      emptyCond
    );
    check(
      'F16 子表本次提交多行互查（第 2 行报重复）',
      r5.errors.length === 1 && r5.errors[0].rowIndex === 1 && /第 1 条/.test(r5.errors[0].message),
      r5.errors
    );

    const cfgNoPerm = { ...cfgDup, mainTable: { ...cfgDup.mainTable, tableId: NO_PERM } };
    const r6 = await checkDuplicates(cfgNoPerm, { fldM1: 'ANY' }, { [SUB1]: [{}] }, emptyCond);
    check('F16 读取已有数据失败时不静默放行', r6.failures.length === 1 && r6.errors.length === 0, r6);
    check(
      'F16 失败原因带权限分类提示',
      /权限/.test(r6.failures[0]?.reason ?? ''),
      r6.failures[0]?.reason
    );

    check('F16 归一化：去空格转小写', normalizeForCompare('  ABC ') === 'abc');
    check('F16 归一化：数字', normalizeForCompare(123) === '123');
    check('F16 归一化：取对象 text', normalizeForCompare({ text: ' Hello ' }) === 'hello');

    // —— 失焦实时校验（checkOneValue）：服务端过滤优先 + 整列分页兜底 + 缓存复用 + 提交后并入 ——
    invalidateExistingCache();
    readCalls = 0;
    filterCalls = 0;

    const c1 = await checkOneValue(MAIN, 'fldM1', '跨页值C', undefined, FieldType.Text);
    check('F16 失焦校验命中跨页数据（第 2 页的值）', c1.status === 'dup', c1);
    check('F16 走服务端过滤：只 1 次请求、未全量翻页', filterCalls === 1 && readCalls === 0, {
      filterCalls,
      readCalls,
    });

    const c2 = await checkOneValue(MAIN, 'fldM1', '已存在B', undefined, FieldType.Text);
    check('F16 失焦校验命中已有值', c2.status === 'dup', c2);

    const c3 = await checkOneValue(MAIN, 'fldM1', 'BRAND-NEW', undefined, FieldType.Text);
    check('F16 新值提示可用', c3.status === 'ok' && c3.message === '可用', c3);

    const before = filterCalls;
    await checkOneValue(MAIN, 'fldM1', 'BRAND-NEW', undefined, FieldType.Text);
    check('F16 同一值复用过滤结果缓存，不重复请求', filterCalls === before, filterCalls);

    // ★ 关键回归：过滤不可用（旧宿主 / 返回无关记录）→ 必须回退整列分页全量，且真的翻满 2 页
    invalidateExistingCache();
    selectBaseForTest({ base: makeDupBase({ supportFilter: false }) });
    readCalls = 0;
    const cFallback = await checkOneValue(MAIN, 'fldM1', '跨页值C', undefined, FieldType.Text);
    check('F16 过滤不可用时回退全量并命中跨页值', cFallback.status === 'dup', cFallback);
    check('F16 回退时整列分页确实翻了 2 页', readCalls === 2, readCalls);

    // ★ 关键回归：超大表（超过预加载阈值）不再全量预拉，但判重依然准确（走服务端过滤）
    invalidateExistingCache();
    selectBaseForTest({ base: makeDupBase({ total: 200000 }) });
    readCalls = 0;
    const bigSet = await loadAllExistingValues(MAIN, 'fldM1', '合同号', { totalLimit: 3 });
    check('F16 超大表跳过全量预拉（标记 skipped）', bigSet.ok && bigSet.skipped === true, bigSet);
    check('F16 超大表探测到总数后只发 1 次请求即中止（不再逐页扫完）', readCalls === 1, readCalls);
    const cBig = await checkOneValue(MAIN, 'fldM1', '跨页值C', undefined, FieldType.Text);
    check('F16 超大表判重依然准确（服务端过滤）', cBig.status === 'dup', cBig);

    // 回到正常 base 继续后续用例
    invalidateExistingCache();
    selectBaseForTest({ base: makeDupBase() });
    readCalls = 0;

    const c4 = await checkOneValue(MAIN, 'fldM1', '');
    check('F16 空值不提示也不判重', c4.status === 'ok' && c4.message === '', c4);

    const c5 = await checkOneValue(NO_PERM, 'fldM1', 'ANY');
    check('F16 无权限时返回 error 且不静默放行', c5.status === 'error' && /权限/.test(c5.detail ?? ''), c5);

    // 提交成功后把新值并入全量缓存 → 过滤不可用时，同一会话再填相同值仍判重
    invalidateExistingCache();
    selectBaseForTest({ base: makeDupBase({ supportFilter: false }) });
    readCalls = 0;
    const cPre = await checkOneValue(MAIN, 'fldM1', 'BRAND-NEW', undefined, FieldType.Text);
    check('F16 提交前新值判定可用', cPre.status === 'ok', cPre);
    noteSubmittedValues(MAIN, 'fldM1', ['BRAND-NEW']);
    const c6 = await checkOneValue(MAIN, 'fldM1', 'BRAND-NEW', undefined, FieldType.Text);
    check('F16 提交后并入缓存：相同值再填即判重', c6.status === 'dup', c6);
    check('F16 并入后不再重新翻表', readCalls === 2, readCalls);

    // 服务端过滤路径：记录真正写进表后，过滤应能查到（模拟提交落库后的下一次填写）
    invalidateExistingCache();
    selectBaseForTest({ base: makeDupBase() });
    allRows.push({ fields: { fldM1: 'BRAND-NEW' } });
    const c7 = await checkOneValue(MAIN, 'fldM1', 'BRAND-NEW', undefined, FieldType.Text);
    check('F16 服务端过滤能发现表内新增的同名记录', c7.status === 'dup', c7);
    allRows.pop();

    // 缓存失效后重新全量拉取
    invalidateExistingCache(MAIN, 'fldM1');
    readCalls = 0;
    await loadAllExistingValues(MAIN, 'fldM1');
    check('F16 失效缓存后重新分页全量拉取', readCalls === 2, readCalls);

    const set = await loadAllExistingValues(MAIN, 'fldM1');
    check('F16 全量结果带扫描条数与去重值', set.scanned === 4 && set.values.size === 3, {
      scanned: set.scanned,
      size: set.values.size,
    });
  }

  // —— F17：新配置的持久化往返 + 权限错误分类（发布后功能不失效的防线）——
  {
    const dateFill = { sourceFieldId: 'fldStart', direction: 'plus', amount: 1, unit: 'year' };
    const cfg = {
      id: 'form1', version: '1.0.0', formTitle: '新功能持久化',
      mainTable: {
        tableId: MAIN, tableName: '主表',
        fields: [
          { fieldId: 'fldM1', fieldName: '合同号', fieldType: FieldType.Text, visible: true, required: true, unique: { enabled: true } },
          { fieldId: 'fldStart', fieldName: '起始日', fieldType: FieldType.DateTime, visible: true, required: false },
          { fieldId: 'fldEnd', fieldName: '到期日', fieldType: FieldType.DateTime, visible: true, required: false, dateAutoFill: dateFill },
        ],
      },
      subTables: [],
      conditionalRules: [],
    };
    const thin = serializeConfig({ forms: [cfg], defaultFormId: 'form1' });
    const stored = JSON.parse(JSON.stringify(thin));
    const f1 = stored.forms[0].mainTable.fields.find((f) => f.fieldId === 'fldM1');
    const f3 = stored.forms[0].mainTable.fields.find((f) => f.fieldId === 'fldEnd');
    check('F17 序列化保留 unique（否则发布后配置静默丢失）', JSON.stringify(f1?.unique) === JSON.stringify({ enabled: true }), f1);
    check('F17 序列化保留 dateAutoFill', JSON.stringify(f3?.dateAutoFill) === JSON.stringify(dateFill), f3);

    const metaBase = {
      getTableById: async () => ({
        getFieldMetaList: async () => [
          { id: 'fldM1', name: '合同号', type: FieldType.Text },
          { id: 'fldStart', name: '起始日', type: FieldType.DateTime },
          { id: 'fldEnd', name: '到期日', type: FieldType.DateTime },
        ],
      }),
      getTableMetaList: async () => [{ id: MAIN, name: '主表' }],
    };
    selectBaseForTest({ base: metaBase });
    const hydrated = await hydrateConfig(stored);
    const h1 = hydrated.forms[0].mainTable.fields.find((f) => f.fieldId === 'fldM1');
    const h3 = hydrated.forms[0].mainTable.fields.find((f) => f.fieldId === 'fldEnd');
    check('F17 hydrate 后 unique 保留', h1?.unique?.enabled === true, h1);
    check('F17 hydrate 后 dateAutoFill 保留', JSON.stringify(h3?.dateAutoFill) === JSON.stringify(dateFill), h3);
    check('F17 hydrate 后日期字段类型恢复', h3?.fieldType === FieldType.DateTime, h3);

    const ePerm = classifySdkError(new Error('permission denied'), '源数据表');
    check('F17 权限错误分类', ePerm.kind === 'permission' && /权限/.test(ePerm.title), ePerm);
    const eMissing = classifySdkError(new Error('table not found'), '源数据表');
    check('F17 目标不存在分类', eMissing.kind === 'notfound', eMissing);
    const eOther = classifySdkError(new Error('network timeout'), '源数据表');
    check('F17 未知错误兜底', eOther.kind === 'unknown', eOther);
    const eZh = classifySdkError(new Error('没有权限访问该数据表'), '源数据表');
    check('F17 中文权限错误也能识别', eZh.kind === 'permission', eZh);
  }

  // —— F18：表记录加载服务（展开只取最新 200 / 搜索才逐页翻 / 缓存 / 自证）——
  {
    const BIG = 'tblBig';
    const COL = 'fldName';
    let headCalls = 0;
    let filterCalls = 0;

    // 造 450 条（3 页：200/200/50），深处有一条「隐藏在深处的客户D」（第 434 条）
    const ALL = Array.from({ length: 450 }, (_, i) => `客户${i + 1}`);
    ALL[433] = '隐藏在深处的客户D';
    const recOf = (start, slice) =>
      slice.map((t, i) => ({ recordId: `rec${start + i}`, fields: { [COL]: t } }));

    const bigBase = {
      getTableById: async (id) => {
        if (id !== BIG) {
          return {
            getField: async () => null,
            getRecords: async () => ({ records: [], hasMore: false }),
            getRecordsByPage: async () => ({ records: [], hasMore: false }),
            getFieldMetaList: async () => [],
          };
        }
        return {
          getFieldMetaList: async () => [{ id: 'fldMod', name: '更新时间', type: 1002, isPrimary: false }],
          getRecordsByPage: async ({ filter, pageToken, pageSize }) => {
            if (filter) {
              // 服务端 contains 过滤：逐页返回命中
              filterCalls += 1;
              const kw = String(filter.conditions?.[0]?.value ?? '');
              const hits = ALL.filter((t) => t.includes(kw));
              const start = pageToken === undefined ? 0 : Number(pageToken);
              const slice = hits.slice(start, start + (pageSize || 200));
              const nextStart = start + (pageSize || 200);
              const hasMore = nextStart < hits.length;
              return {
                records: slice.map((t) => ({ recordId: `hit:${t}`, fields: { [COL]: t } })),
                hasMore,
                pageToken: hasMore ? String(nextStart) : undefined,
                total: hits.length,
              };
            }
            // 无过滤：首屏最新 200（这里按数组前 200 模拟）
            headCalls += 1;
            const slice = ALL.slice(0, pageSize || 200);
            const hasMore = (pageSize || 200) < ALL.length;
            return {
              records: recOf(0, slice),
              hasMore,
              pageToken: hasMore ? String(pageSize || 200) : undefined,
              total: ALL.length,
            };
          },
        };
      },
      getTableMetaList: async () => [{ id: BIG, name: '大表' }],
    };
    selectBaseForTest({ base: bigBase });
    invalidateTableRecords();

    // 1) 首屏：只发 1 次请求、只拿 200 条（不再是全量翻页）
    const headTask = loadHeadColumn(BIG, COL, { label: '客户名' });
    check('F18 任务键按「列」维度生成', headTask.key === taskKey(BIG, 'col', COL), headTask.key);
    const head = await headTask.promise;
    check('F18 展开只取最新 200 条', head.rows.length === 200, head.rows.length);
    check('F18 首屏只发 1 次请求（不再全量翻页）', headCalls === 1, headCalls);
    check('F18 首屏带回总数与 hasMore', head.total === 450 && head.hasMore === true, {
      total: head.total,
      hasMore: head.hasMore,
    });

    // 2) 缓存复用：再次取首屏零请求
    const before = headCalls;
    const cachedHead = getHeadCache(taskKey(BIG, 'col', COL));
    check('F18 首屏缓存命中：零请求', headCalls === before && cachedHead?.rows.length === 200, {
      headCalls,
      len: cachedHead?.rows.length,
    });
    await loadHeadColumn(BIG, COL).promise;
    check('F18 重复调用复用同一任务', headCalls === before, headCalls);

    // 3) 失效后重新加载
    invalidateTableRecords(BIG);
    headCalls = 0;
    await loadHeadColumn(BIG, COL).promise;
    check('F18 缓存失效后重新加载首屏', headCalls === 1, headCalls);

    // 4) 搜索：逐页翻，命中深处的记录，且耗时与表大小无关（服务端过滤）
    filterCalls = 0;
    const hits = [];
    let scanned = 0;
    const sh = searchAllPages(BIG, COL, '客户D', {
      onHits: (rows) => hits.push(...rows),
      onProgress: (s) => { scanned = s; },
    });
    await sh.done;
    check('F18 搜索命中深处的记录（首屏 200 条之外）', hits.some((h) => h.text === '隐藏在深处的客户D'), hits.length);
    check('F18 搜索走了服务端过滤', filterCalls >= 1, filterCalls);
    check('F18 搜索"命中即止"：未把全表当命中刷完', hits.length < 450, hits.length);

    // 5) 搜索可取消
    const sh2 = searchAllPages(BIG, COL, '客户', { onHits: () => {} });
    sh2.cancel();
    await sh2.done;
    check('F18 搜索可取消（不抛错）', true);

    // 6) 自证：宿主忽略 filter（返回不含关键字的记录）→ 停止、不返回伪命中
    invalidateTableRecords();
    selectBaseForTest({
      base: {
        getTableById: async () => ({
          getFieldMetaList: async () => [],
          getRecordsByPage: async () => ({
            records: [{ recordId: 'x', fields: { [COL]: '完全无关的值' } }],
            hasMore: false,
          }),
        }),
        getTableMetaList: async () => [{ id: BIG }],
      },
    });
    const bogus = [];
    await searchAllPages(BIG, COL, '客户D', { onHits: (r) => bogus.push(...r) }).done;
    check('F18 过滤未生效时不返回伪命中（防误判）', bogus.length === 0, bogus.length);

    // 7) 整行搜索（引用选项用）：命中即并入
    invalidateTableRecords();
    selectBaseForTest({ base: bigBase });
    const rowHits = [];
    await searchAllRows(BIG, COL, '隐藏在深处', { onHits: (r) => rowHits.push(...r) }).done;
    check('F18 整行搜索命中引用选项源记录', rowHits.some((r) => r.fields[COL] === '隐藏在深处的客户D'), rowHits.length);

    // 8) 首屏整行（引用选项展开用）：只 1 次请求
    invalidateTableRecords();
    headCalls = 0;
    const headRows = await loadHeadRows(BIG, { label: '大表' }).promise;
    check('F18 引用选项首屏只取 200 条', headRows.rows.length === 200, headRows.rows.length);
    check('F18 引用选项首屏只发 1 次请求', headCalls === 1, headCalls);

    // 9) 条件加载（引用选项联动用）：服务端精确过滤，取回「该父级下的全部」
    {
      const CITY = 'fldCity';
      const PROV = 'fldProv';
      // 造 1 万行城市表：浙江省 3000 行（远超首屏 200），江苏省 7000 行
      const provRows = [
        ...Array.from({ length: 3000 }, (_, i) => ({ [PROV]: '浙江省', [CITY]: `浙城市${i + 1}` })),
        ...Array.from({ length: 7000 }, (_, i) => ({ [PROV]: '江苏省', [CITY]: `苏城市${i + 1}` })),
      ];
      let condFilterCalls = 0;
      const condBase = {
        getTableById: async () => ({
          getFieldMetaList: async () => [],
          getRecordsByPage: async ({ filter, pageToken, pageSize }) => {
            const conds = filter?.conditions ?? [];
            condFilterCalls += 1;
            const hits = provRows.filter((r) => conds.every((c) => String(r[c.fieldId] ?? '') === String(c.value)));
            const start = pageToken === undefined ? 0 : Number(pageToken);
            const ps = pageSize || 200;
            const slice = hits.slice(start, start + ps);
            const nextStart = start + ps;
            const hasMore = nextStart < hits.length;
            return {
              records: slice.map((f, i) => ({ recordId: `c${start + i}`, fields: f })),
              hasMore,
              pageToken: hasMore ? String(nextStart) : undefined,
            };
          },
        }),
        getTableMetaList: async () => [{ id: 'tblCity' }],
      };
      selectBaseForTest({ base: condBase });
      invalidateTableRecords();

      const got = [];
      const condHits = await loadRowsByConditions('tblCity', [{ fieldId: PROV, text: '浙江省' }]).promise;
      check('F18 条件加载取回该父级下全部记录（突破首屏 200 限制）', condHits.rows.length === 3000, condHits.rows.length);
      check('F18 条件加载走服务端过滤', condFilterCalls > 0, condFilterCalls);
      check('F18 条件加载自证通过（filterEffective）', condHits.filterEffective === true, condHits.filterEffective);
      check(
        'F18 条件加载结果全部满足条件（无串档）',
        condHits.rows.every((r) => r.fields[PROV] === '浙江省'),
        condHits.rows.slice(0, 3)
      );

      // 缓存复用：相同条件再取零请求
      const callsBefore = condFilterCalls;
      await loadRowsByConditions('tblCity', [{ fieldId: PROV, text: '浙江省' }]).promise;
      check('F18 相同条件命中缓存：零请求', condFilterCalls === callsBefore, condFilterCalls);

      // 含 = / & 的文本不应破坏条件（此前用字符串拼接 key 会解析错位）
      const weird = await loadRowsByConditions('tblCity', [{ fieldId: PROV, text: '浙=江&省' }]).promise;
      check('F18 条件文本含 = / & 时仍安全（无匹配返回空）', weird.rows.length === 0, weird.rows.length);

      // 过滤未生效（宿主忽略 filter 返回无关记录）→ filterEffective=false，调用方可回退
      const bogusBase = {
        getTableById: async () => ({
          getFieldMetaList: async () => [],
          getRecordsByPage: async () => ({
            records: [{ recordId: 'z', fields: { [PROV]: '广东省', [CITY]: '粤城市1' } }],
            hasMore: false,
          }),
        }),
        getTableMetaList: async () => [{ id: 'tblCity' }],
      };
      selectBaseForTest({ base: bogusBase });
      invalidateTableRecords();
      const ignored = await loadRowsByConditions('tblCity', [{ fieldId: PROV, text: '浙江省' }]).promise;
      check('F18 条件过滤被宿主忽略时标记 filterEffective=false', ignored.filterEffective === false, {
        n: ignored.rows.length,
        eff: ignored.filterEffective,
      });

      // 搜索叠加联动条件：命中必须同时满足关键字与父级条件（不串档）
      selectBaseForTest({ base: condBase });
      invalidateTableRecords();
      const bothHits = [];
      await searchAllRows('tblCity', CITY, '浙城市1', {
        extraConditions: [{ fieldId: PROV, text: '浙江省' }],
        onHits: (rs) => bothHits.push(...rs),
      }).done;
      check('F18 搜索叠加联动条件：命中均满足父级条件', bothHits.length > 0 && bothHits.every((r) => r.fields[PROV] === '浙江省'), bothHits.length);

      const wrongProv = [];
      await searchAllRows('tblCity', CITY, '浙城市1', {
        extraConditions: [{ fieldId: PROV, text: '江苏省' }],
        onHits: (rs) => wrongProv.push(...rs),
      }).done;
      check('F18 搜索叠加不匹配的父级条件：零命中（不串档）', wrongProv.length === 0, wrongProv.length);
    }

    // 10) sort 不被宿主支持时自动降级（否则首屏会整个失败变空）
    {
      let attempts = 0;
      const noSortBase = {
        getTableById: async () => ({
          getFieldMetaList: async () => [{ id: 'fldMod', name: '更新时间', type: 1002 }],
          getRecordsByPage: async (p) => {
            attempts += 1;
            if (p && p.sort) throw new Error('unsupported param: sort');
            return {
              records: [{ recordId: 'r1', fields: { [COL]: '降级后的客户' } }],
              hasMore: false,
              total: 1,
            };
          },
        }),
        getTableMetaList: async () => [{ id: BIG }],
      };
      selectBaseForTest({ base: noSortBase });
      invalidateTableRecords();
      const degraded = await loadHeadColumn(BIG, COL, { label: '客户名' }).promise;
      check(
        'F18 sort 不被支持时自动降级且仍有数据',
        attempts >= 2 && degraded.rows.length === 1 && !degraded.error,
        { attempts, n: degraded.rows.length, err: degraded.error }
      );
    }
  }

  // —— F20：级联选项「假空」修复 ——
  // 线上症状：源表条件字段是「单选」，按联动条件取数返回 0 条，
  // 表单下拉永远空白（灰字「已按联动条件取回全部 0 条源记录」）。
  // 根因：单选 is 条件未带 fieldType / 宿主对条件支持不完整 → 稳定 0 条，且旧逻辑直接判空。
  // 本轮修复：① 条件带字段类型；② 0 条时用宽松条件复核；③ 仍为 0 才认「真无」。
  {
    const CITY = 'fldCity';
    const PROV = 'fldProv';
    // 字典表：浙江省 2 行、江苏省 1 行；条件字段 PROV 是「单选」(FieldType.SingleSelect = 3)
    const dictRows = [
      { recordId: 'r1', fields: { [PROV]: '浙江省', [CITY]: '杭州' } },
      { recordId: 'r2', fields: { [PROV]: '浙江省', [CITY]: '宁波' } },
      { recordId: 'r3', fields: { [PROV]: '江苏省', [CITY]: '南京' } },
    ];

    // 1) 条件带 fieldType：filter 条件里必须出现 fieldType
    {
      let seenFilter = null;
      const base = {
        getTableById: async () => ({
          getFieldMetaList: async () => [],
          getRecordsByPage: async ({ filter }) => {
            seenFilter = filter;
            const conds = filter?.conditions ?? [];
            const hits = dictRows.filter((r) =>
              conds.every((c) => String((r.fields ?? {})[c.fieldId] ?? '') === String(c.value))
            );
            return { records: hits, hasMore: false };
          },
        }),
        getTableMetaList: async () => [{ id: 'tblCity' }],
      };
      selectBaseForTest({ base });
      invalidateTableRecords();
      const res = await loadRowsByConditions('tblCity', [
        { fieldId: PROV, text: '浙江省', fieldType: FieldType.SingleSelect },
      ]).promise;
      check(
        'F20 单选条件带 fieldType 下发（服务端才能正确解析）',
        !!seenFilter && seenFilter.conditions?.[0]?.fieldType === FieldType.SingleSelect,
        seenFilter?.conditions?.[0]
      );
      check('F20 带类型条件正常取回该父级记录', res.rows.length === 2 && res.filterEffective === true, {
        n: res.rows.length,
        eff: res.filterEffective,
      });
    }

    // 2) 多选字段的「等于」语义必须用 contains（is 不会命中含多个选项的单元格）
    {
      let seenOps = [];
      const base = {
        getTableById: async () => ({
          getFieldMetaList: async () => [],
          getRecordsByPage: async ({ filter }) => {
            seenOps = (filter?.conditions ?? []).map((c) => c.operator);
            return { records: [], hasMore: false };
          },
        }),
        getTableMetaList: async () => [{ id: 'tblCity' }],
      };
      selectBaseForTest({ base });
      invalidateTableRecords();
      await loadRowsByConditions('tblCity', [
        { fieldId: 'fldTags', text: '重点', fieldType: FieldType.MultiSelect },
      ]).promise;
      check('F20 多选条件使用 contains 语义', seenOps[0] === 'contains', seenOps);
    }

    // 3) ★核心回归：精确条件返回 0 条（宿主误解析=假空），宽松条件能命中 → 采用复核结果，不判空
    {
      const base = {
        getTableById: async () => ({
          getFieldMetaList: async () => ([]),
          getRecordsByPage: async ({ filter }) => {
            const conds = filter?.conditions ?? [];
            const c = conds[0] ?? {};
            // 模拟宿主缺陷：只要带 fieldType 的 is 条件就返回空（假空）
            if (c.operator === 'is' && typeof c.fieldType === 'number') {
              return { records: [], hasMore: false };
            }
            // 宽松条件（contains，无 fieldType）能正常命中
            const hits = dictRows.filter((r) => {
              const v = String((r.fields ?? {})[c.fieldId] ?? '');
              return c.operator === 'contains' ? v.includes(String(c.value)) : v === String(c.value);
            });
            return { records: hits, hasMore: false };
          },
        }),
        getTableMetaList: async () => [{ id: 'tblCity' }],
      };
      selectBaseForTest({ base });
      invalidateTableRecords();
      const res = await loadRowsByConditions('tblCity', [
        { fieldId: PROV, text: '浙江省', fieldType: FieldType.SingleSelect },
      ]).promise;
      check(
        'F20 假空场景：精确条件 0 条时用宽松条件复核并命中（不再直接判空）',
        res.rows.length === 2 && res.filterEffective === true,
        { n: res.rows.length, eff: res.filterEffective }
      );
      const opts = resolveRefOptions(
        { tableId: 'tblCity', fieldId: CITY, conditions: [
          { sourceFieldId: PROV, sourceFieldType: FieldType.SingleSelect, valueSource: 'static', staticValue: '浙江省' },
        ] },
        res.rows,
        {}
      );
      check('F20 复核结果经本地筛后能产出子级选项', opts.join(',') === '杭州,宁波', opts);
    }

    // 4) 真无：精确与宽松条件都 0 条 → 才认「该条件下确实无记录」
    {
      const base = {
        getTableById: async () => ({
          getFieldMetaList: async () => [],
          getRecordsByPage: async () => ({ records: [], hasMore: false }),
        }),
        getTableMetaList: async () => [{ id: 'tblCity' }],
      };
      selectBaseForTest({ base });
      invalidateTableRecords();
      const res = await loadRowsByConditions('tblCity', [
        { fieldId: PROV, text: '不存在的省', fieldType: FieldType.SingleSelect },
      ]).promise;
      check('F20 真无记录时仍返回空（不伪造）', res.rows.length === 0, res.rows.length);
    }

    // 5) 条件构造保持类型无关的本地自证正确性（多选单元格「A B」）
    {
      const base = {
        getTableById: async () => ({
          getFieldMetaList: async () => [],
          getRecordsByPage: async () => ({
            records: [{ recordId: 'm1', fields: { fldTags: '重点 紧急' } }],
            hasMore: false,
          }),
        }),
        getTableMetaList: async () => [{ id: 'tblCity' }],
      };
      selectBaseForTest({ base });
      invalidateTableRecords();
      const res = await loadRowsByConditions('tblCity', [
        { fieldId: 'fldTags', text: '重点', fieldType: FieldType.MultiSelect },
      ]).promise;
      check(
        'F20 多选本地自证按「单元格含该选项」判定',
        res.rows.length === 1 && res.filterEffective === true,
        { n: res.rows.length, eff: res.filterEffective }
      );
    }

    // 6) 有界本地扫描兜底：条件反复失效时仍能扫出满足条件的记录
    {
      const base = {
        getTableById: async () => ({
          getFieldMetaList: async () => [],
          getRecordsByPage: async ({ pageToken }) => {
            const start = pageToken === undefined ? 0 : Number(pageToken);
            const slice = dictRows.slice(start, start + 2);
            const next = start + 2;
            return {
              records: slice,
              hasMore: next < dictRows.length,
              pageToken: next < dictRows.length ? String(next) : undefined,
            };
          },
        }),
        getTableMetaList: async () => [{ id: 'tblCity' }],
      };
      selectBaseForTest({ base });
      invalidateTableRecords();
      const scan = await scanRowsByConditionsLocal('tblCity', [
        { fieldId: PROV, text: '浙江省', fieldType: FieldType.SingleSelect },
      ]).done;
      check(
        'F20 有界本地扫描兜底能扫出该父级全部记录',
        scan.rows.length === 2 && scan.truncated === false,
        { n: scan.rows.length, truncated: scan.truncated }
      );
    }

    // 7) conditionSpecOf 纯函数：类型随条件带出；父级未填/固定值为空不下发
    {
      const withType = conditionSpecOf(
        { sourceFieldId: PROV, sourceFieldType: FieldType.SingleSelect, valueSource: 'field', formFieldId: 'fldFormProv' },
        { fldFormProv: '浙江' }
      );
      check(
        'F20 conditionSpecOf 带出源表字段类型',
        !!withType && withType.fieldType === FieldType.SingleSelect && withType.text === '浙江',
        withType
      );
      check(
        'F20 conditionSpecOf 父级未填时返回 null（子级无选项）',
        conditionSpecOf(
          { sourceFieldId: PROV, valueSource: 'field', formFieldId: 'fldFormProv' },
          {}
        ) === null
      );
      check(
        'F20 conditionSpecOf 固定值为空时返回 null（不放出全部选项）',
        conditionSpecOf({ sourceFieldId: PROV, valueSource: 'static', staticValue: '  ' }, {}) === null
      );
    }
  }

// —— F22：引用选项「完整穷举」（上万条源表不再只出前 200）——
  // 线上症状：源表上万条、配了引用条件，需要该条件下全部去重取值作为选项，
  // 实际只出来了前 200 条对应的选项 → 选项不全；且底部灰字显示"已加载最新 200 条"。
  // 根因（本轮定位）：① 旧实现上限内截断却把 hasMore 写死 false → 静默丢数据；
  //                  ② 首版穷举过度依赖 `getFieldValueListByPage` / 字段选项域，本宿主不可用
  //                     → 静默回退到「200 条」老路径（正是用户看到的灰字）。
  // 本轮修复：把「关联字段选择器同源」的 `getRecordsByPage` 渐进扫描作为**必然可用**的兜底引擎，
  //          选项域 / 存在性探测只作更快的可选优化；任何情形都不会静默只给 200 条。
  {
    const CITY2 = 'fldCity2';
    const PROV2 = 'fldProv2';
    // 源表 3 万行：浙江省 2 万行（杭州/宁波/温州 轮转），江苏省 1 万行。
    // 「温州」出现位置远在第 200 行之后 → 旧实现（只读 200）必然漏掉它。
    const DECLARED = ['杭州', '宁波', '温州', '绍兴']; // 字段配置的选项域（4 项）

    /** 造一个「行为真实」的 mock 表：分页按 token 推进、可按 pageSize 截断 */
    function makeBigDictBase({ ignoreFilter = false } = {}) {
      const calls = { records: 0, meta: 0, pages: 0 };
      const rows = [];
      const zj = ['杭州', '宁波', '温州'];
      for (let i = 0; i < 20000; i += 1) {
        rows.push({ recordId: `zj${i}`, fields: { [PROV2]: '浙江省', [CITY2]: zj[i % 3] } });
      }
      for (let i = 0; i < 10000; i += 1) {
        rows.push({ recordId: `js${i}`, fields: { [PROV2]: '江苏省', [CITY2]: '南京' } });
      }
      const filtered = (filter) => {
        const conds = filter?.conditions ?? [];
        if (ignoreFilter) return rows;
        let hits = rows;
        for (const c of conds) {
          hits = hits.filter((r) => {
            const v = String((r.fields ?? {})[c.fieldId] ?? '');
            if (c.operator === 'contains') return v.includes(String(c.value));
            return v === String(c.value);
          });
        }
        return hits;
      };
      const table = {
        getFieldMetaList: async () => {
          calls.meta += 1;
          return [
            {
              id: CITY2,
              name: '城市',
              type: FieldType.SingleSelect,
              property: { options: DECLARED.map((n, i) => ({ id: `o${i}`, name: n })) },
            },
            { id: PROV2, name: '省', type: FieldType.SingleSelect, property: { options: [] } },
          ];
        },
        getRecordsByPage: async ({ filter, pageSize, pageToken }) => {
          calls.records += 1;
          calls.pages += 1;
          const all = filtered(filter);
          const start = pageToken === undefined ? 0 : Number(pageToken);
          const n = pageSize ?? 200;
          const slice = all.slice(start, start + n);
          const next = start + n;
          return {
            records: slice,
            total: all.length,
            hasMore: next < all.length,
            pageToken: next < all.length ? String(next) : undefined,
          };
        },
      };
      return {
        base: { getTableById: async () => table, getTableMetaList: async () => [{ id: 'tblBig' }] },
        calls,
        rows,
      };
    }

    // 1) loadFieldSelectOptions：1 次请求读到完整选项域（更快路径的基础）
    {
      const { base, calls } = makeBigDictBase();
      selectBaseForTest({ base });
      invalidateTableRecords();
      const mo = await loadFieldSelectOptions('tblBig', CITY2).promise;
      check(
        'F22 读到源字段完整选项域（单选，1 次元信息请求）',
        mo.found === true && mo.options.join(',') === DECLARED.join(','),
        { opts: mo.options, metaCalls: calls.meta }
      );
      check('F22 读选项域未读取任何记录', calls.records === 0, calls.records);
    }

    // 2) ★核心：单选+有条件 → 存在性探测穷举，完整（含排在第 2 万位的「温州」）
    {
      const { base } = makeBigDictBase();
      selectBaseForTest({ base });
      invalidateTableRecords();
      const r = await enumerateOptionsByProbe('tblBig', CITY2, [
        { fieldId: PROV2, text: '浙江省', fieldType: FieldType.SingleSelect },
      ]).promise;
      check(
        'F22 有条件下穷举出全部命中选项（杭州/宁波/温州，不再只出前 200 条对应的）',
        r.values.join(',') === '杭州,宁波,温州' && r.complete === true,
        { values: r.values, complete: r.complete }
      );
      check('F22 绍兴（该条件下无记录）被正确排除', !r.values.includes('绍兴'), r.values);
      check('F22 探测成本只与选项个数有关（4 项=4 次探测）', r.probes === 4, r.probes);
      check('F22 探测每项只取 1 条（scanned<=3，远小于 3 万行）', r.scanned <= 3, {
        scanned: r.scanned,
        tableRows: 30000,
      });
    }

    // 3) 无条件：直接返回选项域（1 次元信息请求、0 次记录读取、必然完整）
    {
      const { base, calls } = makeBigDictBase();
      selectBaseForTest({ base });
      invalidateTableRecords();
      const r = await enumerateOptionsByProbe('tblBig', CITY2, []).promise;
      check(
        'F22 无条件下直接返回选项域（完整、不读记录）',
        r.values.join(',') === DECLARED.join(',') && r.source === 'metadata' && calls.records === 0,
        { values: r.values, source: r.source, records: calls.records }
      );
    }

    // 4) 存在性探测：单次探测的返回值与自证
    {
      const { base } = makeBigDictBase();
      selectBaseForTest({ base });
      const hit = await probeOptionExists('tblBig', CITY2, '温州', [
        { fieldId: PROV2, text: '浙江省', fieldType: FieldType.SingleSelect },
      ]);
      const miss = await probeOptionExists('tblBig', CITY2, '绍兴', [
        { fieldId: PROV2, text: '浙江省', fieldType: FieldType.SingleSelect },
      ]);
      check('F22 探测命中已存在选项（温州@浙江省）', hit.exists === true && hit.effective === true, hit);
      check('F22 探测判定无记录选项（绍兴@浙江省）', miss.exists === false, miss);
    }

    // 5) 宿主忽略 filter → 探测路径自证失败，如实回报（不伪造选项）
    {
      const { base } = makeBigDictBase({ ignoreFilter: true });
      selectBaseForTest({ base });
      invalidateTableRecords();
      const r = await enumerateOptionsByProbe('tblBig', CITY2, [
        { fieldId: PROV2, text: '浙江省', fieldType: FieldType.SingleSelect },
      ]).promise;
      check(
        'F22 宿主忽略 filter 时探测路径自证失败（不伪造选项）',
        r.filterEffective === false && r.values.length === 0 && r.error === 'filter-ineffective',
        { eff: r.filterEffective, values: r.values, err: r.error }
      );
    }

    // 6) 单选 is / 多选 contains 的取值匹配语义
    {
      let seenOps = [];
      const base = {
        getTableById: async () => ({
          getFieldMetaList: async () => [
            { id: 'fldTags2', name: '标签', type: FieldType.MultiSelect, property: { options: [{ id: 'a', name: '重点' }] } },
          ],
          getRecordsByPage: async ({ filter }) => {
            seenOps = (filter?.conditions ?? []).map((c) => c.operator);
            return { records: [], hasMore: false };
          },
        }),
        getTableMetaList: async () => [{ id: 'tblBig' }],
      };
      selectBaseForTest({ base });
      invalidateTableRecords();
      await probeOptionExists('tblBig', 'fldTags2', '重点', [], FieldType.MultiSelect);
      check('F22 多选取值匹配用 contains（含该选项即命中）', seenOps.includes('contains'), seenOps);
    }

    // 7) ★★ 本轮核心回归：宿主「元信息无选项域 + 无 getFieldValueListByPage」时，
    //    统一入口必须能给出**完整选项**（= 用户线上真实故障场景）。
    //    注：2026-10-21 起「有条件」默认走**直接查询**快速路径；本用例专测**扫描引擎**，
    //        故显式指定 engine:'scan'（扫描仍是必然可用的最终兜底）。
    {
      const PROV3 = 'fldProv3';
      const CITY3 = 'fldCity3';
      const rows2 = [];
      for (let i = 0; i < 2100; i += 1) rows2.push({ recordId: `a${i}`, fields: { [PROV3]: '浙', [CITY3]: `城${i % 7}` } });
      let pages = 0;
      const base = {
        getTableById: async () => ({
          // 故意返回 Text 类型：无选项域；且不提供 getFieldById → 必然走扫描
          getFieldMetaList: async () => [{ id: CITY3, name: '城', type: FieldType.Text }],
          getRecordsByPage: async ({ pageToken }) => {
            pages += 1;
            const start = pageToken === undefined ? 0 : Number(pageToken);
            const slice = rows2.slice(start, start + 200);
            const next = start + 200;
            return {
              records: slice,
              total: rows2.length,
              hasMore: next < rows2.length,
              pageToken: next < rows2.length ? String(next) : undefined,
            };
          },
        }),
        getTableMetaList: async () => [{ id: 'tblBig' }],
      };
      selectBaseForTest({ base });
      invalidateTableRecords();
      const r = await enumerateRefOptions('tblBig', CITY3, [
        { fieldId: PROV3, text: '浙', fieldType: FieldType.Text },
      ], { engine: 'scan' }).promise;
      check(
        'F22 无选项域时扫描引擎给出完整选项（7 个取值全出）',
        r.source === 'scan' && r.complete === true && r.values.join(',') === '城0,城1,城2,城3,城4,城5,城6',
        { source: r.source, complete: r.complete, values: r.values }
      );
      check('F22 扫描翻了 2100/200 页（非只读 200）', pages >= 11, { pages });
    }

    // 7b) 扫描「首屏秒出 + 后台续扫」：第一页回调即产出选项、且有进度回调
    {
      const PROV4 = 'fldProv4';
      const CITY4 = 'fldCity4';
      const rows3 = [];
      for (let i = 0; i < 1200; i += 1) rows3.push({ recordId: `b${i}`, fields: { [PROV4]: '浙', [CITY4]: `甲${i % 3}` } });
      const base = {
        getTableById: async () => ({
          getFieldMetaList: async () => [{ id: CITY4, name: '城', type: FieldType.Text }],
          getRecordsByPage: async ({ pageToken }) => {
            const start = pageToken === undefined ? 0 : Number(pageToken);
            const slice = rows3.slice(start, start + 200);
            const next = start + 200;
            return {
              records: slice,
              total: rows3.length,
              hasMore: next < rows3.length,
              pageToken: next < rows3.length ? String(next) : undefined,
            };
          },
        }),
        getTableMetaList: async () => [{ id: 'tblBig' }],
      };
      selectBaseForTest({ base });
      invalidateTableRecords();
      let callbacks = 0;
      let progressSeen = 0;
      const h = enumerateRefOptions('tblBig', CITY4, [
        { fieldId: PROV4, text: '浙', fieldType: FieldType.Text },
      ], {
        engine: 'scan', // 本用例专测扫描引擎的渐进能力
        onOption: () => { callbacks += 1; },
        onScanProgress: (s) => { progressSeen = s; },
      });
      const r = await h.promise;
      check('F22 扫描有 onOption 渐进回调（不干等全量）', callbacks >= 3, { callbacks });
      check('F22 扫描有进度回调（已扫描达到全表 1200）', progressSeen >= 1200, progressSeen);
      check('F22 扫描结果完整（3 个取值）', r.complete === true && r.values.length === 3, r.values);
    }

    // 7c) 扫描撞页数上限 → 如实标 truncated（不谎报完整）
    {
      const PROV5 = 'fldProv5';
      const CITY5 = 'fldCity5';
      const rows4 = [];
      for (let i = 0; i < 5000; i += 1) rows4.push({ recordId: `c${i}`, fields: { [PROV5]: '浙', [CITY5]: `X${i}` } });
      const base = {
        getTableById: async () => ({
          getFieldMetaList: async () => [{ id: CITY5, name: '城', type: FieldType.Text }],
          getRecordsByPage: async ({ pageToken }) => {
            const start = pageToken === undefined ? 0 : Number(pageToken);
            const slice = rows4.slice(start, start + 200);
            const next = start + 200;
            return {
              records: slice,
              total: rows4.length,
              hasMore: next < rows4.length,
              pageToken: next < rows4.length ? String(next) : undefined,
            };
          },
        }),
        getTableMetaList: async () => [{ id: 'tblBig' }],
      };
      selectBaseForTest({ base });
      invalidateTableRecords();
      const r = await enumerateRefOptions('tblBig', CITY5, [
        { fieldId: PROV5, text: '浙', fieldType: FieldType.Text },
      ], { engine: 'scan', maxScanPages: 3 }).promise;
      check(
        'F22 扫描撞页数上限时如实标 truncated（不谎报完整）',
        r.truncated === true && r.complete === false && r.source === 'scan',
        { truncated: r.truncated, complete: r.complete, n: r.values.length }
      );
    }

    // 8) 探测自证失败（宿主忽略 filter）→ 统一入口自动降级扫描，仍得出完整选项
    {
      const PROV6 = 'fldProv6';
      const CITY6 = 'fldCity6';
      const rows5 = [];
      for (let i = 0; i < 600; i += 1) {
        rows5.push({ recordId: `d${i}`, fields: { [PROV6]: i % 2 === 0 ? '浙' : '苏', [CITY6]: i % 2 === 0 ? '杭' : '宁' } });
      }
      const base = {
        getTableById: async () => ({
          getFieldMetaList: async () => [
            { id: CITY6, name: '城', type: FieldType.SingleSelect, property: { options: [{ id: 'x', name: '杭' }, { id: 'y', name: '宁' }] } },
          ],
          // 宿主忽略 filter：始终返回全部（含不满足条件的）→ 探测自证失败
          getRecordsByPage: async ({ pageToken }) => {
            const start = pageToken === undefined ? 0 : Number(pageToken);
            const slice = rows5.slice(start, start + 200);
            const next = start + 200;
            return {
              records: slice,
              total: rows5.length,
              hasMore: next < rows5.length,
              pageToken: next < rows5.length ? String(next) : undefined,
            };
          },
        }),
        getTableMetaList: async () => [{ id: 'tblBig' }],
      };
      selectBaseForTest({ base });
      invalidateTableRecords();
      const r = await enumerateRefOptions('tblBig', CITY6, [
        { fieldId: PROV6, text: '浙', fieldType: FieldType.SingleSelect },
      ]).promise;
      check(
        'F22 探测自证失败 → 自动降级扫描，仍得出该条件下完整选项（杭）',
        r.source === 'scan' && r.values.join(',') === '杭' && r.complete === true,
        { source: r.source, values: r.values, complete: r.complete }
      );
    }

    // 9) resolveRefOptions 纯函数行为不受本轮改动影响（去重 + 按条件筛）
    {
      const opts = resolveRefOptions(
        { tableId: 't', fieldId: CITY2, conditions: [
          { sourceFieldId: PROV2, sourceFieldType: FieldType.SingleSelect, valueSource: 'static', staticValue: '浙江省' },
        ] },
        [
          { fields: { [PROV2]: '浙江省', [CITY2]: '杭州' } },
          { fields: { [PROV2]: '江苏省', [CITY2]: '南京' } },
          { fields: { [PROV2]: '浙江省', [CITY2]: '杭州' } },
        ],
        {}
      );
      check('F22 resolveRefOptions 去重且按条件筛', opts.join(',') === '杭州', opts);
    }
  }
  // —— F19：Semi Select「可搜索性」静态防回归 ——
  // 踩过的坑：`filter={undefined}` 会让 Semi 判定 filterable=false，
  // **连搜索输入框都不渲染**，onSearch 永不触发 → 用户"只能选，没法模糊搜索"。
  // 这里直接扫源码断言：凡是用 remote 的 Select，必须同时给出真值 filter。
  {
    const fs = await import('node:fs');
    const targets = [
      '../src/components/FormRenderer/LinkSelector.tsx',
      '../src/components/FormRenderer/RefOptionSelect.tsx',
    ];
    for (const rel of targets) {
      const url = new URL(rel, import.meta.url);
      let src = '';
      try {
        src = fs.readFileSync(url, 'utf8');
      } catch (e) {
        check(`F19 ${rel} 可读取`, false, String(e?.message ?? e));
        continue;
      }
      const file = rel.split('/').pop();
      // 先剥掉注释，避免"注释里提到坏写法"被误判为坏写法
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/([^:])\/\/.*$/gm, '$1');

      const hasRemote = /(^|\s)remote(\s|$|\n)/m.test(code);
      check(`F19 ${file} 使用 remote（跳过本地过滤）`, hasRemote);

      // 不得出现 filter={undefined} / filter={false} —— 会关闭搜索框渲染
      const badFilter = /filter=\{(?:undefined|false)\}/.test(code);
      check(`F19 ${file} 未把 filter 置为假值（否则搜索框不渲染）`, !badFilter);

      // 必须出现独立的真值 `filter` 属性（不是 filter={...} 的表达式形式）
      const truthyFilter = /(^|\s)filter(\s*$|\s*\n)/m.test(code);
      check(`F19 ${file} 声明了真值 filter（保证渲染搜索输入框）`, truthyFilter);

      // onSearch 必须绑定（否则输入后不会触发服务端搜索）
      check(`F19 ${file} 绑定了 onSearch`, /onSearch=/.test(code));

      // 选中后不清空关键字，便于连续多选
      check(`F19 ${file} 保留关键字（autoClearSearchValue=false）`, /autoClearSearchValue=\{false\}/.test(code));
    }
  }

  // —— F23：引用选项「搜索必须替换列表、且完整性不依赖易缺接口」（静态防回归）——
  // 踩过的坑：
  //  ① 选项列表把「搜索结果」与「全量穷举值」求并集 → 列表几乎仍是全量，用户觉得"搜索没生效"；
  //  ② 完整性过度依赖 `getFieldValueListByPage` / 字段选项域 → 宿主不支持时静默回退到 200 条。
  // 这里直接扫源码断言这两点不再发生。
  {
    const fs = await import('node:fs');
    const read = (rel) => {
      const url = new URL(rel, import.meta.url);
      return fs
        .readFileSync(url, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/([^:])\/\/.*$/gm, '$1');
    };
    // ① RefOptionSelect：搜索态必须只取「匹配关键字」的项（不得把未过滤的全量 values 放进来）
    const sel = read('../src/components/FormRenderer/RefOptionSelect.tsx');
    // 取 optionTexts 的 useMemo 主体，检查 if(inSearch){...}else{...} 分支内容是否互斥
    const memoMatch = sel.match(/const optionTexts = useMemo\(\(\) => \{([\s\S]*?)\n  \}, \[/);
    const body = memoMatch ? memoMatch[1] : '';
    const ifBlock = (body.match(/if \(inSearch\) \{([\s\S]*?)\} else \{/) || [])[1] || '';
    const elseBlock = (body.match(/\} else \{([\s\S]*?)\n    \}/) || [])[1] || '';
    const branchOk =
      /searchHits\.forEach/.test(ifBlock) &&
      !/^\s*values\.forEach/m.test(ifBlock) && // 搜索分支绝不能直接铺全量 values
      /values\.forEach/.test(elseBlock);
    check('F23 引用选项在搜索态只展示匹配项（不铺未过滤全量）', branchOk, {
      branchOk,
      ifHasSearchHits: /searchHits\.forEach/.test(ifBlock),
      ifHasRawValues: /^\s*values\.forEach/m.test(ifBlock),
    });
    // 全量本地过滤必须存在（把关键字应用到已穷举的全量选项上 → 「全量搜索」的可靠一环）
    check(
      'F23 搜索对已穷举全量选项做本地过滤（全量搜索的可靠一环）',
      /localHits\s*=\s*useMemo[\s\S]{0,200}values\.filter\(\(v\)\s*=>\s*v\.toLowerCase\(\)\.includes\(kw\)\)/.test(
        sel
      ),
      null
    );
    // ② 统一入口必须存在「扫描」兜底源（保证不静默只给 200 条）
    const cache = read('../src/services/tableRecordCache.ts');
    check(
      'F23 穷举统一入口含 getRecordsByPage 扫描兜底（不依赖易缺接口）',
      /scanDistinctValues/.test(cache) && /source:\s*'scan'/.test(cache),
      null
    );
    check(
      'F23 扫描兜底基于 getRecordsByPage（与关联字段选择器同源）',
      /scanRowsByConditionsLocal[\s\S]*?getRecordsByPage/.test(cache),
      null
    );
  }

  // —— F24：应用模式「数据源 ≠ 宿主所在多维表格」时，重新打开配置不得丢失 ——
  // 踩过的坑（真实缺陷，用户实测「第一次配置启用日期联动预填，再次打开配置模式后配置消失」）：
  //   loadConfig 里先做「跨 base 归属校验」、后绑定配置声明的数据源 base，顺序反了。
  //   isForeignConfig 用 baseId 判归属，而应用模式允许数据源 ≠ 宿主 base
  //   → 校验时 getBaseId() 拿到的是「宿主默认 base」的 ID → 合法配置被判为外来配置
  //   → 静默 return null → 界面表现为「配置凭空消失」。
  // 断言方式：直接扫源码，要求 dashboard / bridge / localStorage 三条读取分支
  // 都满足「ensureBaseBound 出现在 isForeignConfig 之前」。
  {
    const fs = await import('node:fs');
    const src = fs
      .readFileSync(new URL('../src/services/configService.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/([^:])\/\/.*$/gm, '$1');

    // 取 loadConfig 函数体（从定义到文件内下一个顶层 export/函数）
    const loadStart = src.indexOf('export async function loadConfig');
    const loadBody = loadStart >= 0 ? src.slice(loadStart, loadStart + 6000) : '';

    // 每个分支：ensureBaseBound(...) 的索引必须早于同分支的 isForeignConfig(...)
    const orderOk = (chunk) => {
      const bound = chunk.indexOf('ensureBaseBound(parsed)');
      const foreign = chunk.indexOf('isForeignConfig(parsed)');
      if (bound < 0 || foreign < 0) return false; // 两者都必须存在
      return bound < foreign;
    };

    // 按「分支起点」切块：dashboard(getConfig) / bridge / localStorage
    const dashChunk = loadBody.slice(0, loadBody.indexOf('try {\n    let data: unknown = await getBridge()'));
    const bridgeChunk = loadBody.slice(
      loadBody.indexOf('let data: unknown = await getBridge()'),
      loadBody.indexOf('if (LS_OK)')
    );
    const lsChunk = loadBody.slice(loadBody.indexOf('if (LS_OK)'));

    check('F24 dashboard 读取分支：先绑定数据源 base，再判归属', orderOk(dashChunk), {
      hasEnsureBaseBound: dashChunk.includes('ensureBaseBound(parsed)'),
      hasIsForeign: dashChunk.includes('isForeignConfig(parsed)'),
    });
    check('F24 bridge 读取分支：先绑定数据源 base，再判归属', orderOk(bridgeChunk), null);
    check('F24 localStorage 读取分支：先绑定数据源 base，再判归属', orderOk(lsChunk), null);

    // ensureBaseBound 必须返回「是否绑定成功」，且调用方用「无 baseToken 或绑定失败」才做归属校验
    check(
      'F24 ensureBaseBound 回传绑定结果（供调用方判断配置能否自证归属）',
      /async function ensureBaseBound\([\s\S]*?\): Promise<boolean>/.test(src) &&
        /return true;/.test(src.slice(src.indexOf('async function ensureBaseBound'))),
      null
    );
    check(
      'F24 带 baseToken 且绑定成功的配置不做跨 base 丢弃（自描述配置）',
      /\(!parsed\.baseToken \|\| !bound\)/.test(src),
      null
    );
  }

  // —— F25：子表「展现形式」（纵向卡片 / 横向表格）——
  // 覆盖：layout 缺省值、序列化白名单保留、列模型（列头/列宽/整列移除/逐行标记）、
  //       行变更纯函数（级联清空 / 默认值 / maxRows）、源码级断言（表格横向滚动 + sticky）
  {
    const mkField = (over) => ({
      fieldId: 'f',
      fieldName: '字段',
      fieldType: FieldType.Text,
      visible: true,
      required: false,
      ...over,
    });

    const subBase = {
      tableId: SUB1,
      tableName: '子表1',
      linkFieldId: 'fldLink1',
      allowMultiple: true,
      fields: [
        mkField({ fieldId: 'fldA', fieldName: '产品', label: '产品', required: true, fieldType: FieldType.Text }),
        mkField({ fieldId: 'fldB', fieldName: '数量', label: '数量', fieldType: FieldType.Number }),
        mkField({ fieldId: 'fldC', fieldName: '日期', label: '日期', fieldType: FieldType.DateTime }),
        mkField({ fieldId: 'fldD', fieldName: '附件', label: '附件', fieldType: FieldType.Attachment }),
        mkField({ fieldId: 'fldH', fieldName: '隐藏字段', label: '隐藏字段', visible: false }),
        mkField({ fieldId: 'fldLink1', fieldName: '关联主表', label: '关联主表', fieldType: FieldType.SingleLink }),
      ],
    };

    // a) 缺省与非法值都解析为 vertical（旧配置零迁移）
    check('F25 layout 缺省解析为纵向', resolveSubLayout({ ...subBase }) === 'vertical', null);
    check(
      'F25 layout 非法值回退纵向',
      resolveSubLayout({ ...subBase, layout: 'weird' }) === 'vertical',
      null
    );
    check(
      'F25 layout=table 正确解析',
      resolveSubLayout({ ...subBase, layout: 'table' }) === 'table',
      null
    );

    // b) 序列化白名单：layout 必须随配置持久化（漏了 → 别人打开静默退回纵向）
    const thin = serializeConfig({
      forms: [
        {
          id: 'form1',
          version: '1.0.0',
          formTitle: 'T',
          mainTable: { tableId: MAIN, tableName: '主表', fields: [] },
          subTables: [{ ...subBase, layout: 'table' }],
          conditionalRules: [],
        },
      ],
      defaultFormId: 'form1',
    });
    check('F25 layout=table 随序列化保留', thin.forms[0].subTables[0].layout === 'table', thin.forms[0].subTables[0].layout);

    const thinVertical = serializeConfig({
      forms: [
        {
          id: 'form1',
          version: '1.0.0',
          formTitle: 'T',
          mainTable: { tableId: MAIN, tableName: '主表', fields: [] },
          subTables: [{ ...subBase, layout: 'vertical' }],
          conditionalRules: [],
        },
      ],
      defaultFormId: 'form1',
    });
    check(
      'F25 layout=vertical 也如实保留（不依赖缺省）',
      thinVertical.forms[0].subTables[0].layout === 'vertical',
      thinVertical.forms[0].subTables[0].layout
    );

    // c) 列模型：可见字段成列、隐藏字段与关联字段不出现
    const form = {
      id: 'form1',
      version: '1.0.0',
      formTitle: 'T',
      mainTable: { tableId: MAIN, tableName: '主表', fields: [] },
      subTables: [subBase],
      conditionalRules: [],
    };
    const emptyCond = computeConditionalState(form, {}, { [SUB1]: [{}, {}] });
    const cols = buildSubColumns(subBase, emptyCond, 2, true);
    check(
      'F25 列模型含 4 个可见字段（排除 visible=false 与关联字段）',
      cols.columns.map((c) => c.fieldId).join(',') === 'fldA,fldB,fldC,fldD',
      cols.columns.map((c) => c.fieldId)
    );
    check('F25 列宽按字段类型分配（文本 200 / 数字·日期 150 / 附件 230）', 
      cols.columns[0].width === 200 && cols.columns[1].width === 150 && cols.columns[2].width === 150 && cols.columns[3].width === 230,
      cols.columns.map((c) => c.width)
    );
    check('F25 表格最小宽 = 序号48 + 内容列之和 + 操作56', cols.minWidth === 48 + (200 + 150 + 150 + 230) + 56, {
      minWidth: cols.minWidth,
      contentWidth: cols.contentWidth,
    });
    check('F25 单行模式（不可删）不预留操作列宽', buildSubColumns(subBase, emptyCond, 1, false).minWidth === 48 + (200 + 150 + 150 + 230), null);
    check('F25 全表必填 → 列头显示星号', cols.columns[0].requiredEverywhere === true, cols.columns[0]);
    check('F25 非必填字段列头不给星', cols.columns[1].requiredEverywhere === false, null);

    // d) 条件规则：全表隐藏 → 整列移除；行级隐藏 → 列保留 + 该行标记留空
    const ruleForm = {
      ...form,
      conditionalRules: [
        {
          ruleId: 'r1',
          trigger: { tableId: MAIN, fieldId: 'fldM1', operator: 'equals', value: 'x' },
          actions: [
            { type: 'hide', tableId: SUB1, fieldIds: ['fldC'] }, // 主表触发 → 子表全表级隐藏
            { type: 'hide', tableId: SUB1, fieldIds: ['fldD'] }, // 同上
          ],
        },
      ],
    };
    const hiddenCond = computeConditionalState(
      ruleForm,
      { fldM1: 'x' },
      { [SUB1]: [{}, {}] }
    );
    const colsHidden = buildSubColumns(subBase, hiddenCond, 2, true);
    check(
      'F25 全表级隐藏的字段整列移除',
      !colsHidden.columns.some((c) => c.fieldId === 'fldC') && !colsHidden.columns.some((c) => c.fieldId === 'fldD'),
      colsHidden.columns.map((c) => c.fieldId)
    );

    // 行级规则：子表 fldB 触发 → 只作用于同一子表的某一行
    const rowRuleForm = {
      ...form,
      conditionalRules: [
        {
          ruleId: 'r2',
          trigger: { tableId: SUB1, fieldId: 'fldB', operator: 'equals', value: 0 },
          actions: [{ type: 'hide', tableId: SUB1, fieldIds: ['fldC'] }],
        },
      ],
    };
    const rowCond = computeConditionalState(rowRuleForm, {}, { [SUB1]: [{ fldB: 0 }, { fldB: 5 }] });
    const colsRow = buildSubColumns(subBase, rowCond, 2, true);
    const colC = colsRow.columns.find((c) => c.fieldId === 'fldC');
    check('F25 行级隐藏：列保留（不整列移除）', !!colC, colsRow.columns.map((c) => c.fieldId));
    check('F25 行级隐藏：仅命中行标记为留空', colC.hiddenRows.join(',') === '0', colC.hiddenRows);

    // 行级必填：只有部分行必填 → 列头不给星，标 partialRequired
    const reqRuleForm = {
      ...form,
      conditionalRules: [
        {
          ruleId: 'r3',
          trigger: { tableId: SUB1, fieldId: 'fldB', operator: 'equals', value: 0 },
          actions: [{ type: 'require', tableId: SUB1, fieldIds: ['fldC'] }],
        },
      ],
    };
    const reqCond = computeConditionalState(reqRuleForm, {}, { [SUB1]: [{ fldB: 0 }, { fldB: 5 }] });
    const colCReq = buildSubColumns(subBase, reqCond, 2, true).columns.find((c) => c.fieldId === 'fldC');
    check('F25 部分行必填 → 列头不给星', colCReq.requiredEverywhere === false, colCReq);
    check('F25 部分行必填 → 标记 partialRequired 供单元格内提示', colCReq.partialRequired === true, null);
    check('F25 部分行必填 → requiredRows 精确到命中行', colCReq.requiredRows.join(',') === '0', colCReq.requiredRows);

    // e) 行变更纯函数：级联清空（引用选项依赖同行字段）/ 默认值 / 删除 / maxRows
    const linkFields = [
      mkField({ fieldId: 'p', fieldName: '省', label: '省', fieldType: FieldType.SingleSelect }),
      mkField({
        fieldId: 'c',
        fieldName: '市',
        label: '市',
        fieldType: FieldType.SingleSelect,
        optionRef: {
          tableId: 'tblCity',
          fieldId: 'fldCity',
          conditions: [{ sourceFieldId: 'fldProv', valueSource: 'field', formFieldId: 'p' }],
        },
      }),
      mkField({ fieldId: 'ms', fieldName: '标签', label: '标签', fieldType: FieldType.MultiSelect,
        optionRef: {
          tableId: 'tblCity',
          fieldId: 'fldCity',
          conditions: [{ sourceFieldId: 'fldProv', valueSource: 'field', formFieldId: 'p' }],
        },
      }),
    ];
    const changed = applyRowFieldChange(linkFields, { p: '浙江', c: '杭州', ms: ['A'] }, 'p', '江苏');
    check('F25 级联：父值变更清空单选取值', changed.c === undefined, changed.c);
    check('F25 级联：父值变更清空多选取值（置空数组）', Array.isArray(changed.ms) && changed.ms.length === 0, changed.ms);
    // 与既有纵向行为一致：只要父字段触发 onChange 即清空下游（Semi 同值不触发 onChange，实际无副作用）
    const unrelated = applyRowFieldChange(linkFields, { p: '浙江', c: '杭州' }, 'otherFld', 1);
    check('F25 级联：无关字段变更不影响下游取值', unrelated.c === '杭州', unrelated.c);
    const noDeps = applyRowFieldChange(subBase.fields, { fldB: 1 }, 'fldB', 2);
    check('F25 无引用依赖的字段变更不清空任何值', noDeps.fldB === 2, null);

    const origRows = [{}, {}];
    const rows2 = updateRowAt(subBase.fields, origRows, 1, 'fldB', 7);
    check('F25 updateRowAt 只改目标行', rows2[0].fldB === undefined && rows2[1].fldB === 7, rows2);
    check(
      'F25 updateRowAt 不改原数组（纯函数）',
      origRows[1].fldB === undefined && rows2 !== origRows,
      origRows
    );

    const defSub = {
      ...subBase,
      fields: [mkField({ fieldId: 'd1', defaultValue: 'v1' }), mkField({ fieldId: 'd2', defaultValue: ['a'] })],
    };
    const appended = appendRow([{}], defSub.fields);
    check('F25 appendRow 用默认值填新行', appended.length === 2 && appended[1].d1 === 'v1', appended[1]);
    check('F25 appendRow 数组默认值做拷贝（不共享引用）', appended[1].d2 !== defSub.fields[1].defaultValue, null);
    check('F25 removeRowAt 按索引删除', removeRowAt([{ a: 1 }, { a: 2 }, { a: 3 }], 1).length === 2, null);
    check('F25 canAppendRow 受 maxRows 约束', canAppendRow(2, 1) === true && canAppendRow(2, 2) === false, null);
    check('F25 canAppendRow 未设 maxRows 不限条数', canAppendRow(undefined, 99) === true, null);

    // f) 源码级断言：表格必须真横向滚动 + sticky 表头/序号列/操作列（Semi 类 prop 静默失效的教训）
    const fs2 = await import('node:fs');
    const cssSrc = fs2
      .readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    check(
      'F25 表格容器开启横向滚动（overflow-x: auto）',
      /\.sub-table-scroll\s*\{[^}]*overflow-x:\s*auto/.test(cssSrc),
      null
    );
    check(
      'F25 表头吸顶（thead th position: sticky + top: 0）',
      /\.sub-table\s+thead\s+th\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/.test(cssSrc),
      null
    );
    check(
      'F25 序号列左侧固定（sticky + left: 0）',
      /\.sub-table\s+\.st-cell-idx\s*\{[^}]*position:\s*sticky[^}]*left:\s*0/.test(cssSrc),
      null
    );
    check(
      'F25 操作列右侧固定（sticky + right: 0）',
      /\.sub-table\s+\.st-cell-act\s*\{[^}]*position:\s*sticky[^}]*right:\s*0/.test(cssSrc),
      null
    );
    check(
      'F25 吸顶/固定列有不透明底色（防滚动穿透）',
      /\.sub-table\s+thead\s+th\s*\{[^}]*background:\s*#/.test(cssSrc) &&
        /\.sub-table\s+\.st-cell-idx\s*\{[^}]*background:\s*#/.test(cssSrc),
      null
    );

    const tableSrc = fs2.readFileSync(
      new URL('../src/components/FormRenderer/SubFormTable.tsx', import.meta.url),
      'utf8'
    );
    check('F25 表格内复用同一 FieldRenderer（功能与纵向一致）', /<FieldRenderer/.test(tableSrc), null);
    check('F25 表格 min-width 由列模型计算（非硬编码）', /style=\{\{\s*minWidth\s*\}\}/.test(tableSrc), null);
    check('F25 表格模式唯一性徽标走紧凑形态（避免撑宽列）', /uniqueCompact/.test(tableSrc), null);
    check('F25 行级隐藏单元格留空（不渲染控件）', /st-cell-hidden/.test(tableSrc), null);

    // 2026-10-21 反馈修复：表头星号必须红色（全局类）+ 必填格橙色标记 + 文本压单行
    check(
      'F25 必填星号是全局类（不再局限 .field-row 后代，否则表头继承灰色）',
      /^\.required-star\s*\{[^}]*color:\s*var\(--danger\)/m.test(cssSrc) &&
        !/\.field-row\s+\.required-star\s*\{/.test(cssSrc),
      null
    );
    check(
      'F25 必填格橙色标记（淡橙底 + 橙左边条，用 inset shadow 不撑列宽）',
      /\.sub-table\s+td\.st-cell--required\s*\{[^}]*background:\s*#fffbf5/.test(cssSrc) &&
        /\.sub-table\s+td\.st-cell--required\s*\{[^}]*box-shadow:\s*inset\s+3px\s+0\s+0\s+0\s+#f59e0b/.test(cssSrc),
      null
    );
    check(
      'F25 必填格 hover 仍保持橙底可辨',
      /tbody\s+tr:hover\s+td\.st-cell--required\s*\{[^}]*background:\s*#fff7ec/.test(cssSrc),
      null
    );
    check(
      'F25 错误态红底压倒必填橙（不叠加两种底色）',
      /\.sub-table\s+td\.st-cell--error\s*\{[^}]*background:\s*#fff5f5/.test(cssSrc),
      null
    );
    check(
      'F25 表格必填格按「该行是否必填」判定（含行级规则）',
      /const cellRequired = isFieldRequired\(field, sub\.tableId, cond, idx\)/.test(tableSrc) &&
        /cellClass\s*\(?\s*\)?[\s\S]{0,160}'st-cell--required'/.test(tableSrc),
      null
    );
    check('F25 表格向 FieldRenderer 传 compact（文本压单行）', /compact\b/.test(tableSrc) && /\scompact\s*$/m.test(tableSrc), null);

    const fieldRendererSrc = fs2.readFileSync(
      new URL('../src/components/FormRenderer/FieldRenderer.tsx', import.meta.url),
      'utf8'
    );
    check(
      'F25 文本字段在 compact 下改用单行 Input（默认仍是两行 TextArea）',
      /case FieldType\.Text:\s*\/\/[^\n]*\n\s*if \(compact\) \{[\s\S]{0,300}<Input/.test(fieldRendererSrc) &&
        /<TextArea[\s\S]{0,200}rows=\{2\}/.test(fieldRendererSrc),
      null
    );

    const subFormSrc = fs2.readFileSync(
      new URL('../src/components/FormRenderer/SubForm.tsx', import.meta.url),
      'utf8'
    );
    check('F25 SubForm 按 layout 分流到表格组件', /resolveSubLayout\(/.test(subFormSrc) && /SubFormTable/.test(subFormSrc), null);
    check(
      'F25 纵向分支同样走共用纯函数（两形态写入行为一致）',
      /applyRowFieldChange\(/.test(subFormSrc) && /appendRow\(/.test(subFormSrc),
      null
    );

    const cfgSizeSrc = fs2.readFileSync(new URL('../src/services/configSize.ts', import.meta.url), 'utf8');
    check(
      'F25 configSize 序列化白名单含 layout（防瘦身剥离）',
      /layout:\s*s\.layout/.test(cfgSizeSrc),
      null
    );

    const subCfgSrc = fs2.readFileSync(
      new URL('../src/components/ConfigPanel/SubTableConfig.tsx', import.meta.url),
      'utf8'
    );
    check(
      'F25 配置面板提供两种展现形式切换',
      /layout:\s*'vertical'/.test(subCfgSrc) && /layout:\s*'table'/.test(subCfgSrc),
      null
    );
  }

  /* ============================================================
   * F26 条件穷举「假空」兜底（2026-10-21 用户反馈修复）
   *
   * 症状：大数据量源表 + 选了上级字段后，子级下拉显示
   *       「已按条件穷举全部 0 个选项」（灰字），选项根本不出现。
   *
   * 根因：`probeOptionExists` 拿到 0 条记录时返回 {exists:false, effective:true}
   *      （注释「无命中，无从证伪」）→ 当宿主对 typed 条件（is + fieldType）
   *      **稳定返回 0 条**（本项目已知的「假空」坑）时，逐项探测全 miss 被当成
   *      「该条件下确实无选项」+「过滤有效」→ 返回 complete:true, values:[]。
   *      而 `loadRowsByConditions` 有「精确→宽松→本地扫描」三层兜底，
   *      探测路径**一层都没有** —— 这就是「小数据量能用、大数据量不行」的分界。
   *
   * 修复：① 探测全 miss 时做**宽松复核**（去 fieldType、统一 contains）；
   *      ② 两级皆空仍不声称可信（error='probe-all-miss'）→ 统一入口回退扫描确认。
   * ============================================================ */
  {
    const VAL = 'fldModule26';
    const COND = 'fldLine26';
    const MODULES = ['模组一', '模组二', '模组三'];

    /** 造 mock：emptyWhenFiltered=true 模拟宿主「带 filter 一律返回 0 条」的假空 */
    function makeFakeEmptyBase({ emptyWhenFiltered = true, valueType = FieldType.SingleSelect } = {}) {
      const rows = [];
      for (let i = 0; i < 20000; i += 1) {
        rows.push({ recordId: `a${i}`, fields: { [COND]: '企企云', [VAL]: MODULES[i % 3] } });
      }
      for (let i = 0; i < 10000; i += 1) {
        rows.push({ recordId: `b${i}`, fields: { [COND]: '产品B', [VAL]: '模组X' } });
      }
      const table = {
        getFieldMetaList: async () => [
          {
            id: VAL,
            name: '模组名称',
            type: valueType,
            property: { options: MODULES.map((n, i) => ({ id: `m${i}`, name: n })) },
          },
          { id: COND, name: '产品线', type: FieldType.SingleSelect, property: { options: [] } },
        ],
        getRecordsByPage: async ({ filter, pageSize, pageToken }) => {
          let all = rows;
          if (filter) {
            if (emptyWhenFiltered) {
              all = []; // ★ 假空：typed 条件被宿主误解析 → 稳定 0 条
            } else {
              for (const c of (filter.conditions ?? [])) {
                all = all.filter((r) => String((r.fields ?? {})[c.fieldId] ?? '') === String(c.value));
              }
            }
          }
          const start = pageToken === undefined ? 0 : Number(pageToken);
          const n = pageSize ?? 200;
          const slice = all.slice(start, start + n);
          const next = start + n;
          return {
            records: slice,
            total: all.length,
            hasMore: next < all.length,
            pageToken: next < all.length ? String(next) : undefined,
          };
        },
      };
      return { base: { getTableById: async () => table, getTableMetaList: async () => [{ id: 'tblBig26' }] } };
    }

    const SPEC = [{ fieldId: COND, text: '企企云', fieldType: FieldType.SingleSelect }];

    // 1) 探测路径：假空时**不得**声称「穷举完成且 0 选项」（这正是用户看到的灰字）
    {
      const { base } = makeFakeEmptyBase({ emptyWhenFiltered: true });
      selectBaseForTest({ base });
      invalidateTableRecords();
      const r = await enumerateOptionsByProbe('tblBig26', VAL, SPEC).promise;
      check(
        'F26 假空时探测路径不伪造「complete=true 且 0 选项」（用户看到的灰字根因）',
        !(r.complete === true && r.values.length === 0),
        { complete: r.complete, values: r.values, error: r.error }
      );
    }

    // 2) ★ 统一入口：假空时必须回退扫描、拿到本该有的全部选项
    {
      const { base } = makeFakeEmptyBase({ emptyWhenFiltered: true });
      selectBaseForTest({ base });
      invalidateTableRecords();
      const r = await enumerateRefOptions('tblBig26', VAL, SPEC, {}).promise;
      check(
        'F26 假空时统一入口回退扫描并取到全部 3 个模组（大数据量选项不再为空）',
        r.values.join(',') === MODULES.join(',') && r.complete === true,
        { values: r.values, source: r.source, complete: r.complete }
      );
    }

    // 3) 对照：宿主 filter 正常时探测路径仍走通（未被兜底逻辑破坏）
    {
      const { base } = makeFakeEmptyBase({ emptyWhenFiltered: false });
      selectBaseForTest({ base });
      invalidateTableRecords();
      const r = await enumerateOptionsByProbe('tblBig26', VAL, SPEC).promise;
      check(
        'F26 filter 正常时仍走探测路径且结果正确（兜底不干扰快路径）',
        r.values.join(',') === MODULES.join(',') && r.source === 'probe' && r.complete === true,
        { values: r.values, source: r.source }
      );
    }

    // 4) 宽松复核：typed 条件被误解析、但宽松（contains）条件可用时，采用复核结果
    {
      const VAL2 = 'fldModule26b';
      const table = {
        getFieldMetaList: async () => [
          {
            id: VAL2,
            name: '模组',
            type: FieldType.SingleSelect,
            property: { options: MODULES.map((n, i) => ({ id: `n${i}`, name: n })) },
          },
          { id: COND, name: '产品线', type: FieldType.SingleSelect, property: { options: [] } },
        ],
        getRecordsByPage: async ({ filter, pageSize }) => {
          const conds = filter?.conditions ?? [];
          // ★ 只认「去掉了 fieldType 的 contains 条件」；带 fieldType 的 is 条件一律返回 0（误解析）
          const typed = conds.some((c) => c.fieldType !== undefined);
          if (typed) return { records: [], total: 0, hasMore: false };
          const want = conds.filter((c) => c.operator === 'contains').map((c) => String(c.value));
          // 值字段 contains + 条件字段 contains 都命中才返回
          const hitVal = want[want.length - 1];
          const hitCond = want[0];
          if (hitVal && MODULES.includes(hitVal) && hitCond === '企企云') {
            return {
              records: [{ recordId: 'r1', fields: { [COND]: '企企云', [VAL2]: hitVal } }],
              total: 1,
              hasMore: false,
            };
          }
          return { records: [], total: 0, hasMore: false };
        },
      };
      selectBaseForTest({ base: { getTableById: async () => table, getTableMetaList: async () => [{ id: 'tbl26b' }] } });
      invalidateTableRecords();
      const r = await enumerateOptionsByProbe('tbl26b', VAL2, SPEC).promise;
      check(
        'F26 typed 条件被误解析时宽松复核兜住（不判假空）',
        r.values.length === MODULES.length && r.complete === true,
        { values: r.values, complete: r.complete, error: r.error }
      );
    }

    // 5) 条件字段类型未记录（旧配置）时，多选条件也按「含该选项」判定（否则整表被筛空）
    {
      const PROV_M = 'fldProvM';
      const CITY_M = 'fldCityM';
      const src = await (async () => {
        const rows = [
          { recordId: 'x1', fields: { [PROV_M]: [{ text: '浙江省' }, { text: '江苏省' }], [CITY_M]: '杭州' } },
          { recordId: 'x2', fields: { [PROV_M]: [{ text: '江苏省' }], [CITY_M]: '南京' } },
        ];
        const table = {
          getFieldMetaList: async () => [{ id: CITY_M, name: '市', type: FieldType.Text }],
          getRecordsByPage: async ({ pageToken }) => {
            const start = pageToken === undefined ? 0 : Number(pageToken);
            const slice = rows.slice(start, start + 200);
            return { records: slice, total: rows.length, hasMore: false };
          },
        };
        selectBaseForTest({ base: { getTableById: async () => table, getTableMetaList: async () => [{ id: 'tblM' }] } });
        invalidateTableRecords();
        // 条件字段多选但 sourceFieldType 未记录（undefined）
        return await enumerateRefOptions('tblM', CITY_M, [{ fieldId: PROV_M, text: '浙江省' }]).promise;
      })();
      check(
        'F26 多选条件字段类型未记录时仍按「含该选项」判定（不整表筛空）',
        src.values.join(',') === '杭州',
        { values: src.values }
      );
    }
  }

  /* ============================================================
   * F27 引用的「多选取值字段」拆分为独立单选项（2026-10-21 用户需求 2）
   *
   * 需求：引用的取值字段是**多选**时，也要能被识别，并引用成为**单选**的选项。
   * 症状（修复前）：多选单元格 [{text:'A'},{text:'B'}] 被 stringifyCellValue
   *      join 成 "A B"，当成**一个**选项 → 引用到单选控件后无法单独选中。
   * ============================================================ */
  {
    const VAL = 'fldMs27';
    const COND = 'fldLine27';
    const OPT = ['模组一', '模组二', '模组三'];

    const rows = [];
    for (let i = 0; i < 3000; i += 1) {
      rows.push({
        recordId: `m${i}`,
        fields: {
          [COND]: '企企云',
          [VAL]: [{ text: OPT[i % 3] }, { text: OPT[(i + 1) % 3] }],
        },
      });
    }
    const table = {
      getFieldMetaList: async () => [
        {
          id: VAL,
          name: '模组名称',
          type: FieldType.MultiSelect,
          property: { options: OPT.map((n, i) => ({ id: `o${i}`, name: n })) },
        },
        { id: COND, name: '产品线', type: FieldType.SingleSelect, property: { options: [] } },
      ],
      getRecordsByPage: async ({ filter, pageSize, pageToken }) => {
        // 无 filter 时返回全部（走扫描路径）；带 filter 时按 contains 语义
        let all = rows;
        if (filter) {
          for (const c of (filter.conditions ?? [])) {
            all = all.filter((r) => {
              const raw = (r.fields ?? {})[c.fieldId];
              const t = Array.isArray(raw)
                ? raw.map((x) => x?.text ?? '').filter(Boolean).join(' ')
                : String(raw ?? '');
              return c.operator === 'contains' ? t.includes(String(c.value)) : t === String(c.value);
            });
          }
        }
        const start = pageToken === undefined ? 0 : Number(pageToken);
        const n = pageSize ?? 200;
        const slice = all.slice(start, start + n);
        const next = start + n;
        return {
          records: slice,
          total: all.length,
          hasMore: next < all.length,
          pageToken: next < all.length ? String(next) : undefined,
        };
      },
    };
    selectBaseForTest({ base: { getTableById: async () => table, getTableMetaList: async () => [{ id: 'tblMs27' }] } });
    invalidateTableRecords();

    // 1) extractOptionTexts：多选按类型拆分
    check(
      'F27 extractOptionTexts 多选单元格拆成多个独立选项（不 join）',
      extractOptionTexts([{ text: 'A' }, { text: 'B' }], FieldType.MultiSelect).join(',') === 'A,B',
      null
    );
    check(
      'F27 extractOptionTexts 单选/未给类型时不拆（保持单值语义）',
      extractOptionTexts([{ text: 'A' }, { text: 'B' }], FieldType.SingleSelect).join(',') === 'A B' &&
        extractOptionTexts('杭州').join(',') === '杭州',
      null
    );

    // 2) 统一入口：多选取值字段 → 三个独立选项，且无合并串
    {
      const r = await enumerateRefOptions('tblMs27', VAL, [
        { fieldId: COND, text: '企企云', fieldType: FieldType.SingleSelect },
      ], { valueFieldType: FieldType.MultiSelect }).promise;
      check(
        'F27 多选取值字段穷举出 3 个独立选项（可被引用到单选控件）',
        r.values.length === 3 && OPT.every((o) => r.values.includes(o)),
        { values: r.values, source: r.source }
      );
      check(
        'F27 不再产出「模组一 模组二」这类合并串',
        !r.values.some((v) => /\s/.test(v)),
        r.values
      );
    }

    // 3) 扫描路径（模拟选项域不可用）：同样按类型拆分
    {
      invalidateTableRecords();
      const r = await scanDistinctValues(
        'tblMs27',
        VAL,
        [{ fieldId: COND, text: '企企云', fieldType: FieldType.SingleSelect }],
        { valueFieldType: FieldType.MultiSelect }
      ).promise;
      check(
        'F27 渐进扫描路径同样拆多选（不依赖选项域）',
        r.values.length === 3 && !r.values.some((v) => /\s/.test(v)),
        { values: r.values }
      );
    }

    // 4) 本地兜底筛路径（resolveRefOptions）也拆多选
    {
      const vals = resolveRefOptions(
        {
          tableId: 'tblMs27',
          fieldId: VAL,
          fieldType: FieldType.MultiSelect,
          conditions: [{ sourceFieldId: COND, valueSource: 'static', staticValue: '企企云', sourceFieldType: FieldType.SingleSelect }],
        },
        [
          { fields: { [COND]: '企企云', [VAL]: [{ text: '模组一' }, { text: '模组二' }] } },
          { fields: { [COND]: '产品B', [VAL]: [{ text: '模组九' }] } },
        ],
        {}
      );
      check(
        'F27 本地兜底筛（resolveRefOptions）同样拆多选且按条件过滤',
        vals.join(',') === '模组一,模组二',
        vals
      );
    }

    // 5) 配置侧必须记录取值字段类型（否则多选拆分无从判断）
    {
      const fs27 = await import('node:fs');
      const optRefEditorSrc = fs27.readFileSync(
        new URL('../src/components/ConfigPanel/OptionRefEditor.tsx', import.meta.url),
        'utf8'
      );
      check(
        'F27 配置侧记录取值字段类型（onSave 带 fieldType）',
        /onSave\(\{\s*tableId,\s*fieldId,\s*fieldType/.test(optRefEditorSrc) &&
          /setFieldType\(/.test(optRefEditorSrc),
        null
      );
      const typesSrc = fs27.readFileSync(new URL('../src/types/index.ts', import.meta.url), 'utf8');
      check(
        'F27 OptionReference 增加 fieldType 字段（随配置持久化）',
        /interface OptionReference[\s\S]{0,600}fieldType\?: FieldType/.test(typesSrc),
        null
      );
    }
  }

  /* ============================================================
   * F28 有条件引用选项「计算慢」修复（2026-10-21 用户实测第二轮反馈）
   *
   * 症状：选了上级字段后，子级下拉长时间停在「正在穷举选项…已扫描 0 条」，
   *      很久（实测十几秒）才刷出选项。用户原话：
   *      「按道理有了条件直接查询应该是很快的啊」—— 用户是对的。
   *
   * 根因（端到端复现确认，见 .workbuddy/memory/2026-10-21.md）：
   *   ① 旧实现在有条件下**首选逐项存在性探测**，请求数 = **选项域大小**：
   *      200 个选项 → 200 次请求（并发 8，按 200ms/请求 ≈ 5s）；
   *   ② 若宿主对 typed 条件「假空」（本项目已知坑），还要再跑 200 次**宽松复核**
   *      才回退扫描 → 400 次请求 ≈ 10s，期间 onScanProgress **一次都不回调**
   *      → UI 全程「已扫描 0 条」，用户以为卡死。
   *
   * 修复：有条件改为**「直接查询」优先**（filter 只放条件字段、每页 200 行、
   *      本地自证、选项域找齐即停）—— 请求量 ∝ 匹配行数，不是选项域大小；
   *      不可信 / 两级空才回退扫描，且扫描也支持「找齐即停」。
   * ============================================================ */
  {
    const PROV = 'fldProv28';
    const VAL = 'fldVal28';

    /**
     * @param {object} o
     *  o.totalRows  满足条件的行数
     *  o.domainSize 值字段选项域大小
     *  o.filterMode 'ok' | 'empty'(带 filter 一律 0 条 = 假空) | 'ignore'(忽略 filter)
     *  o.interleave 把不满足条件的行**交错**在满足条件的行之间（模拟真实表），
     *               使「忽略 filter」能被首屏本地自证立刻发现
     */
    function makeBase28({ totalRows = 20000, domainSize = 200, filterMode = 'ok', interleave = false } = {}) {
      const calls = { meta: 0, page: 0 };
      const domain = Array.from({ length: domainSize }, (_, i) => `模组${i}`);
      const rows = [];
      for (let i = 0; i < totalRows; i += 1) {
        const prov = interleave && i % 2 === 1 ? '产品B' : '企企云';
        rows.push({ recordId: `m${i}`, fields: { [PROV]: prov, [VAL]: domain[i % domainSize] } });
      }
      if (!interleave) {
        for (let i = 0; i < 300; i += 1) {
          rows.push({ recordId: `x${i}`, fields: { [PROV]: '产品B', [VAL]: domain[i % domainSize] } });
        }
      }
      const table = {
        getFieldMetaList: async () => {
          calls.meta += 1;
          return [
            { id: VAL, name: '模组', type: FieldType.SingleSelect, property: { options: domain.map((n, i) => ({ id: `o${i}`, name: n })) } },
            { id: PROV, name: '产品线', type: FieldType.SingleSelect, property: { options: [] } },
          ];
        },
        getRecordsByPage: async ({ filter, pageSize, pageToken }) => {
          calls.page += 1;
          let all = rows;
          if (filter) {
            if (filterMode === 'empty') all = [];
            else if (filterMode === 'ignore') all = rows;
            else if (filterMode === 'typed-empty') {
              // 带 fieldType 的条件返回 0 条（假空），宽松条件正常生效
              const typed = (filter.conditions ?? []).some((c) => c.fieldType !== undefined);
              all = typed
                ? []
                : rows.filter((r) => (filter.conditions ?? []).every((c) => {
                    const v = String((r.fields ?? {})[c.fieldId] ?? '');
                    return c.operator === 'contains' ? v.includes(String(c.value)) : v === String(c.value);
                  }));
            } else {
              all = rows.filter((r) => (filter.conditions ?? []).every((c) => {
                const v = String((r.fields ?? {})[c.fieldId] ?? '');
                return c.operator === 'contains' ? v.includes(String(c.value)) : v === String(c.value);
              }));
            }
          }
          const start = pageToken === undefined ? 0 : Number(pageToken);
          const n = pageSize ?? 200;
          const slice = all.slice(start, start + n);
          const next = start + n;
          return { records: slice, total: all.length, hasMore: next < all.length, pageToken: next < all.length ? String(next) : undefined };
        },
      };
      return { base: { getTableById: async () => table, getTableMetaList: async () => [{ id: 'tbl28' }] }, calls };
    }

    const SPEC28 = [{ fieldId: PROV, text: '企企云', fieldType: FieldType.SingleSelect }];

    // 1) ★ 核心：有条件下请求量必须 ∝ 匹配行数，**不得** ∝ 选项域大小
    {
      const { base, calls } = makeBase28({ totalRows: 30, domainSize: 200, filterMode: 'ok' });
      selectBaseForTest({ base });
      invalidateTableRecords();
      const r = await enumerateRefOptions('tbl28', VAL, SPEC28, { valueFieldType: FieldType.SingleSelect }).promise;
      check(
        'F28 有条件下走「直接查询」而非逐项探测（请求数与选项域大小无关）',
        r.source === 'query' && calls.page === 1,
        { source: r.source, pageCalls: calls.page, domainSize: 200, values: r.values.length }
      );
      check(
        'F28 命中 30 行 → 1 页即完，全部 30 个选项取到',
        r.values.length === 30 && r.complete === true,
        { values: r.values.length, complete: r.complete }
      );
      check('F28 未发出任何存在性探测（probes=0）', r.probes === 0, r.probes);
    }

    // 2) ★ 进度可观测：直接查询也必须回调扫描进度（修「已扫描 0 条」的观感根因）
    {
      const { base, calls } = makeBase28({ totalRows: 20000, domainSize: 200, filterMode: 'ok' });
      selectBaseForTest({ base });
      invalidateTableRecords();
      const seen = [];
      const r = await enumerateRefOptions('tbl28', VAL, SPEC28, {
        valueFieldType: FieldType.SingleSelect,
        onScanProgress: (s) => seen.push(s),
      }).promise;
      check(
        'F28 直接查询期间有进度回调（UI 不再全程「已扫描 0 条」）',
        seen.length > 0 && seen[seen.length - 1] > 0,
        { progressSamples: seen.length, last: seen[seen.length - 1] ?? null, source: r.source }
      );
      check(
        'F28 选项域 200 且取值覆盖 → 首屏（选项域找齐）即判完整、不白扫大表',
        r.source === 'query' && r.complete === true && calls.page === 1 && r.values.length === 200,
        { source: r.source, pageCalls: calls.page, values: r.values.length, complete: r.complete }
      );
    }

    // 3) 假空（typed+loose 都 0 条）→ 仍**必须**回退扫描拿到全部选项（首轮修复不得回归）
    {
      const { base, calls } = makeBase28({ totalRows: 20000, domainSize: 200, filterMode: 'empty' });
      selectBaseForTest({ base });
      invalidateTableRecords();
      const r = await enumerateRefOptions('tbl28', VAL, SPEC28, { valueFieldType: FieldType.SingleSelect }).promise;
      check(
        'F28 假空时回退扫描并取到全部 200 个选项（首轮修复不回归）',
        r.values.length === 200 && r.complete === true,
        { values: r.values.length, source: r.source, complete: r.complete }
      );
    }

    // 4) 假空回退扫描时「找齐即停」：选项域小、取值集中在前面几页 → 不得扫全表
    {
      const { base, calls } = makeBase28({ totalRows: 20000, domainSize: 8, filterMode: 'empty' });
      selectBaseForTest({ base });
      invalidateTableRecords();
      const r = await enumerateRefOptions('tbl28', VAL, SPEC28, { valueFieldType: FieldType.SingleSelect }).promise;
      check(
        'F28 假空回退扫描时「选项域找齐即停」（不为 8 个选项白扫 2 万行）',
        r.values.length === 8 && r.complete === true && calls.page < 20,
        { values: r.values.length, pageCalls: calls.page, complete: r.complete }
      );
    }

    // 5) typed 条件被误解析、宽松可用的宿主 → 直接查询的宽松复核兜住
    {
      const { base } = makeBase28({ totalRows: 50, domainSize: 12, filterMode: 'typed-empty' });
      selectBaseForTest({ base });
      invalidateTableRecords();
      const r = await enumerateRefOptions('tbl28', VAL, SPEC28, { valueFieldType: FieldType.SingleSelect }).promise;
      check(
        'F28 typed 条件假空但宽松可用 → 直接查询宽松复核兜住（12 个选项全出）',
        r.values.length === 12 && r.complete === true,
        { values: r.values.length, source: r.source, complete: r.complete }
      );
    }

    // 6) 宿主忽略 filter → 直接查询自证失败 → 回退扫描，仍得正确选项
    {
      const { base } = makeBase28({ totalRows: 300, domainSize: 3, filterMode: 'ignore', interleave: true });
      selectBaseForTest({ base });
      invalidateTableRecords();
      const r = await enumerateRefOptions('tbl28', VAL, SPEC28, { valueFieldType: FieldType.SingleSelect }).promise;
      check(
        'F28 宿主忽略 filter → 直接查询自证失败并回退扫描，仍得该条件下 3 个选项',
        r.source === 'scan' &&
          r.values.length === 3 &&
          ['模组0', '模组1', '模组2'].every((o) => r.values.includes(o)) &&
          r.complete === true,
        { source: r.source, values: r.values }
      );
    }

    // 7) 静态保障：统一入口必须有「直接查询」源标记（否则被回退成慢路径无人知）
    {
      const fs28 = await import('node:fs');
      const cache28 = fs28.readFileSync(new URL('../src/services/tableRecordCache.ts', import.meta.url), 'utf8');
      check(
        'F28 统一入口含「直接查询」引擎（source: query）',
        /queryDistinctByConditions/.test(cache28) && /source:\s*'query'/.test(cache28),
        null
      );
      check(
        'F28 扫描引擎支持「选项域找齐即停」（declaredOptions）',
        /declaredOptions/.test(cache28) && /stoppedEarly/.test(cache28),
        null
      );
    }
  }

  /* ============================================================
   * F29 表单内跨区块取值（formFieldRef）—— 2026-10-21 新增的**可选**功能
   *
   * 需求：某子表字段的选项，来自**同一张表单中另一个区块**（主表 / 另一张子表）
   *      用户**已录入**的值（例：合同主表下 3 条产品明细 → 收款计划的「产品」只出这 3 个）。
   *
   * ★ 与 optionRef 完全并列、互不干扰：
   *   - 纯本地计算、**零网络请求**（断言 API 调用数为 0）；
   *   - formRef 优先于 optionRef，未配置时行为与今日**完全一致**（零破坏）；
   *   - 新增持久化字段必须登记进 configSize 白名单，否则「配置者保存成功、别人打开静默失效」。
   * ============================================================ */
  {
    const {
      buildFormScope,
      hasFormRef,
      resolveOptionMode,
      collectFormRefOptions,
      formHasAnyFormRef,
      formRefValuesSignature,
      canBeRefSource,
      describeRefSource,
    } = await import('../src/utils/formFieldRef.ts');

    const T_MAIN = 'tblMain29';
    const T_SUB_A = 'tblSubA29';
    const T_SUB_B = 'tblSubB29';
    const F_PROD = 'fldProd29'; // 子表A 的产品（单选）
    const F_TAGS = 'fldTags29'; // 子表A 的标签（多选）
    const F_PLAN = 'fldPlan29'; // 子表B 的产品（要被引用的字段）
    const F_REGION = 'fldRegion29'; // 主表的大区（单选）

    const mainFields = [
      { fieldId: F_REGION, fieldName: '大区', fieldType: FieldType.SingleSelect, visible: true, required: false },
      { fieldId: F_PLAN, fieldName: '产品', fieldType: FieldType.SingleSelect, visible: true, required: false },
    ];
    const subA = {
      tableId: T_SUB_A,
      fields: [
        { fieldId: F_PROD, fieldName: '产品', fieldType: FieldType.SingleSelect, visible: true, required: false },
        { fieldId: F_TAGS, fieldName: '标签', fieldType: FieldType.MultiSelect, visible: true, required: false },
      ],
    };
    const subTables = [
      subA,
      {
        tableId: T_SUB_B,
        fields: [
          { fieldId: F_PLAN, fieldName: '产品', fieldType: FieldType.SingleSelect, visible: true, required: false },
        ],
      },
    ];
    const mainValues = { [F_REGION]: '华东', [F_PLAN]: '主表产品X' };
    const subValues = {
      [T_SUB_A]: [
        { [F_PROD]: '产品甲', [F_TAGS]: [{ text: '红' }, { text: '蓝' }] },
        { [F_PROD]: '产品乙', [F_TAGS]: [{ text: '蓝' }] },
        { [F_PROD]: '产品甲', [F_TAGS]: [] }, // 重复值 → 必须去重
        { [F_PROD]: '', [F_TAGS]: [] }, // 空值 → 必须跳过
      ],
      [T_SUB_B]: [{ [F_PLAN]: '' }],
    };
    const scope = buildFormScope(T_MAIN, mainValues, subValues, subTables, {
      mainFields,
      blockLabels: { [T_MAIN]: '合同', [T_SUB_A]: '产品明细', [T_SUB_B]: '收款计划' },
    });

    // 1) 子表 → 其他子表：遍历全部行、去重、保序、跳过空值
    {
      const field = {
        fieldId: F_PLAN,
        fieldName: '产品',
        fieldType: FieldType.SingleSelect,
        visible: true,
        required: false,
        formRef: { sourceTableId: T_SUB_A, sourceFieldId: F_PROD },
      };
      const opts = collectFormRefOptions(field.formRef, scope);
      check(
        'F29 子表→子表：取来源全部行的值并去重（产品甲/产品乙，顺序稳定）',
        opts.join(',') === '产品甲,产品乙',
        opts
      );
      check('F29 子表→子表：空单元格被跳过（不产生空选项）', !opts.includes(''), opts);
      check('F29 resolveOptionMode 判定为 formRef', resolveOptionMode(field) === 'formRef', null);
      check('F29 hasFormRef 识别完整配置', hasFormRef(field) === true, null);
    }

    // 2) 子表 → 主表：取主表该字段的单个值
    {
      const field = {
        fieldId: F_PLAN,
        fieldName: '产品',
        fieldType: FieldType.SingleSelect,
        visible: true,
        required: false,
        formRef: { sourceTableId: T_MAIN, sourceFieldId: F_REGION },
      };
      const opts = collectFormRefOptions(field.formRef, scope);
      check('F29 子表→主表：取主表字段的单值', opts.join(',') === '华东', opts);
    }

    // 3) 来源字段是多选 → 单元格拆成多个独立选项（复用 extractOptionTexts）
    {
      const field = {
        fieldId: F_PLAN,
        fieldName: '产品',
        fieldType: FieldType.SingleSelect,
        visible: true,
        required: false,
        formRef: { sourceTableId: T_SUB_A, sourceFieldId: F_TAGS, sourceFieldType: FieldType.MultiSelect },
      };
      const opts = collectFormRefOptions(field.formRef, scope);
      check('F29 来源是多选 → 按单元格拆成独立选项（红/蓝）', opts.join(',') === '红,蓝', opts);
      // 同样的数据、类型未记录（旧配置）→ 保持单值，绝不误拆
      const legacy = collectFormRefOptions({ ...field.formRef, sourceFieldType: undefined }, scope);
      check(
        'F29 多选类型未记录（旧配置）→ 不拆，退化为整格文本（零迁移）',
        legacy.length === 2 && legacy.every((v) => typeof v === 'string') && legacy[0] !== '红',
        legacy
      );
    }

    // 4) aggregate='single'：只取来源的第一条非空值
    {
      const single = collectFormRefOptions(
        { sourceTableId: T_SUB_A, sourceFieldId: F_PROD, aggregate: 'single' },
        scope
      );
      check('F29 aggregate=single 只取第一个非空值', single.join(',') === '产品甲', single);
    }

    // 5) 来源区块无行 / 空作用域 → 空集（不抛错）
    {
      check('F29 作用域为 null 时返回空集（不抛错）', collectFormRefOptions({ sourceTableId: T_SUB_A, sourceFieldId: F_PROD }, null).length === 0, null);
      const emptyScope = buildFormScope(T_MAIN, {}, {}, subTables, { mainFields });
      check(
        'F29 来源子表无行 → 空集',
        collectFormRefOptions({ sourceTableId: T_SUB_A, sourceFieldId: F_PROD }, emptyScope).length === 0,
        null
      );
    }

    // 6) ★ 零破坏：未配置 formRef 时判定为 optionRef / static，与今日完全一致
    {
      check(
        'F29 未配置 formRef 且无 optionRef → static（固定选项，行为不变）',
        resolveOptionMode({ fieldId: 'x', fieldName: 'x', fieldType: FieldType.SingleSelect, visible: true, required: false }) === 'static',
        null
      );
      check(
        'F29 未配置 formRef 但配置了 optionRef → optionRef（原路径不变）',
        resolveOptionMode({
          fieldId: 'x',
          fieldName: 'x',
          fieldType: FieldType.SingleSelect,
          visible: true,
          required: false,
          optionRef: { tableId: 't', fieldId: 'f', conditions: [] },
        }) === 'optionRef',
        null
      );
      check(
        'F29 两者都配置 → formRef 优先（互不干扰、优先级确定）',
        resolveOptionMode({
          fieldId: 'x',
          fieldName: 'x',
          fieldType: FieldType.SingleSelect,
          visible: true,
          required: false,
          optionRef: { tableId: 't', fieldId: 'f', conditions: [] },
          formRef: { sourceTableId: T_SUB_A, sourceFieldId: F_PROD },
        }) === 'formRef',
        null
      );
      check(
        'F29 formRef 配置不完整（缺 sourceFieldId）→ 视为未配置（不抢 optionRef）',
        resolveOptionMode({
          fieldId: 'x',
          fieldName: 'x',
          fieldType: FieldType.SingleSelect,
          visible: true,
          required: false,
          optionRef: { tableId: 't', fieldId: 'f', conditions: [] },
          formRef: { sourceTableId: T_SUB_A, sourceFieldId: '' },
        }) === 'optionRef',
        null
      );
    }

    // 7) ★ formHasAnyFormRef：决定「是否构建并下传作用域」——旧配置必须为假（渲染路径零变化）
    {
      check(
        'F29 无 formRef 的表单 → formHasAnyFormRef=false（不构建作用域，旧路径零变化）',
        formHasAnyFormRef(mainFields, subTables) === false,
        null
      );
      const withRef = [
        { ...subTables[0] },
        {
          ...subTables[1],
          fields: [
            {
              ...subTables[1].fields[0],
              formRef: { sourceTableId: T_SUB_A, sourceFieldId: F_PROD },
            },
          ],
        },
      ];
      check('F29 任一字段配了 formRef → formHasAnyFormRef=true', formHasAnyFormRef(mainFields, withRef) === true, null);
    }

    // 8) ★ memo 保命线：作用域值签名只随「被引用的字段值」变化
    {
      const withRef = [
        subA,
        {
          ...subTables[1],
          fields: [
            {
              ...subTables[1].fields[0],
              formRef: { sourceTableId: T_SUB_A, sourceFieldId: F_PROD },
            },
          ],
        },
      ];
      const sigOf = (mv, sv) => formRefValuesSignature(T_MAIN, mainFields, mv, withRef, sv);
      const s0 = sigOf(mainValues, subValues);
      // 改「未被引用」的主表值 → 签名必须不变（否则 typed 时 memo 会被穿透）
      const s1 = sigOf({ ...mainValues, [F_PLAN]: '改了个无关的值' }, subValues);
      check('F29 改未被引用的字段 → 作用域签名不变（不穿透 React.memo）', s0 === s1, null);
      // 改「被引用」的来源字段值 → 签名必须变化（否则选项不更新）
      const s2 = sigOf(mainValues, {
        ...subValues,
        [T_SUB_A]: [{ [F_PROD]: '产品丙', [F_TAGS]: [] }],
      });
      check('F29 改被引用的来源字段 → 作用域签名变化（选项实时更新）', s0 !== s2, null);
      // 未被引用字段的**新增行**（其它列变化）也要保持稳定
      const s3 = sigOf(mainValues, {
        ...subValues,
        [T_SUB_B]: [{ [F_PLAN]: '随便填' }],
      });
      check('F29 改动非来源区块 → 签名不变', s0 === s3, null);
      // 无 formRef 的表单 → 签名恒为空串（不构建作用域）
      check(
        'F29 表单无 formRef → 签名恒为空（短路，不做任何遍历开销）',
        formRefValuesSignature(T_MAIN, mainFields, mainValues, subTables, subValues) === '',
        null
      );
    }

    // 9) 来源字段候选过滤：不可产出选项的类型（附件/人员等）不得作为来源
    {
      check('F29 单选/多选/文本可作为取值来源', canBeRefSource(FieldType.SingleSelect) && canBeRefSource(FieldType.MultiSelect) && canBeRefSource(FieldType.Text), null);
      check('F29 附件/人员不可作为取值来源（无法产出选项文本）', !canBeRefSource(FieldType.Attachment) && !canBeRefSource(FieldType.User), null);
    }

    // 10) 来源描述（UI 文案）：能拿到配置时给出「区块·字段」
    {
      const desc = describeRefSource({ sourceTableId: T_SUB_A, sourceFieldId: F_PROD }, scope);
      check('F29 来源描述包含区块名与字段名', desc === '产品明细·产品', desc);
      const descMain = describeRefSource({ sourceTableId: T_MAIN, sourceFieldId: F_REGION }, scope);
      check('F29 主表来源描述正确', descMain === '合同·大区', descMain);
    }

    // 11) ★ 零网络请求：整条链路不得触发任何 Base API（本地纯计算）
    {
      const calls = { field: 0, record: 0, table: 0 };
      const trapBase = {
        getTableList: async () => {
          calls.table += 1;
          return [];
        },
        getTable: (id) => ({
          getFieldMetaList: async () => {
            calls.field += 1;
            return [];
          },
          getRecordsByPage: async () => {
            calls.record += 1;
            return { records: [], hasMore: false };
          },
          getFieldValueListByPage: async () => {
            calls.field += 1;
            return { values: [], hasMore: false };
          },
        }),
      };
      selectBaseForTest({ base: trapBase });
      const field = {
        fieldId: F_PLAN,
        fieldName: '产品',
        fieldType: FieldType.SingleSelect,
        visible: true,
        required: false,
        formRef: { sourceTableId: T_SUB_A, sourceFieldId: F_PROD },
      };
      const opts = collectFormRefOptions(field.formRef, scope);
      check(
        'F29 取值链路零网络请求（纯本地）',
        opts.length === 2 && calls.table === 0 && calls.field === 0 && calls.record === 0,
        { opts, calls }
      );
    }

    // 12) ★ 持久化登记：formRef 必须在 configSize 白名单里，否则「配好保存成功、别人打开静默失效」
    {
      const fs29 = await import('node:fs');
      const sizeSrc = fs29.readFileSync(new URL('../src/services/configSize.ts', import.meta.url), 'utf8');
      check('F29 configSize KEEP_FIELDS 登记了 formRef（防瘦身剥离）', /'formRef'/.test(sizeSrc), null);
      check('F29 configSize untrimField 还原 formRef', /formRef:\s*stub\.formRef/.test(sizeSrc), null);

      // 端到端：序列化 → 反序列化，formRef 必须原样存活
      const cfg = {
        forms: [
          {
            id: 'f1',
            version: 1,
            formTitle: 't',
            formDescription: '',
            themeColor: '#000',
            mainTable: { tableId: T_MAIN, tableName: '合同', sectionName: '', fields: mainFields },
            subTables: [
              {
                tableId: T_SUB_B,
                linkFieldId: 'lk',
                sectionName: '',
                allowMultiple: true,
                maxRows: 10,
                layout: 'vertical',
                fields: [
                  {
                    fieldId: F_PLAN,
                    fieldName: '产品',
                    fieldType: FieldType.SingleSelect,
                    visible: true,
                    required: false,
                    options: [{ id: 'o1', name: '枚举带来的选项' }],
                    formRef: {
                      sourceTableId: T_SUB_A,
                      sourceFieldId: F_PROD,
                      sourceFieldType: FieldType.SingleSelect,
                      aggregate: 'distinctSet',
                    },
                  },
                ],
              },
            ],
            conditionalRules: [],
          },
        ],
        defaultFormId: 'f1',
      };
      const thin = serializeConfig(cfg);
      const thinField = thin.forms[0].subTables[0].fields[0];
      check(
        'F29 序列化后 formRef 完整保留（含 sourceFieldType / aggregate）',
        thinField.formRef &&
          thinField.formRef.sourceTableId === T_SUB_A &&
          thinField.formRef.sourceFieldId === F_PROD &&
          thinField.formRef.sourceFieldType === FieldType.SingleSelect &&
          thinField.formRef.aggregate === 'distinctSet',
        thinField.formRef
      );
      check(
        'F29 运行时可重取的 options 仍被剥离（瘦身不受影响）',
        thinField.options === undefined && thinField.fieldName === undefined,
        { options: thinField.options, fieldName: thinField.fieldName }
      );
      const bytes = new (await import('node:buffer')).Buffer.from(JSON.stringify(thin)).length;
      check('F29 体积远小于 10240 上限（formRef 体积极小）', bytes < 4096, { bytes });
    }

    // 13) ★ 静态保障：渲染层与配置层的接线（防止未来重构把入口悄悄摘掉）
    {
      const fs29 = await import('node:fs');
      const read29 = (rel) => fs29.readFileSync(new URL(rel, import.meta.url), 'utf8');
      const fieldRenderer = read29('../src/components/FormRenderer/FieldRenderer.tsx');
      check(
        'F29 FieldRenderer 按 resolveOptionMode 分流（唯一判断入口）',
        /resolveOptionMode\(field\)/.test(fieldRenderer) && /optionMode === 'formRef'/.test(fieldRenderer),
        null
      );
      check(
        'F29 FieldRenderer 渲染 FormRefSelect 并传入 scope',
        /FormRefSelect/.test(fieldRenderer) && /scope=\{formScope/.test(fieldRenderer),
        null
      );
      check(
        'F29 未配置 formRef 时 optionRef 路径保持不变（零破坏证据：仍走 RefOptionSelect）',
        // optionRef 分流分支必须仍然存在，且 preview 屏蔽仍只针对真正的 optionRef（不是 formRef）
        /optionMode === 'optionRef'/.test(fieldRenderer) &&
          /<RefOptionSelect/.test(fieldRenderer) &&
          /optionMode === 'optionRef' && hasOptionRef\(field\)/.test(fieldRenderer),
        null
      );
      const formRenderer = read29('../src/components/FormRenderer/index.tsx');
      check(
        'F29 FormRenderer 仅在 formHasAnyFormRef 为真时构建作用域（旧配置零变化）',
        /formHasAnyFormRef\(/.test(formRenderer) && /if \(!hasFormRefFeature\) return null/.test(formRenderer),
        null
      );
      check(
        'F29 作用域身份由「值签名」守门（不穿透 React.memo）',
        /formRefValuesSignature\(/.test(formRenderer) && /formRefSig/.test(formRenderer),
        null
      );
      check(
        'F29 三个表单组件均透传 formScope',
        /formScope=\{formScope/.test(read29('../src/components/FormRenderer/MainForm.tsx')) &&
          /formScope=\{formScope/.test(read29('../src/components/FormRenderer/SubForm.tsx')) &&
          /formScope=\{formScope/.test(read29('../src/components/FormRenderer/SubFormTable.tsx')),
        null
      );
      // FormRefSelect 必须零请求：不得出现任何服务端读取调用 / 服务端模块 import
      const formRefSelect = read29('../src/components/FormRenderer/FormRefSelect.tsx');
      check(
        'F29 FormRefSelect 不含任何服务端读取（零请求控件）',
        !/enumerateRefOptions|searchAllRows|getRecordsByPage|loadRowsByConditions|tableRecordCache|optionRef'/.test(
          formRefSelect
        ),
        null
      );
      const cfgList = read29('../src/components/ConfigPanel/FieldConfigList.tsx');
      check(
        'F29 配置面板有「表单取值」入口，且未传 otherBlocks 时不显示（旧调用方零变化）',
        /FormRefEditor/.test(cfgList) && /formRefAvailable/.test(cfgList) && /otherBlocks\?\.length/.test(cfgList),
        null
      );
      const cfgPanel = read29('../src/components/ConfigPanel/index.tsx');
      check(
        'F29 ConfigPanel 把全部区块作为来源候选下传',
        /refBlocks/.test(cfgPanel) && /otherBlocks=\{refBlocks\}/.test(cfgPanel),
        null
      );
      const refEditor = read29('../src/components/ConfigPanel/FormRefEditor.tsx');
      check(
        'F29 来源候选排除当前区块（防自引用）',
        /b\.tableId !== currentTableId/.test(refEditor) || /otherBlocks \?\? \[\]\)\.filter/.test(refEditor),
        null
      );
    }

    // 14) ★ 端到端复现（真实渲染）：静态正则查不出「配置了 formRef 的字段实际渲染成了哪个控件」，
    //     必须真渲染一次，断言两条路径的**实际输出**互不相同且各自正确。
    {
      const React = (await import('react')).default;
      // ★ 必须用 server.browser 入口：`react-dom/server` 在 platform=node 下会解析到
      //   server.node.js，它 `require('stream')` —— 在 ESM bundle 里是 "Dynamic require
      //   not supported"（bundle 无法内联 Node 内置模块）。browser 入口无此依赖。
      const { renderToStaticMarkup } = await import('react-dom/server.browser');
      const { FieldRenderer } = await import('../src/components/FormRenderer/FieldRenderer.tsx');

      const t_a = 'tblSubA29';
      const f_prod = 'fldProd29';
      const f_plan = 'fldPlan29';
      const subs29 = [
        {
          tableId: t_a,
          fields: [{ fieldId: f_prod, fieldName: '产品', fieldType: FieldType.SingleSelect, visible: true, required: false }],
        },
        {
          tableId: T_SUB_B,
          fields: [{ fieldId: f_plan, fieldName: '产品', fieldType: FieldType.SingleSelect, visible: true, required: false }],
        },
      ];
      const sc = buildFormScope(
        T_MAIN,
        {},
        { [t_a]: [{ [f_prod]: '产品A' }, { [f_prod]: '产品B' }], [T_SUB_B]: [{}] },
        subs29,
        { mainFields: [], blockLabels: { [T_MAIN]: '合同', [t_a]: '产品明细' } }
      );
      const render = (f, extra = {}) =>
        renderToStaticMarkup(
          React.createElement(FieldRenderer, {
            field: f,
            value: '',
            onChange: () => {},
            tableId: T_SUB_B,
            formValues: {},
            ...extra,
          })
        );

      // ① 配了 formRef → 渲染本地取值控件（占位提示来自本功能，绝非引用选项的懒加载文案）
      const htmlRef = render({
        fieldId: f_plan,
        fieldName: '产品',
        fieldType: FieldType.SingleSelect,
        visible: true,
        required: false,
        formRef: { sourceTableId: t_a, sourceFieldId: f_prod, sourceFieldType: FieldType.SingleSelect },
      }, { formScope: sc });
      check('F29 端到端：formRef 字段渲染出选择控件', /semi-select/.test(htmlRef), { len: htmlRef.length });
      check(
        'F29 端到端：formRef 字段走本地取值文案（不是引用选项的「点击展开（加载全部选项）」）',
        /从上方已录入的值中选择/.test(htmlRef) && !/点击展开（加载全部选项）/.test(htmlRef),
        null
      );
      check('F29 端到端：formRef 字段不显示「已扫描 / 正在穷举」等加载态', !/已扫描|正在穷举/.test(htmlRef), null);

      // ② 未配置 formRef、配了 optionRef（旧配置）→ 仍走引用选项控件，文案不变（零破坏）
      //    ★ 这条是最关键的零破坏证据：同样的渲染器、同样的入参形状，只有 field 配置不同
      const htmlOpt = render({
        fieldId: f_plan,
        fieldName: '产品',
        fieldType: FieldType.SingleSelect,
        visible: true,
        required: false,
        optionRef: { tableId: t_a, fieldId: f_prod, conditions: [] },
      });
      check('F29 端到端：旧 optionRef 字段仍渲染选择控件（零破坏）', /semi-select/.test(htmlOpt), { len: htmlOpt.length });
      check(
        'F29 端到端：旧 optionRef 文案与今日一致（点击展开（加载全部选项））',
        /点击展开（加载全部选项）/.test(htmlOpt),
        null
      );
      check('F29 端到端：两条路径的实际输出互不相同（确实分流了）', htmlRef !== htmlOpt, null);

      // ③ 两者都配 → 必须渲染 formRef 那一套（优先级在渲染层的体现）
      const htmlBoth = render({
        fieldId: f_plan,
        fieldName: '产品',
        fieldType: FieldType.SingleSelect,
        visible: true,
        required: false,
        optionRef: { tableId: t_a, fieldId: f_prod, conditions: [] },
        formRef: { sourceTableId: t_a, sourceFieldId: f_prod, sourceFieldType: FieldType.SingleSelect },
      }, { formScope: sc });
      check(
        'F29 端到端：两者都配置 → 渲染 formRef 路径（优先级生效）',
        /从上方已录入的值中选择/.test(htmlBoth) && !/点击展开（加载全部选项）/.test(htmlBoth),
        null
      );

      // ④ 来源尚未录入 → 明确的占位提示（不空白、不报错）
      const emptySc = buildFormScope(T_MAIN, {}, { [t_a]: [{}], [T_SUB_B]: [{}] }, subs29, {
        mainFields: [],
        blockLabels: { [T_MAIN]: '合同', [t_a]: '产品明细' },
      });
      const htmlEmpty = render({
        fieldId: f_plan,
        fieldName: '产品',
        fieldType: FieldType.SingleSelect,
        visible: true,
        required: false,
        formRef: { sourceTableId: t_a, sourceFieldId: f_prod, sourceFieldType: FieldType.SingleSelect },
      }, { formScope: emptySc });
      check(
        'F29 端到端：来源尚未录入 → 提示「请先填写「产品明细·产品」」',
        /请先填写/.test(htmlEmpty) && /产品明细·产品/.test(htmlEmpty),
        null
      );

      // ⑤ 零请求：整条渲染链路（含 formRef 取值）不得触碰任何 Base API
      const apiCalls = { table: 0, field: 0, record: 0 };
      selectBaseForTest({
        base: {
          getTableList: async () => {
            apiCalls.table += 1;
            return [];
          },
          getTable: () => ({
            getFieldMetaList: async () => {
              apiCalls.field += 1;
              return [];
            },
            getRecordsByPage: async () => {
              apiCalls.record += 1;
              return { records: [], hasMore: false };
            },
            getFieldValueListByPage: async () => {
              apiCalls.field += 1;
              return { values: [], hasMore: false };
            },
          }),
        },
      });
      render(
        {
          fieldId: f_plan,
          fieldName: '产品',
          fieldType: FieldType.SingleSelect,
          visible: true,
          required: false,
          formRef: { sourceTableId: t_a, sourceFieldId: f_prod, sourceFieldType: FieldType.SingleSelect },
        },
        { formScope: sc }
      );
      check(
        'F29 端到端：渲染配置了 formRef 的表单零 Base API 调用',
        apiCalls.table === 0 && apiCalls.field === 0 && apiCalls.record === 0,
        apiCalls
      );
    }
  }

  /* ============================================================
   * F30 人员字段「默认值＝当前用户」—— 2026-10-22 新增的**可选**功能
   *
   * 需求：表单中可录入的人员字段（排除查找引用/公式）可设「默认值＝当前用户」；
   *      打开表单自动填入本人，填写人可自行改选/删除，**改过之后不再回填**。
   *
   * ★ 关键设计：
   *   1) 不能复用 `defaultValue` —— 它在配置者会话里同步求值，存下的是**配置者**的
   *      open_id，会把所有填写者默认成同一个人；必须运行时取「打开者」身份。
   *   2) 仅 `fieldType === User` 生效：Lookup / Formula 的 fieldType 不是 User，
   *      天然排除（符合「排除查找引用或公式字段」的要求）。
   *   3) 一次性初始化语义：done 集合守门，用户改过/清空后绝不回填。
   * ============================================================ */
  {
    const {
      hasUserDefault,
      listUserDefaultFields,
      formHasAnyUserDefault,
      applyUserDefaults,
      resetUserDefaultDone,
      isEmptyPersonValue,
    } = await import('../src/utils/userDefault.ts');

    const uf = (id, extra = {}) => ({
      fieldId: id, fieldName: id, fieldType: FieldType.User, visible: true, required: false, ...extra,
    });
    const MAIN_KEY = (fid) => `main:${fid}`;

    // 1) 识别：只有 User + 开关为真才算；查找引用/公式天然不成立
    check('F30 人员字段 + 开关 → 识别为默认当前用户', hasUserDefault(uf('u1', { defaultToCurrentUser: true })) === true, null);
    check('F30 人员字段未开开关 → 不识别（零变化）', hasUserDefault(uf('u1')) === false, null);
    check('F30 开关为 false → 不识别', hasUserDefault(uf('u1', { defaultToCurrentUser: false })) === false, null);
    check(
      'F30 查找引用(Lookup)字段即使误配开关也不生效',
      hasUserDefault({ fieldId: 'x', fieldName: 'x', fieldType: FieldType.Lookup, visible: true, required: false, defaultToCurrentUser: true }) === false,
      null
    );
    check(
      'F30 公式(Formula)字段即使误配开关也不生效',
      hasUserDefault({ fieldId: 'x', fieldName: 'x', fieldType: FieldType.Formula, visible: true, required: false, defaultToCurrentUser: true }) === false,
      null
    );

    // 2) 零破坏守门：无配置 → formHasAnyUserDefault=false（调用方据此完全不发请求）
    check(
      'F30 无任何配置 → formHasAnyUserDefault=false（不取 userId、零请求）',
      formHasAnyUserDefault([uf('u1')], [{ fields: [uf('u2')] }]) === false,
      null
    );
    check(
      'F30 主表或子表任一配置 → formHasAnyUserDefault=true',
      formHasAnyUserDefault([uf('u1', { defaultToCurrentUser: true })], [{ fields: [] }]) === true &&
        formHasAnyUserDefault([uf('u1')], [{ fields: [uf('u2', { defaultToCurrentUser: true })] }]) === true,
      null
    );

    // 3) 空值判定（人员字段值是 BitableUser[]）
    check('F30 空值判定：undefined/null/[] 为空，[{id}] 非空',
      isEmptyPersonValue(undefined) && isEmptyPersonValue(null) && isEmptyPersonValue([]) &&
        !isEmptyPersonValue([{ id: 'ou_me' }]), null);

    // 4) 核心：填入当前用户
    {
      const fields = [uf('owner', { defaultToCurrentUser: true }), uf('member')];
      const done = new Set();
      const v0 = {};
      const n1 = applyUserDefaults(fields, v0, 'ou_me', done, MAIN_KEY);
      check('F30 空字段 → 自动填入当前用户', !!n1 && JSON.stringify(n1.owner) === JSON.stringify([{ id: 'ou_me' }]), n1);
      check('F30 未开开关的人员字段不动', n1 && n1.member === undefined, n1);
      check('F30 原 values 未被就地修改（返回新对象）', v0.owner === undefined, v0);
      check('F30 填过的字段登记进 done', done.has('main:owner'), [...done]);
      check('F30 已填后再次调用返回 null（不重复写回，避免死循环）',
        applyUserDefaults(fields, n1, 'ou_me', done, MAIN_KEY) === null, null);
    }

    // 5) 用户改过 → 不再回填（本功能的核心承诺）
    {
      const fields = [uf('owner', { defaultToCurrentUser: true })];
      const done = new Set();
      const n1 = applyUserDefaults(fields, {}, 'ou_me', done, MAIN_KEY);
      // 用户改成别人
      const edited = { ...n1, owner: [{ id: 'ou_other' }] };
      const n2 = applyUserDefaults(fields, edited, 'ou_me', done, MAIN_KEY);
      check('F30 用户改选他人后不再被覆盖回当前用户',
        n2 === null && edited.owner[0].id === 'ou_other', n2);
      // 用户清空
      const cleared = { ...n1, owner: [] };
      const n3 = applyUserDefaults(fields, cleared, 'ou_me', done, MAIN_KEY);
      check('F30 用户主动清空后不再自动补回', n3 === null && cleared.owner.length === 0, n3);
    }

    // 6) 字段本就有值（配置了 defaultValue）→ 尊重它，不覆盖
    {
      const fields = [uf('owner', { defaultToCurrentUser: true, defaultValue: [{ id: 'ou_default' }] })];
      const done = new Set();
      const n = applyUserDefaults(fields, { owner: [{ id: 'ou_default' }] }, 'ou_me', done, MAIN_KEY);
      check('F30 字段自带默认值时尊重原值（不被当前用户覆盖）', n === null, n);
      check('F30 自带值的字段同样登记 done（之后不再插手）', done.has('main:owner'), [...done]);
    }

    // 7) 取不到当前用户 → 不填（且不登记 done，等拿到身份再补）
    {
      const fields = [uf('owner', { defaultToCurrentUser: true })];
      const done = new Set();
      check('F30 meId 为空 → 不填任何值', applyUserDefaults(fields, {}, '', done, MAIN_KEY) === null, null);
      check('F30 meId 为空时不登记 done（下次拿到身份仍可补填）', !done.has('main:owner'), [...done]);
      const n = applyUserDefaults(fields, {}, 'ou_me', done, MAIN_KEY);
      check('F30 拿到身份后补填成功', !!n && n.owner[0].id === 'ou_me', n);
    }

    // 8) 子表逐行 key 隔离：一行已填不影响另一行
    {
      const fields = [uf('owner', { defaultToCurrentUser: true })];
      const done = new Set();
      const rowKey = (idx) => (fid) => `sub:t1:${idx}:${fid}`;
      const n0 = applyUserDefaults(fields, {}, 'ou_me', done, rowKey(0));
      const n1 = applyUserDefaults(fields, {}, 'ou_me', done, rowKey(1));
      check('F30 子表第 1 行填入当前用户', !!n0 && n0.owner[0].id === 'ou_me', n0);
      check('F30 子表第 2 行也独立填入（key 按行隔离）', !!n1 && n1.owner[0].id === 'ou_me', n1);
      check('F30 子表两行的 done key 互不相同',
        done.has('sub:t1:0:owner') && done.has('sub:t1:1:owner'), [...done]);
    }

    // 9) submit 后重置：新一条记录重新默认当前用户
    {
      const fields = [uf('owner', { defaultToCurrentUser: true })];
      const done = new Set();
      applyUserDefaults(fields, {}, 'ou_me', done, MAIN_KEY);
      check('F30 提交前 done 非空', done.size > 0, [...done]);
      resetUserDefaultDone(done);
      check('F30 提交成功后重置 done → 下一条记录可重新默认', done.size === 0, [...done]);
      const n = applyUserDefaults(fields, {}, 'ou_me', done, MAIN_KEY);
      check('F30 重置后重新填入当前用户', !!n && n.owner[0].id === 'ou_me', n);
    }

    // 10) 静态保障：接线 + 持久化登记（防未来重构悄悄摘掉）
    {
      const fs30 = await import('node:fs');
      const read30 = (rel) => fs30.readFileSync(new URL(rel, import.meta.url), 'utf8');

      const cfgList = read30('../src/components/ConfigPanel/FieldConfigList.tsx');
      check(
        'F30 配置面板有「默认当前用户」开关，且仅对人员字段显示',
        /defaultToCurrentUser/.test(cfgList) && /isUserField/.test(cfgList),
        null
      );
      const cfgSize = read30('../src/services/configSize.ts');
      check('F30 configSize KEEP_FIELDS 登记了 defaultToCurrentUser（防瘦身剥离）',
        /'defaultToCurrentUser'/.test(cfgSize), null);
      check('F30 configSize untrimField 还原 defaultToCurrentUser',
        /defaultToCurrentUser:\s*stub\.defaultToCurrentUser/.test(cfgSize), null);
      const formRenderer = read30('../src/components/FormRenderer/index.tsx');
      check(
        'F30 FormRenderer 仅在 formHasAnyUserDefault 为真时取当前用户（零破坏）',
        /formHasAnyUserDefault\(/.test(formRenderer) && /hasUserDefaultFeature/.test(formRenderer),
        null
      );
      check(
        'F30 FormRenderer 提交成功后重置默认值标记（下一条记录重新默认）',
        /resetUserDefaultDone\(/.test(formRenderer) && /setSubmitSeq/.test(formRenderer),
        null
      );
      const personSel = read30('../src/components/FormRenderer/PersonSelector.tsx');
      check('F30 PersonSelector 把当前用户标签显示为「我（当前用户）」（否则只见裸 ID）',
        /我（当前用户）/.test(personSel), null);
    }

    // 11) 持久化往返：defaultToCurrentUser 瘦身后不丢
    {
      const thin30 = serializeConfig({
        forms: [
          {
            id: 'f30', version: '1.0.0', formTitle: 't',
            mainTable: {
              tableId: 'tblM30',
              fields: [uf('owner', { defaultToCurrentUser: true }), uf('member')],
            },
            subTables: [],
            conditionalRules: [],
          },
        ],
      });
      const th = thin30.forms[0].mainTable.fields;
      check('F30 序列化后 defaultToCurrentUser 保留', th[0].defaultToCurrentUser === true, th[0]);
      check('F30 未配置该开关的字段不产生该属性（体积不变）', !('defaultToCurrentUser' in th[1]), th[1]);
      const bytes = new (await import('node:buffer')).Buffer.from(JSON.stringify(thin30)).length;
      check('F30 体积远小于 10240 上限（布尔值体积极小）', bytes < 4096, { bytes });
    }
  }

  const failed = results.filter((r) => !r.pass);
  log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) process.exit(1);
}

run().catch((e) => {
  process.stdout.write('测试执行异常: ' + (e && e.stack || e) + '\n');
  process.exit(1);
});
