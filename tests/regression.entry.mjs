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
import { resolveRefOptions, getOptionRefDependencies, hasOptionRef } from '../src/utils/optionRef';
import { applyDateOffset, isSameInstant, describeOffset, toDateOrNull } from '../src/utils/dateCalc';
import { applyAutoFill, markManualEdits } from '../src/utils/dateAutoFill';
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
  searchAllPages,
  searchAllRows,
  getHeadCache,
  invalidateTableRecords,
  taskKey,
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
    const fmt = (x) =>
      x
        ? `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
        : 'null';
    const d = (s) => new Date(`${s}T00:00:00`);
    const plus1y = { sourceFieldId: 'fStart', direction: 'plus', amount: 1, unit: 'year' };

    check('F15 +1 年（2026-03-01→2027-03-01）', fmt(applyDateOffset(d('2026-03-01'), plus1y)) === '2027-03-01');
    check(
      'F15 -1 年（2026-03-01→2025-03-01）',
      fmt(applyDateOffset(d('2026-03-01'), { ...plus1y, direction: 'minus' })) === '2025-03-01'
    );
    check(
      'F15 月偏移日溢出取月末（1/31 +1 月→2/28）',
      fmt(applyDateOffset(d('2026-01-31'), { ...plus1y, amount: 1, unit: 'month' })) === '2026-02-28'
    );
    check(
      'F15 闰年 2/29 +1 年→次年 2/28',
      fmt(applyDateOffset(d('2024-02-29'), plus1y)) === '2025-02-28'
    );
    check(
      'F15 按天偏移（+30 天）',
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
    check('F15 来源有值时自动预填', n1 && fmt(n1.fEnd) === '2027-03-01', n1 && fmt(n1.fEnd));
    check('F15 预填后标记为自动值', auto.has('main:fEnd'));
    check('F15 值已正确时不重复写入', applyAutoFill(fields, n1, manual, auto, keyOf) === null);

    const v2 = { ...n1, fStart: d('2027-05-06') };
    const n2 = applyAutoFill(fields, v2, manual, auto, keyOf);
    check('F15 未手动改过时来源变化会重算', n2 && fmt(n2.fEnd) === '2028-05-06', n2 && fmt(n2.fEnd));

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
    check('F15 清空后重新自动预填', n4 && fmt(n4.fEnd) === '2030-01-01', n4 && fmt(n4.fEnd));

    const noSrc = { ...n4, fStart: undefined };
    const n5 = applyAutoFill(fields, noSrc, manual, auto, keyOf);
    check('F15 来源清空后清掉自动值', n5 && n5.fEnd === undefined, n5 && fmt(n5.fEnd));
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

  const failed = results.filter((r) => !r.pass);
  log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) process.exit(1);
}

run().catch((e) => {
  process.stdout.write('测试执行异常: ' + (e && e.stack || e) + '\n');
  process.exit(1);
});
