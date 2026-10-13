import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeDocumentation, stepTypeText } from '../dist/tools/planning.js';

test('a planning function documentation escaped twice comes back with its line breaks', () => {
  assert.equal(
    decodeDocumentation('- Select the characteristics.&amp;amp;#xD;&amp;amp;#xA;- Mark them as changeable.'),
    '- Select the characteristics.\n- Mark them as changeable.',
  );
  assert.equal(decodeDocumentation('R&amp;amp;D &#10;next'), 'R&D \nnext');
  assert.equal(decodeDocumentation('plain text'), 'plain text');
});

test('a sequence step names what it does', () => {
  assert.match(stepTypeText('1'), /input template/);
  assert.equal(stepTypeText('2'), 'Planning function');
  assert.equal(stepTypeText('9'), '[type 9]');
});

test('characteristic relationships come with type, roles and exit class', async () => {
  const { parseCharacteristicRelations, formatCharacteristicRelations } = await import('../dist/tools/planning.js');
  const xml =
    '<characteristicRelation type="E" derivation="true" active="true">' +
    '<exitClass name="ZCL_EXIT" uri="/x"/>' +
    '<constraint xsi:type="plIprov:Member" attribute="PROV.composite#///CHAR_A" role="S"/>' +
    '<constraint xsi:type="plIprov:Member" attribute="PROV.composite#///CHAR_B" role="T"/>' +
    '</characteristicRelation>' +
    '<characteristicRelation type="A" derivation="false" active="false">' +
    '<characteristic>PROV.composite#///CHAR_C</characteristic>' +
    '<constraint xsi:type="plIprov:Member" attribute="PROV.composite#///CHAR_C" role="S"/>' +
    '</characteristicRelation>';
  const rel = parseCharacteristicRelations(xml);
  assert.deepEqual(rel.map((r) => [r.type, r.exitClass, r.sources, r.targets, r.active]), [
    ['E', 'ZCL_EXIT', ['CHAR_A'], ['CHAR_B'], true],
    ['A', '', ['CHAR_C'], [], false],
  ]);
  const text = formatCharacteristicRelations(rel).join('\n');
  assert.match(text, /1\. Exit \(ABAP class\)/);
  assert.match(text, /2\. Attribute  \(inactive\)/);
  assert.match(text, /only checked/);
});

test('a function type lists its class and parameters, table rows nested', async () => {
  const { parseFunctionType, formatFunctionType } = await import('../dist/tools/planning.js');
  const xml =
    '<bwPlanningServiceType:planningServiceType name="ZTYPE" refData="true" emptyRecords="false">' +
    '<tlogoProperties adtcore:name="ZTYPE"></tlogoProperties><description label="Type text"/>' +
    '<exitClass name="ZCL_TYPE"/>' +
    '<parameter xsi:type="bwPlanningServiceType:ElementaryParameter" name="P1" multiselection="false" infoObject="IOBJ_A" internalDefaultValue="X" variablesAllowed="true"><description label="First"/></parameter>' +
    '<parameter xsi:type="bwPlanningServiceType:StructureParameter" name="TAB" multiselection="true"><description label="Table"/>' +
    '<elementaryParameter xsi:type="bwPlanningServiceType:ElementaryParameter" name="SEQ" infoObject="IOBJ_B"><description label="Row"/></elementaryParameter>' +
    '<selectionParameter xsi:type="bwPlanningServiceType:SelectionParameter" name="SEL"><description label="Sel"/></selectionParameter>' +
    '</parameter></bwPlanningServiceType:planningServiceType>';
  const t = parseFunctionType(xml);
  assert.equal(t.description, 'Type text');
  assert.equal(t.exitClass, 'ZCL_TYPE');
  assert.deepEqual(t.parameters.map((p) => [p.name, p.kind, p.children.map((c) => c.name)]), [
    ['P1', 'value', []],
    ['TAB', 'table', ['SEQ', 'SEL']],
  ]);
  const text = formatFunctionType(t).join('\n');
  assert.match(text, /P1  \[value; IOBJ_A; default X; variables allowed\]  "First"/);
  assert.match(text, /\n      SEQ  \[value; IOBJ_B\]/);
});
