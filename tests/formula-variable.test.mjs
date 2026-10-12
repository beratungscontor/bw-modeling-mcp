import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decimalSeparatorOf,
  formatDecimal,
  parseDecimal,
  formulaDefaultLiteral,
  unitCurrencyXml,
  checkUnitCurrency,
  defaultSelectionXml,
  bwCreateVariable,
} from '../dist/tools/variable.js';
import { formulaDefaultText } from '../dist/tools/cp_components.js';
import { parseFormulaXml, renderFormulaTree, applyVariableChanges } from '../dist/tools/elem_write.js';
import { renderFormulaNode, collectFormulaVariables, assertFormulaVariable } from '../dist/tools/query_update.js';

// ── Decimal notation ─────────────────────────────────────────────────────────
// BW parses a formula variable's default in the logon user's notation: with a comma
// notation "2.5" is stored as 25 and reported as consistent.

test('USR01-DCPFM maps to the decimal separator', () => {
  assert.equal(decimalSeparatorOf(''), ',');
  assert.equal(decimalSeparatorOf(' '), ',');
  assert.equal(decimalSeparatorOf('Y'), ',');
  assert.equal(decimalSeparatorOf('X'), '.');
});

test('a value is written in the user notation, without thousands separators', () => {
  assert.equal(formatDecimal(2.5, ','), '2,5');
  assert.equal(formatDecimal(-3.75, ','), '-3,75');
  assert.equal(formatDecimal(2.5, '.'), '2.5');
  assert.equal(formatDecimal(1234567.5, ','), '1234567,5');
  assert.equal(formatDecimal(1e-7, '.'), '0.0000001');
});

test('a value BW shows is read back in the user notation', () => {
  assert.equal(parseDecimal('2,50000', ','), 2.5);
  assert.equal(parseDecimal('-3,75000', ','), -3.75);
  assert.equal(parseDecimal('3.75000-', '.'), -3.75);
  assert.equal(parseDecimal('1.234,5', ','), 1234.5);
  assert.equal(parseDecimal('1,234.5', '.'), 1234.5);
  assert.equal(parseDecimal('', ','), undefined);
});

test('a whole-number default needs no notation lookup', async () => {
  const client = { rawPost: async () => { throw new Error('no lookup expected'); } };
  assert.equal(await formulaDefaultLiteral(client, 7), '7');
  assert.equal(await formulaDefaultLiteral(client, -12), '-12');
});

test('a fractional default is refused when the notation cannot be read', async () => {
  const client = {
    getCsrfToken: async () => 'x',
    rawPost: async () => { throw new Error('HTTP 403'); },
  };
  await assert.rejects(formulaDefaultLiteral(client, 2.5), /decimal notation of the logon user/);
});

test('the default value lands in defaultValues as I EQ on 1FORMULA', () => {
  const xml = defaultSelectionXml('1FORMULA', '2,5');
  assert.match(xml, /<Qry:selections infoObject="1FORMULA" paramSelectionType="Default" usageType="asFilter">/);
  assert.match(xml, /operator="Equal"/);
  assert.match(xml, /<Qry:value>2,5<\/Qry:value>/);
  assert.equal(
    defaultSelectionXml('1FORMULA'),
    '<Qry:selections infoObject="1FORMULA" paramSelectionType="Default" usageType="asFilter"/>'
  );
});

test('the default value is read out of defaultValues, not defaultSelection', () => {
  const body =
    '<Qry:defaultSelection/><Qry:defaultValues><Qry:selections infoObject="1FORMULA">' +
    '<Qry:tokens xsi:type="Qry:SelectionRange" operator="Equal"><Qry:fromValue><Qry:value>2,50000</Qry:value>' +
    '<Qry:type>Value</Qry:type></Qry:fromValue></Qry:tokens></Qry:selections></Qry:defaultValues>';
  assert.equal(formulaDefaultText(body), '2,50000');
  assert.equal(formulaDefaultText('<Qry:defaultValues><Qry:selections infoObject="1FORMULA"/></Qry:defaultValues>'), undefined);
});

// ── Unit and currency ────────────────────────────────────────────────────────

test('unit and currency are key attributes; a text body would be dropped', () => {
  assert.equal(unitCurrencyXml(undefined, 'st'), '<Qry:currency/><Qry:unit key="ST"/>');
  assert.equal(unitCurrencyXml('eur', 'st'), '<Qry:currency key="EUR"/><Qry:unit key="ST"/>');
  assert.equal(unitCurrencyXml(), '<Qry:currency/><Qry:unit/>');
});

test('each dimension takes the unit and currency it can carry', () => {
  assert.throws(() => checkUnitCurrency('Quantity'), /needs a unit/);
  assert.throws(() => checkUnitCurrency('Amount'), /needs a currency/);
  assert.throws(() => checkUnitCurrency('Number', 'EUR'), /has no currency/);
  assert.throws(() => checkUnitCurrency('Amount', 'EUR', 'ST'), /has no unit/);
  checkUnitCurrency('Quantity', undefined, 'ST');
  checkUnitCurrency('Amount', 'EUR');
  checkUnitCurrency('Price');
  checkUnitCurrency('Price', 'EUR', 'ST');
  checkUnitCurrency('Number');
});

test('bw_create_variable refuses formula arguments that cannot be stored', async () => {
  const base = { variable_name: 'VAR_NAME', description: 'x', variable_type: 'Formula' };
  const client = {};
  await assert.rejects(bwCreateVariable(client, { ...base, iobj_name: 'CHARACTERISTIC' }), /not defined on a characteristic/);
  await assert.rejects(bwCreateVariable(client, { ...base, processing_type: 'Authorization' }), /UserEntry" or "CustomerExit/);
  await assert.rejects(bwCreateVariable(client, { ...base, represents: 'Interval' }), /single value/);
  await assert.rejects(bwCreateVariable(client, { ...base, dimension: 'Quantity' }), /needs a unit/);
  await assert.rejects(
    bwCreateVariable(client, { variable_name: 'VAR_NAME', description: 'x', iobj_name: 'CHARACTERISTIC', default_value: 1 }),
    /formula variables only/
  );
});

// ── Formula operand ──────────────────────────────────────────────────────────

const VAR_ID = 'VARUID0000000000000000001';

test('a CKF references a formula variable by its id with operandType Variable', () => {
  const xml = renderFormulaTree(
    { type: 'operator', code: '/', operands: [
      { type: 'key_figure', name: 'KEYFIGURE' },
      { type: 'variable', variable_id: VAR_ID, variable_name: 'VAR_NAME' },
    ] },
    'Qry:formulaToken'
  );
  assert.match(xml, new RegExp(`<Qry:childToken xsi:type="Qry:FormulaMemberOperand" member="${VAR_ID}" operandType="Variable"/>`));
});

test('reading a CKF formula back keeps a variable operand a variable', () => {
  const fragment =
    '<Qry:formulaToken xsi:type="Qry:FormulaInfixOperator" code="/">' +
    '<Qry:childToken xsi:type="Qry:FormulaIObjectOperand" infoObject="KEYFIGURE"/>' +
    `<Qry:childToken xsi:type="Qry:FormulaMemberOperand" member="${VAR_ID}" operandType="Variable"/>` +
    '</Qry:formulaToken>';
  const tree = parseFormulaXml(fragment);
  assert.deepEqual(tree.operands[1], { type: 'variable', variable_id: VAR_ID });
  assert.match(renderFormulaTree(tree, 'Qry:formulaToken'), /operandType="Variable"/);
  assert.doesNotMatch(renderFormulaTree(tree, 'Qry:formulaToken'), /operandType="Formula"/);
});

test('a query formula references the embedded variable subComponent', () => {
  const doc =
    `<Qry:subComponents xsi:type="Qry:Variable" id="${VAR_ID}" technicalName="VAR_NAME" infoObject="1FORMULA"/>` +
    '<Qry:mainComponent id="Q"></Qry:mainComponent>';
  const xml = renderFormulaNode({ type: 'variable', variable_name: 'var_name' }, doc, 'Qry:childToken');
  assert.equal(xml, `<Qry:childToken xsi:type="Qry:FormulaMemberOperand" member="${VAR_ID}" operandType="Variable"/>`);
  assert.throws(
    () => renderFormulaNode({ type: 'variable', variable_name: 'OTHER' }, doc, 'Qry:childToken'),
    /not embedded/
  );
});

test('every variable operand of a formula and its inverse is collected once', () => {
  const names = collectFormulaVariables({ type: 'operator', code: '+', operands: [
    { type: 'variable', variable_name: 'var_a' },
    { type: 'operator', code: '*', operands: [{ type: 'variable', variable_name: 'VAR_A' }, { type: 'variable', variable_name: 'VAR_B' }] },
    { type: 'constant', value: 1 },
  ] });
  assert.deepEqual([...names], ['VAR_A', 'VAR_B']);
  assert.deepEqual([...collectFormulaVariables(undefined)], []);
});

test('a characteristic variable is refused as a formula operand', () => {
  assert.throws(() => assertFormulaVariable('VAR_NAME', 'CHARACTERISTIC'), /characteristic variable/);
  assertFormulaVariable('VAR_NAME', '1FORMULA');
});

// ── bw_update_variable on a formula variable ─────────────────────────────────

const FORMULA_DOC =
  '<Qry:queryResource><Qry:mainComponent xsi:type="Qry:Variable" id="X" technicalName="VAR_NAME" ' +
  'attribute="1ATTRKEY" dimIndicator="Quantity" infoObject="1FORMULA" readyForInput="true">' +
  '<Qry:description default="false" value="Old"/>' +
  '<Qry:defaultHint><Qry:value>5</Qry:value><Qry:type>Constant</Qry:type></Qry:defaultHint>' +
  '<Qry:entityProperties adtCore:description="Old"></Qry:entityProperties>' +
  '<Qry:currency/><Qry:unit key="ST"/><Qry:replacementPath/><Qry:type>Formula</Qry:type>' +
  '<Qry:procType>UserEntry</Qry:procType><Qry:represents>SingleValue</Qry:represents>' +
  '<Qry:inputType>Optional</Qry:inputType><Qry:defaultSelection/>' +
  '<Qry:defaultValues><Qry:selections infoObject="1FORMULA" usageType="asFilter" paramSelectionType="Default"/></Qry:defaultValues>' +
  '</Qry:mainComponent></Qry:queryResource>';

test('the default value, unit and currency of a formula variable are replaced in place', () => {
  const { document, applied } = applyVariableChanges(
    FORMULA_DOC,
    { variable_name: 'VAR_NAME', default_value: 2.5, unit: 'kg' },
    { literal: '2,5' }
  );
  assert.match(document, /<Qry:unit key="KG"\/>/);
  assert.match(document, /<Qry:value>2,5<\/Qry:value>/);
  assert.match(document, /<Qry:defaultHint><Qry:value>5<\/Qry:value><Qry:type>Constant<\/Qry:type><\/Qry:defaultHint>/);
  assert.deepEqual(applied, ['unit set to KG', 'default value set to 2.5']);

  const cleared = applyVariableChanges(FORMULA_DOC, { variable_name: 'VAR_NAME', default_value: null }, { literal: null });
  assert.match(cleared.document, /<Qry:defaultValues><Qry:selections infoObject="1FORMULA" paramSelectionType="Default" usageType="asFilter"\/><\/Qry:defaultValues>/);
});

test('changes a formula variable cannot have are refused', () => {
  assert.throws(() => applyVariableChanges(FORMULA_DOC, { variable_name: 'V', unit: '' }), /needs a unit/);
  assert.throws(() => applyVariableChanges(FORMULA_DOC, { variable_name: 'V', currency: 'EUR' }), /has no currency/);
  assert.throws(() => applyVariableChanges(FORMULA_DOC, { variable_name: 'V', processing_type: 'Authorization' }), /UserEntry/);
  assert.throws(() => applyVariableChanges(FORMULA_DOC, { variable_name: 'V', represents: 'Interval' }), /single value/);
  const characteristic = FORMULA_DOC.replace('infoObject="1FORMULA" readyForInput', 'infoObject="CHARACTERISTIC" readyForInput');
  assert.throws(() => applyVariableChanges(characteristic, { variable_name: 'V', unit: 'ST' }), /only be changed on a formula variable/);
});
