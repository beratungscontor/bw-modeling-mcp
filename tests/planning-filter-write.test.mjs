import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPlanningFilterOperations, resolveLevelCharacteristic } from '../dist/tools/planning_filter_write.js';

// A filter as the modeling tools write it: a variable embedded before the main component, which
// carries its own selection, and the filter's restrictions on the main component itself.
const DOC =
  '<Qry:queryResource xmlns:Qry="http://www.sap.com/bw/Query.ecore" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
  '<Qry:subComponents xsi:type="Qry:Variable" id="VARUID" technicalName="VAR_NAME" infoObject="CHAR_B">' +
  '<Qry:defaultValues><Qry:selections infoObject="CHAR_B" paramSelectionType="Default" usageType="asFilter"/></Qry:defaultValues>' +
  '</Qry:subComponents>' +
  '<Qry:mainComponent xsi:type="Qry:Filter" id="F" providerName="LEVEL">' +
  '<Qry:selections xsi:type="Qry:StandardFilterSelection" dimension="D1" infoObject="4PROV-CHAR_B" usageType="asFilter">' +
  '<Qry:tokens xsi:type="Qry:SelectionVariable" usageType="asFilter" variable="VARUID"/>' +
  '<Qry:localDimension id="D1" infoObjectName="4PROV-CHAR_B"/></Qry:selections>' +
  '</Qry:mainComponent></Qry:queryResource>';

const CHARS = ['4PROV-CHAR_A', '4PROV-CHAR_B'];

test('a bare characteristic name finds the prefixed field of a CompositeProvider level', () => {
  assert.equal(resolveLevelCharacteristic('char_a', CHARS), '4PROV-CHAR_A');
  assert.equal(resolveLevelCharacteristic('CHAR_X', []), 'CHAR_X');
  assert.throws(() => resolveLevelCharacteristic('CHAR_X', CHARS), /not on the aggregation level/);
});

test('a new restriction is added to the main component with a virtual id', () => {
  const { xml, applied } = applyPlanningFilterOperations(DOC, [{ action: 'set_values', infoobject: 'CHAR_A', values: [{ value: 'V1', high: 'V9' }] }], new Map(), CHARS);
  assert.deepEqual(applied, ['4PROV-CHAR_A: 1 value(s)']);
  const main = xml.slice(xml.indexOf('<Qry:mainComponent'));
  assert.match(main, /<Qry:selections xsi:type="Qry:StandardFilterSelection" dimension="!VIRTUAL-1" infoObject="4PROV-CHAR_A" usageType="asFilter">/);
  assert.match(main, /operator="Between">[\s\S]*<Qry:value>V1<\/Qry:value>[\s\S]*<Qry:value>V9<\/Qry:value>/);
});

test("replacing a restriction leaves the embedded variable's own selection alone", () => {
  const { xml } = applyPlanningFilterOperations(DOC, [{ action: 'set_values', infoobject: 'CHAR_B', values: [{ value: 'V2' }] }], new Map(), CHARS);
  assert.match(xml, /<Qry:defaultValues><Qry:selections infoObject="CHAR_B" paramSelectionType="Default" usageType="asFilter"\/><\/Qry:defaultValues>/);
  assert.doesNotMatch(xml.slice(xml.indexOf('<Qry:mainComponent')), /SelectionVariable/);
  assert.match(xml, /<Qry:localDimension id="D1" infoObjectName="4PROV-CHAR_B"\/>/);
});

test('removing the last use of a variable drops its embedded definition', () => {
  const { xml } = applyPlanningFilterOperations(DOC, [{ action: 'remove', infoobject: 'CHAR_B' }], new Map(), CHARS);
  assert.doesNotMatch(xml, /Qry:subComponents/);
  assert.doesNotMatch(xml, /4PROV-CHAR_B/);
});

test('a variable is embedded once and its token written as the modeling tools write it', () => {
  const variables = new Map([['VAR_C', { componentId: 'UID_C', characteristic: 'CHAR_A', subComponentXml: '<Qry:subComponents xsi:type="Qry:Variable" id="UID_C"/>', extraSubComponents: [] }]]);
  const { xml } = applyPlanningFilterOperations(DOC, [{ action: 'set_variable', variable_name: 'var_c' }, { action: 'set_variable', variable_name: 'VAR_C' }], variables, CHARS);
  assert.equal((xml.match(/id="UID_C"/g) ?? []).length, 1);
  assert.match(xml, /<Qry:tokens xsi:type="Qry:SelectionVariable" usageType="asFilter" variable="UID_C"\/>/);
});

test('a new description replaces every copy on the main component, not the texts of the characteristics', async () => {
  const { setFilterDescription } = await import('../dist/tools/planning_filter_write.js');
  const doc =
    '<Qry:subComponents id="V"><Qry:description default="false" value="variable text"/></Qry:subComponents>' +
    '<Qry:mainComponent xsi:type="Qry:Filter"><Qry:description default="false" value="old"/>' +
    '<Qry:entityProperties adtCore:description="old"/><Qry:description default="false" value="old"/>' +
    '<Qry:selections infoObject="C"><Qry:localDimension><Qry:description shortValue="C" value="C text"/></Qry:localDimension></Qry:selections>' +
    '</Qry:mainComponent>';
  const out = setFilterDescription(doc, 'new & better');
  assert.equal((out.match(/value="new &amp; better"/g) ?? []).length, 2);
  assert.match(out, /value="variable text"/);
  assert.match(out, /value="C text"/);
  assert.match(out, /adtCore:description="old"/);
});
