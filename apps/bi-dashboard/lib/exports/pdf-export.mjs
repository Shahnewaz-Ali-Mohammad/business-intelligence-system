import PDFDocument from 'pdfkit';
import { PassThrough } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.env.BI_EXPORT_DIR || path.join(process.cwd(), '.data', 'exports');

// Row iterators can be reopened for wide tables, so each horizontal band
// contains every record without loading the entire report into memory.
export function startPdfExport({ title, narrative = '', tables, output = {}, returnValue = null }) {
  const response = new PassThrough(); const fileId = crypto.randomUUID();
  const done = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const file = createWriteStream(path.join(root, `${fileId}.pdf`), { mode: 0o600 });
    const closed = new Promise((resolve, reject) => { file.on('finish', resolve); file.on('error', reject); });
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, autoFirstPage: false, bufferPages: false, info: { Title: title, Creator: 'Business Intelligence' } });
    doc.on('error', error => { response.destroy(error); file.destroy(error); });
    doc.pipe(response); doc.pipe(file);
    const font = process.env.REPORT_PDF_FONT_PATH || 'Helvetica';
    let rows = 0; let pages = 0;
    const page = heading => {
      doc.addPage(); pages++; doc.font(font).fillColor('#18181b').fontSize(14).text(title, 36, 30, { width: 720, height: 35, ellipsis: true });
      doc.fontSize(9).fillColor('#52525b').text(heading, 36, 69, { width: 730, height: 24, ellipsis: true });
      doc.fontSize(8).text(`Page ${pages}`, 710, 30, { width: 95, align: 'right' });
      return 104;
    };
    try {
      let y = page('Report summary');
      doc.fontSize(10).fillColor('#27272a').text(narrative || title, 36, y, { width: 765, height: 130, ellipsis: true });
      y += Math.min(130, doc.heightOfString(narrative || title, { width: 765 })) + 24;
      for (const [tableIndex, table] of tables.entries()) {
        const bands = [];
        // Keep readable column widths rather than shrinking an entire wide table.
        for (let start = 0; start < table.columns.length; start += 6) bands.push(table.columns.slice(start, start + 6));
        if (!bands.length) { y = page(`Result ${tableIndex + 1}: all columns are hidden.`); continue; }
        for (const [bandIndex, columns] of bands.entries()) {
          const width = 770 / columns.length;
          const heading = `Result ${tableIndex + 1}${bands.length > 1 ? ` - column band ${bandIndex + 1} of ${bands.length}` : ''}`;
          const header = () => {
            doc.rect(36, y, 770, 28).fill('#f4f4f5');
            columns.forEach((column, index) => doc.font(font).fontSize(8).fillColor('#18181b').text(column, 40 + index * width, y + 6, { width: width - 8, height: 19, ellipsis: true }));
            y += 28;
          };
          if (tableIndex || bandIndex || y > doc.page.height - 150) y = page(heading);
          else { doc.fontSize(10).fillColor('#18181b').text(heading, 36, y); y += 22; }
          header(); let count = 0;
          for await (const row of table.rows()) {
            const cells = columns.map(column => row[column] == null ? '' : String(row[column]));
            doc.font(font).fontSize(8);
            const height = Math.min(385, Math.max(23, ...cells.map(text => doc.heightOfString(text, { width: width - 8 }) + 10)));
            if (y + height > doc.page.height - 38) { y = page(heading); header(); }
            if (count % 2) doc.rect(36, y, 770, height).fill('#fafafa');
            cells.forEach((text, index) => doc.font(font).fontSize(8).fillColor('#27272a').text(text, 40 + index * width, y + 5, { width: width - 8, height: height - 8, ellipsis: true }));
            y += height; count++; if (!bandIndex) rows++;
            if (doc.readableLength > 1024 * 1024) await new Promise(resolve => doc.once('data', resolve));
          }
          if (!count) doc.fillColor('#71717a').fontSize(9).text('No matching rows.', 40, y + 8);
        }
      }
      if (y > doc.page.height - 120) y = page('Output parameters and return code');
      else { y += 22; doc.fillColor('#18181b').fontSize(10).text('Output parameters and return code', 36, y); y += 22; }
      for (const [name, value] of [...Object.entries(output), ['Return code', returnValue]]) {
        if (y > doc.page.height - 90) y = page('Output parameters continued');
        const text = `${name}: ${value == null ? 'NULL' : String(value)}`;
        doc.fillColor('#27272a').fontSize(9).text(text, 36, y, { width: 765, height: 55, ellipsis: true }); y += Math.min(55, doc.heightOfString(text, { width: 765 })) + 8;
      }
      doc.end(); await closed;
      return { fileId, rows };
    } catch (error) { doc.destroy(error); file.destroy(error); throw error; }
  })();
  done.catch(error => response.destroy(error));
  return { response, done };
}
