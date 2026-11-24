import path from 'node:path';
import { ArtifactError, unsupportedOperationError } from '../errors.js';
import type {
  AdapterEditResult,
  AdapterExportResult,
  AdapterOperation,
  AdapterVerifyIssue,
  AdapterVerifyResult,
  OperationCapability,
  TargetResolutionResult,
  TargetSelector,
} from '../types.js';
import { sha256Text, type AdapterCapabilityContext, type AdapterFileMeta, type FormatAdapter } from './base.js';

function detectDelimiter(filename: string): string {
  return path.extname(filename).toLowerCase() === '.tsv' ? '\t' : ',';
}

export function parseCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/\r\n/g, '\n');

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
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
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

export class CsvAdapter implements FormatAdapter {
  readonly format = 'csv' as const;
  readonly previewKind = 'table' as const;
  readonly directEditUiSupported = true;
  readonly targetPinSupported = true;
  readonly requiresExternalWorker = false;

  getOperations(_ctx: AdapterCapabilityContext): OperationCapability[] {
    return [
      { operation: 'create', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'get_structure', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'read_range', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'edit', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'verify', availability: 'supported', scope: 'mcp_and_ui' },
      { operation: 'export', availability: 'supported', scope: 'mcp_and_ui', notes: 'json, csv, tsv' },
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
    const text = buffer.toString('utf8');
    const delimiter = detectDelimiter(meta.filename);
    const issues: AdapterVerifyIssue[] = [];

    // Detect unbalanced quotes
    let quoteCount = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"') quoteCount += 1;
    }
    if (quoteCount % 2 !== 0) {
      issues.push({ severity: 'error', code: 'CSV_UNBALANCED_QUOTES', message: 'Unbalanced double quotes detected.' });
    }

    const rows = parseCsvRows(text, delimiter);
    const expectedCols = rows[0]?.length ?? 0;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].length !== expectedCols) {
        issues.push({
          severity: 'warning',
          code: 'CSV_COLUMN_COUNT_MISMATCH',
          message: `Row ${i + 1} has ${rows[i].length} columns (expected ${expectedCols}).`,
          location: `row:${i + 1}`,
        });
      }
    }

    return {
      ok: !issues.some((i) => i.severity === 'error'),
      issues,
      metrics: { rowCount: rows.length, colCount: expectedCols },
    };
  }

  exportAs(buffer: Buffer, targetFormat: string, meta: AdapterFileMeta): AdapterExportResult {
    const delimiter = detectDelimiter(meta.filename);
    const rows = parseCsvRows(buffer.toString('utf8'), delimiter);
    const stem = path.basename(meta.filename, path.extname(meta.filename));
    const fmt = targetFormat.toLowerCase();

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

  resolveTarget(buffer: Buffer, selector: TargetSelector, meta: AdapterFileMeta): TargetResolutionResult {
    const delimiter = detectDelimiter(meta.filename);
    const rows = parseCsvRows(buffer.toString('utf8'), delimiter);
    const rowCount = rows.length;
    const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);

    if (selector.expectedRowCount !== undefined && Number(selector.expectedRowCount) !== rowCount) {
      return { status: 'needs_review', reason: 'row_count_changed' };
    }
    if (selector.expectedColCount !== undefined && Number(selector.expectedColCount) !== colCount) {
      return { status: 'needs_review', reason: 'col_count_changed' };
    }
    if (selector.expectedHeaderHash && sha256Text(JSON.stringify(rows[0] ?? [])) !== String(selector.expectedHeaderHash)) {
      return { status: 'needs_review', reason: 'header_changed' };
    }

    if (selector.kind === 'csv_range') {
      const sr = Number(selector.startRow ?? 0);
      const er = Number(selector.endRow ?? sr);
      const sc = Number(selector.startCol ?? 0);
      const ec = Number(selector.endCol ?? sc);
      if (er >= rowCount || ec >= colCount || sr < 0 || sc < 0) {
        return { status: 'stale', reason: 'range_out_of_bounds' };
      }
      const slice = rows.slice(sr, er + 1).map((r) => r.slice(sc, ec + 1));
      const valHash = sha256Text(JSON.stringify(slice));
      if (selector.expectedRangeValuesHash && valHash !== String(selector.expectedRangeValuesHash)) {
        return { status: 'needs_review', reason: 'range_values_changed' };
      }
      return {
        status: 'resolved',
        resolvedSnippet: serializeCsvRows(slice, delimiter),
        resolvedRange: { startRow: sr, endRow: er, startCol: sc, endCol: ec },
      };
    }

    if (selector.kind === 'csv_row_col') {
      const axis = String(selector.axis ?? 'row');
      const start = Number(selector.start ?? 0);
      const end = Number(selector.end ?? start);
      const slice =
        axis === 'col'
          ? rows.map((r) => r.slice(start, end + 1))
          : rows.slice(start, end + 1);
      const valHash = sha256Text(JSON.stringify(slice));
      if (selector.expectedRangeValuesHash && valHash !== String(selector.expectedRangeValuesHash)) {
        return { status: 'needs_review', reason: 'row_col_values_changed' };
      }
      return {
        status: 'resolved',
        resolvedSnippet: serializeCsvRows(slice, delimiter),
        resolvedRange: { axis, start, end },
      };
    }

    return { status: 'needs_review', reason: 'unsupported_selector_kind' };
  }
}
