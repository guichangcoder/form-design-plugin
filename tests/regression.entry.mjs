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

  const failed = results.filter((r) => !r.pass);
  log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) process.exit(1);
}

run().catch((e) => {
  process.stdout.write('测试执行异常: ' + (e && e.stack || e) + '\n');
  process.exit(1);
});
