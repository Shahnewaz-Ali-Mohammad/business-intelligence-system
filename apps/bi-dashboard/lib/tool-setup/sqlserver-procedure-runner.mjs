import sql from 'mssql';
import { validateConnection, sensitiveOutput } from './connectors.mjs';
import { validateProcedureValues } from './report-procedures.mjs';

const types = {
  varchar: 'VarChar', nvarchar: 'NVarChar', char: 'Char', nchar: 'NChar', text: 'Text', ntext: 'NText',
  int: 'Int', smallint: 'SmallInt', tinyint: 'TinyInt', bigint: 'BigInt', bit: 'Bit',
  decimal: 'Decimal', numeric: 'Numeric', money: 'Money', smallmoney: 'SmallMoney', real: 'Real', float: 'Float',
  date: 'Date', datetime: 'DateTime', datetime2: 'DateTime2', datetimeoffset: 'DateTimeOffset', smalldatetime: 'SmallDateTime', time: 'Time',
  uniqueidentifier: 'UniqueIdentifier', binary: 'Binary', varbinary: 'VarBinary', image: 'Image', xml: 'Xml',
  timestamp: 'Binary', rowversion: 'Binary', sql_variant: 'Variant',
};

export function parameterType(parameter, driver = sql, { textConversion = true } = {}) {
  const type = (parameter.baseType || parameter.type).toLowerCase();
  // SQL Server performs conversion at the RPC boundary. Strings preserve exact
  // decimal digits and datetime2 fractions instead of rounding through JS Number/Date.
  if (textConversion && /^(decimal|numeric|money|smallmoney|date|datetime|datetime2|datetimeoffset|smalldatetime|time)$/.test(type)) return driver.NVarChar(driver.MAX);
  const factory = driver[types[type]];
  if (!factory) throw new Error(`${parameter.name}: SQL type ${parameter.type} is not supported by this driver. No procedure was executed.`);
  if (/^(n?varchar|n?char|varbinary|binary|timestamp|rowversion)$/.test(type)) {
    const bytes = parameter.maxLength ?? (type === 'timestamp' || type === 'rowversion' ? 8 : -1);
    const length = bytes === -1 ? driver.MAX : Math.max(1, /^n/.test(type) ? bytes / 2 : bytes);
    return factory(length);
  }
  if (/^(decimal|numeric)$/.test(type)) return factory(parameter.precision || 18, parameter.scale || 0);
  if (/^(time|datetime2|datetimeoffset)$/.test(type)) return factory(parameter.scale ?? 7);
  return factory();
}

function driverValue(parameter, value, { textConversion = true } = {}) {
  if (value == null) return value;
  const type = (parameter.baseType || parameter.type).toLowerCase();
  if (/^(binary|varbinary|image|timestamp|rowversion)$/.test(type)) return Buffer.from(value.replace(/^0x/i, ''), 'hex');
  if (type === 'bit') return value === '1' || value === 'true';
  if (/^(int|smallint|tinyint|real|float)$/.test(type)) return Number(value);
  if (!textConversion && /^(decimal|numeric|money|smallmoney)$/.test(type)) {
    if (String(value).replace(/[^\d]/g, '').length > 15) throw new Error(`${parameter.name}: table input decimals above 15 digits cannot be represented exactly by this driver.`);
    return Number(value);
  }
  if (!textConversion && /^(date|datetime|datetime2|datetimeoffset|smalldatetime|time)$/.test(type)) return new Date(type === 'time' ? `1970-01-01T${value}Z` : value);
  return value;
}

export function bindProcedureParameters(request, procedure, values, omitted = [], driver = sql) {
  const checked = validateProcedureValues(procedure.parameters, values, omitted);
  procedure.parameters.forEach((parameter, index) => {
    const name = parameter.name.replace(/^@/, '');
    if (!name || /[\s;\[\]'"=]/.test(name)) throw new Error('Unsupported SQL parameter identifier.');
    if (omitted.includes(parameter.name)) return;
    if (parameter.tableType) {
      if (parameter.output) throw new Error('SQL Server table parameters cannot be OUTPUT parameters.');
      const table = new driver.Table(parameter.tableType);
      parameter.tableColumns.forEach(column => table.columns.add(column.name, parameterType(column, driver, { textConversion: false }), { nullable: column.nullable }));
      checked[index].forEach(row => table.rows.add(...row.map((value, col) => driverValue(parameter.tableColumns[col], value, { textConversion: false }))));
      request.input(name, table);
    } else if (parameter.output) request.output(name, parameterType(parameter, driver), driverValue(parameter, checked[index]));
    else request.input(name, parameterType(parameter, driver), driverValue(parameter, checked[index]));
  });
}

function serializable(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

export function resultColumns(metadata) {
  const used = new Set();
  const columns = Array.isArray(metadata) ? metadata : Object.values(metadata).sort((a, b) => a.index - b.index);
  return columns.map((column, index) => {
    const base = column.name || `Column ${index + 1}`;
    let name = base; let suffix = 2;
    while (used.has(name)) name = `${base} (${suffix++})`;
    used.add(name);
    return { name, index, hidden: sensitiveOutput(column.name || '') };
  });
}

/**
 * Runs a reporting procedure and hands every row to the caller as it arrives,
 * so results of any size never sit in memory. There is no row, size or
 * result-table cap and no time limit; the caller stores rows and can cancel
 * through the signal. Asynchronous handlers pause the stream until they finish.
 */
export async function streamReportProcedure(input, procedure, values, omitted = [], { signal, driver = sql, onResultSet, onRow, onMessage } = {}) {
  const config = validateConnection(input);
  if (config.dialect !== 'sqlserver') throw new Error('This runner requires SQL Server.');
  const pool = new driver.ConnectionPool({ server: config.host, port: config.port, user: config.username, password: config.password, database: config.database, options: { encrypt: config.tls, trustServerCertificate: config.trustServerCertificate, appName: 'BI procedure report' }, connectionTimeout: 30000, requestTimeout: 0, pool: { max: 1, min: 0 } });
  let request; let failure; let mapping = []; let setIndex = -1;
  let queue = Promise.resolve();
  const cancel = () => request?.cancel();
  // Rows are handled strictly in order; while a handler is busy the stream is paused.
  const enqueue = work => {
    request.pause();
    queue = queue.then(work).catch(error => { failure = failure || error; cancel(); }).finally(() => { if (!failure) request.resume(); });
  };
  try {
    if (signal?.aborted) throw new Error('Report cancelled.');
    await pool.connect();
    request = pool.request(); request.stream = true; request.arrayRowMode = true;
    bindProcedureParameters(request, procedure, values, omitted, driver);
    signal?.addEventListener('abort', cancel, { once: true });
    request.on('recordset', metadata => {
      mapping = resultColumns(metadata); setIndex++;
      const index = setIndex; const columns = mapping.filter(c => !c.hidden).map(c => c.name);
      enqueue(() => onResultSet?.(index, columns));
    });
    request.on('row', row => {
      const index = setIndex; const visible = mapping.filter(c => !c.hidden);
      const output = Object.fromEntries(visible.map(c => [c.name, serializable(Array.isArray(row) ? row[c.index] : row[c.name])]));
      enqueue(() => onRow?.(index, output));
    });
    request.on('info', message => { onMessage?.(String(message.message).slice(0, 2000)); });
    const quote = name => `[${name.replace(/]/g, ']]')}]`;
    const result = await request.execute(`${quote(procedure.schema)}.${quote(procedure.name)}`);
    await queue;
    if (failure) throw failure;
    return { output: Object.fromEntries(Object.entries(result.output || {}).filter(([key]) => !sensitiveOutput(key)).map(([key, value]) => [key, serializable(value)])), returnValue: result.returnValue ?? null, rowsAffected: result.rowsAffected || [] };
  } catch (error) {
    await queue.catch(() => {});
    if (failure) throw failure;
    if (signal?.aborted) throw new Error('Report cancelled.');
    throw error;
  } finally { signal?.removeEventListener('abort', cancel); await pool.close(); }
}
