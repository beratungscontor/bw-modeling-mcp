import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPlanningFunctionChanges, toPutReferences } from '../dist/tools/planning_function_write.js';
import { parsePlseXmlForTest } from '../dist/tools/planning.js';

// The edits run on the body the GET returns and must leave everything they do not touch as it
// was: the PUT sends the whole object back, so anything dropped here is deleted on the server.

const XML =
  '<?xml version="1.0" encoding="utf-8"?><bwPlanningService:planningService name="ZFUNC" ' +
  'planningServiceType="ZTYPE.plst#//" alvl="ZLEVEL.composite#//" ' +
  'xmlns:bwPlanningService="http://www.sap.com/bw/modeling/BwPlanningService.ecore" ' +
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:qry="http://www.sap.com/bw/Query.ecore">' +
  '<description label="Old text"/>' +
  '<charUsage infoObject="ZLEVEL.composite#///0CALMONTH" fieldUsage="FIELD_FOR_CONDITIONS" isChangeable="true"/>' +
  '<charUsage infoObject="ZLEVEL.composite#///4ZPROV-ZCHAR" fieldUsage="NONE" isChangeable="true"/>' +
  '<charUsage infoObject="ZLEVEL.composite#///ZOTHER" fieldUsage="FIELDS_TO_BE_CHANGED" isChangeable="true"/>' +
  '<condition>' +
  '<fieldSelection characteristic="ZLEVEL.composite#///0CALMONTH"><constraint selectionType="areaSelection" operator="Equal">' +
  '<qry:fromValue><qry:type>Value</qry:type><qry:value>01.2024</qry:value></qry:fromValue></constraint></fieldSelection>' +
  '<parameter xsi:type="bwPlanningService:PlanningServiceParameter" name="SINGLE" multiselection="false" parameterType="1">' +
  '<selectionRange selectionType="areaSelection" operator="Equal"><qry:fromValue><qry:type>Value</qry:type>' +
  '<qry:value>1</qry:value></qry:fromValue></selectionRange></parameter>' +
  '<parameter xsi:type="bwPlanningService:PlanningServiceParameter" name="TABLE" multiselection="true" parameterType="4">' +
  '<parameter xsi:type="bwPlanningService:PlanningServiceParameter" name="KYF" multiselection="false" parameterType="2">' +
  '<restriction characteristic="ZLEVEL.composite#///ZKYF1"/><restriction characteristic="ZLEVEL.composite#///ZKYF2"/></parameter>' +
  '<parameter xsi:type="bwPlanningService:PlanningServiceParameter" name="FACTOR" multiselection="false" parameterType="1">' +
  '<selectionRange selectionType="areaSelection" operator="Equal"><qry:fromValue><qry:type>Value</qry:type><qry:value>0</qry:value></qry:fromValue></selectionRange>' +
  '<selectionRange selectionType="areaSelection" operator="Equal"><qry:fromValue><qry:type>Value</qry:type><qry:value>0</qry:value></qry:fromValue></selectionRange>' +
  '</parameter></parameter>' +
  '</condition></bwPlanningService:planningService>';

const client = {
  get: async () => ({ body: '<Qry:mainComponent xsi:type="Qry:Variable" id="VARUID123" technicalName="ZVAR"/>', headers: {} }),
};

test('characteristic usage resolves the bare name of a prefixed characteristic', async () => {
  const { xml } = await applyPlanningFunctionChanges(client, XML, {
    charUsage: [{ characteristic: 'zchar', usage: 'FIELDS_TO_BE_CHANGED' }],
  });
  const info = parsePlseXmlForTest(xml, '');
  assert.equal(info.charUsages.find((c) => c.infoObject === '4ZPROV-ZCHAR').fieldUsage, 'FIELDS_TO_BE_CHANGED');
  assert.equal(info.charUsages.find((c) => c.infoObject === 'ZOTHER').fieldUsage, 'FIELDS_TO_BE_CHANGED');
});

test('an unknown characteristic is refused with the list of what exists', async () => {
  await assert.rejects(
    applyPlanningFunctionChanges(client, XML, { charUsage: [{ characteristic: 'ZNONE', usage: 'NONE' }] }),
    /Available: 0CALMONTH, 4ZPROV-ZCHAR, ZOTHER/
  );
});

test('a condition is replaced, a variable carries its id, and parameters stay untouched', async () => {
  const { xml } = await applyPlanningFunctionChanges(client, XML, {
    description: 'New & improved',
    conditions: [{ characteristic: '0CALMONTH', constraints: [{ operator: 'GreaterEqual', variable: 'zvar' }] }],
  });
  assert.match(xml, /label="New &amp; improved"/);
  assert.match(xml, /<qry:type>VariableCIN<\/qry:type><qry:value>ZVAR<\/qry:value><qry:variable>VARUID123<\/qry:variable>/);
  const rule = parsePlseXmlForTest(xml, '').rules[0];
  assert.equal(rule.conditions.length, 1);
  assert.equal(rule.conditions[0].constraints[0].operator, 'GreaterEqual');
  assert.deepEqual(rule.parameters.map((p) => p.name), ['SINGLE', 'TABLE']);
});

test('an empty constraint list removes the condition', async () => {
  const { xml } = await applyPlanningFunctionChanges(client, XML, { conditions: [{ characteristic: '0CALMONTH' }] });
  assert.equal(parsePlseXmlForTest(xml, '').rules[0].conditions.length, 0);
});

test('a new condition goes before the parameters, with range and exclusion', async () => {
  const { xml } = await applyPlanningFunctionChanges(client, XML, {
    conditions: [{ characteristic: 'ZCHAR', constraints: [
      { operator: 'Between', value: 'A', to_value: 'C' },
      { value: 'B', exclude: true },
    ] }],
  });
  const body = xml.match(/<condition>([\s\S]*)<\/condition>/)[1];
  assert.ok(body.indexOf('4ZPROV-ZCHAR') < body.indexOf('<parameter'));
  const cond = parsePlseXmlForTest(xml, '').rules[0].conditions.find((c) => c.characteristic === '4ZPROV-ZCHAR');
  assert.equal(cond.constraints[0].to.value, 'C');
  assert.equal(cond.constraints[1].exclude, true);
});

test('FOX line ends are written as CRLF', async () => {
  const { xml } = await applyPlanningFunctionChanges(client, XML, { parameters: [{ name: 'SINGLE', value: 'A = 1.\nB = 2.' }] });
  assert.match(xml, /<qry:value>A = 1\.\r\nB = 2\.<\/qry:value>/);
});

test('a table parameter needs a row, and setting one row keeps the others', async () => {
  await assert.rejects(
    applyPlanningFunctionChanges(client, XML, { parameters: [{ name: 'FACTOR', value: '5' }] }),
    /has 2 rows/
  );
  const { xml } = await applyPlanningFunctionChanges(client, XML, { parameters: [{ name: 'TABLE/FACTOR', value: '5', row: 2 }] });
  const factor = parsePlseXmlForTest(xml, '').rules[0].parameters[1].children.find((p) => p.name === 'FACTOR');
  assert.deepEqual(factor.selections.map((s) => s.fromValue), ['0', '5']);
});

test('structures and key figure selections are refused rather than overwritten', async () => {
  await assert.rejects(applyPlanningFunctionChanges(client, XML, { parameters: [{ name: 'TABLE', value: 'X' }] }), /structure/);
  await assert.rejects(applyPlanningFunctionChanges(client, XML, { parameters: [{ name: 'KYF', value: 'X' }] }), /key figure selection/);
});

test('the PUT writes the references in their full relative form', () => {
  const out = toPutReferences(XML);
  assert.match(out, /alvl="\.\.\/\.\.\/\.\.\/infoprov\/a\/ZLEVEL\.composite#\/\/"/);
  assert.match(out, /planningServiceType="\.\.\/\.\.\/\.\.\/plst\/ZTYPE\/a\/model\.plst#\/\/"/);
  assert.match(out, /infoObject="\.\.\/\.\.\/\.\.\/infoprov\/a\/ZLEVEL\.composite#\/\/\/4ZPROV-ZCHAR"/);
  assert.match(out, /characteristic="\.\.\/\.\.\/\.\.\/infoprov\/a\/ZLEVEL\.composite#\/\/\/0CALMONTH"/);
});

test('the reader lists the key figure of every table row', () => {
  const kyf = parsePlseXmlForTest(XML, '').rules[0].parameters[1].children.find((p) => p.name === 'KYF');
  assert.deepEqual(kyf.restrictions, ['ZKYF1', 'ZKYF2']);
});
