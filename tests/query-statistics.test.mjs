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
  statObjectNames,
  stepsStatement,
  summarize,
  toEvents,
  usersStatement,
} from '../dist/tools/query_statistics.js';

test('every statement stays within what DataPreview parses, with the longest names', () => {
  const longest = '$!1' + 'P'.repeat(30); // another front end's direct call on a 30-character provider
  const uid = 'X'.repeat(25);
  const window = [new Date('2026-01-01T00:00:00Z'), new Date('2026-12-31T23:59:59Z')];
  for (const sql of [
    stepsStatement(longest, ...window),
    stepsStatement(longest, ...window, 'slowest'),
    usersStatement(longest, ...window),
    eventsStatement(uid),
    dataManagerStatement(uid),
    headerStatement(uid),
    infoStatement(uid),
  ]) {
    assert.ok(sql.length <= MAX_STATEMENT, `${sql.length}: ${sql}`);
  }
});

test('names and step ids are escaped, steps come once each and newest or slowest first', () => {
  const window = [new Date('2026-10-13T10:00:00Z'), new Date('2026-10-13T11:00:00Z')];
  const sql = stepsStatement("Q'X", ...window);
  assert.match(sql, /stepuid IN \( SELECT stepuid FROM rsddstatheader WHERE objname = 'Q''X' \)/);
  assert.match(sql, /BETWEEN 20261013100000 AND 20261013110000 ORDER BY starttime DESCENDING$/);
  assert.match(stepsStatement('Q', ...window, 'slowest'), /ORDER BY runtime DESCENDING$/);
  assert.match(usersStatement('Q', ...window), /COUNT\(\*\) AS n .* GROUP BY uname$/);
  assert.match(eventsStatement("A'B"), /stepuid = 'A''B'/);
});

test('steps are recorded in UTC, a direct provider call under "$" or "$!1" plus its name', () => {
  assert.equal(statStamp(new Date('2026-10-13T12:06:03+02:00')), '20261013100603');
  assert.equal(stampToIso('20261013100603.2722980'), '2026-10-13 10:06:03 UTC');
  assert.equal(statObjectName('provider', true), '$PROVIDER');
  assert.equal(statObjectName('query', false), 'QUERY');
  assert.deepEqual(statObjectNames('provider', true), ['$PROVIDER', '$!1PROVIDER']);
  assert.deepEqual(statObjectNames('query', false), ['QUERY']);
});

test('events fall into the layer they belong to', () => {
  assert.equal(layerOf(0), 'Not assigned');
  assert.equal(layerOf(1), 'Not assigned'); // the user's wait time
  assert.equal(layerOf(2505), 'OLAP cache');
  assert.equal(layerOf(4600), 'Authorizations');
  assert.equal(layerOf(9000), 'Data manager / database');
  assert.equal(layerOf(3200), 'Transfer to front end');
  assert.equal(layerOf(13054), 'BICS provider');
  assert.equal(layerOf(3010), 'OLAP processor');
  assert.equal(layerOf(40000), 'MDX / OLAP BAPI');
  assert.equal(layerOf(40020), 'MDX / OLAP BAPI');
  assert.equal(layerOf(6001), 'Input help');
  assert.equal(layerOf(10000), 'Remote function calls');
  assert.equal(layerOf(12500), 'Front end / application');
  assert.equal(layerOf(51040), 'Planning');
});

test('a gross planning runtime in EVCOUNT is not summed as time', () => {
  const b = breakdown(toEvents([
    { HANDLETP: 'PLAN', EVENTID: '000050017', EVTIME: '0.000000', EVCOUNT: '2252', TXTLG: 'Gross Runtime Planning Function' },
    { HANDLETP: 'PLAN', EVENTID: '000050010', EVTIME: '0.040512', EVCOUNT: '0', TXTLG: 'Planning: Execution of a Planning Function' },
  ]));
  assert.deepEqual(b.layers.map((l) => [l.layer, l.seconds]), [['Planning', 0.040512]]);
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

test('executions are summarized with percentiles, the last run and the users', () => {
  const steps = [0.2, 0.1, 2.7, 0.3, 1.1].map((runtime, i) => ({
    stepUid: `S${i}`, user: i % 2 ? 'B' : 'A', start: `2026101310000${i}`, runtime,
  }));
  const lines = summarize(steps, [{ user: 'A', executions: 3 }, { user: 'B', executions: 2 }]).join('\n');
  assert.match(lines, /Executions: 5\n/);
  assert.match(lines, /Last: 2026-10-13 10:00:00 UTC by A/);
  assert.match(lines, /Runtime: min 0\.100 s, median 0\.300 s, p90 2\.700 s, max 2\.700 s/);
  assert.match(lines, /Users: A \(3\), B \(2\)/);
});

test('a total beyond the rows read says what the percentiles cover', () => {
  const steps = [{ stepUid: 'S', user: 'A', start: '20261013100000', runtime: 1 }];
  const lines = summarize(steps, [{ user: 'A', executions: 36480 }]).join('\n');
  assert.match(lines, /Executions: 36,480/);
  assert.match(lines, /Runtime over the latest 1 of 36,480:/);
});
