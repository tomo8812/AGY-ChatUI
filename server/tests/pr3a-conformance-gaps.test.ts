import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { createTestServer } from './helpers/test-harness.js';
import { FormatAdapterRegistry } from '../src/artifacts/adapters/registry.js';
import { readDocxAllParagraphTargets, readXlsxRangeTarget } from '../src/artifacts/adapters/ooxml-target.js';
import { inspectPdfDocument, computePdfRegionDigest } from '../src/artifacts/adapters/pdf-target.js';
import { sha256Hex } from '../../web/src/utils/sha256.js';
import { auditRegions, decodePng } from '../../e2e/helpers/visualAudit.js';
import { BlockRenderAccounting, addNode, expression } from '../../web/src/components/shared-ui/runtime.js';
import { RichStateStore } from '../../web/src/components/shared-ui/RichStateStore.js';
import type { RichDocumentV1 } from '../../shared/rich-schema.js';

function buildMinimalXlsx(opts: {
  sheets: Array<{
    name: string;
    rows: Array<{ r: number; cells: Array<{ ref: string; v?: string | number; f?: string; sharedString?: boolean }> }>;
    merges?: string[];
  }>;
  sharedStrings?: string[];
}): Buffer {
  const sharedStrings = opts.sharedStrings ?? [];
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        opts.sheets
          .map(
            (_, idx) =>
              `<Override PartName="/xl/worksheets/sheet${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('') +
        (sharedStrings.length
          ? `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>`
          : '') +
        `</Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`,
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets>` +
        opts.sheets
          .map((s, idx) => `<sheet name="${s.name}" sheetId="${idx + 1}" r:id="rId${idx + 1}"/>`)
          .join('') +
        `</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        opts.sheets
          .map(
            (_, idx) =>
              `<Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${idx + 1}.xml"/>`,
          )
          .join('') +
        `</Relationships>`,
    ),
  };

  if (sharedStrings.length > 0) {
    files['xl/sharedStrings.xml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">` +
        sharedStrings.map((s) => `<si><t>${s}</t></si>`).join('') +
        `</sst>`,
    );
  }

  opts.sheets.forEach((sheet, idx) => {
    const rowsXml = sheet.rows
      .map((row) => {
        const cellsXml = row.cells
          .map((c) => {
            const tAttr = c.sharedString ? ' t="s"' : typeof c.v === 'string' && !c.f ? ' t="inlineStr"' : '';
            const formulaXml = c.f ? `<f>${c.f}</f>` : '';
            const valueXml =
              c.v === undefined
                ? ''
                : c.sharedString || typeof c.v === 'number' || c.f
                  ? `<v>${c.v}</v>`
                  : `<is><t>${c.v}</t></is>`;
            return `<c r="${c.ref}"${tAttr}>${formulaXml}${valueXml}</c>`;
          })
          .join('');
        return `<row r="${row.r}">${cellsXml}</row>`;
      })
      .join('');
    const mergesXml =
      sheet.merges && sheet.merges.length > 0
        ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
        : '';
    files[`xl/worksheets/sheet${idx + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<sheetData>${rowsXml}</sheetData>${mergesXml}</worksheet>`,
    );
  });

  return Buffer.from(zipSync(files));
}

function buildMinimalDocx(paragraphs: Array<{ text: string; paraId?: string }>): Buffer {
  const bodyXml = paragraphs
    .map((p) => {
      const idAttr = p.paraId ? ` w14:paraId="${p.paraId}"` : '';
      return `<w:p${idAttr}><w:r><w:t>${p.text}</w:t></w:r></w:p>`;
    })
    .join('');
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
          `</Types>`,
      ),
      '_rels/.rels': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
          `</Relationships>`,
      ),
      'word/document.xml': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">` +
          `<w:body>${bodyXml}</w:body></w:document>`,
      ),
    }),
  );
}

function buildMinimalPdf(
  pages: Array<{ width: number; height: number; rotate?: number; text: string; compressed?: boolean }>,
): Buffer {
  const objects: Buffer[] = [];
  const addObj = (body: string | Buffer): number => {
    const id = objects.length + 1;
    const prefix = Buffer.from(`${id} 0 obj\n`, 'ascii');
    const suffix = Buffer.from('\nendobj\n', 'ascii');
    const payload = typeof body === 'string' ? Buffer.from(body, 'ascii') : body;
    objects.push(Buffer.concat([prefix, payload, suffix]));
    return id;
  };

  // Reserve 1=Catalog, 2=Pages, 3=Font
  const catalogId = addObj('');
  const pagesId = addObj('');
  const fontId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const pageIds: number[] = [];
  for (const p of pages) {
    const escaped = p.text.replace(/[()\\]/g, '\\$&');
    const rawStream = Buffer.from(`BT /F1 18 Tf 72 ${Math.max(40, p.height - 90)} Td (${escaped}) Tj ET\n`, 'ascii');
    const streamData = p.compressed ? zlib.deflateSync(rawStream) : rawStream;
    const filter = p.compressed ? ' /Filter /FlateDecode' : '';
    const contentId = addObj(
      Buffer.concat([
        Buffer.from(`<< /Length ${streamData.length}${filter} >>\nstream\n`, 'ascii'),
        streamData,
        Buffer.from('\nendstream', 'ascii'),
      ]),
    );
    const rotatePart = p.rotate ? ` /Rotate ${p.rotate}` : '';
    const pageId = addObj(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${p.width} ${p.height}]${rotatePart} /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }

  objects[catalogId - 1] = Buffer.from(`${catalogId} 0 obj\n<< /Type /Catalog /Pages ${pagesId} 0 R >>\nendobj\n`, 'ascii');
  objects[pagesId - 1] = Buffer.from(
    `${pagesId} 0 obj\n<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>\nendobj\n`,
    'ascii',
  );

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'ascii')];
  const offsets: number[] = [0];
  let cursor = chunks[0].length;
  for (const obj of objects) {
    offsets.push(cursor);
    chunks.push(obj);
    cursor += obj.length;
  }
  const xrefPos = cursor;
  const xrefLines = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n'];
  for (let i = 1; i <= objects.length; i++) {
    xrefLines.push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  xrefLines.push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);
  chunks.push(Buffer.from(xrefLines.join(''), 'ascii'));
  return Buffer.concat(chunks);
}

function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Buffer {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const typeBuf = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const dst = y * (1 + width * 4);
    raw[dst] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), dst + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('PR 3A Conformance Gap Fixes', () => {
  it('Workstream 1 (XLSX): enforces real sheetStructHash & ordered rangeValuesHash without whole-file SHA-256 fallback', async () => {
    const server = await createTestServer({ installDocRuntime: 'off', sandboxMode: 'off', allowUnsandboxedDocWorkers: false });
    try {
      const userId = 'u-xlsx';
      const chatId = 'c-xlsx';
      const workspaceDir = fs.mkdtempSync(path.join(server.dataRoot, 'xlsx-ws-'));
      server.ctx.db.createUser({ id: userId, username: 'u-xlsx', displayName: 'XLSX', passwordHash: 'x', role: 'user', profileDir: workspaceDir });
      server.ctx.db.createChat({ id: chatId, userId, projectId: null, title: 'XLSX', workspaceDir, modelId: '', effortValue: '', projectContextVersion: 0 });

      const v1 = buildMinimalXlsx({
        sharedStrings: ['Item', 'Price', 'Apple', 'Orange'],
        sheets: [
          {
            name: 'Sales',
            rows: [
              { r: 1, cells: [{ ref: 'A1', v: 0, sharedString: true }, { ref: 'B1', v: 1, sharedString: true }] },
              { r: 2, cells: [{ ref: 'A2', v: 2, sharedString: true }, { ref: 'B2', v: 100, f: '50*2' }] },
              { r: 3, cells: [{ ref: 'A3', v: 3, sharedString: true }, { ref: 'B3', v: 200 }] },
              { r: 5, cells: [{ ref: 'C5', v: 999 }] },
            ],
            merges: ['D1:E1'],
          },
        ],
      });

      const created = await server.ctx.artifactService.createArtifact({
        userId, scopeKind: 'chat', chatId, relPath: 'sales.xlsx', content: v1, actorKind: 'user', actorId: userId,
      });
      const artId = created.artifact.id;

      // Pure-JS Base ChatUI readRange(targetMetadata='true') works with installDocRuntime='off'
      const meta = await server.ctx.artifactService.readRange(userId, artId, {
        sheetId: '1',
        rangeA1: 'A1:B2',
        targetMetadata: 'true',
      }) as { target?: { expectedSheetStructHash?: string; expectedRangeValuesHash?: string } };
      expect(typeof meta.target?.expectedSheetStructHash).toBe('string');
      expect(typeof meta.target?.expectedRangeValuesHash).toBe('string');
      expect(meta.target?.expectedRangeValuesHash).not.toBe(created.artifact.sha256);

      const selector = {
        kind: 'xlsx_range' as const,
        sheetId: '1',
        sheetName: 'Sales',
        rangeA1: 'A1:B2',
        expectedSheetStructHash: String(meta.target!.expectedSheetStructHash),
        expectedRangeValuesHash: String(meta.target!.expectedRangeValuesHash),
      };

      const adapter = new FormatAdapterRegistry().resolve('sales.xlsx', 'table');
      const xlsxMeta = { filename: 'sales.xlsx', previewKind: 'table' as const };
      expect(adapter.resolveTarget(v1, selector, xlsxMeta).status).toBe('resolved');

      // Missing expectedSheetStructHash must NOT resolve
      expect(
        adapter.resolveTarget(v1, { ...selector, expectedSheetStructHash: '' }, xlsxMeta).status,
      ).toBe('needs_review');

      // Unrelated cell outside A1:B2 (C5 changed from 999 to 777, same sheet structure) MUST still resolve!
      const vUnrelated = buildMinimalXlsx({
        sharedStrings: ['Item', 'Price', 'Apple', 'Orange'],
        sheets: [
          {
            name: 'Sales',
            rows: [
              { r: 1, cells: [{ ref: 'A1', v: 0, sharedString: true }, { ref: 'B1', v: 1, sharedString: true }] },
              { r: 2, cells: [{ ref: 'A2', v: 2, sharedString: true }, { ref: 'B2', v: 100, f: '50*2' }] },
              { r: 3, cells: [{ ref: 'A3', v: 3, sharedString: true }, { ref: 'B3', v: 200 }] },
              { r: 5, cells: [{ ref: 'C5', v: 777 }] },
            ],
            merges: ['D1:E1'],
          },
        ],
      });
      expect(adapter.resolveTarget(vUnrelated, selector, xlsxMeta).status).toBe('resolved');

      // Formula changed inside A1:B2 (same cached value 100!) -> needs_review
      const vFormulaChanged = buildMinimalXlsx({
        sharedStrings: ['Item', 'Price', 'Apple', 'Orange'],
        sheets: [
          {
            name: 'Sales',
            rows: [
              { r: 1, cells: [{ ref: 'A1', v: 0, sharedString: true }, { ref: 'B1', v: 1, sharedString: true }] },
              { r: 2, cells: [{ ref: 'A2', v: 2, sharedString: true }, { ref: 'B2', v: 100, f: '25*4' }] },
              { r: 3, cells: [{ ref: 'A3', v: 3, sharedString: true }, { ref: 'B3', v: 200 }] },
              { r: 5, cells: [{ ref: 'C5', v: 999 }] },
            ],
            merges: ['D1:E1'],
          },
        ],
      });
      expect(adapter.resolveTarget(vFormulaChanged, selector, xlsxMeta).status).toBe('needs_review');

      // Row order swapped inside A1:B2 -> needs_review
      const vOrderSwapped = buildMinimalXlsx({
        sharedStrings: ['Item', 'Price', 'Apple', 'Orange'],
        sheets: [
          {
            name: 'Sales',
            rows: [
              { r: 1, cells: [{ ref: 'A1', v: 2, sharedString: true }, { ref: 'B1', v: 100, f: '50*2' }] },
              { r: 2, cells: [{ ref: 'A2', v: 0, sharedString: true }, { ref: 'B2', v: 1, sharedString: true }] },
              { r: 3, cells: [{ ref: 'A3', v: 3, sharedString: true }, { ref: 'B3', v: 200 }] },
              { r: 5, cells: [{ ref: 'C5', v: 999 }] },
            ],
            merges: ['D1:E1'],
          },
        ],
      });
      expect(adapter.resolveTarget(vOrderSwapped, selector, xlsxMeta).status).toBe('needs_review');

      // Sheet structure changed (merge added) while A1:B2 values are identical -> needs_review
      const vStructChanged = buildMinimalXlsx({
        sharedStrings: ['Item', 'Price', 'Apple', 'Orange'],
        sheets: [
          {
            name: 'Sales',
            rows: [
              { r: 1, cells: [{ ref: 'A1', v: 0, sharedString: true }, { ref: 'B1', v: 1, sharedString: true }] },
              { r: 2, cells: [{ ref: 'A2', v: 2, sharedString: true }, { ref: 'B2', v: 100, f: '50*2' }] },
              { r: 3, cells: [{ ref: 'A3', v: 3, sharedString: true }, { ref: 'B3', v: 200 }] },
              { r: 5, cells: [{ ref: 'C5', v: 999 }] },
            ],
            merges: ['D1:E1', 'F1:G1'],
          },
        ],
      });
      expect(adapter.resolveTarget(vStructChanged, selector, xlsxMeta).status).toBe('needs_review');

      // Sheet deleted -> stale
      const vSheetDeleted = buildMinimalXlsx({
        sheets: [{ name: 'Other', rows: [{ r: 1, cells: [{ ref: 'A1', v: 1 }] }] }],
      });
      expect(
        adapter.resolveTarget(vSheetDeleted, { ...selector, sheetId: '99', sheetName: 'Sales' }, xlsxMeta).status,
      ).toBe('stale');

      // Direct helper sanity check
      const direct = readXlsxRangeTarget(v1, '1', 'A1:B2');
      expect(direct?.expectedRangeValuesHash).toBe(meta.target!.expectedRangeValuesHash);
    } finally {
      await server.cleanup();
    }
  });

  it('Workstream 1 (CSV/TSV): requires expectedRowCount, expectedColCount, expectedHeaderHash, and expectedRangeValuesHash', async () => {
    const server = await createTestServer({ installDocRuntime: 'off', sandboxMode: 'off', allowUnsandboxedDocWorkers: false });
    try {
      const userId = 'u-csv';
      const chatId = 'c-csv';
      const workspaceDir = fs.mkdtempSync(path.join(server.dataRoot, 'csv-ws-'));
      server.ctx.db.createUser({ id: userId, username: 'u-csv', displayName: 'CSV', passwordHash: 'x', role: 'user', profileDir: workspaceDir });
      server.ctx.db.createChat({ id: chatId, userId, projectId: null, title: 'CSV', workspaceDir, modelId: '', effortValue: '', projectContextVersion: 0 });

      const csv1 = Buffer.from('Name,Score\nAlice,90\nBob,80\n', 'utf8');
      const created = await server.ctx.artifactService.createArtifact({
        userId, scopeKind: 'chat', chatId, relPath: 'scores.csv', content: csv1, actorKind: 'user', actorId: userId,
      });

      const range = await server.ctx.artifactService.readRange(userId, created.artifact.id, {
        startRow: 1,
        endRow: 2,
        startCol: 0,
        endCol: 1,
        targetHashes: 'true',
      }) as Record<string, unknown>;
      expect(range.totalRows).toBe(3);
      expect(range.totalCols).toBe(2);
      expect(typeof range.headerHash).toBe('string');
      expect(typeof range.valuesHash).toBe('string');

      const adapter = new FormatAdapterRegistry().resolve('scores.csv', 'table');
      const fullSelector = {
        kind: 'csv_range' as const,
        startRow: 1,
        endRow: 2,
        startCol: 0,
        endCol: 1,
        expectedRowCount: Number(range.totalRows),
        expectedColCount: Number(range.totalCols),
        expectedHeaderHash: String(range.headerHash),
        expectedRangeValuesHash: String(range.valuesHash),
      };

      const csvMeta = { filename: 'scores.csv', previewKind: 'table' as const };
      expect(adapter.resolveTarget(csv1, fullSelector, csvMeta).status).toBe('resolved');

      // Missing mandatory fields -> needs_review
      expect(adapter.resolveTarget(csv1, { ...fullSelector, expectedHeaderHash: undefined }, csvMeta).status).toBe('needs_review');
      expect(adapter.resolveTarget(csv1, { ...fullSelector, expectedRowCount: undefined }, csvMeta).status).toBe('needs_review');
      expect(adapter.resolveTarget(csv1, { ...fullSelector, expectedColCount: undefined }, csvMeta).status).toBe('needs_review');
      expect(adapter.resolveTarget(csv1, { ...fullSelector, expectedRangeValuesHash: '' }, csvMeta).status).toBe('needs_review');

      // Row count drift (new row appended, selected rows 1..2 unchanged) -> needs_review
      expect(adapter.resolveTarget(Buffer.from('Name,Score\nAlice,90\nBob,80\nCarol,70\n'), fullSelector, csvMeta).status).toBe('needs_review');
      // Column count drift -> needs_review
      expect(adapter.resolveTarget(Buffer.from('Name,Score,Rank\nAlice,90,1\nBob,80,2\n'), fullSelector, csvMeta).status).toBe('needs_review');
      // Header change (selected rows 1..2 unchanged!) -> needs_review
      expect(adapter.resolveTarget(Buffer.from('Student,Points\nAlice,90\nBob,80\n'), fullSelector, csvMeta).status).toBe('needs_review');
      // Row order swap inside selected range -> needs_review
      expect(adapter.resolveTarget(Buffer.from('Name,Score\nBob,80\nAlice,90\n'), fullSelector, csvMeta).status).toBe('needs_review');
    } finally {
      await server.cleanup();
    }
  });

  it('Workstream 1 (PDF): validates per-page content/rotation/dimension & region digest in Pure-JS Base ChatUI without external worker', async () => {
    const server = await createTestServer({ installDocRuntime: 'off', sandboxMode: 'off', allowUnsandboxedDocWorkers: false });
    try {
      const userId = 'u-pdf';
      const chatId = 'c-pdf';
      const workspaceDir = fs.mkdtempSync(path.join(server.dataRoot, 'pdf-ws-'));
      server.ctx.db.createUser({ id: userId, username: 'u-pdf', displayName: 'PDF', passwordHash: 'x', role: 'user', profileDir: workspaceDir });
      server.ctx.db.createChat({ id: chatId, userId, projectId: null, title: 'PDF', workspaceDir, modelId: '', effortValue: '', projectContextVersion: 0 });

      const pdf1 = buildMinimalPdf([
        { width: 595, height: 842, text: 'Page One Revenue 100', compressed: true },
        { width: 595, height: 842, text: 'Page Two Notes Alpha', compressed: true },
      ]);
      const created = await server.ctx.artifactService.createArtifact({
        userId, scopeKind: 'chat', chatId, relPath: 'report.pdf', content: pdf1, actorKind: 'user', actorId: userId,
      });

      const rectPt: [number, number, number, number] = [60, 730, 220, 40];
      const meta = await server.ctx.artifactService.readRange(userId, created.artifact.id, {
        pageIndex: 0,
        rectPt: JSON.stringify(rectPt),
        targetMetadata: 'true',
      }) as { target?: { pageContentHash?: string; regionDigest?: string } };
      expect(typeof meta.target?.pageContentHash).toBe('string');
      expect(typeof meta.target?.regionDigest).toBe('string');
      expect(meta.target?.pageContentHash).not.toBe(created.artifact.sha256);

      const adapter = new FormatAdapterRegistry().resolve('report.pdf', 'pdf');
      const regionSelector = {
        kind: 'pdf_region' as const,
        pageIndex: 0,
        expectedPageCount: 2,
        rectPt,
        expectedPageContentHash: String(meta.target!.pageContentHash),
        expectedRegionDigest: String(meta.target!.regionDigest),
      };
      const pdfMeta = { filename: 'report.pdf', previewKind: 'pdf' as const };
      expect(adapter.resolveTarget(pdf1, regionSelector, pdfMeta).status).toBe('resolved');
      expect(adapter.resolveTarget(pdf1, { ...regionSelector, expectedPageCount: 3 }, pdfMeta).status).toBe('needs_review');

      // Modifying ONLY Page 2 MUST NOT invalidate Page 1's pdf_region! (Proves NOT whole-file SHA-256!)
      const pdfPage2Changed = buildMinimalPdf([
        { width: 595, height: 842, text: 'Page One Revenue 100', compressed: true },
        { width: 595, height: 842, text: 'Page Two Completely Rewritten Beta', compressed: true },
      ]);
      expect(adapter.resolveTarget(pdfPage2Changed, regionSelector, pdfMeta).status).toBe('resolved');

      // Modifying Page 1 content -> needs_review
      const pdfPage1Changed = buildMinimalPdf([
        { width: 595, height: 842, text: 'Page One Revenue 999', compressed: true },
        { width: 595, height: 842, text: 'Page Two Notes Alpha', compressed: true },
      ]);
      expect(adapter.resolveTarget(pdfPage1Changed, regionSelector, pdfMeta).status).toBe('needs_review');

      // Rotating Page 1 (/Rotate 90) -> needs_review
      const pdfRotated = buildMinimalPdf([
        { width: 595, height: 842, rotate: 90, text: 'Page One Revenue 100', compressed: true },
        { width: 595, height: 842, text: 'Page Two Notes Alpha', compressed: true },
      ]);
      expect(adapter.resolveTarget(pdfRotated, regionSelector, pdfMeta).status).toBe('needs_review');

      // Changing Page 1 MediaBox dimensions -> needs_review
      const pdfResized = buildMinimalPdf([
        { width: 612, height: 792, text: 'Page One Revenue 100', compressed: true },
        { width: 595, height: 842, text: 'Page Two Notes Alpha', compressed: true },
      ]);
      expect(adapter.resolveTarget(pdfResized, regionSelector, pdfMeta).status).toBe('needs_review');

      // Tampering expectedRegionDigest -> needs_review
      expect(
        adapter.resolveTarget(pdf1, { ...regionSelector, expectedRegionDigest: '0'.repeat(64) }, pdfMeta).status,
      ).toBe('needs_review');

      // Direct inspectPdfDocument + computePdfRegionDigest determinism check
      const inspected = inspectPdfDocument(pdf1);
      expect(inspected?.pageCount).toBe(2);
      expect(computePdfRegionDigest(inspected!.pages[0], rectPt)).toBe(meta.target!.regionDigest);
    } finally {
      await server.cleanup();
    }
  });

  it('Workstream 1 (DOCX): prevents duplicate paragraphs without paraId from falsely matching a shifted sibling', async () => {
    const server = await createTestServer({ installDocRuntime: 'off', sandboxMode: 'off', allowUnsandboxedDocWorkers: false });
    try {
      const adapter = new FormatAdapterRegistry().resolve('doc.docx', 'docx');
      const docxMeta = { filename: 'doc.docx', previewKind: 'docx' as const };
      const docxV1 = buildMinimalDocx([
        { text: 'Intro' },
        { text: 'Shared clause' },
        { text: 'Middle' },
        { text: 'Shared clause' },
        { text: 'End' },
      ]);
      const targets = readDocxAllParagraphTargets(docxV1).paragraphs;
      const firstShared = targets[1];
      expect(firstShared.duplicateCount).toBe(2);
      expect(firstShared.occurrenceIndex).toBe(0);

      const selector = {
        kind: 'docx_paragraph' as const,
        blockIndex: 1,
        expectedBlockHash: firstShared.fingerprint,
        contextBeforeHash: firstShared.contextBeforeHash,
        contextAfterHash: firstShared.contextAfterHash,
        occurrenceIndex: firstShared.occurrenceIndex,
        duplicateCount: firstShared.duplicateCount,
      };
      expect(adapter.resolveTarget(docxV1, selector, docxMeta).status).toBe('resolved');

      // Delete Intro + first 'Shared clause' so the SECOND 'Shared clause' now sits at blockIndex 1!
      const docxSecondLandedAtIndex1 = buildMinimalDocx([
        { text: 'Middle' },
        { text: 'Shared clause' },
        { text: 'End' },
      ]);
      const resShifted = adapter.resolveTarget(docxSecondLandedAtIndex1, selector, docxMeta);
      expect(resShifted.status).toBe('needs_review');

      // Insert a new paragraph at top so both duplicates shift down -> ambiguous without paraId -> needs_review
      const docxInsertedTop = buildMinimalDocx([
        { text: 'Preamble' },
        { text: 'Intro' },
        { text: 'Shared clause' },
        { text: 'Middle' },
        { text: 'Shared clause' },
        { text: 'End' },
      ]);
      expect(adapter.resolveTarget(docxInsertedTop, selector, docxMeta).status).toBe('needs_review');

      // With unique paraId, shifting position still resolves uniquely when content matches
      const docxWithParaId = buildMinimalDocx([
        { text: 'Intro', paraId: '11111111' },
        { text: 'Shared clause', paraId: '22222222' },
        { text: 'Shared clause', paraId: '33333333' },
      ]);
      const pTarget = readDocxAllParagraphTargets(docxWithParaId).paragraphs[1];
      const paraSelector = {
        kind: 'docx_paragraph' as const,
        paraId: '22222222',
        blockIndex: 1,
        expectedBlockHash: pTarget.fingerprint,
      };
      const docxParaShifted = buildMinimalDocx([
        { text: 'Added header', paraId: '00000000' },
        { text: 'Intro', paraId: '11111111' },
        { text: 'Shared clause', paraId: '22222222' },
        { text: 'Shared clause', paraId: '33333333' },
      ]);
      expect(adapter.resolveTarget(docxParaShifted, paraSelector, docxMeta).status).toBe('resolved');
    } finally {
      await server.cleanup();
    }
  });

  it('Workstream 2 (HTTP-safe SHA-256): matches Node crypto SHA-256 without crypto.subtle', () => {
    const samples = [
      '',
      'abc',
      'a'.repeat(55),
      'a'.repeat(56),
      'a'.repeat(64),
      '日本語PDFページ領域ハッシュテスト 12345',
      'x'.repeat(4096),
    ];
    for (const s of samples) {
      const expected = crypto.createHash('sha256').update(s, 'utf8').digest('hex');
      expect(sha256Hex(s)).toBe(expected);
    }
  });

  it('Workstream 3 (PPTX Visual Consistency): region-level audit fails local bbox defects & residual ghosts even when whole-slide SSIM >= 0.96', () => {
    const W = 400;
    const H = 225;
    const base = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      base[i * 4] = 245;
      base[i * 4 + 1] = 247;
      base[i * 4 + 2] = 250;
      base[i * 4 + 3] = 255;
    }
    const drawRect = (buf: Uint8Array, x0: number, y0: number, w: number, h: number, r: number, g: number, b: number) => {
      for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
          const idx = (y * W + x) * 4;
          buf[idx] = r;
          buf[idx + 1] = g;
          buf[idx + 2] = b;
          buf[idx + 3] = 255;
        }
      }
    };
    // Paint two elements on reference slide
    drawRect(base, 20, 20, 120, 40, 30, 64, 175); // Title
    drawRect(base, 260, 120, 36, 28, 220, 38, 38); // Small badge

    const broken = new Uint8Array(base);
    // Corrupt ONLY the small 36x28 badge (1.1% of slide pixels) — simulates broken render / ghosting
    drawRect(broken, 260, 120, 36, 28, 16, 185, 129);

    const pngRef = encodeRgbaPng(W, H, base);
    const pngBroken = encodeRgbaPng(W, H, broken);

    const imgRef = decodePng(pngRef);
    const imgBroken = decodePng(pngBroken);

    const audit = auditRegions(
      imgBroken,
      imgRef,
      [
        { id: 'title', label: 'Title', rectPx: { x: 20, y: 20, width: 120, height: 40 } },
        { id: 'badge', label: 'Small badge', rectPx: { x: 260, y: 120, width: 36, height: 28 } },
        { id: 'bg', label: 'Background', rectPx: { x: 150, y: 150, width: 80, height: 40 } },
      ],
      { minSsim: 0.90, maxMae: 8.5 },
    );
    // Whole-slide SSIM stays high (>= 0.96), yet region audit MUST fail and pinpoint Small badge!
    expect(audit.wholeSlide.ssim).toBeGreaterThanOrEqual(0.96);
    expect(audit.allPassed).toBe(false);
    expect(audit.failedRegions.map((r) => r.label)).toEqual(['Small badge']);

    const cleanAudit = auditRegions(imgRef, imgRef, [
      { id: 'title', label: 'Title', rectPx: { x: 20, y: 20, width: 120, height: 40 } },
      { id: 'badge', label: 'Small badge', rectPx: { x: 260, y: 120, width: 36, height: 28 } },
    ]);
    expect(cleanAudit.allPassed).toBe(true);
  });

  it('Workstream 5 (Rich UI Global Limits): BlockRenderAccounting enforces block-wide SVG, node, and AST step ceilings across sibling/lazy scopes & partial re-renders', () => {
    const accounting = new BlockRenderAccounting();

    // 1. Two lazy SvgScene scopes each rendering 1,200 SVG elements (each individually <= 2,000) -> fails at 2,001!
    const sceneA = accounting.beginScope('root-children-0:lazy');
    for (let i = 0; i < 1200; i++) addNode(sceneA, true);
    expect(accounting.getTotals().svgElements).toBe(1200);

    const sceneB = accounting.beginScope('root-children-1:lazy');
    expect(() => {
      for (let i = 0; i < 1200; i++) addNode(sceneB, true);
    }).toThrow('図の表示上限');

    // Removing sceneB frees its partial contribution; re-rendering sceneA 100 times never drifts!
    accounting.removeScope('root-children-1:lazy');
    for (let pass = 0; pass < 100; pass++) {
      const rerunA = accounting.beginScope('root-children-0:lazy');
      for (let i = 0; i < 1200; i++) addNode(rerunA, true);
    }
    expect(accounting.getTotals().svgElements).toBe(1200);

    // 2. Cumulative AST steps across baseSteps (computed) + sibling scopes cannot exceed 20,000
    const stepAcc = new BlockRenderAccounting();
    stepAcc.setBaseSteps(19_980);
    const s1 = stepAcc.beginScope('root-children-0');
    expression('1 + 2 + 3 + 4 + 5', { state: {}, computed: {}, theme: 'light' }, s1);
    const s2 = stepAcc.beginScope('root-children-1');
    expect(() => {
      expression('1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10', { state: {}, computed: {}, theme: 'light' }, s2);
    }).toThrow(/AST steps/i);

    // 3. Cumulative nodes across sibling repeat expansions cannot exceed 2,000
    const nodeAcc = new BlockRenderAccounting();
    const r1 = nodeAcc.beginScope('root-children-0');
    for (let i = 0; i < 1500; i++) addNode(r1, false);
    const r2 = nodeAcc.beginScope('root-children-1');
    expect(() => {
      for (let i = 0; i < 600; i++) addNode(r2, false);
    }).toThrow('表示項目数の上限');
  });

  it('Workstream 5 (Rich UI Performance): RichStateStore avoids full re-validation & untouched computed/subtree re-evaluation on continuous slider updates while preserving limits', () => {
    const bigRows = Array.from({ length: 500 }, (_, i) => ({ id: i, label: `Row ${i}`, value: i * 10 }));
    const svgItems = Array.from({ length: 150 }, (_, i) => ({ x: i * 3, y: 20 }));
    const doc: RichDocumentV1 = {
      schemaVersion: 1,
      state: { threshold: 50, bigRows, svgItems, extraList: [1, 2, 3] },
      computed: {
        heavySummary: 'sum(pluck($state.bigRows, "value"))',
        filteredScore: '$state.threshold * 3',
      },
      root: {
        id: 'root',
        type: 'stack',
        direction: 'col',
        children: [
          { id: 'slider', type: 'slider', bind: 'threshold', label: 'Threshold', min: 0, max: 200, step: 1 },
          { id: 'kpi-fast', type: 'kpi_card', label: 'Filtered', value: { expr: '$computed.filteredScore' } },
          { id: 'md-fast', type: 'markdown', content: { expr: 'concat("Score: ", $computed.filteredScore)' } },
          { id: 'kpi-heavy', type: 'kpi_card', label: 'Heavy Total', value: { expr: '$computed.heavySummary' } },
          {
            id: 'heavy-table',
            type: 'data_table',
            columns: [
              { key: 'id', label: 'ID' },
              { key: 'label', label: 'Label' },
              { key: 'value', label: 'Value' },
            ],
            rows: { expr: '$state.bigRows' },
          },
          {
            id: 'heavy-svg',
            type: 'svg_scene',
            viewBox: '0 0 600 100',
            elements: [
              {
                tag: 'circle',
                repeat: { itemsExpr: '$state.svgItems', as: 'pt' },
                attrs: { cx: { expr: '$item.x' }, cy: { expr: '$item.y' }, r: 2, fill: '#397ac4' },
              },
            ],
          },
          {
            id: 'extra-repeat',
            type: 'text',
            repeat: { itemsExpr: '$state.extraList', as: 'n' },
            content: { expr: 'concat("N=", $item)' },
          },
        ],
      },
    };

    const store = new RichStateStore(doc);
    const initialHeavy = store.getSnapshot().computed.heavySummary;
    const fastListener = vi.fn();
    const heavyListener = vi.fn();
    store.subscribeProjection(['computed:filteredScore'], fastListener);
    store.subscribeProjection(['computed:heavySummary', 'state:bigRows'], heavyListener);

    const t0 = performance.now();
    for (let i = 1; i <= 100; i++) {
      store.set('threshold', i);
    }
    const elapsedMs = performance.now() - t0;

    const snap = store.getSnapshot();
    expect(snap.computed.filteredScore).toBe(300);
    expect(snap.computed.heavySummary).toBe(initialHeavy);
    expect(fastListener).toHaveBeenCalledTimes(100);
    expect(heavyListener).not.toHaveBeenCalled();
    // Incremental engine only recomputed filteredScore and reused heavy untouched subtrees!
    expect(snap.stats.recomputedKeys).toEqual(['filteredScore']);
    expect(snap.stats.reusedSubtrees).toBeGreaterThanOrEqual(3);
    expect(snap.stats.expandedSvgElements).toBe(150);
    expect(elapsedMs).toBeLessThan(1500);

    // Dynamic limits are STILL strictly enforced atomically on subsequent mutations!
    expect(() => store.set('extraList', Array.from({ length: 2005 }, (_, i) => i))).toThrow();
    expect(store.getStateValue('extraList')).toEqual([1, 2, 3]);
  });
});
