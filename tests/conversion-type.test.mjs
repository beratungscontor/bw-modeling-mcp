import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversionContent, fullBody, formatConversionType } from '../dist/tools/conversion_type.js';

// The forms below are the ones the modeling tools sent in a trace, and the ones the backend's
// simple transformation reads.

test('a flag that is false is left out, as the backend refuses "false" with a runtime error', () => {
  const xml = conversionContent({ kind: 'currency', name: 'X', description: 'x', rate_type: 'M' });
  assert.doesNotMatch(xml, /inverse=|useInTransformationOnly=/);
  assert.match(xml, /<conv:exchange viaFiModules="true"><conv:exchangeType type="RateType" refObject="M"\/><conv:exchangeRate\/><\/conv:exchange>/);
  assert.match(xml, /<conv:time xsi:type="conv:FixedTime"><conv:type>CurrentDate<\/conv:type><\/conv:time>$/);
  const on = conversionContent({ kind: 'currency', name: 'X', description: 'x', rate_type: 'M', inverse: true, in_transformation_only: true });
  assert.match(on, /<conv:type useInTransformationOnly="true"\/>/);
  assert.match(on, /<conv:exchange inverse="true"/);
});

test('source and target: data dependent is left out, the others carry kind and name', () => {
  const xml = conversionContent({
    kind: 'currency', name: 'X', description: 'x', rate_type: 'M',
    source: { kind: 'record' }, target: { kind: 'variable', name: 'var_name' },
  });
  assert.match(xml, /^<conv:type target="Variable" targetName="VAR_NAME"\/>/);
  assert.match(conversionContent({ kind: 'unit', name: 'X', description: 'x', target: { kind: 'select' } }), /^<conv:type\/>/);
});

test('a time characteristic carries its reference point, shift and period handling', () => {
  const xml = conversionContent({
    kind: 'currency', name: 'X', description: 'x', rate_type: 'M',
    time: { kind: 'time_characteristic', characteristic: '0calmonth', reference: 'endofmonth', shift: -1, period_handling: '01_01_to_31_12_365Days' },
  });
  assert.match(xml, /<conv:time xsi:type="conv:VariableTime" refObject="0CALMONTH" type="EndOfMonth" periodHandling="01_01_to_31_12_365Days"><conv:timeShift type="TimeShift" shift="-1"\/><\/conv:time>/);
  assert.match(
    conversionContent({ kind: 'currency', name: 'X', description: 'x', rate_type: 'M', time: { kind: 'key_date', date: '2026-12-31' } }),
    /<conv:time xsi:type="conv:FixedTime" refObject="20261231"><conv:type>KeyDate<\/conv:type>/
  );
});

test('a unit type takes its factor determination and the InfoObject it needs', () => {
  const xml = conversionContent({ kind: 'unit', name: 'X', description: 'x', factors: 'infoobject_t006', factors_infoobject: 'iobj_name', allow_initial_source_value: true });
  assert.match(xml, /<conv:factors allowInitialSourceValue="true"><conv:type determinationMode="InfoObject_T006" refObject="IOBJ_NAME"\/><\/conv:factors>$/);
  assert.throws(() => conversionContent({ kind: 'unit', name: 'X', description: 'x', factors: 'InfoObject' }), /needs factors_infoobject/);
});

test('an unknown option or a missing rate type is refused before anything is written', () => {
  assert.throws(() => conversionContent({ kind: 'currency', name: 'X', description: 'x' }), /exactly one of rate_type or rate_type_variable/);
  assert.throws(
    () => conversionContent({ kind: 'currency', name: 'X', description: 'x', rate_type: 'M', time: { kind: 'time_characteristic', characteristic: 'C', reference: 'Noon' } }),
    /time.reference "Noon" is not one of/
  );
  assert.throws(() => conversionContent({ kind: 'currency', name: 'X', description: 'x', rate_type: 'M', target: { kind: 'fixed' } }), /needs name/);
});

test('the PUT keeps the entity properties as read and replaces the content after them', () => {
  const read =
    '<?xml version="1.0" encoding="utf-8"?><conv:conversion xsi:type="conv:UnitConversion" xmlns:conv="http://www.sap.com/bw/Conversion.ecore" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    '<conv:name>X</conv:name><conv:description>old</conv:description><conv:entityProperties adtcore:name="X"><infoArea>0BW4_GLOBAL</infoArea></conv:entityProperties>' +
    '<conv:type source="DataDependent" target="DataDependent"/><conv:factors><conv:type determinationMode="T006"/></conv:factors></conv:conversion>';
  const out = fullBody(read, { kind: 'unit', name: 'X', description: 'new', target: { kind: 'fixed', name: 'KM' } });
  assert.match(out, /<conv:description>new<\/conv:description>/);
  assert.match(out, /<infoArea>0BW4_GLOBAL<\/infoArea><\/conv:entityProperties><conv:type target="Fixed" targetName="KM"\/>/);
  assert.equal((out.match(/<conv:factors>/g) ?? []).length, 1);
});

test('the reader names a target chosen when converting, and a reference point rather than the element type', () => {
  const text = formatConversionType(
    '<conv:conversion xsi:type="conv:CurrencyTranslation"><conv:name>X</conv:name><conv:description>d</conv:description>' +
    '<conv:type source="DataDependent" target="DataDependent"/><conv:exchange viaFiModules="true"><conv:exchangeType type="RateType" refObject="M"/><conv:exchangeRate type="Dynamic"/></conv:exchange>' +
    '<conv:time xsi:type="conv:VariableTime" type="EndOfMonth" refObject="0CALMONTH"><conv:timeShift type="TimeShift" shift="1"/></conv:time></conv:conversion>'
  );
  assert.match(text, /Target: selected at conversion time/);
  assert.match(text, /time characteristic 0CALMONTH, EndOfMonth, shifted by 1/);
});
