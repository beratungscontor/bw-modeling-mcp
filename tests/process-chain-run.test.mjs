import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStartResponse, parseRunStatus, isRunning, formatStartResult,
} from '../dist/tools/process_chain_run.js';

const STATUS_ABORTED = JSON.stringify({
  processChain: 'CHAIN_NAME',
  logid: 'LOGID0001',
  logURI: '/sap/bw/whm/backend/run/processChain/log/CHAIN_NAME/LOGID0001',
  status: 'aborted',
  statusType: 'ERROR',
  manuallyAborted: false,
  aMsg: [
    { level: 1, severity: 'W', text: "Process 'Execute DTP', variant 'DTP_A' has status 'Undefined' (instance '')", class: 'RSPC', number: '009' },
    { level: 1, severity: 'S', text: "Process 'Start process', variant '' has status 'Finished'", class: 'RSPC', number: '009' },
    { level: 1, severity: 'E', text: "Process 'Execute ABAP program', variant 'STEP_A' has status 'Canceled'", class: 'RSPC', number: '009' },
    { level: 2, severity: 'A', text: 'Variant VARIANT_A of report REPORT_A does not exist', class: 'DB', number: '612' },
  ],
});

test('the start answer is read from its body, whatever its content type says', () => {
  assert.deepEqual(
    parseStartResponse('{"processChain":"CHAIN_NAME","logid":"LOGID0001"}'),
    { processChain: 'CHAIN_NAME', logid: 'LOGID0001' },
  );
});

test('a start answer without a log ID is an error, not a silent success', () => {
  assert.throws(() => parseStartResponse('{"processChain":"CHAIN_NAME"}'), /no log ID/);
  assert.throws(() => parseStartResponse('<html>Logon</html>'), /carries no run/);
});

test('the run status names status, type and messages with their id', () => {
  const s = parseRunStatus(STATUS_ABORTED);
  assert.equal(s.status, 'aborted');
  assert.equal(s.statusType, 'ERROR');
  assert.equal(s.messages.length, 4);
  assert.equal(s.messages[0].id, 'RSPC009');
  assert.equal(isRunning(s), false);
  assert.equal(isRunning({ ...s, statusType: 'ACTIVE' }), true);
});

test('steps the run has not reached are left out, the failing one stays', () => {
  const text = formatStartResult('CHAIN_NAME', 'LOGID0001', parseRunStatus(STATUS_ABORTED), 60, 12);
  assert.match(text, /Log ID: LOGID0001/);
  assert.match(text, /Status: aborted \(ERROR\)/);
  assert.match(text, /Finished within 12 s/);
  assert.doesNotMatch(text, /DTP_A/);
  assert.match(text, /E Process 'Execute ABAP program'/);
  assert.match(text, /A Variant VARIANT_A/);
  assert.match(text, /bw_get_process_chain_run_detail with chain_id="CHAIN_NAME" and log_id="LOGID0001"/);
});

test('a run still going says so and how to follow it', () => {
  const running = { ...parseRunStatus(STATUS_ABORTED), status: 'active', statusType: 'ACTIVE' };
  const text = formatStartResult('CHAIN_NAME', 'LOGID0001', running, 0, 0);
  assert.doesNotMatch(text, /Finished within|Still running after/);
  assert.match(text, /continues in the background/);
});
