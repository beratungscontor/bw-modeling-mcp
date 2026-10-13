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
