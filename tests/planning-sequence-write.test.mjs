import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sequenceBody, stepXml } from '../dist/tools/planning_sequence_write.js';

// The forms the modeling tools sent in a trace: relative paths, the filter by id and by name.

test('a function step and an input template are written as the modeling tools write them', () => {
  assert.equal(
    stepXml({ type: 'planning_function', aggregation_level: 'LEVEL', planning_function: 'FUNC', filter: 'filter_a' }, 'FILTERUID'),
    '<step alvl="../../../alvl/level/a/model.alvl#//" filter="../../../filter/filter_a/A/model.filter#FILTERUID" ' +
      'filterName="FILTER_A" planningService="../../../plse/func/a/model.plse#//" type="2"/>'
  );
  assert.match(stepXml({ type: 'input_template', aggregation_level: 'LEVEL', filter: 'F' }, 'U'), /filterName="F" type="1"\/>$/);
  assert.throws(() => stepXml({ type: 'planning_function', aggregation_level: 'LEVEL', filter: 'F' }, 'U'), /needs planning_function/);
});

test('the steps of the read document are replaced in the given order, the rest kept', () => {
  const read =
    '<PlanningSequence:planningSequence name="SEQ"><description label="old"/><tlogoProperties><infoArea>AREA</infoArea></tlogoProperties>' +
    '<step type="2" alvl="LEVEL.alvl#//" planningService="A.plse#//" filter="U" filterName="F"/>' +
    '<step type="1" alvl="LEVEL.alvl#//" filter="U" filterName="F"/></PlanningSequence:planningSequence>';
  const out = sequenceBody(read, ['<step id="2"/>', '<step id="1"/>'], 'new');
  assert.equal(out, '<PlanningSequence:planningSequence name="SEQ"><description label="new"/><tlogoProperties><infoArea>AREA</infoArea></tlogoProperties><step id="2"/><step id="1"/></PlanningSequence:planningSequence>');
});
