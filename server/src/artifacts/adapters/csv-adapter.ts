import { createHash } from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';
import { ArtifactError, unsupportedOperationError } from '../errors.js';
import type {
  AdapterEditResult,
  AdapterExportResult,
  AdapterOperation,
  AdapterVerifyCheck,
  AdapterVerifyIssue,
  AdapterVerifyResult,
  OperationCapability,
  TargetResolutionResult,
  TargetSelector,
} from '../types.js';
import { sha256Text, type AdapterCapabilityContext, type AdapterFileMeta, type FormatAdapter } from './base.js';
import { textVerificationReport } from './text-verification.js';

function detectDelimiter(filename: string): string {
  return path.extname(filename).toLowerCase() === '.tsv' ? '\t' : ',';
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildMinimalZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const uncompressed = entry.data;
    const compressed = zlib.deflateRawSync(uncompressed);
    const crc = crc32(uncompressed);

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 flag
    localHeader.writeUInt16LE(8, 8); // deflate
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(uncompressed.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    localParts.push(localHeader, compressed);

    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(uncompressed.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHeader, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

function escapeXml(text: string): string {
  // Strip XML 1.0 disallowed control chars while preserving \t, \n, \r.
  // eslint-disable-next-line no-control-regex
  const safe = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  return safe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xlsxColumnName(colIndex: number): string {
  let n = colIndex + 1;
  let label = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

function isPlainXlsxNumber(raw: string): boolean {
  const s = raw.trim();
  if (!s || s !== raw) return false;
  // Avoid coercing leading-zero identifiers like "00123" or formula-like values.
  if (/^[+-]?0[0-9]/.test(s)) return false;
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(s)) return false;
  const num = Number(s);
  return Number.isFinite(num) && Math.abs(num) <= 1e15;
}

function buildXlsxFromRows(rows: string[][], sheetTitle: string): Buffer {
  const sanitizedTitle = (sheetTitle.replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Sheet1').trim() || 'Sheet1';
  const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const rowCount = rows.length;
  const colWidths: number[] = new Array(colCount).fill(10);

  const rowXmlParts: string[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const cells: string[] = [];
    for (let c = 0; c < row.length; c++) {
      const value = row[c] ?? '';
      const displayLen = Math.min(60, Math.max(8, value.length + 3));
      if (displayLen > colWidths[c]) colWidths[c] = displayLen;
      const addr = `${xlsxColumnName(c)}${r + 1}`;
      const styleAttr = r === 0 ? ' s="1"' : '';
      if (r > 0 && isPlainXlsxNumber(value)) {
        cells.push(`<c r="${addr}"${styleAttr}><v>${value}</v></c>`);
      } else {
        cells.push(
          `<c r="${addr}" t="inlineStr"${styleAttr}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
        );
      }
    }
    rowXmlParts.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  }

  const dimRef =
    rowCount > 0 && colCount > 0 ? `A1:${xlsxColumnName(colCount - 1)}${rowCount}` : 'A1';
  const colsXml =
    colCount > 0
      ? `<cols>${colWidths
          .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
          .join('')}</cols>`
      : '';

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="${dimRef}"/>` +
    `<sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    colsXml +
    `<sheetData>${rowXmlParts.join('')}</sheetData>` +
    `</worksheet>`;

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${escapeXml(sanitizedTitle)}" sheetId="1" r:id="rId1"/></sheets>` +
    `</workbook>`;

  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="2">` +
    `<font><sz val="11"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="11"/><name val="Calibri"/></font>` +
    `</fonts>` +
    `<fills count="3">` +
    `<fill><patternFill patternType="none"/></fill>` +
    `<fill><patternFill patternType="gray125"/></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FFEFF3F8"/><bgColor indexed="64"/></patternFill></fill>` +
    `</fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="2">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>` +
    `</cellXfs>` +
    `</styleSheet>`;

  const contentTypesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `</Types>`;

  const rootRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const wbRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  return buildMinimalZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRelsXml, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(wbRelsXml, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(stylesXml, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf8') },
  ]);
}

export function parseCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let fieldStarted = false;
  let inQuotes = false;
  const s = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      fieldStarted = false;
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStarted = false;
    } else {
      field += ch;
    }
  }
  if (fieldStarted || field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function serializeCsvRows(rows: string[][], delimiter: string): string {
  return rows
    .map((r) =>
      r
        .map((cell) => {
          const val = cell ?? '';
          if (val.includes(delimiter) || val.includes('"') || val.includes('\n') || val.includes('\r')) {
            return `"${val.replace(/"/g, '""')}"`;
          }
          return val;
        })
        .join(delimiter)
    )
    .join('\n');
}

/** Apply only the cells changed by an original edit, with values checked against the current file. */
export function replayCsvCellEdit(filename: string, currentBytes: Buffer, fromBytes: Buffer, toBytes: Buffer, keys: unknown): Buffer {
  const conflict = () => new ArtifactError('UNDO_SEMANTIC_CONFLICT', '対象セルを安全に変更できません。', 409);
  const delimiter = detectDelimiter(filename);
  const parse = (bytes: Buffer) => parseCsvRows(bytes.toString('utf8'), delimiter);
  const [current, from, to] = [currentBytes, fromBytes, toBytes].map(parse);
  if (!Array.isArray(keys) || !keys.length || from.length !== to.length || current.length !== from.length ||
      from.some((row, ri) => row.length !== to[ri].length || row.length !== current[ri].length) ||
      from[0]?.some((value, ci) => value !== current[0][ci])) throw conflict();
  const allowed = new Set(keys);
  for (const [ri, row] of from.entries()) {
    for (const [ci, value] of row.entries()) {
      if (value === to[ri][ci]) continue;
      if (ri === 0 || !allowed.has(`r${ri}c${ci}`) || current[ri][ci] !== value) throw conflict();
      current[ri][ci] = to[ri][ci];
    }
  }
  return Buffer.from(serializeCsvRows(current, delimiter) + '\n', 'utf8');
}

export class CsvAdapter implements FormatAdapter {
  readonly format = 'csv' as const;
  readonly previewKind = 'table' as const;
  readonly directEditUiSupported = true;
  readonly targetPinSupported = true;
  readonly requiresExternalWorker = false;

  getOperations(ctx: AdapterCapabilityContext): OperationCapability[] {
    const workerReady = ctx.runtimeProfile !== 'base_chatui' && ctx.sandboxAvailable;
    return [
      { operation: 'create', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'get_structure', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'read_range', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'edit', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'verify', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'export:xlsx', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'export:json', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'export:csv', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'export:tsv', availability: 'supported', scope: 'mcp_and_ui' },
      {
        operation: 'render_png',
        availability: workerReady ? 'supported' : 'disabled_by_resource_tier',
        scope: 'mcp_only',
        remediation: workerReady
          ? undefined
          : ctx.runtimeProfile === 'base_chatui'
            ? 'deploy/setup-doc-runtime.sh を実行してください。'
            : 'bubblewrap サンドボックスを有効化してください。',
      },
    ];
  }

  create(params: Record<string, unknown>, meta: AdapterFileMeta): Buffer {
    const delimiter = detectDelimiter(meta.filename);
    if (typeof params.content === 'string') {
      return Buffer.from(params.content, 'utf8');
    }
    const headers = Array.isArray(params.headers) ? params.headers.map(String) : ['col1', 'col2'];
    const rows = Array.isArray(params.rows)
      ? params.rows.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : []))
      : [];
    return Buffer.from(serializeCsvRows([headers, ...rows], delimiter) + '\n', 'utf8');
  }

  getStructure(buffer: Buffer, meta: AdapterFileMeta): Record<string, unknown> {
    const delimiter = detectDelimiter(meta.filename);
    const rows = parseCsvRows(buffer.toString('utf8'), delimiter);
    const headerRow = rows[0] ?? [];
    const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
    return {
      format: 'csv',
      delimiter,
      rowCount: rows.length,
      colCount,
      headers: headerRow,
      headerHash: sha256Text(JSON.stringify(headerRow)),
    };
  }

  readRange(buffer: Buffer, range: Record<string, unknown>, meta: AdapterFileMeta): Record<string, unknown> {
    const delimiter = detectDelimiter(meta.filename);
    const rows = parseCsvRows(buffer.toString('utf8'), delimiter);
    const startRow = Math.max(0, Number(range.startRow ?? 0));
    const endRow = Math.min(rows.length - 1, Number(range.endRow ?? Math.min(rows.length - 1, startRow + 99)));
    const startCol = Math.max(0, Number(range.startCol ?? 0));
    const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const endCol = Math.min(Math.max(0, maxCols - 1), Number(range.endCol ?? Math.max(0, maxCols - 1)));

    const sliced = rows.slice(startRow, endRow + 1).map((r) => r.slice(startCol, endCol + 1));
    return {
      startRow,
      endRow,
      startCol,
      endCol,
      totalRows: rows.length,
      totalCols: maxCols,
      rows: sliced,
      valuesHash: sha256Text(JSON.stringify(sliced)),
    };
  }

  applyOperations(buffer: Buffer, operations: AdapterOperation[], meta: AdapterFileMeta): AdapterEditResult {
    const delimiter = detectDelimiter(meta.filename);
    let rows = parseCsvRows(buffer.toString('utf8'), delimiter);
    const touchedRegions = new Set<string>();
    let structural = false;

    for (const op of operations) {
      if (op.op === 'replace_all' && typeof op.content === 'string') {
        rows = parseCsvRows(op.content, delimiter);
        structural = true;
      } else if (op.op === 'set_cell') {
        const r = Number(op.row);
        const c = Number(op.col);
        if (!Number.isInteger(r) || r < 0 || !Number.isInteger(c) || c < 0) {
          throw new ArtifactError('INVALID_OPERATION', 'set_cell requires non-negative integer row and col.', 400);
        }
        structural ||= r === 0 || r >= rows.length || c >= rows[r].length;
        while (rows.length <= r) rows.push([]);
        while (rows[r].length <= c) rows[r].push('');
        rows[r][c] = String(op.value ?? '');
        touchedRegions.add(`r${r}c${c}`);
      } else if (op.op === 'set_range' && Array.isArray(op.values)) {
        const startRow = Number(op.startRow ?? 0);
        const startCol = Number(op.startCol ?? 0);
        for (let dr = 0; dr < op.values.length; dr++) {
          const srcRow = op.values[dr];
          if (!Array.isArray(srcRow)) continue;
          const r = startRow + dr;
          structural ||= r === 0 || r >= rows.length || startCol + srcRow.length > rows[r].length;
          while (rows.length <= r) rows.push([]);
          for (let dc = 0; dc < srcRow.length; dc++) {
            const c = startCol + dc;
            while (rows[r].length <= c) rows[r].push('');
            rows[r][c] = String(srcRow[dc] ?? '');
            touchedRegions.add(`r${r}c${c}`);
          }
        }
      } else if (op.op === 'insert_row') {
        const idx = Math.max(0, Math.min(rows.length, Number(op.index ?? rows.length)));
        const values = Array.isArray(op.values) ? op.values.map((v) => String(v ?? '')) : [];
        rows.splice(idx, 0, values);
        structural = true;
      } else if (op.op === 'delete_row') {
        const idx = Number(op.index);
        if (Number.isInteger(idx) && idx >= 0 && idx < rows.length) {
          rows.splice(idx, 1);
          structural = true;
        }
      } else if (op.op === 'insert_col') {
        const idx = Math.max(0, Number(op.index ?? 0));
        const values = Array.isArray(op.values) ? op.values.map((v) => String(v ?? '')) : [];
        rows.forEach((row, ri) => {
          while (row.length < idx) row.push('');
          row.splice(idx, 0, values[ri] ?? '');
        });
        structural = true;
      } else if (op.op === 'delete_col') {
        const idx = Number(op.index);
        if (Number.isInteger(idx) && idx >= 0) {
          rows.forEach((row) => {
            if (idx < row.length) row.splice(idx, 1);
          });
          structural = true;
        }
      } else {
        throw unsupportedOperationError(op.op, 'unsupported_by_format', `CSV adapter does not support op '${op.op}'.`);
      }
    }

    const out = serializeCsvRows(rows, delimiter) + '\n';
    return {
      buffer: Buffer.from(out, 'utf8'),
      summary: `Updated CSV (${operations.length} op${operations.length === 1 ? '' : 's'})`,
      semanticScope: {
        kind: structural ? 'structural' : 'cells',
        regionKeys: structural ? [] : [...touchedRegions],
      },
    };
  }

  verify(buffer: Buffer, meta: AdapterFileMeta): AdapterVerifyResult {
    const delimiter = detectDelimiter(meta.filename);
    const issues: AdapterVerifyIssue[] = [];
    const checks: AdapterVerifyCheck[] = [];

    let validUtf8 = true;
    let hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      validUtf8 = false;
      text = buffer.toString('utf8');
      issues.push({
        severity: 'error',
        code: 'CSV_INVALID_UTF8',
        message: 'Invalid UTF-8 byte sequence detected.',
      });
    }
    const hasNullByte = buffer.includes(0x00);
    if (hasNullByte) {
      issues.push({
        severity: 'error',
        code: 'CSV_NULL_BYTE',
        message: 'NUL byte detected in delimited text file.',
      });
    }
    if (hasBom) {
      issues.push({
        severity: 'info',
        code: 'CSV_UTF8_BOM',
        message: 'UTF-8 BOM prefix detected.',
      });
    }
    const encodingProblems: string[] = [];
    if (!validUtf8) encodingProblems.push('invalid UTF-8 byte sequences');
    if (hasNullByte) encodingProblems.push('NUL byte(s)');
    checks.push({
      id: 'csv_encoding',
      status: encodingProblems.length === 0 ? 'passed' : 'failed',
      evidence:
        encodingProblems.length === 0
          ? hasBom
            ? 'Valid UTF-8 (with BOM).'
            : 'Valid UTF-8.'
          : `Detected ${encodingProblems.join(' and ')}.`,
    });

    // Detect unbalanced quotes
    let quoteCount = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"') quoteCount += 1;
    }
    const unbalancedQuotes = quoteCount % 2 !== 0;
    if (unbalancedQuotes) {
      issues.push({ severity: 'error', code: 'CSV_UNBALANCED_QUOTES', message: 'Unbalanced double quotes detected.' });
    }
    checks.push({
      id: 'csv_quotes',
      status: unbalancedQuotes ? 'failed' : 'passed',
      evidence: unbalancedQuotes ? `Odd number of double quotes (${quoteCount}).` : 'Quotes are balanced.',
    });

    const rows = parseCsvRows(text, delimiter);
    const expectedCols = rows[0]?.length ?? 0;
    let mismatchedRows = 0;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].length !== expectedCols) {
        mismatchedRows += 1;
        issues.push({
          severity: 'warning',
          code: 'CSV_COLUMN_COUNT_MISMATCH',
          message: `Row ${i + 1} has ${rows[i].length} columns (expected ${expectedCols}).`,
          location: `row:${i + 1}`,
        });
      }
    }
    checks.push({
      id: 'csv_column_consistency',
      status: mismatchedRows > 0 ? 'failed' : 'passed',
      evidence: `Checked ${rows.length} rows against ${expectedCols} header columns; ${mismatchedRows} mismatched.`,
    });

    return textVerificationReport(checks, issues, { rowCount: rows.length, colCount: expectedCols, validUtf8, hasBom });
  }

  exportAs(buffer: Buffer, targetFormat: string, meta: AdapterFileMeta): AdapterExportResult {
    const delimiter = detectDelimiter(meta.filename);
    const rows = parseCsvRows(buffer.toString('utf8'), delimiter);
    const stem = path.basename(meta.filename, path.extname(meta.filename));
    const fmt = targetFormat.toLowerCase();

    if (fmt === 'xlsx') {
      return {
        buffer: buildXlsxFromRows(rows, stem || 'Sheet1'),
        filename: `${stem}.xlsx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
    }
    if (fmt === 'json') {
      const headers = rows[0] ?? [];
      const records = rows.slice(1).map((r) => {
        const obj: Record<string, string> = {};
        headers.forEach((h, idx) => {
          obj[h || `col_${idx + 1}`] = r[idx] ?? '';
        });
        return obj;
      });
      return {
        buffer: Buffer.from(JSON.stringify(records, null, 2) + '\n', 'utf8'),
        filename: `${stem}.json`,
        mimeType: 'application/json',
      };
    }
    if (fmt === 'tsv') {
      return {
        buffer: Buffer.from(serializeCsvRows(rows, '\t') + '\n', 'utf8'),
        filename: `${stem}.tsv`,
        mimeType: 'text/tab-separated-values',
      };
    }
    if (fmt === 'csv') {
      return {
        buffer: Buffer.from(serializeCsvRows(rows, ',') + '\n', 'utf8'),
        filename: `${stem}.csv`,
        mimeType: 'text/csv',
      };
    }
    throw unsupportedOperationError(`export:${fmt}`, 'unsupported_by_format', `CSV export to '${fmt}' is unsupported.`);
  }

  targetContextHash(buffer: Buffer, selector: TargetSelector, meta: AdapterFileMeta): string | null {
    const rows = parseCsvRows(buffer.toString('utf8'), detectDelimiter(meta.filename));
    const columnOnly = selector.kind === 'csv_row_col' && selector.axis === 'col';
    const rowOnly = selector.kind === 'csv_row_col' && selector.axis === 'row';
    const startRow = Number(selector.kind === 'csv_range' ? selector.startRow : selector.start);
    const endRow = Number(selector.kind === 'csv_range' ? selector.endRow : selector.end);
    if (!columnOnly) {
      const selectedCounts = new Map(rows.slice(startRow, endRow + 1).map(row => [JSON.stringify(row), 0]));
      for (const row of rows) {
        const key = JSON.stringify(row);
        const count = selectedCounts.get(key);
        if (count === undefined) continue;
        if (count > 0) return null;
        selectedCounts.set(key, count + 1);
      }
    }
    if (rowOnly) return sha256Text(JSON.stringify(rows.slice(startRow, endRow + 1)));
    const startCol = Number(columnOnly ? selector.start : selector.startCol);
    const endCol = Number(columnOnly ? selector.end : selector.endCol);
    const distinctHeaders = new Set(rows[0]?.slice(startCol, endCol + 1));
    const columns = new Map<number, ReturnType<typeof createHash>>();
    for (const [rowIndex, row] of rows.entries()) {
      for (const [col, cell] of row.entries()) {
        if (rows[0]?.[col] !== undefined && !distinctHeaders.has(rows[0][col])) continue;
        let hash = columns.get(col);
        if (!hash) {
          hash = createHash('sha256');
          columns.set(col, hash);
        }
        hash.update(JSON.stringify([rowIndex, cell])).update('\n');
      }
    }
    const signatures = new Map<string, number>();
    const selected: string[] = [];
    for (const [col, hash] of columns) {
      const fingerprint = hash.digest('hex');
      signatures.set(fingerprint, (signatures.get(fingerprint) ?? 0) + 1);
      if (col >= startCol && col <= endCol) selected.push(fingerprint);
    }
    if (selected.length !== endCol - startCol + 1 || selected.some(fingerprint => signatures.get(fingerprint) !== 1)) return null;
    if (columnOnly) return sha256Text(JSON.stringify(rows));
    return sha256Text(JSON.stringify(rows.map((row, index) =>
      index >= startRow && index <= endRow ? row : row.slice(startCol, endCol + 1))));
  }

  resolveTarget(buffer: Buffer, selector: TargetSelector, meta: AdapterFileMeta): TargetResolutionResult {
    const delimiter = detectDelimiter(meta.filename);
    const rows = parseCsvRows(buffer.toString('utf8'), delimiter);
    const rowCount = rows.length;
    const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const headerHash = sha256Text(JSON.stringify(rows[0] ?? []));

    if (selector.kind !== 'csv_range' && selector.kind !== 'csv_row_col') {
      return { status: 'needs_review', reason: 'unsupported_selector_kind' };
    }

    const expectedRowCount = Number(selector.expectedRowCount);
    const expectedColCount = Number(selector.expectedColCount);
    if (!Number.isInteger(expectedRowCount) || expectedRowCount < 0) {
      return { status: 'needs_review', reason: 'missing_expected_row_count' };
    }
    if (!Number.isInteger(expectedColCount) || expectedColCount < 0) {
      return { status: 'needs_review', reason: 'missing_expected_col_count' };
    }
    if (expectedRowCount !== rowCount) {
      return { status: 'needs_review', reason: 'row_count_changed' };
    }
    if (expectedColCount !== colCount) {
      return { status: 'needs_review', reason: 'col_count_changed' };
    }

    if (typeof selector.expectedHeaderHash !== 'string' || !selector.expectedHeaderHash) {
      return { status: 'needs_review', reason: 'missing_expected_header_hash' };
    }
    if (headerHash !== selector.expectedHeaderHash) {
      return { status: 'needs_review', reason: 'header_changed' };
    }
    if (typeof selector.expectedRangeValuesHash !== 'string' || !selector.expectedRangeValuesHash) {
      return { status: 'needs_review', reason: 'missing_expected_range_values_hash' };
    }

    if (selector.kind === 'csv_range') {
      const sr = Number(selector.startRow);
      const er = Number(selector.endRow);
      const sc = Number(selector.startCol);
      const ec = Number(selector.endCol);
      if (
        !Number.isInteger(sr) || !Number.isInteger(er) || !Number.isInteger(sc) || !Number.isInteger(ec) ||
        sr < 0 || sc < 0 || er < sr || ec < sc || er >= rowCount || ec >= colCount
      ) {
        return { status: 'stale', reason: 'range_out_of_bounds' };
      }
      const slice = rows.slice(sr, er + 1).map((r) => r.slice(sc, ec + 1));
      const valHash = sha256Text(JSON.stringify(slice));
      if (valHash !== selector.expectedRangeValuesHash) {
        return { status: 'needs_review', reason: 'range_values_changed' };
      }
      return {
        status: 'resolved',
        resolvedSnippet: serializeCsvRows(slice, delimiter),
        resolvedRange: { startRow: sr, endRow: er, startCol: sc, endCol: ec },
      };
    }

    const { axis } = selector;
    if (axis !== 'row' && axis !== 'col') return { status: 'stale', reason: 'range_out_of_bounds' };
    const start = Number(selector.start);
    const end = Number(selector.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      return { status: 'stale', reason: 'range_out_of_bounds' };
    }
    if ((axis === 'col' && end >= colCount) || (axis !== 'col' && end >= rowCount)) {
      return { status: 'stale', reason: 'range_out_of_bounds' };
    }
    const slice =
      axis === 'col'
        ? rows.map((r) => r.slice(start, end + 1))
        : rows.slice(start, end + 1);
    const valHash = sha256Text(JSON.stringify(slice));
    if (valHash !== selector.expectedRangeValuesHash) {
      return { status: 'needs_review', reason: 'row_col_values_changed' };
    }
    return {
      status: 'resolved',
      resolvedSnippet: serializeCsvRows(slice, delimiter),
      resolvedRange: { axis, start, end },
    };
  }
}
