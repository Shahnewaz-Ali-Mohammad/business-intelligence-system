import { Transform } from 'node:stream';

export const pgIdentifier = (name) => `"${String(name).replaceAll('"', '""')}"`;
export const sqlIdentifier = (name) => `[${String(name).replaceAll(']', ']]')}]`;

export function postgresType(column) {
  const type = column.data_type.toLowerCase();
  if (['varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext', 'xml'].includes(type)) return 'text';
  if (['int', 'smallint', 'tinyint'].includes(type)) return type === 'int' ? 'integer' : 'smallint';
  if (type === 'bigint') return 'bigint';
  if (['decimal', 'numeric'].includes(type)) return `numeric(${column.numeric_precision},${column.numeric_scale})`;
  if (['money', 'smallmoney'].includes(type)) return 'numeric(19,4)';
  if (['float', 'real'].includes(type)) return type === 'float' ? 'double precision' : 'real';
  if (type === 'bit') return 'boolean';
  if (type === 'date') return 'date';
  if (type === 'time') return 'time';
  if (type === 'datetimeoffset') return 'timestamp with time zone';
  if (['datetime', 'datetime2', 'smalldatetime'].includes(type)) return 'timestamp without time zone';
  if (['binary', 'varbinary', 'image', 'timestamp', 'rowversion'].includes(type)) return 'bytea';
  if (type === 'uniqueidentifier') return 'uuid';
  throw new Error(`Unsupported source type ${type}; the table will not be copied with a guessed conversion.`);
}

export function sourceExpression(column) {
  const name = sqlIdentifier(column.column_name);
  const type = column.data_type.toLowerCase();
  // Avoid JS numeric rounding and preserve database date/time precision.
  if (['money', 'smallmoney'].includes(type)) return `CONVERT(varchar(100), ${name}, 2) AS ${name}`;
  if (['bigint', 'decimal', 'numeric'].includes(type)) return `CONVERT(varchar(100), ${name}) AS ${name}`;
  if (['date', 'time', 'datetime', 'datetime2', 'datetimeoffset', 'smalldatetime'].includes(type)) return `CONVERT(varchar(50), ${name}, 126) AS ${name}`;
  return name;
}

export function copyField(value) {
  if (value == null) return '\\N';
  const text = Buffer.isBuffer(value) ? `\\x${value.toString('hex')}` : typeof value === 'boolean' ? value ? 't' : 'f' : String(value);
  if (text.includes('\0')) throw new Error('Source text contains a NUL character that PostgreSQL text cannot represent; no value was silently removed.');
  return text.replaceAll('\\', '\\\\').replaceAll('\t', '\\t').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\b', '\\b').replaceAll('\f', '\\f').replaceAll('\v', '\\v');
}

export function rowEncoder(columns, onRow) {
  return new Transform({
    writableObjectMode: true,
    transform(row, _encoding, callback) {
      try {
        const line = columns.map((c) => copyField(row[c.column_name])).join('\t') + '\n';
        onRow();
        callback(null, line);
      } catch (error) { callback(error); }
    },
  });
}
