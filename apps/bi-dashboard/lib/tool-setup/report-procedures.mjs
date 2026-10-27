import { createHash } from 'node:crypto';

// Review aid only, not a proof that arbitrary SQL is read-only. Uncertain
// operations require separate business-write authorization on every run.
export function sqlTokens(source = '') {
  const tokens = [];
  for (let i = 0; i < source.length;) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source.startsWith('--', i)) { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end + 1; continue; }
    if (source.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < source.length && depth) { if (source.startsWith('/*', i)) { depth++; i += 2; } else if (source.startsWith('*/', i)) { depth--; i += 2; } else i++; }
      if (depth) throw new Error('Unclosed SQL comment.');
      continue;
    }
    if (source[i] === "'" || source[i] === '[' || source[i] === '"') {
      const close = source[i] === '[' ? ']' : source[i]; const kind = source[i] === "'" ? 'string' : 'identifier'; i++;
      let value = ''; let closed = false;
      while (i < source.length) {
        if (source[i] === close) { if (source[i + 1] === close) { value += close; i += 2; } else { i++; closed = true; break; } }
        else value += source[i++];
      }
      if (!closed) throw new Error('Unclosed SQL value.');
      tokens.push({ value, kind }); continue;
    }
    const word = source.slice(i).match(/^[@#\p{L}_][@#\p{L}\p{N}_$]*/u)?.[0];
    if (word) { i += word.length; tokens.push({ value: word, kind: 'word' }); }
    else tokens.push({ value: source[i++], kind: 'symbol' });
  }
  return tokens;
}

export function reviewProcedure(definition) {
  if (!definition) return { allowed: false, requiresWriteConsent: true, reason: 'The procedure definition is unavailable or encrypted. Ask for VIEW DEFINITION access before approving it.' };
  let tokens;
  try { tokens = sqlTokens(definition); } catch (e) { return { allowed: false, requiresWriteConsent: true, reason: e.message }; }
  const risks = new Set();
  const word = i => tokens[i]?.value.toUpperCase();
  const local = i => /^#[^#]|^@/.test(tokens[i]?.value || '');
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind !== 'word') continue;
    const key = word(i);
    if (['EXEC', 'EXECUTE', 'OPENQUERY', 'OPENROWSET', 'OPENDATASOURCE'].includes(key)) risks.add('Nested or dynamic execution needs review.');
    if (['GRANT', 'REVOKE', 'DENY', 'DBCC', 'BACKUP', 'RESTORE', 'SEND', 'RECEIVE'].includes(key)) risks.add('Administrative or external operations need review.');
    if (['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'INTO'].includes(key)) {
      let next = i + 1;
      if (['INTO', 'FROM', 'TABLE'].includes(word(next))) next++;
      if (!local(next)) risks.add('Possible business-record changes need review.');
    }
    if (['CREATE', 'ALTER', 'DROP'].includes(key)) {
      if (key === 'ALTER' && i === 2 && word(0) === 'CREATE' && word(1) === 'OR') continue;
      let next = i + 1;
      if (word(next) === 'OR' && word(next + 1) === 'ALTER') next += 2;
      if (i === 0 && ['PROC', 'PROCEDURE'].includes(word(next))) continue;
      if (word(next) === 'TABLE') { next++; if (word(next) === 'IF' && word(next + 1) === 'EXISTS') next += 2; if (local(next)) continue; }
      risks.add('Database-object changes need review.');
    }
    if (key === 'NEXT' && word(i + 1) === 'VALUE') risks.add('Sequence changes need review.');
  }
  return { allowed: true, requiresWriteConsent: risks.size > 0, reason: [...risks].join(' ') };
}

export const procedureHash = definition => createHash('sha256').update(definition || '').digest('hex');

export function authorizeProcedureRun(procedure, _approvalHash, request) {
  if (!procedure.allowed) throw new Error(procedure.reason || 'Procedure unavailable.');
  if (request.hash !== procedure.hash) throw new Error('The procedure changed. Reopen its parameter form.');
  if (procedure.requiresWriteConsent && request.allowBusinessWrites !== true) throw new Error('This procedure may modify business records or call other procedures. Explicit authorization is required for this run.');
}

export function procedureDefaults(definition, parameters) {
  const result = {}; let tokens;
  try { tokens = sqlTokens(definition); } catch { return result; }
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value === '(') depth++;
    if (tokens[i].value === ')') depth--;
    if (!depth && tokens[i].kind === 'word' && tokens[i].value.toUpperCase() === 'AS' && tokens[i - 1]?.value.toUpperCase() !== 'EXECUTE') break;
    const parameter = parameters.find(p => p.name.toLowerCase() === tokens[i].value.toLowerCase());
    if (!parameter) continue;
    let inner = 0;
    for (let j = i + 1; j < tokens.length; j++) {
      const value = tokens[j].value;
      if (value === '(') inner++;
      if (value === ')') inner--;
      if (!inner && (value === ',' || value.toUpperCase() === 'AS')) break;
      if (value === '=') { result[parameter.name] = true; break; }
    }
  }
  return result;
}

export function validateScalar(p, raw) {
    if (raw === null) return null;
    if (!['string', 'number', 'boolean'].includes(typeof raw)) throw new Error(`${p.name} must be a scalar value.`);
    const value = String(raw); const type = (p.baseType || p.type).toLowerCase();
    if (value.length > 1024 * 1024) throw new Error(`${p.name} is too long.`);
    if (/^(tinyint|smallint|int|bigint)$/.test(type) && !/^[+-]?\d+$/.test(value)) throw new Error(`${p.name} must be an integer.`);
    if (/^(decimal|numeric|money|smallmoney|float|real)$/.test(type) && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) throw new Error(`${p.name} must be a number.`);
    if (/^(date|datetime|datetime2|smalldatetime|datetimeoffset)$/.test(type) && (!/^\d{4}-\d{2}-\d{2}(?:[T ][\d:.+\-]+Z?)?$/.test(value) || !Number.isFinite(Date.parse(value)))) throw new Error(`${p.name} must be a valid date.`);
    if (type === 'time' && !/^\d{2}:\d{2}(?::\d{2}(?:\.\d{1,7})?)?$/.test(value)) throw new Error(`${p.name} must be a time.`);
    if (type === 'bit' && !['0', '1', 'true', 'false'].includes(value)) throw new Error(`${p.name} must be Yes or No.`);
    if (type === 'uniqueidentifier' && !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value)) throw new Error(`${p.name} must be a UUID.`);
    if (/^(varbinary|binary|image|timestamp|rowversion)$/.test(type) && !/^(?:0x)?(?:[\da-f]{2})*$/i.test(value)) throw new Error(`${p.name} must contain hexadecimal bytes.`);
    return value;
}

export function validateProcedureValues(parameters, values, omitted = []) {
  if (!values || typeof values !== 'object' || Array.isArray(values) || !Array.isArray(omitted)) throw new Error('Invalid parameters.');
  const names = new Set(parameters.map(p => p.name));
  if (Object.keys(values).some(name => !names.has(name)) || omitted.some(name => !names.has(name))) throw new Error('Unknown parameter.');
  return parameters.map(p => {
    if (omitted.includes(p.name)) {
      if (p.output || p.tableType) throw new Error(`${p.name} cannot use a default in this mode.`);
      return undefined;
    }
    const raw = values[p.name];
    if (raw === undefined) { if (p.output) return undefined; throw new Error(`Enter ${p.name}, NULL, or select Procedure default.`); }
    if (!p.tableType) return validateScalar(p, raw);
    if (!Array.isArray(raw) || raw.length > 10000) throw new Error(`${p.name} must be a table with at most 10,000 input rows.`);
    return raw.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${p.name} contains an invalid row.`);
      if (Object.keys(row).some(key => !p.tableColumns.some(c => c.name === key))) throw new Error(`${p.name} contains an unknown column.`);
      return p.tableColumns.map(column => {
        const value = row[column.name] ?? null;
        if (value === null && !column.nullable) throw new Error(`${p.name}.${column.name} is required.`);
        return validateScalar(column, value);
      });
    });
  });
}
