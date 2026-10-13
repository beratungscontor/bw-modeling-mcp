import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPostBody, nodeTypeOf, notApplied } from '../dist/tools/reporting.js';
import { formatDimHierarchy, parseDimHierarchy } from '../dist/tools/query.js';

// Response fragments follow live answers of the reporting endpoint.

const io = (name, axis, extra = {}) => ({ name, id: '1', axis, ...extra });

test('a hierarchy node goes out with its node type; a plain member without one', () => {
  assert.equal(nodeTypeOf('CHAR', { nodeId: 1, nodeType: '0HIER_NODE' }), '0HIER_NODE');
  assert.equal(nodeTypeOf('CHAR', { nodeId: 1 }), 'CHAR');
  assert.equal(nodeTypeOf('CHAR__ATTR', { nodeId: 1 }), 'ATTR');
  assert.equal(nodeTypeOf('CHAR', {}), undefined);
  const body = buildPostBody('Q', { infoObjects: [io('CHAR', 'ROWS', { filterValues: [{ lowInt: 'NODE', nodeId: 1, nodeType: '0HIER_NODE' }] })] });
  assert.match(body, /lowInt="NODE" nodeId="1" nodeName="0HIER_NODE"/);
});

test('the upper bound of an interval goes in the format of the lower one', () => {
  const internal = buildPostBody('Q', { infoObjects: [io('CHAR', 'ROWS', { filterValues: [{ lowInt: 'A', high: 'C', op: 'BT' }] })] });
  assert.match(internal, /lowInt="A" highInt="C"/);
  const external = buildPostBody('Q', { infoObjects: [io('CHAR', 'ROWS', { filterValues: [{ low: 'A', high: 'C', op: 'BT' }] })] });
  assert.match(external, /low="A" high="C"/);
  assert.doesNotMatch(external, /highInt/);
});

const response = (stateXml, effectiveXml) =>
  `<queryView><selection><state>${stateXml}</state>${effectiveXml}</selection><resultSet/></queryView>`;

test('an excluded node that BW applied as included is reported', () => {
  const xml = response(
    '<infoObject id="1" name="CHAR" axis="ROWS" pos="1"/>',
    '<effective><infoObject id="1" name="CHAR"><selectValue id="4" presentationMode="INT" sign="I" op="EQ" lowInt="NODE" low="NODE" nodeId="8" nodeName="0HIER_NODE" hryMinLvl="1"/></infoObject></effective>',
  );
  const findings = notApplied({ infoObjects: [io('CHAR', 'ROWS', { filterValues: [{ lowInt: 'NODE', nodeId: 1, nodeType: '0HIER_NODE', sign: 'E' }] })] }, xml);
  assert.deepEqual(findings, ['CHAR: exclude EQ NODE was requested, BW applied include EQ NODE.']);
});

test('a filter applied as requested, an interval included, yields nothing', () => {
  const xml = response(
    '<infoObject id="1" name="CHAR" axis="ROWS" pos="1"/>',
    '<effective><infoObject id="1" name="CHAR"><selectValue id="4" presentationMode="INT_NC" sign="I" op="BT" lowInt="A" low="A" highInt="C" high="C" hryMinLvl="0"/></infoObject></effective>',
  );
  assert.deepEqual(notApplied({ infoObjects: [io('CHAR', 'ROWS', { filterValues: [{ lowInt: 'A', high: 'C', op: 'BT' }] })] }, xml), []);
});

test('a lost upper bound and a missing internal key are reported', () => {
  const xml = response(
    '<infoObject id="1" name="CHAR" axis="ROWS" pos="1"/>',
    '<effective><infoObject id="1" name="CHAR"><selectValue id="4" sign="I" op="BT" lowInt="A" low="A" hryMinLvl="0"/></infoObject></effective>',
  );
  const findings = notApplied({ infoObjects: [io('CHAR', 'ROWS', { filterValues: [{ lowInt: 'A', high: 'C', op: 'BT' }, { lowInt: 'X' }] })] }, xml);
  assert.equal(findings.length, 2);
  assert.match(findings[0], /include BT A\.\.C was requested, BW applied include BT A\./);
  assert.match(findings[1], /include EQ X was requested and is not in the effective selection/);
});

test('an external key BW may have converted and an empty effective selection are not judged', () => {
  const converted = response('', '<effective><infoObject id="1" name="CHAR"><selectValue sign="I" op="EQ" lowInt="00A" low="00A"/></infoObject></effective>');
  assert.deepEqual(notApplied({ infoObjects: [io('CHAR', 'FREE', { filterValues: [{ low: 'A' }] })] }, converted), []);
  const empty = response('', '<effective/>');
  assert.deepEqual(notApplied({ infoObjects: [io('CHAR', 'FREE', { filterValues: [{ lowInt: 'A' }] })] }, empty), []);
});

test('a requested hierarchy other than the query uses, and a moved axis, are reported', () => {
  const xml = response(
    '<infoObject id="1" name="CHAR" axis="FREE" pos="1"><hierarchy id="12" name="HIER_A" hryId="A" hryDateFrom="00000000" hryDateTo="99991231"/></infoObject>',
    '<effective/>',
  );
  const findings = notApplied({ infoObjects: [io('CHAR', 'ROWS', { hierarchy: { id: '12', name: 'HIER_B', hryId: 'B' } })] }, xml);
  assert.equal(findings.length, 2);
  assert.match(findings[0], /axis ROWS was requested, BW placed it on FREE/);
  assert.match(findings[1], /hierarchy HIER_B was requested, BW uses HIER_A/);
});

test('a display hierarchy is read with its literal name, key date and non-default options', () => {
  const vars = new Map([['VARUID', { technicalName: 'HIER_VAR' }]]);
  const h = parseDimHierarchy({
    '@_active': 'true',
    'Qry:name': { 'Qry:value': '0001', 'Qry:type': 'Value' },
    'Qry:dateTo': { 'Qry:value': '00000000', 'Qry:type': 'Value' },
    'Qry:expandToLevel': { '@_default': 'false', '@_level': '02' },
    'Qry:valuesOfPostableNodes': { '@_default': 'false', '@_show': 'false' },
    'Qry:suppressNodes': { '@_default': 'true', '@_suppress': 'true' },
  }, vars);
  assert.equal(formatDimHierarchy(h), 'Hierarchy: 0001 (active), key date 00000000, expanded to level 2, hide values of postable nodes');
  const v = parseDimHierarchy({ '@_active': 'false', 'Qry:name': { 'Qry:value': 'VARUID', 'Qry:type': 'Variable' } }, vars);
  assert.equal(formatDimHierarchy(v), 'Hierarchy: variable HIER_VAR (assigned, not active)');
  assert.equal(parseDimHierarchy({ '@_active': 'false', 'Qry:name': '' }, vars), undefined);
});
