import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';

// Excel exports of any size: the workbook is written row by row to the HTTP
// response and, at the same time, to a file kept for the Exports page. Neither
// the rows nor the file are held in memory.
const root = process.env.BI_EXPORT_DIR || path.join(process.cwd(), '.data', 'exports');
const SHEET_ROWS = 1_048_575; // Excel's per-sheet limit, minus the header row
export const FILE_MARKER = 'file:';

const cellValue = (value) => {
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
};

/**
 * Starts a streaming workbook. `write` receives a sheet builder; call
 * `sheet(name, headers)` then `add(rowArray)` for each row. A sheet that
 * passes Excel's row limit continues on "<name> (2)", "<name> (3)", ...
 * Returns the response stream and a promise for { fileId, rows } once the
 * file is complete.
 */
export function startWorkbookExport(write) {
  const fileId = crypto.randomUUID();
  const response = new PassThrough();
  const done = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const target = path.join(root, `${fileId}.xlsx`);
    const tee = new PassThrough();
    const file = createWriteStream(target, { mode: 0o600 });
    tee.pipe(file); tee.pipe(response);
    const fileClosed = new Promise((resolve, reject) => { file.on('finish', resolve); file.on('error', reject); });
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: tee, useSharedStrings: false, useStyles: false });
    let rows = 0; let current = null;
    const builder = {
      sheet(name, headers) {
        const base = String(name).replace(/[\\/?*[\]:]/g, ' ').slice(0, 25) || 'Sheet';
        let part = 1; let count = 0;
        const open = () => { const sheet = workbook.addWorksheet(part > 1 ? `${base} (${part})` : base); sheet.addRow(headers).commit(); return sheet; };
        let sheet = open();
        current = {
          async add(values) {
            if (count === SHEET_ROWS) { await sheet.commit(); part++; count = 0; sheet = open(); }
            sheet.addRow(values.map(cellValue)).commit(); count++; rows++;
          },
          async close() { await sheet.commit(); },
        };
        return current;
      },
    };
    await write(builder);
    await workbook.commit();
    await fileClosed;
    return { fileId, rows };
  })();
  done.catch((error) => response.destroy(error));
  return { response, done };
}

/** Streams a stored export file back for the Exports page. */
export async function openStoredExport(marker) {
  const fileId = String(marker).slice(FILE_MARKER.length);
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) throw new Error('Invalid export file.');
  const target = path.join(root, `${fileId}.xlsx`);
  const info = await stat(target);
  return { stream: createReadStream(target), size: info.size };
}
