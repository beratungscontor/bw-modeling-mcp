import {
  BwClient,
  MEDIA_TYPES,
  bwSeg,
  lockSessionHeader,
} from '../bw-client.js';
import { variableAccept } from './query.js';

/**
 * Writes to a Planning Function (TLOGO PLSE).
 *
 * The resource saves straight into the active version: the PUT answers "saved" and there is
 * no inactive version to activate afterwards, unlike an aggregation level. Lock, write and
 * unlock all address `/plse/{name}/a` — not the `/m` form the generic client helpers use —
 * so the sequence runs over the raw request helpers.
 *
 * The body is the whole object. Eclipse sends back what it read, with one difference that is
 * kept here: the references to the aggregation level, the function type and the
 * characteristics are written in their full relative form (`../../../infoprov/a/…`) instead of
 * the short form the GET returns.
 */

const PLSE_FALLBACK = 'application/vnd.sap.bw.modeling.plse-v2_0_0+xml';

function plseMediaType(): string {
  return MEDIA_TYPES['plse'] ?? PLSE_FALLBACK;
}

export const CHAR_USAGES = ['FIELDS_TO_BE_CHANGED', 'FIELD_FOR_CONDITIONS', 'NONE'] as const;
export type CharUsage = (typeof CHAR_USAGES)[number];

export const CONDITION_OPERATORS = [
  'Equal', 'NotEqual', 'Between', 'NotBetween', 'Less', 'LessEqual', 'Greater', 'GreaterEqual',
] as const;

export interface CharUsageChange {
  characteristic: string;
  usage: CharUsage;
}

export interface ConditionConstraintInput {
  operator?: string;
  value?: string;
  to_value?: string;
  variable?: string;
  exclude?: boolean;
}

export interface ConditionChange {
  characteristic: string;
  /** Replaces every constraint of the characteristic. Empty or omitted removes the condition. */
  constraints?: ConditionConstraintInput[];
}

export interface ParameterChange {
  /** Parameter name; a nested one may be given as a path, e.g. "PARENT/CHILD". */
  name: string;
  value?: string;
  variable?: string;
  /** 1-based row of a table parameter; required when the parameter holds several values. */
  row?: number;
}

export interface PlanningFunctionChanges {
  description?: string;
  charUsage?: CharUsageChange[];
  conditions?: ConditionChange[];
  parameters?: ParameterChange[];
  /** 1-based rule the conditions and parameters belong to. */
  rule?: number;
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Rewrites the short references of a GET body into the form the PUT is sent with. */
export function toPutReferences(xml: string): string {
  return xml
    .replace(/(=")([A-Za-z0-9_]+)\.composite#/g, '$1../../../infoprov/a/$2.composite#')
    .replace(/(planningServiceType=")([A-Za-z0-9_]+)\.plst#\/\//, '$1../../../plst/$2/a/model.plst#//');
}

/** Last path segment of a characteristic reference (`ALVL.composite#///NAME` → `NAME`). */
function refName(ref: string): string {
  const slash = ref.lastIndexOf('/');
  return slash >= 0 ? ref.slice(slash + 1) : ref;
}

/**
 * Finds the characteristic a caller means. On a CompositeProvider the aggregation level names
 * its characteristics with the provider's generated prefix (`4PROVIDER-NAME`); the bare name
 * is accepted as well when it is unambiguous.
 */
function resolveCharacteristic(requested: string, available: string[], funcName: string): string {
  const upper = requested.trim().toUpperCase();
  const exact = available.find((a) => a.toUpperCase() === upper);
  if (exact) return exact;
  const bySuffix = available.filter((a) => a.toUpperCase().endsWith(`-${upper}`));
  if (bySuffix.length === 1) return bySuffix[0];
  if (bySuffix.length > 1) {
    throw new Error(
      `Characteristic "${requested}" is ambiguous in Planning Function ${funcName}: ${bySuffix.join(', ')}.`
    );
  }
  throw new Error(
    `Characteristic "${requested}" is not on the aggregation level of Planning Function ${funcName}. ` +
    `Available: ${available.join(', ')}.`
  );
}

/** The id of a reusable variable, which a reference to it carries next to its name. */
async function variableUid(client: BwClient, name: string): Promise<string> {
  const result = await client.get(`/sap/bw/modeling/variable/${bwSeg(name.toLowerCase())}/a`, variableAccept());
  const id = result.body.match(/<Qry:mainComponent\b[^>]*?\bid="([^"]+)"/)?.[1];
  if (!id) throw new Error(`Variable ${name.toUpperCase()} could not be resolved to a component id.`);
  return id;
}

async function qryValueXml(
  client: BwClient,
  tag: 'fromValue' | 'toValue',
  input: { value?: string; variable?: string },
  uids: Map<string, string>
): Promise<string> {
  if (input.variable) {
    const name = input.variable.trim().toUpperCase();
    if (!uids.has(name)) uids.set(name, await variableUid(client, name));
    return (
      `<qry:${tag}><qry:type>VariableCIN</qry:type><qry:value>${escapeXmlText(name)}</qry:value>` +
      `<qry:variable>${uids.get(name)}</qry:variable></qry:${tag}>`
    );
  }
  // FOX code only compiles with CRLF line ends; with bare LF every line runs into the next.
  const value = (input.value ?? '').replace(/\r?\n/g, '\r\n');
  return `<qry:${tag}><qry:type>Value</qry:type><qry:value>${escapeXmlText(value)}</qry:value></qry:${tag}>`;
}

/** Body span of the n-th `<condition>` block: the start and end offsets of its content. */
function conditionSpan(xml: string, rule: number): { start: number; end: number } | undefined {
  const blocks = [...xml.matchAll(/<condition>([\s\S]*?)<\/condition>/g)];
  const block = blocks[rule - 1];
  if (!block || block.index === undefined) return undefined;
  const start = block.index + '<condition>'.length;
  return { start, end: start + block[1].length };
}

function findMatchingClose(xml: string, tagName: string, bodyStart: number): number {
  const closeStr = `</${tagName}>`;
  const openRe = new RegExp(`<${tagName}\\b[^>]*?(/?)>`, 'g');
  let depth = 1;
  let pos = bodyStart;
  while (depth > 0) {
    openRe.lastIndex = pos;
    const open = openRe.exec(xml);
    const closeIdx = xml.indexOf(closeStr, pos);
    if (closeIdx === -1) return -1;
    if (open && open.index < closeIdx) {
      if (open[1] !== '/') depth++;
      pos = open.index + open[0].length;
    } else {
      depth--;
      if (depth === 0) return closeIdx;
      pos = closeIdx + closeStr.length;
    }
  }
  return -1;
}

interface ParamNode {
  path: string[];
  /** Offsets of the whole element, opening tag through closing tag. */
  start: number;
  end: number;
  openTag: string;
  body: string;
  hasChildren: boolean;
}

/** Every parameter element of a rule body, nested ones included, with its name path. */
function collectParameters(xml: string, offset: number, parents: string[] = []): ParamNode[] {
  const out: ParamNode[] = [];
  const openRe = /<parameter\b[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(xml)) !== null) {
    const name = m[0].match(/\bname="([^"]*)"/)?.[1] ?? '';
    const path = [...parents, name];
    if (m[1] === '/') {
      out.push({ path, start: offset + m.index, end: offset + m.index + m[0].length, openTag: m[0], body: '', hasChildren: false });
      continue;
    }
    const bodyStart = m.index + m[0].length;
    const closeIdx = findMatchingClose(xml, 'parameter', bodyStart);
    if (closeIdx === -1) break;
    const body = xml.slice(bodyStart, closeIdx);
    const children = collectParameters(body, offset + bodyStart, path);
    out.push({
      path,
      start: offset + m.index,
      end: offset + closeIdx + '</parameter>'.length,
      openTag: m[0],
      body,
      hasChildren: children.length > 0,
    });
    out.push(...children);
    openRe.lastIndex = closeIdx + '</parameter>'.length;
  }
  return out;
}

function findParameter(nodes: ParamNode[], requested: string, funcName: string): ParamNode {
  const wanted = requested.trim().toUpperCase().split('/').filter(Boolean);
  const matches = nodes.filter((n) => {
    const p = n.path.map((s) => s.toUpperCase());
    return p.length >= wanted.length && wanted.every((w, i) => p[p.length - wanted.length + i] === w);
  });
  if (matches.length === 1) return matches[0];
  const known = nodes.map((n) => n.path.join('/')).join(', ') || '(none)';
  if (matches.length === 0) {
    throw new Error(`Planning Function ${funcName} has no parameter "${requested}". Parameters: ${known}.`);
  }
  throw new Error(
    `Parameter "${requested}" is ambiguous in Planning Function ${funcName}: ` +
    `${matches.map((n) => n.path.join('/')).join(', ')}. Give the full path.`
  );
}

/**
 * Applies the requested changes to a GET body. Exported so the edits can be checked without a
 * system; the variable lookups are the only calls it makes.
 */
export async function applyPlanningFunctionChanges(
  client: BwClient,
  xmlIn: string,
  changes: PlanningFunctionChanges
): Promise<{ xml: string; applied: string[] }> {
  let xml = xmlIn;
  const applied: string[] = [];
  const funcName = xml.match(/<bwPlanningService:planningService\b[^>]*?\bname="([^"]*)"/)?.[1] ?? '';
  const rule = changes.rule ?? 1;
  const uids = new Map<string, string>();

  if (changes.description !== undefined) {
    const replaced = xml.replace(
      /(<description\b[^>]*?\blabel=")[^"]*(")/,
      `$1${escapeXmlAttr(changes.description)}$2`
    );
    if (replaced === xml && !/<description\b[^>]*?\blabel="/.test(xml)) {
      throw new Error(`Planning Function ${funcName} has no description element to change.`);
    }
    xml = replaced;
    applied.push('description');
  }

  const charRefs = [...xml.matchAll(/<charUsage\b[^>]*?\binfoObject="([^"]*)"/g)].map((m) => refName(m[1]));

  for (const change of changes.charUsage ?? []) {
    if (!(CHAR_USAGES as readonly string[]).includes(change.usage)) {
      throw new Error(`Unknown characteristic usage "${change.usage}". Use one of: ${CHAR_USAGES.join(', ')}.`);
    }
    const name = resolveCharacteristic(change.characteristic, charRefs, funcName);
    const re = new RegExp(`<charUsage\\b[^>]*?\\binfoObject="[^"]*/${escapeRegex(name)}"[^>]*?/?>`);
    const tag = xml.match(re)?.[0];
    if (!tag) throw new Error(`Characteristic usage of ${name} not found in Planning Function ${funcName}.`);
    xml = xml.replace(tag, tag.replace(/\bfieldUsage="[^"]*"/, `fieldUsage="${change.usage}"`));
    applied.push(`char_usage ${name} = ${change.usage}`);
  }

  if ((changes.conditions?.length ?? 0) > 0 || (changes.parameters?.length ?? 0) > 0) {
    if (!conditionSpan(xml, rule)) {
      const count = [...xml.matchAll(/<condition>/g)].length;
      throw new Error(`Planning Function ${funcName} has ${count} rule(s); rule ${rule} does not exist.`);
    }
  }

  for (const change of changes.conditions ?? []) {
    const name = resolveCharacteristic(change.characteristic, charRefs, funcName);
    const span = conditionSpan(xml, rule)!;
    const body = xml.slice(span.start, span.end);
    const existingRe = new RegExp(
      `<fieldSelection\\b[^>]*?\\bcharacteristic="[^"]*/${escapeRegex(name)}"[^>]*>[\\s\\S]*?</fieldSelection>`
    );
    const existing = body.match(existingRe);
    const constraints = change.constraints ?? [];

    let element = '';
    if (constraints.length > 0) {
      const alvlRef = xml.match(/<charUsage\b[^>]*?\binfoObject="([^"]*\.composite#\/\/)\//)?.[1] ?? '';
      const parts: string[] = [];
      for (const c of constraints) {
        const operator = c.operator ?? 'Equal';
        if (!(CONDITION_OPERATORS as readonly string[]).includes(operator)) {
          throw new Error(`Unknown operator "${operator}". Use one of: ${CONDITION_OPERATORS.join(', ')}.`);
        }
        if (c.value === undefined && !c.variable) {
          throw new Error(`A condition on ${name} needs a value or a variable.`);
        }
        const ranged = operator === 'Between' || operator === 'NotBetween';
        if (ranged && c.to_value === undefined) {
          throw new Error(`Operator ${operator} on ${name} needs to_value.`);
        }
        let inner = await qryValueXml(client, 'fromValue', c, uids);
        if (ranged) inner += await qryValueXml(client, 'toValue', { value: c.to_value }, uids);
        parts.push(
          `<constraint selectionType="areaSelection"${c.exclude ? ' exclude="true"' : ''} operator="${operator}">` +
          `${inner}</constraint>`
        );
      }
      element = `<fieldSelection characteristic="${alvlRef}/${name}">${parts.join('')}</fieldSelection>`;
    }

    if (existing && existing.index !== undefined) {
      const at = span.start + existing.index;
      xml = xml.slice(0, at) + element + xml.slice(at + existing[0].length);
      applied.push(element ? `condition ${name} replaced` : `condition ${name} removed`);
    } else if (element) {
      // Conditions precede the parameters inside a rule.
      const lastSel = [...body.matchAll(/<\/fieldSelection>/g)].pop();
      const at = lastSel?.index !== undefined ? span.start + lastSel.index + lastSel[0].length : span.start;
      xml = xml.slice(0, at) + element + xml.slice(at);
      applied.push(`condition ${name} added`);
    } else {
      applied.push(`condition ${name} not present, nothing removed`);
    }
  }

  for (const change of changes.parameters ?? []) {
    if (change.value === undefined && !change.variable) {
      throw new Error(`Parameter ${change.name} needs a value or a variable.`);
    }
    const span = conditionSpan(xml, rule)!;
    const nodes = collectParameters(xml.slice(span.start, span.end), span.start);
    const node = findParameter(nodes, change.name, funcName);
    const label = node.path.join('/');
    if (node.hasChildren) {
      throw new Error(`Parameter ${label} is a structure; set its fields instead (e.g. "${label}/FIELD").`);
    }
    if (/<fieldSelectionSet\b/.test(node.body)) {
      throw new Error(`Parameter ${label} is a data selection, which this tool does not change.`);
    }
    if (/<restriction\b/.test(node.body)) {
      throw new Error(`Parameter ${label} is a key figure selection, which this tool does not change.`);
    }
    const from = await qryValueXml(client, 'fromValue', change, uids);
    const range = `<selectionRange selectionType="areaSelection" operator="Equal">${from}</selectionRange>`;
    const openTag = node.openTag.replace(/\s*\/>$/, '>');

    // A table parameter keeps its rows column by column: one selectionRange per row in each
    // field. Replacing the body would collapse every row into one.
    const rows = [...node.body.matchAll(/<selectionRange\b[^>]*?(?:\/>|>[\s\S]*?<\/selectionRange>)/g)];
    let newBody = range;
    if (change.row !== undefined) {
      const target = rows[change.row - 1];
      if (!target || target.index === undefined) {
        throw new Error(`Parameter ${label} has ${rows.length} row(s); row ${change.row} does not exist.`);
      }
      newBody = node.body.slice(0, target.index) + range + node.body.slice(target.index + target[0].length);
    } else if (rows.length > 1) {
      throw new Error(
        `Parameter ${label} has ${rows.length} rows (one per table line); pass row to say which one to set.`
      );
    }
    xml = xml.slice(0, node.start) + `${openTag}${newBody}</parameter>` + xml.slice(node.end);
    const shown = change.variable ? `variable ${change.variable.toUpperCase()}` : JSON.stringify(change.value);
    applied.push(`parameter ${label}${change.row !== undefined ? ` row ${change.row}` : ''} = ${shown}`);
  }

  return { xml, applied };
}

interface SaveResult {
  ok: boolean;
  messages: string[];
}

function parseSaveFeed(body: string): SaveResult {
  const entries = [...body.matchAll(/<atom:entry>([\s\S]*?)<\/atom:entry>/g)].map((m) => m[1]);
  const messages: string[] = [];
  let ok = true;
  for (const e of entries) {
    const type = e.match(/messageType="([^"]*)"/)?.[1] ?? '';
    const title = e.match(/<atom:title>([^<]*)<\/atom:title>/)?.[1] ?? '';
    if (type === 'Error') ok = false;
    if (title) messages.push(type ? `${type}: ${title}` : title);
  }
  return { ok, messages };
}

function plsePath(name: string): string {
  return `/sap/bw/modeling/plse/${bwSeg(name.toLowerCase())}/a`;
}

/** Lock, PUT, unlock on the active version, with the lock released whatever the outcome. */
async function savePlanningFunction(
  client: BwClient,
  name: string,
  xml: string,
  timestamp: string | undefined,
  transport: string | undefined
): Promise<SaveResult> {
  const mt = plseMediaType();
  const path = plsePath(name);
  const csrf = await client.getCsrfToken();
  const lock = await client.rawPost(`${path}?action=lock`, '', {
    Accept: mt,
    'x-csrf-token': csrf,
    ...lockSessionHeader(),
  });
  const lockHandle = lock.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1];
  if (!lockHandle) throw new Error(`No <LOCK_HANDLE> in lock response:\n${lock.body}`);
  try {
    const corr = transport ? `corrNr=${encodeURIComponent(transport)}&` : '';
    const res = await client.rawPut(`${path}?${corr}lockHandle=${lockHandle}`, toPutReferences(xml), {
      'Content-Type': `application/xml, ${mt}`,
      Accept: mt,
      'x-csrf-token': csrf,
      ...(timestamp ? { timestamp } : {}),
    });
    return parseSaveFeed(res.body);
  } finally {
    await client.rawPost(`${path}?action=unlock`, '', { Accept: mt, 'x-csrf-token': csrf }).catch(() => {/* ignore */});
  }
}

/**
 * bw_update_planning_function — change the characteristic usage, conditions, parameter values
 * or description of a Planning Function. The function is saved active; there is no activation
 * step.
 */
export async function bwUpdatePlanningFunction(
  client: BwClient,
  funcName: string,
  changes: PlanningFunctionChanges,
  opts: { transport?: string } = {}
): Promise<string> {
  const nameUpper = funcName.toUpperCase();
  const nothing =
    changes.description === undefined &&
    !changes.charUsage?.length &&
    !changes.conditions?.length &&
    !changes.parameters?.length;
  if (nothing) {
    throw new Error('Nothing to change: pass description, char_usage, conditions or parameters.');
  }

  const read = () => client.rawGet(plsePath(funcName), { Accept: plseMediaType(), 'bwmt-level': '50' });
  const current = await read();
  const timestamp = current.headers['timestamp'];
  const { xml, applied } = await applyPlanningFunctionChanges(client, current.body, changes);

  const result = await savePlanningFunction(client, funcName, xml, timestamp, opts.transport);
  // An error does not mean nothing was written: a FOX syntax error is reported as an error and
  // the function is saved with it, while an invalid value rejects the whole save.
  const saved = result.ok || (await read()).body !== current.body;
  return JSON.stringify({
    success: result.ok,
    saved,
    planning_function_name: nameUpper,
    changes: applied,
    messages: result.messages,
    note: result.ok
      ? 'Saved to the active version; no activation step is needed.'
      : saved
        ? 'Saved despite the errors above — the function is stored as sent and needs correcting.'
        : 'Nothing was saved.',
  }, null, 2);
}

export interface PlanningFunctionCreateOptions extends PlanningFunctionChanges {
  aggregationLevel: string;
  functionType: string;
  label: string;
  infoArea?: string;
  package?: string;
  transport?: string;
}

/**
 * bw_create_planning_function — create a Planning Function on an aggregation level.
 *
 * The create takes only the shell: name, function type, aggregation level, description and
 * InfoArea. The server fills in a usage of NONE for every characteristic of the level and the
 * parameter skeleton of the function type, and saves the result active. Any characteristic
 * usage, condition or parameter value the caller passes is applied afterwards as an update.
 */
export async function bwCreatePlanningFunction(
  client: BwClient,
  funcName: string,
  options: PlanningFunctionCreateOptions
): Promise<string> {
  const nameUpper = funcName.toUpperCase();
  const alvlUpper = options.aggregationLevel.trim().toUpperCase();
  const typeUpper = options.functionType.trim().toUpperCase();
  const pkg = options.package ?? '$TMP';
  const mt = plseMediaType();

  let infoArea = options.infoArea?.trim().toUpperCase();
  if (!infoArea) {
    const alvl = await client.rawGet(`/sap/bw/modeling/alvl/${bwSeg(alvlUpper.toLowerCase())}/a`, {
      Accept: MEDIA_TYPES['alvl'],
    });
    infoArea = alvl.body.match(/<infoArea>([^<]+)<\/infoArea>/)?.[1]?.trim();
    if (!infoArea) {
      throw new Error(`Could not read the InfoArea of Aggregation Level ${alvlUpper}; pass info_area.`);
    }
  }

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<bwPlanningService:planningService xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"` +
    ` xmlns:adtCore="http://www.sap.com/adt/core" xmlns:atom="http://www.w3.org/2005/Atom"` +
    ` xmlns:bwCore="http://www.sap.com/bw/modeling/BwCore.ecore"` +
    ` xmlns:bwPlanningService="http://www.sap.com/bw/modeling/BwPlanningService.ecore"` +
    ` xmlns:qry="http://www.sap.com/bw/Query.ecore"` +
    ` alvl="../../../infoprov/a/${alvlUpper}.composite#//" name="${nameUpper}"` +
    ` planningServiceType="../../../plst/${typeUpper}/a/model.plst#//">\n` +
    `  <tlogoProperties adtCore:name="${nameUpper}" adtCore:type="PLSE">\n` +
    `    <adtCore:packageRef adtCore:name="${escapeXmlAttr(pkg)}"/>\n` +
    `    <infoArea>${infoArea}</infoArea>\n` +
    `  </tlogoProperties>\n` +
    `  <description label="${escapeXmlAttr(options.label)}"/>\n` +
    `</bwPlanningService:planningService>`;

  const path = plsePath(funcName);
  const csrf = await client.getCsrfToken();
  const lock = await client.rawPost(`${path}?action=lock`, '', {
    Accept: mt,
    'x-csrf-token': csrf,
    activity_context: 'CREA',
    parent_name: alvlUpper,
    parent_type: 'ALVL',
    ...lockSessionHeader(),
  });
  const lockHandle = lock.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1];
  if (!lockHandle) throw new Error(`No <LOCK_HANDLE> in lock response:\n${lock.body}`);

  let created: SaveResult;
  try {
    const corr = options.transport ? `&corrNr=${encodeURIComponent(options.transport)}` : '';
    const res = await client.rawPost(`${path}?lockHandle=${lockHandle}${corr}`, body, {
      'Content-Type': `application/xml, ${mt}`,
      Accept: mt,
      'x-csrf-token': csrf,
      'Development-Class': pkg,
    });
    created = parseSaveFeed(res.body);
  } finally {
    await client.rawPost(`${path}?action=unlock`, '', { Accept: mt, 'x-csrf-token': csrf }).catch(() => {/* ignore */});
  }

  if (!created.ok) {
    return JSON.stringify({ success: false, planning_function_name: nameUpper, messages: created.messages }, null, 2);
  }

  const hasChanges =
    !!options.charUsage?.length || !!options.conditions?.length || !!options.parameters?.length;
  if (!hasChanges) {
    return JSON.stringify({
      success: true,
      planning_function_name: nameUpper,
      function_type: typeUpper,
      aggregation_level: alvlUpper,
      info_area: infoArea,
      package: pkg,
      messages: created.messages,
      note:
        'Saved active. Every characteristic starts with usage NONE; set the usages, conditions ' +
        'and parameter values with bw_update_planning_function.',
    }, null, 2);
  }

  let update: string;
  try {
    update = await bwUpdatePlanningFunction(client, funcName, {
      charUsage: options.charUsage,
      conditions: options.conditions,
      parameters: options.parameters,
      rule: options.rule,
    }, { transport: options.transport });
  } catch (err) {
    throw new Error(
      `Planning Function ${nameUpper} was created, but applying the settings failed: ` +
      `${(err as Error).message}`
    );
  }
  const parsed = JSON.parse(update);
  return JSON.stringify({
    ...parsed,
    function_type: typeUpper,
    aggregation_level: alvlUpper,
    info_area: infoArea,
    package: pkg,
    messages: [...created.messages, ...parsed.messages],
  }, null, 2);
}
