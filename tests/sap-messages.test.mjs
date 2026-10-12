import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLongText, formatLongText, findProgramLocations, mergeNodeLog, formatNodeLogs,
} from '../dist/tools/sap_messages.js';

// The shape of a runtime error a transformation caught: the message line is generic, the
// cause is in the variables and in the long text. Names are placeholders.
const LONG_TEXT_HTML =
  '<HTML><HEAD><META http-equiv="Content-Type" content="text/html; charset=utf-16le">' +
  '<TITLE>Konvertierung des SAPscript-Textes HELP_DOKU nach HTML</TITLE></HEAD><BODY>' +
  '<H3>Runtime error while executing the rule -&gt; long text</H3><P>Message no. RSTRAN301</P>' +
  '<H3>Diagnosis</H3><P>The exact error message is:</P><P>Division by zero.</P>' +
  '<P>Raised at program location:</P><P>CLASS_NAME==========CM00B 37</P>' +
  '<H3>Procedure</H3><P>Check the rule with <I>RuleId:165</I>.</P></BODY></HTML>';

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

test('a long text escaped once (OData) parses into title, number and sections', () => {
  const lt = parseLongText(escape(LONG_TEXT_HTML));
  assert.equal(lt.title, 'Runtime error while executing the rule -> long text');
  assert.equal(lt.number, 'RSTRAN301');
  assert.deepEqual(lt.sections.map((s) => s.heading), ['Diagnosis', 'Procedure']);
  assert.match(lt.sections[0].text, /Division by zero\./);
  assert.match(lt.sections[0].text, /CLASS_NAME=+CM00B 37/);
  // The title of the HTML document is conversion boilerplate, never content.
  assert.doesNotMatch(JSON.stringify(lt), /SAPscript/);
});

test('a long text escaped twice (step log) parses the same way', () => {
  assert.deepEqual(parseLongText(escape(escape(LONG_TEXT_HTML))), parseLongText(escape(LONG_TEXT_HTML)));
});

test('a long text that only restates the message renders nothing', () => {
  const lt = parseLongText(escape('<HTML><BODY><H3>Some message</H3><P>Message no. AB123</P></BODY></HTML>'));
  assert.equal(lt.number, 'AB123');
  assert.deepEqual(formatLongText(lt, '  '), []);
});

test('the program location of a runtime error is found in the class pool include notation', () => {
  assert.deepEqual(findProgramLocations('CLASS_NAME==========CM00B 37'), [
    { className: 'CLASS_NAME', include: 'CM00B', line: 37 },
  ]);
  assert.deepEqual(findProgramLocations('/NS/CLASS_NAME=====CM1A2 5'), [
    { className: '/NS/CLASS_NAME', include: 'CM1A2', line: 5 },
  ]);
  assert.deepEqual(findProgramLocations('no location here'), []);
});

const entry = (msgty, msgid, msgno, message, vars = [], longText = '') => ({
  message, severity: msgty === 'E' ? 'error' : 'success', longText,
  sMsg: { msgty, msgid, msgno, msgv1: vars[0] ?? '', msgv2: vars[1] ?? '', msgv3: vars[2] ?? '', msgv4: vars[3] ?? '' },
});

const RUNTIME_ERROR = entry('E', 'RSTRAN', '301', 'Runtime error while executing the rule -> long text',
  ['Division by zero.', 'RuleId:165', 'RuleType:START', 'CLASS_NAME==========CM00B 37'],
  escape(escape(LONG_TEXT_HTML)));
const PACKAGE_1 = entry('E', 'RSBK', '257', "Data package 1 / Status 'Processed with errors'", ['1', '', 'Processed with errors']);
const CHAIN_STATUS = entry('E', 'RSPC', '206', "Process returned status 'Error'", ['Error']);
const JOB_START = entry('S', '00', '516', 'Job started');

test('the three parts of a node log are merged, none of them is a subset of another', () => {
  // The joined log carries the chain status message that neither part has; the job log
  // carries entries the joined log leaves out.
  const merged = mergeNodeLog({
    joinedLog: { log: [PACKAGE_1, RUNTIME_ERROR, RUNTIME_ERROR, CHAIN_STATUS] },
    processLog: { log: [PACKAGE_1, RUNTIME_ERROR] },
    jobLog: { log: [JOB_START] },
  });
  assert.deepEqual(merged.map((m) => [m.entry.sMsg.msgid, m.entry.sMsg.msgno, m.count]), [
    ['RSBK', '257', 1],
    ['RSTRAN', '301', 2],
    ['RSPC', '206', 1],
    ['00', '516', 1],
  ]);
});

test('a runtime error renders with its variables, resolved method and diagnosis', async () => {
  // TMDIR answers through ADT DataPreview; the fake returns one row for the include index.
  const queries = [];
  const client = {
    getCsrfToken: async () => 'token',
    clearCsrfToken: () => {},
    rawPost: async (_url, sql) => {
      queries.push(sql);
      return {
        body:
          '<dataPreview:tableData xmlns:dataPreview="x"><dataPreview:columns>' +
          '<dataPreview:metadata dataPreview:name="METHODNAME"/>' +
          '<dataPreview:dataSet><dataPreview:data>METHOD_NAME</dataPreview:data></dataPreview:dataSet>' +
          '</dataPreview:columns></dataPreview:tableData>',
      };
    },
  };
  const lines = await formatNodeLogs(client, [{
    node: { sProcessType: 'DTP_LOAD', sProcessVariant: 'DTP_NAME' },
    instance: 'DTPR__REQUEST',
    entries: mergeNodeLog({ processLog: { log: [PACKAGE_1, RUNTIME_ERROR, JOB_START] } }),
  }], false);
  const text = lines.join('\n');

  assert.match(queries[0], /FROM TMDIR WHERE CLASSNAME = 'CLASS_NAME' AND METHODINDX = 11/);
  assert.match(text, /\[E\] RSTRAN 301 — Runtime error while executing the rule -> long text/);
  assert.match(text, /Variables: Division by zero\. \| RuleId:165 \| RuleType:START \| CLASS_NAME=+CM00B 37/);
  assert.match(text, /Program: +CLASS_NAME->METHOD_NAME, line 37 \(include CM00B\)/);
  assert.match(text, /Diagnosis: The exact error message is: Division by zero\./);
  // A message whose text already shows its variables does not repeat them.
  const packageLine = lines.findIndex((l) => l.includes('RSBK 257'));
  assert.doesNotMatch(lines[packageLine + 1], /Variables/);
  assert.match(text, /\(1 further message\(s\) of lower severity not shown\)/);
});
