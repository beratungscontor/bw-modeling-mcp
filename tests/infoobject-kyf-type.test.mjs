import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KYF_TYPE_MAP } from '../dist/tools/infoobject.js';

test('an amount key figure gets the key figure type BW accepts', () => {
  // BW knows AMO, QUA, NUM, INT, DAT and TIM; "AMT" is created without complaint and then
  // refused at activation with "invalid type AMT".
  assert.deepEqual(KYF_TYPE_MAP.CURR, { keyfigureType: 'AMO', semantics: 'AMO' });
  assert.equal(KYF_TYPE_MAP.QUAN.keyfigureType, 'QUA');
});
