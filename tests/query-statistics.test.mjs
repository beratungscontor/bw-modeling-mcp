import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_STATEMENT,
  breakdown,
  dataManagerStatement,
  eventsStatement,
  headerStatement,
  infoStatement,
  layerOf,
  statObjectName,
  statStamp,
  stampToIso,
  stepsStatement,
  summarize,
  toEvents,
} from '../dist/tools/query_statistics.js';

test('every statement stays within what DataPreview parses, with the longest names', () => {
  const longest = '$' + 'P'.repeat(30); // "$" plus a 30-character provider
  const uid = 'X'.repeat(25);
  const window = [new Date('2026-01-01T00:00:00Z'), new Date('2026-12-31T23:59:59Z')];
  for (const sql of [stepsStatement(longest, ...window), eventsStatement(uid), dataManagerStatement(uid), headerStatement(uid), infoStatement(uid)]) {
    assert.ok(sql.length <= MAX_STATEMENT, `${sql.length}: ${sql}`);
  }
});

test('names and step ids are escaped, comparisons keep their blanks', () => {
  const sql = stepsStatement("Q'X", new Date('2026-10-13T10:00:00Z'), new Date('2026-10-13T11:00:00Z'));
  assert.match(sql, /h~objname = 'Q''X'/);
  assert.match(sql, /BETWEEN 20261013100000 AND 20261013110000$/);
  assert.match(eventsStatement("A'B"), /stepuid = 'A''B'/);
});

test('steps are recorded in UTC, a direct provider call under "$" plus its name', () => {
  assert.equal(statStamp(new Date('2026-10-13T12:06:03+02:00')), '20261013100603');
  assert.equal(stampToIso('20261013100603.2722980'), '2026-10-13 10:06:03 UTC');
  assert.equal(statObjectName('provider', true), '$PROVIDER');
  assert.equal(statObjectName('query', false), 'QUERY');
});

test('events fall into the layer they belong to', () => {
  assert.equal(layerOf(0), 'Not assigned');
  assert.equal(layerOf(2505), 'OLAP cache');
  assert.equal(layerOf(4600), 'Authorizations');
  assert.equal(layerOf(9000), 'Data manager / database');
  assert.equal(layerOf(3200), 'Transfer to front end');
  assert.equal(layerOf(13054), 'BICS provider');
  assert.equal(layerOf(3010), 'OLAP processor');
});

// Event rows as RSDDSTATEVDATA returns them for one step.
const events = toEvents([
  { HANDLETP: 'OLAP', EVENTID: '000003010', EVTIME: '0.817171', EVCOUNT: '0', EVPROP: '', TXTLG: 'OLAP: Query Generation' },
  { HANDLETP: 'OLAP', EVENTID: '000009000', EVTIME: '0.505981', EVCOUNT: '0', EVPROP: '', TXTLG: 'Data Manager Event' },
  { HANDLETP: 'OLAP', EVENTID: '000009011', EVTIME: '0.000000', EVCOUNT: '11830', EVPROP: '', TXTLG: 'Total Number of Read Records' },
  { HANDLETP: 'OLAP', EVENTID: '000009010', EVTIME: '0.000000', EVCOUNT: '10', EVPROP: '', TXTLG: 'Total Number of Transported Records' },
  { HANDLETP: 'OLAP', EVENTID: '000003115', EVTIME: '0.000000', EVCOUNT: '0', EVPROP: '8', TXTLG: "Effective execution setting for 'Operations in HANA'" },
  { HANDLETP: 'OLAP', EVENTID: '000002505', EVTIME: '0.028093', EVCOUNT: '0', EVPROP: '', TXTLG: 'Read Cache Entries' },
  { HANDLETP: 'DP', EVENTID: '000013050', EVTIME: '0.186014', EVCOUNT: '0', EVPROP: '', TXTLG: 'ABAP BICS Provider Initialization' },
]);

test('a step is summed by layer, with records and the HANA mode read from their events', () => {
  const b = breakdown(events, 3);
  const byLayer = Object.fromEntries(b.layers.map((l) => [l.layer, l.seconds]));
  assert.equal(byLayer['OLAP processor'].toFixed(6), '0.817171');
  assert.equal(byLayer['Data manager / database'].toFixed(6), '0.505981');
  assert.equal(byLayer['OLAP cache'].toFixed(6), '0.028093');
  assert.equal(b.recordsRead, 11830);
  assert.equal(b.recordsTransferred, 10);
  assert.equal(b.hanaMode, '8');
  assert.deepEqual(b.top.map((e) => e.eventId), [3010, 9000, 13050]);
});

test('executions are summarized with percentiles and the users', () => {
  const steps = [0.2, 0.1, 2.7, 0.3, 1.1].map((runtime, i) => ({ stepUid: `S${i}`, user: i % 2 ? 'B' : 'A', start: '', runtime }));
  const lines = summarize(steps).join('\n');
  assert.match(lines, /Executions: 5/);
  assert.match(lines, /min 0\.100 s, median 0\.300 s, p90 2\.700 s, max 2\.700 s/);
  assert.match(lines, /Users: A, B/);
});
