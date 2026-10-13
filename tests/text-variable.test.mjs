import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textProcType, textReplacementPathXml, validateTextArgs } from '../dist/tools/variable.js';
import { bindDescriptionVariables, textVariableTokens } from '../dist/tools/query_update.js';
import { applyVariableChanges } from '../dist/tools/elem_write.js';

const base = { variable_name: 'TV', description: 'Text', variable_type: 'Text' };

test('a text variable is replaced from its characteristic unless told otherwise', () => {
  assert.equal(textProcType({ ...base, iobj_name: 'CHAR' }), 'ReplacementPath');
  assert.equal(textProcType(base), 'UserEntry');
  assert.equal(textProcType({ ...base, processing_type: 'CustomerExit' }), 'CustomerExit');
});

test('the replacement path carries type, interval and four-digit offsets', () => {
  assert.equal(
    textReplacementPathXml({ ...base, replacement_type: 'Name', replacement_interval: 'ToValue', offset_start: 2, offset_length: 4 }),
    '<Qry:replacementPath type="Name" asBoolean="false" offsetStart="0002" offsetLength="0004" calculateBeforeNonCum="false" interval="ToValue"/>',
  );
  assert.match(textReplacementPathXml(base), /type="Key".*interval="FromValue"/);
});

test('text variable arguments that cannot be stored are refused', () => {
  assert.throws(() => validateTextArgs({ ...base, processing_type: 'ReplacementPath' }), /needs iobj_name/);
  assert.throws(() => validateTextArgs({ ...base, iobj_name: 'CHAR', ready_for_input: true }), /cannot be ready for input/);
  assert.throws(() => validateTextArgs({ ...base, iobj_name: 'CHAR', represents: 'Interval' }), /single value/);
  assert.throws(() => validateTextArgs({ ...base, processing_type: 'Authorization' }), /not "Authorization"/);
  assert.throws(() => validateTextArgs({ ...base, processing_type: 'CustomerExit', iobj_name: 'CHAR' }), /leave iobj_name out/);
  assert.throws(() => validateTextArgs({ ...base, replacement_type: 'Key' }), /replacement path only/);
  assert.throws(() => validateTextArgs({ ...base, dimension: 'Number' }), /formula variables only/);
  assert.throws(() => validateTextArgs({ ...base, iobj_name: 'CHAR', offset_start: -1 }), /0 to 9999/);
  assert.doesNotThrow(() => validateTextArgs({ ...base, iobj_name: 'CHAR', replacement_type: 'ExternalCharacteristic' }));
});

// The description form the backend stores for a member that names a text variable.
const doc =
  '<Qry:mainComponent><Qry:members id="M1"><Qry:description default="false" value="Amount &amp;TV_A&amp; (&amp;TV_B&amp;)"/></Qry:members>' +
  '<Qry:members id="M2"><Qry:description default="false" value="R&amp;D"/></Qry:members>' +
  '<Qry:members id="M3"><Qry:description default="false" value="Again &amp;TV_A&amp;"><Qry:variables>UID_A</Qry:variables></Qry:description></Qry:members></Qry:mainComponent>';

test('names written as &NAME& are found in descriptions; a lone ampersand is not one', () => {
  assert.deepEqual(textVariableTokens(doc).sort(), ['TV_A', 'TV_B']);
});

test('a description lists the id of every text variable it names, once', () => {
  const bound = bindDescriptionVariables(doc, new Map([['TV_A', 'UID_A']]));
  assert.match(bound, /value="Amount &amp;TV_A&amp; \(&amp;TV_B&amp;\)"><Qry:variables>UID_A<\/Qry:variables><\/Qry:description>/);
  assert.match(bound, /value="R&amp;D"\/>/);
  assert.equal(bound.match(/<Qry:variables>UID_A<\/Qry:variables>/g).length, 2, 'the already bound description is left alone');
  assert.equal(bindDescriptionVariables(bound, new Map([['TV_A', 'UID_A']])), bound);
});

const textVariable = (procType) =>
  `<Qry:queryResource><Qry:mainComponent xsi:type="Qry:Variable" infoObject="CHAR" readyForInput="false">` +
  `<Qry:description default="false" value="T"/><Qry:entityProperties adtCore:description="T"></Qry:entityProperties><Qry:type>Text</Qry:type><Qry:procType>${procType}</Qry:procType>` +
  `<Qry:represents>SingleValue</Qry:represents></Qry:mainComponent></Qry:queryResource>`;

test('changes a text variable cannot have are refused', () => {
  assert.throws(() => applyVariableChanges(textVariable('ReplacementPath'), { variable_name: 'TV', ready_for_input: true }), /cannot be ready for input/);
  assert.throws(() => applyVariableChanges(textVariable('ReplacementPath'), { variable_name: 'TV', processing_type: 'UserEntry' }), /cannot change between/);
  assert.throws(() => applyVariableChanges(textVariable('UserEntry'), { variable_name: 'TV', processing_type: 'ReplacementPath' }), /cannot change between/);
  assert.throws(() => applyVariableChanges(textVariable('UserEntry'), { variable_name: 'TV', represents: 'Interval' }), /single value/);
  assert.doesNotThrow(() => applyVariableChanges(textVariable('UserEntry'), { variable_name: 'TV', processing_type: 'CustomerExit' }));
});

test('a source variable goes on the replacement path with its id, name and description', () => {
  const xml = textReplacementPathXml(
    { ...base, iobj_name: 'CHAR', replacement_type: 'Name' },
    { id: 'UID_V', name: 'VAR_NAME', description: 'A & B' },
  );
  assert.match(xml, /type="Name".* id="UID_V" name="VAR_NAME" description="A &amp; B"\/>$/);
  assert.throws(() => validateTextArgs({ ...base, replacement_variable: 'VAR_NAME' }), /replacement path only/);
});
