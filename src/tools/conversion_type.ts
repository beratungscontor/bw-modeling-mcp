import { BwClient, MEDIA_TYPES, bwSeg, decodeXmlEntities, lockSessionHeader, stripInfoAreaSentinel } from '../bw-client.js';

/**
 * Currency translation types (TLOGO CTRT) and unit conversion types (TLOGO UOMT).
 *
 * The backend reads the body through a simple transformation per type, and every option of the
 * modeling tools is one attribute of it, independent of the others: the source and target, the
 * exchange rate, the time reference, the factor determination. The values are those of
 * IF_RSO_RES_CONV_CONST. Two kinds of attribute must be left out rather than sent empty: a flag
 * that is false (the transformation refuses "false" for inverse and useInTransformationOnly with a
 * runtime error), and a value-bearing attribute without a value.
 *
 * Creation follows the modeling tools: a shell is posted with the lock taken for creation, then
 * the full object is written to the active version with a PUT on `/a` under a second lock. There
 * is no activation step.
 */

export type ConversionKind = 'currency' | 'unit';

const TLOGO: Record<ConversionKind, 'ctrt' | 'uomt'> = { currency: 'ctrt', unit: 'uomt' };
const FALLBACK: Record<ConversionKind, string> = {
  currency: 'application/vnd.sap.bw.modeling.ctrt-v1_0_0+xml',
  unit: 'application/vnd.sap.bw.modeling.uomt-v1_0_0+xml',
};
const mediaType = (kind: ConversionKind) => MEDIA_TYPES[TLOGO[kind]] ?? FALLBACK[kind];
const objectPath = (kind: ConversionKind, name: string) => `/sap/bw/modeling/${TLOGO[kind]}/${bwSeg(name.toLowerCase())}`;

/**
 * How a source or target currency/unit is determined. data_dependent is the default and is left
 * out: for a source it is the currency or unit of the record, for a target the one chosen when
 * converting; the backend stores both as DataDependent.
 */
export const SIDE_KINDS = ['data_dependent', 'fixed', 'infoobject', 'variable'] as const;
export type SideKind = (typeof SIDE_KINDS)[number];
const SIDE_ALIASES: Record<string, SideKind> = { record: 'data_dependent', select: 'data_dependent' };

const SIDE_VALUES: Record<SideKind, string | undefined> = {
  data_dependent: undefined,
  fixed: 'Fixed',
  infoobject: 'InfoObject',
  variable: 'Variable',
};

/** The longest description each type stores; a longer one ends in a runtime error on the server. */
export const DESCRIPTION_LIMIT: Record<ConversionKind, number> = { currency: 40, unit: 60 };

export interface SideInput {
  kind: SideKind;
  /** The currency or unit (fixed), the InfoObject, or the variable. */
  name?: string;
  /** Unit conversion with an InfoObject: the attribute carrying the quantity. */
  quantity_attribute?: string;
}

export const RATE_SPECIFIC = ['No', 'BuyingRate', 'MiddleRate', 'SellingRate', 'BuyingMiddleOrSellingRate'] as const;

export const TIME_KINDS = ['current_date', 'key_date', 'variable', 'query_key_date', 'time_characteristic'] as const;
export type TimeKind = (typeof TIME_KINDS)[number];

const FIXED_TIME: Partial<Record<TimeKind, string>> = {
  current_date: 'CurrentDate',
  key_date: 'KeyDate',
  variable: 'Variable',
  query_key_date: 'QueryKeyDate',
};

export const TIME_REFERENCES = [
  'FiscalYearEnd', 'FiscalYearStart', 'EndOfPeriod', 'BeginningOfPeriod',
  'EndOfCalendarYear', 'StartOfCalendarYear', 'EndOfCalendarYearQuarter', 'StartOfCalendarYearQuarter',
  'EndOfMonth', 'StartOfMonth', 'EndOfWeek', 'StartOfWeek', 'ToExactDay',
  'EndOfFiscQuarter', 'BeginningOfFiscQuarter', 'EndOfFiscWeek', 'BeginningOfFiscWeek',
] as const;

export const PERIOD_HANDLING = ['31_12_to_31_12_1Day', '01_01_to_01_01_1Day', '01_01_to_31_12_365Days', '31_12_to_01_01_2Days'] as const;

export const FACTOR_DETERMINATION = [
  'T006', 'InfoObject', 'InfoObject_T006', 'T006_InfoObject', 'SIUnits', 'InfoObject_SIUnits', 'SIUnits_InfoObject',
] as const;

export interface TimeInput {
  kind: TimeKind;
  /** key_date: the date, YYYY-MM-DD or YYYYMMDD. */
  date?: string;
  /** variable: the date variable. */
  variable?: string;
  /** time_characteristic: the time characteristic, its reference point and an optional shift. */
  characteristic?: string;
  reference?: string;
  shift?: number;
  shift_variable?: string;
  period_handling?: string;
}

export interface ConversionTypeInput {
  kind: ConversionKind;
  name: string;
  description: string;
  source?: SideInput;
  target?: SideInput;
  // Currency translation
  rate_type?: string;
  rate_type_variable?: string;
  exchange_rate_infoobject?: string;
  rate_specific?: string;
  inverse?: boolean;
  in_transformation_only?: boolean;
  via_fi_modules?: boolean;
  time?: TimeInput;
  // Unit conversion
  factors?: string;
  factors_infoobject?: string;
  allow_initial_source_value?: boolean;
  no_conversion_if_factors_not_found?: boolean;
  package?: string;
  transport?: string;
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function oneOf<T extends string>(value: string, allowed: readonly T[], field: string): T {
  const hit = allowed.find((a) => a.toLowerCase() === value.trim().toLowerCase());
  if (!hit) throw new Error(`${field} "${value}" is not one of: ${allowed.join(', ')}.`);
  return hit;
}

const attr = (name: string, value: string | undefined) => (value ? ` ${name}="${esc(value)}"` : '');

function sideAttrs(side: SideInput | undefined, role: 'source' | 'target', kind: ConversionKind): string {
  if (!side) return '';
  const sideKind = SIDE_ALIASES[side.kind?.trim().toLowerCase()] ?? oneOf(side.kind, SIDE_KINDS, role);
  const value = SIDE_VALUES[sideKind];
  if (value && !side.name) throw new Error(`${role} "${sideKind}" needs name.`);
  if (side.quantity_attribute && (kind !== 'unit' || sideKind !== 'infoobject')) {
    throw new Error(`${role}: quantity_attribute applies to a unit conversion with kind "infoobject" only.`);
  }
  const name = value ? side.name!.trim().toUpperCase() : undefined;
  return attr(role, value) + attr(`${role}Name`, name) + attr(`${role}QtyAttribute`, side.quantity_attribute?.trim().toUpperCase());
}

function normalizeDate(date: string): string {
  const digits = date.replace(/\D/g, '');
  if (digits.length !== 8) throw new Error(`time.date "${date}" is not a date (YYYY-MM-DD or YYYYMMDD).`);
  return digits;
}

function timeXml(time: TimeInput | undefined): string {
  const t: TimeInput = time ?? { kind: 'current_date' };
  const kind = oneOf(t.kind, TIME_KINDS, 'time.kind');
  if (kind !== 'time_characteristic') {
    const ref = kind === 'key_date'
      ? normalizeDate(t.date ?? '')
      : kind === 'variable'
        ? (t.variable ?? '').trim().toUpperCase()
        : '';
    if (kind === 'variable' && !ref) throw new Error('time "variable" needs variable.');
    return `<conv:time xsi:type="conv:FixedTime"${attr('refObject', ref)}><conv:type>${FIXED_TIME[kind]}</conv:type></conv:time>`;
  }
  if (!t.characteristic) throw new Error('time "time_characteristic" needs characteristic.');
  const reference = t.reference ? oneOf(t.reference, TIME_REFERENCES, 'time.reference') : undefined;
  const period = t.period_handling ? oneOf(t.period_handling, PERIOD_HANDLING, 'time.period_handling') : undefined;
  if (t.shift !== undefined && t.shift_variable) throw new Error('time: pass shift or shift_variable, not both.');
  const shift = t.shift_variable
    ? `<conv:timeShift type="TimeShiftFromVariable"${attr('varName', t.shift_variable.trim().toUpperCase())}/>`
    : t.shift !== undefined && t.shift !== 0
      ? `<conv:timeShift type="TimeShift" shift="${Math.trunc(t.shift)}"/>`
      : '<conv:timeShift/>';
  return (
    `<conv:time xsi:type="conv:VariableTime"${attr('refObject', t.characteristic.trim().toUpperCase())}` +
    `${attr('type', reference)}${attr('periodHandling', period)}>${shift}</conv:time>`
  );
}

/** The content elements of the object: everything after the entity properties. */
export function conversionContent(input: ConversionTypeInput): string {
  const typeEl =
    `<conv:type${input.kind === 'currency' && input.in_transformation_only ? ' useInTransformationOnly="true"' : ''}` +
    `${sideAttrs(input.source, 'source', input.kind)}${sideAttrs(input.target, 'target', input.kind)}/>`;

  if (input.kind === 'unit') {
    const mode = oneOf(input.factors ?? 'T006', FACTOR_DETERMINATION, 'factors');
    if (/InfoObject/.test(mode) && !input.factors_infoobject) {
      throw new Error(`factors "${mode}" needs factors_infoobject, the InfoObject that carries the conversion factors.`);
    }
    return (
      typeEl +
      `<conv:factors${input.allow_initial_source_value ? ' allowInitialSourceValue="true"' : ''}` +
      `${input.no_conversion_if_factors_not_found ? ' noConversionIfFactorsNotFound="true"' : ''}>` +
      `<conv:type determinationMode="${mode}"${attr('refObject', input.factors_infoobject?.trim().toUpperCase())}/></conv:factors>`
    );
  }

  if (!!input.rate_type === !!input.rate_type_variable) {
    throw new Error('A currency translation needs exactly one of rate_type or rate_type_variable.');
  }
  const exchangeType = input.rate_type
    ? `<conv:exchangeType type="RateType" refObject="${esc(input.rate_type.trim().toUpperCase())}"/>`
    : `<conv:exchangeType type="FromVariable" refObject="${esc(input.rate_type_variable!.trim().toUpperCase())}"/>`;
  const exchangeRate = input.exchange_rate_infoobject
    ? `<conv:exchangeRate type="FromInfoObject" refObject="${esc(input.exchange_rate_infoobject.trim().toUpperCase())}"/>`
    : '<conv:exchangeRate/>';
  const specific = input.rate_specific ? oneOf(input.rate_specific, RATE_SPECIFIC, 'rate_specific') : undefined;
  return (
    typeEl +
    `<conv:exchange${input.inverse ? ' inverse="true"' : ''} viaFiModules="${input.via_fi_modules === false ? 'false' : 'true'}"` +
    `${specific && specific !== 'No' ? ` exchangeRateTypeSpecific="${specific}"` : ''}>${exchangeType}${exchangeRate}</conv:exchange>` +
    timeXml(input.time)
  );
}

const XSI_TYPE: Record<ConversionKind, string> = { currency: 'conv:CurrencyTranslation', unit: 'conv:UnitConversion' };
const NS =
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:adtcore="http://www.sap.com/adt/core" ' +
  'xmlns:atom="http://www.w3.org/2005/Atom" xmlns:conv="http://www.sap.com/bw/Conversion.ecore"';

/** The shell the modeling tools post first: name, description and the minimum the type needs. */
export function shellBody(input: ConversionTypeInput, responsible: string): string {
  const name = input.name.toUpperCase();
  const tlogo = TLOGO[input.kind].toUpperCase();
  const minimum = input.kind === 'unit'
    ? '<conv:type/><conv:factors><conv:type determinationMode="T006"/></conv:factors>'
    : '<conv:type/><conv:exchange><conv:exchangeType refObject="M"/></conv:exchange>' +
      '<conv:time xsi:type="conv:FixedTime"><conv:type>CurrentDate</conv:type></conv:time>';
  return (
    `<?xml version="1.0" encoding="UTF-8"?><conv:conversion ${NS} xsi:type="${XSI_TYPE[input.kind]}">` +
    `<conv:name>${name}</conv:name><conv:description>${esc(input.description)}</conv:description>` +
    `<conv:entityProperties adtcore:name="${name}" adtcore:type="${tlogo}"${attr('adtcore:responsible', responsible)}/>` +
    `${minimum}</conv:conversion>`
  );
}

/** The object as read, with its content replaced: what the PUT sends back. */
export function fullBody(read: string, input: ConversionTypeInput): string {
  const end = read.indexOf('</conv:entityProperties>');
  if (end < 0) throw new Error('Unexpected conversion type document: no entity properties.');
  const head = read.slice(0, end + '</conv:entityProperties>'.length)
    .replace(/<conv:description>[\s\S]*?<\/conv:description>/, `<conv:description>${esc(input.description)}</conv:description>`);
  const withNs = head.includes('xmlns:atom=') ? head : head.replace('<conv:conversion ', '<conv:conversion xmlns:atom="http://www.w3.org/2005/Atom" ');
  return `${withNs}${conversionContent(input)}</conv:conversion>`;
}

interface SaveResult {
  ok: boolean;
  messages: string[];
}

function parseFeed(body: string): SaveResult {
  const messages: string[] = [];
  let ok = true;
  for (const e of body.matchAll(/<atom:entry>([\s\S]*?)<\/atom:entry>/g)) {
    const type = e[1].match(/messageType="([^"]*)"/)?.[1] ?? '';
    const title = decodeXmlEntities(e[1].match(/<atom:title>([^<]*)<\/atom:title>/)?.[1] ?? '');
    if (type === 'Error') ok = false;
    if (title) messages.push(type ? `${type}: ${title}` : title);
  }
  return { ok, messages };
}

async function lock(client: BwClient, path: string, mt: string, csrf: string, create: boolean) {
  const res = await client.rawPost(`${path}?action=lock`, '', {
    Accept: mt,
    'x-csrf-token': csrf,
    ...(create ? { activity_context: 'CREA' } : {}),
    ...lockSessionHeader(),
  });
  const handle = res.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1];
  if (!handle) throw new Error(`No <LOCK_HANDLE> in lock response:\n${res.body}`);
  return { handle, timestamp: res.headers['timestamp'] };
}

async function unlock(client: BwClient, path: string, mt: string, csrf: string) {
  await client.rawPost(`${path}?action=unlock`, '', { Accept: mt, 'x-csrf-token': csrf }).catch(() => {/* ignore */});
}

/** bw_create_conversion_type — create a currency translation type or a unit conversion type. */
export async function bwCreateConversionType(client: BwClient, input: ConversionTypeInput, responsible = ''): Promise<string> {
  const kind = oneOf(input.kind, ['currency', 'unit'] as const, 'kind');
  const typed: ConversionTypeInput = { ...input, kind };
  if (kind === 'currency' && (input.factors || input.factors_infoobject)) {
    throw new Error('factors apply to a unit conversion type.');
  }
  if (kind === 'unit' && (input.rate_type || input.rate_type_variable || input.time || input.inverse)) {
    throw new Error('rate_type, time and inverse apply to a currency translation type.');
  }
  // Validate the whole input before anything is written.
  conversionContent(typed);
  if (input.description.length > DESCRIPTION_LIMIT[kind]) {
    throw new Error(
      `The description has ${input.description.length} characters; a ` +
        `${kind === 'currency' ? 'currency translation' : 'unit conversion'} type stores at most ${DESCRIPTION_LIMIT[kind]}.`,
    );
  }

  const name = input.name.trim().toUpperCase();
  const mt = mediaType(kind);
  const path = objectPath(kind, name);
  const pkg = input.package ?? '$TMP';
  const corr = input.transport ? `&corrNr=${encodeURIComponent(input.transport)}` : '';
  const csrf = await client.getCsrfToken();

  const first = await lock(client, path, mt, csrf, true);
  let created: SaveResult;
  try {
    const res = await client.rawPost(`${path}?lockHandle=${first.handle}${corr}`, shellBody({ ...typed, name }, responsible), {
      'Content-Type': mt,
      Accept: mt,
      'x-csrf-token': csrf,
      'Development-Class': pkg,
    });
    created = parseFeed(res.body);
  } finally {
    await unlock(client, path, mt, csrf);
  }
  if (!created.ok) {
    return JSON.stringify({ success: false, kind, name, messages: created.messages }, null, 2);
  }

  const read = await client.rawGet(`${path}/a`, { Accept: mt });
  const second = await lock(client, path, mt, csrf, false);
  let saved: SaveResult;
  try {
    const res = await client.rawPut(`${path}/a?lockHandle=${second.handle}${corr}`, fullBody(read.body, typed), {
      'Content-Type': `application/xml, ${mt}`,
      Accept: mt,
      'x-csrf-token': csrf,
      ...(second.timestamp ? { timestamp: second.timestamp } : {}),
    });
    saved = parseFeed(res.body);
  } finally {
    await unlock(client, path, mt, csrf);
  }

  // The backend adjusts some combinations on save, so the answer shows what it stored.
  const stored = await client.rawGet(`${path}/a`, { Accept: mt }).then((r) => formatConversionType(r.body)).catch(() => undefined);
  return JSON.stringify({
    success: saved.ok,
    kind,
    name,
    package: pkg,
    messages: [...created.messages, ...saved.messages],
    ...(stored ? { stored: stored.split('\n') } : {}),
    note: saved.ok
      ? 'Saved to the active version; there is no activation step.'
      : `The object was created, but its settings were refused; it exists with default settings. ` +
        `Correct the input and delete it with bw_delete (object_type "${TLOGO[kind]}") or create it again under another name.`,
  }, null, 2);
}

// ── Reading ──────────────────────────────────────────────────────────────────

// The lookbehind keeps "type" from matching "xsi:type".
const tagAttr = (tag: string | undefined, name: string) =>
  tag ? decodeXmlEntities(tag.match(new RegExp(`(?<![\\w:])${name}="([^"]*)"`))?.[1] ?? '') : '';

function describeSide(kind: string, name: string, qty: string, otherwise: string): string {
  if (!kind || kind === 'DataDependent') return otherwise;
  const label = { Fixed: 'fixed', InfoObject: 'from InfoObject', Variable: 'from variable' }[kind] ?? kind;
  return `${label}${name ? ` ${name}` : ''}${qty ? ` (quantity attribute ${qty})` : ''}`;
}

export function formatConversionType(xml: string): string {
  const unit = /conv:UnitConversion/.test(xml);
  const typeTag = xml.match(/<conv:type\b[^>]*?\/?>/)?.[0];
  const lines = [
    `${unit ? 'Unit Conversion Type' : 'Currency Translation Type'}: ${decodeXmlEntities(xml.match(/<conv:name>([^<]*)/)?.[1] ?? '')}`,
    `Description: ${decodeXmlEntities(xml.match(/<conv:description>([^<]*)/)?.[1] ?? '')}`,
    `InfoArea:    ${stripInfoAreaSentinel(xml.match(/<infoArea>([^<]*)/)?.[1] ?? '') || '(none)'}`,
    `Package:     ${xml.match(/<adtcore:packageRef\b[^>]*\badtcore:name="([^"]*)"/)?.[1] ?? ''}`,
    `Status:      ${xml.match(/<objectStatus>([^<]*)/)?.[1] ?? ''}`,
    '',
    `Source: ${describeSide(tagAttr(typeTag, 'source'), tagAttr(typeTag, 'sourceName'), tagAttr(typeTag, 'sourceQtyAttribute'), 'from the record')}`,
    `Target: ${describeSide(tagAttr(typeTag, 'target'), tagAttr(typeTag, 'targetName'), tagAttr(typeTag, 'targetQtyAttribute'), 'selected at conversion time')}`,
  ];
  if (unit) {
    const factors = xml.match(/<conv:factors\b[^>]*>/)?.[0];
    const det = xml.match(/<conv:factors\b[^>]*>\s*<conv:type\b[^>]*?\/?>/)?.[0];
    lines.push(
      `Factors: ${tagAttr(det, 'determinationMode') || '(not set)'}${tagAttr(det, 'refObject') ? ` — InfoObject ${tagAttr(det, 'refObject')}` : ''}`,
      `Initial source value allowed: ${tagAttr(factors, 'allowInitialSourceValue') === 'true' ? 'yes' : 'no'}`,
      `No conversion if factors not found: ${tagAttr(factors, 'noConversionIfFactorsNotFound') === 'true' ? 'yes' : 'no'}`,
    );
    return lines.join('\n');
  }
  const exchange = xml.match(/<conv:exchange\b[^>]*>/)?.[0];
  const exType = xml.match(/<conv:exchangeType\b[^>]*?\/?>/)?.[0];
  const exRate = xml.match(/<conv:exchangeRate\b[^>]*?\/?>/)?.[0];
  const time = xml.match(/<conv:time\b[^>]*>[\s\S]*?<\/conv:time>/)?.[0] ?? '';
  const timeTag = time.match(/<conv:time\b[^>]*>/)?.[0];
  const shiftTag = time.match(/<conv:timeShift\b[^>]*?\/?>/)?.[0];
  const rateType = tagAttr(exType, 'type') === 'FromVariable' ? `from variable ${tagAttr(exType, 'refObject')}` : tagAttr(exType, 'refObject');
  let timeText: string;
  if (/VariableTime/.test(tagAttr(timeTag, 'xsi:type'))) {
    const shift = tagAttr(shiftTag, 'type') === 'TimeShiftFromVariable'
      ? `, shifted by variable ${tagAttr(shiftTag, 'varName')}`
      : tagAttr(shiftTag, 'shift') ? `, shifted by ${tagAttr(shiftTag, 'shift')}` : '';
    const period = tagAttr(timeTag, 'periodHandling');
    timeText = `time characteristic ${tagAttr(timeTag, 'refObject')}, ${tagAttr(timeTag, 'type') || '(no reference)'}${shift}${period ? `, period handling ${period}` : ''}`;
  } else {
    const fixed = time.match(/<conv:type>([^<]*)<\/conv:type>/)?.[1] ?? '';
    const ref = tagAttr(timeTag, 'refObject');
    timeText = { CurrentDate: 'current date', QueryKeyDate: 'key date of the query', KeyDate: `fixed date ${ref}`, Variable: `date from variable ${ref}` }[fixed] ?? fixed;
  }
  lines.push(
    `Exchange rate type: ${rateType || '(not set)'}`,
    `Exchange rate: ${tagAttr(exRate, 'type') === 'FromInfoObject' ? `from InfoObject ${tagAttr(exRate, 'refObject')}` : 'dynamic'}`,
    `Rate type specific: ${tagAttr(exchange, 'exchangeRateTypeSpecific') || 'No'}`,
    `Inverse: ${tagAttr(exchange, 'inverse') === 'true' ? 'yes' : 'no'}   Via FI modules: ${tagAttr(exchange, 'viaFiModules') === 'true' ? 'yes' : 'no'}` +
      `   Only in transformations: ${tagAttr(typeTag, 'useInTransformationOnly') === 'true' ? 'yes' : 'no'}`,
    `Time reference: ${timeText}`,
  );
  return lines.join('\n');
}

/** The resource answers a missing object with HTTP 500 and a "does not exist" message. */
const isMissing = (err: Error) => /HTTP (404|500)/.test(err.message) && /RSO_RES_CONVMSGS|nicht vorhanden|does not exist|not found/i.test(err.message);

/** bw_get_conversion_type — read a currency translation type or a unit conversion type. */
export async function bwGetConversionType(
  client: BwClient,
  name: string,
  kind?: ConversionKind,
  format: 'text' | 'raw' = 'text',
): Promise<string> {
  const kinds: ConversionKind[] = kind ? [oneOf(kind, ['currency', 'unit'] as const, 'kind')] : ['currency', 'unit'];
  for (const k of kinds) {
    try {
      const res = await client.rawGet(`${objectPath(k, name)}/a`, { Accept: mediaType(k) });
      return format === 'raw' ? res.body : formatConversionType(res.body);
    } catch (err) {
      if (!isMissing(err as Error)) throw err;
    }
  }
  return `No ${kind === 'unit' ? 'unit conversion type' : kind === 'currency' ? 'currency translation type' : 'currency translation or unit conversion type'} ${name.toUpperCase()} exists.`;
}

/**
 * Delete a currency translation or unit conversion type, as the modeling tools do: lock for
 * deletion, DELETE and unlock, all on the object path. The generic delete locks the `/m` version,
 * which these types do not have, and its unlock then misses the lock it took.
 */
export async function bwDeleteConversionType(client: BwClient, kind: ConversionKind, name: string): Promise<string> {
  const mt = mediaType(kind);
  const path = objectPath(kind, name);
  const csrf = await client.getCsrfToken();
  const res = await client.rawPost(`${path}?action=lock`, '', {
    Accept: mt,
    'x-csrf-token': csrf,
    activity_context: 'DELE',
    ...lockSessionHeader(),
  });
  const handle = res.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1];
  if (!handle) throw new Error(`No <LOCK_HANDLE> in lock response:\n${res.body}`);
  let result: SaveResult;
  try {
    const del = await client.rawDelete(`${path}?lockHandle=${handle}`, { 'Content-Type': mt, Accept: mt });
    result = parseFeed(del.body);
  } finally {
    await unlock(client, path, mt, await client.getCsrfToken());
  }
  return JSON.stringify({
    success: result.ok,
    object_type: TLOGO[kind].toUpperCase(),
    object_name: name.toUpperCase(),
    messages: result.messages,
  });
}
