import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChangeLog, buildTree, deleteRecords, TEXT_NODE } from '../dist/tools/hierarchy.js';

// The data API takes a tree as the maintenance app writes it: every node inserted without
// links, then changed to its final child and next links, node ids as plain numbers.

const tree = [
  { text_node: 'group_a', text: 'Group A', children: [{ value: 'V1' }, { value: 'V2' }] },
  { text_node: 'GROUP_B', children: [{ value: 'V3' }] },
];

test('a tree becomes inserts without links, then changes to the final links', () => {
  const log = buildChangeLog('HID', 'CHARACTERISTIC', tree);
  const inserts = log.filter((r) => r.ACTION === 'I');
  const changes = log.filter((r) => r.ACTION === 'C');
  assert.equal(inserts.length, 5);
  assert.ok(inserts.every((r) => r.CHILDID === 0 && r.NEXTID === 0 && r.OBJVERS === 'M' && r.HIEID === 'HID'));
  assert.ok(log.indexOf(changes[0]) > log.indexOf(inserts.at(-1)), 'changes follow all inserts');

  const byName = Object.fromEntries(changes.map((r) => [r.NODENAME, r]));
  assert.deepEqual([byName.GROUP_A.CHILDID, byName.GROUP_A.NEXTID], [2, 4]); // first child V1, next GROUP_B
  assert.deepEqual([byName.V1.NEXTID, byName.V1.PARENTID], [3, 1]);
  assert.equal(byName.GROUP_B.CHILDID, 5);
  assert.equal(byName.V2, undefined, 'a last leaf has no link to change');
});

test('text nodes are 0HIER_NODE with their text, value nodes carry the characteristic and keep their case', () => {
  const log = buildChangeLog('HID', 'CHARACTERISTIC', [{ text_node: 'grp', children: [{ value: 'abc' }] }]);
  const [group, value] = log.filter((r) => r.ACTION === 'I');
  assert.equal(group.IOBJNM, TEXT_NODE);
  assert.equal(group.NODENAME, 'GRP');
  assert.equal(group.TXTSH, 'GRP'); // text defaults to the name
  assert.equal(group.TLEVEL, 1);
  assert.equal(value.IOBJNM, 'CHARACTERISTIC');
  assert.equal(value.NODENAME, 'abc');
  assert.equal(value.TLEVEL, 2);
  assert.equal(value.TXTSH, '');
  assert.equal(typeof value.NODEID, 'string');
  assert.equal(typeof value.PARENTID, 'number');
});

test('a replacement tree starts after the ids it removes', () => {
  const log = buildChangeLog('HID', 'CHARACTERISTIC', [{ value: 'V1' }], 8);
  assert.equal(log[0].NODEID, '8');
});

test('texts are cut to the short, medium and long text lengths', () => {
  const long = 'X'.repeat(70);
  const [node] = buildChangeLog('HID', 'C', [{ text_node: 'N', text: long }]);
  assert.deepEqual([node.TXTSH.length, node.TXTMD.length, node.TXTLG.length], [20, 40, 60]);
});

test('malformed trees are refused before anything is written', () => {
  assert.throws(() => buildChangeLog('H', 'C', []), /at least one node/);
  assert.throws(() => buildChangeLog('H', 'C', [{ text_node: 'A', value: 'B' }]), /exactly one of text_node or value/);
  assert.throws(() => buildChangeLog('H', 'C', [{ text: 'no name' }]), /exactly one of text_node or value/);
  assert.throws(() => buildChangeLog('H', 'C', [{ value: ' ' }]), /may not be empty/);
  assert.throws(() => buildChangeLog('H', 'C', [{ value: 'V1' }, { text_node: 'G', children: [{ value: 'V1' }] }]), /occurs twice/);
  // A text node and a value may share a name: they are different nodes.
  assert.equal(buildChangeLog('H', 'C', [{ text_node: 'X', children: [{ value: 'X' }] }]).filter((r) => r.ACTION === 'I').length, 2);
});

test('the current nodes are removed as delete records with their numeric links', () => {
  const [d] = deleteRecords('HID', [
    { NODEID: '00000003', IOBJNM: 'C', NODENAME: 'V1', TLEVEL: '02', PARENTID: '00000001', CHILDID: '00000000', NEXTID: '00000004' },
  ]);
  assert.equal(d.ACTION, 'D');
  assert.equal(d.NODEID, '3');
  assert.deepEqual([d.TLEVEL, d.PARENTID, d.NEXTID], [2, 1, 4]);
});

test('rows read back form the tree in sibling order', () => {
  const row = (id, name, parent, child, next) => ({
    NODEID: String(id).padStart(8, '0'), IOBJNM: 'C', NODENAME: name, TLEVEL: parent ? '02' : '01',
    PARENTID: String(parent).padStart(8, '0'), CHILDID: String(child).padStart(8, '0'), NEXTID: String(next).padStart(8, '0'),
  });
  // Rows arrive in no particular order; the next links decide the sequence.
  const { roots, children } = buildTree([
    row(4, 'V3', 2, 0, 0), row(2, 'B', 0, 4, 0), row(3, 'V1', 1, 0, 0), row(1, 'A', 0, 3, 2),
  ]);
  assert.deepEqual(roots.map((r) => r.NODENAME), ['A', 'B']);
  assert.deepEqual(children.get('1').map((r) => r.NODENAME), ['V1']);
  assert.deepEqual(children.get('2').map((r) => r.NODENAME), ['V3']);
});
