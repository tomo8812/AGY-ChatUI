import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { zipSync, strToU8 } from 'fflate';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createTestServer } from './helpers/test-harness.js';
import { FormatAdapterRegistry } from '../src/artifacts/adapters/registry.js';
import {
  readDocxAllParagraphTargets,
  readPptxSlideTargets,
  readXlsxRangeTarget,
  readXlsxRowColTarget,
  readXlsxSheetTarget,
} from '../src/artifacts/adapters/ooxml-target.js';
import { inspectPdfDocument, computePdfRegionDigest, readPdfPageTarget } from '../src/artifacts/adapters/pdf-target.js';
import { sha256Hex } from '../../web/src/utils/sha256.js';
import { auditRegions, decodePng } from '../../e2e/helpers/visualAudit.js';
import { BlockRenderAccounting, addNode, expression } from '../../web/src/components/shared-ui/runtime.js';
import { RichStateStore } from '../../web/src/components/shared-ui/RichStateStore.js';
import type { RichDocumentV1 } from '../../shared/rich-schema.js';
import { gridAxisChanges, prepareGridOperations, savedGridOrigin } from '../../web/src/components/ArtifactWorkspace/gridDraft.js';
import type { DraftEntry } from '../../web/src/components/ArtifactWorkspace/types.js';


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

      for (const rectPt of ['[60,730,', '[60,"730",220,40]']) {
        await expect(server.ctx.artifactService.readRange(userId, created.artifact.id, {
          pageIndex: 0,
          rectPt,
          targetMetadata: 'true',
        })).rejects.toMatchObject({ code: 'INVALID_INPUT', statusCode: 400 });
      }

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

  it('Workstream 1 (Markdown & Code): readRange targetHashes returns exact occurrenceIndex and adapters enforce it on re-resolution', async () => {
    const server = await createTestServer({ installDocRuntime: 'off', sandboxMode: 'off', allowUnsandboxedDocWorkers: false });
    try {
      const userId = 'u-src';
      const chatId = 'c-src';
      const workspaceDir = fs.mkdtempSync(path.join(server.dataRoot, 'src-ws-'));
      server.ctx.db.createUser({ id: userId, username: 'u-src', displayName: 'SRC', passwordHash: 'x', role: 'user', profileDir: workspaceDir });
      server.ctx.db.createChat({ id: chatId, userId, projectId: null, title: 'SRC', workspaceDir, modelId: '', effortValue: '', projectContextVersion: 0 });

      const codeV1 = [
        'const header = true;',
        'return compute();',
        'const middleA = 1;',
        'const middleB = 2;',
        'return compute();',
        'const footer = true;',
      ].join('\n');
      const createdCode = await server.ctx.artifactService.createArtifact({
        userId, scopeKind: 'chat', chatId, relPath: 'app.ts', content: Buffer.from(codeV1, 'utf8'), actorKind: 'user', actorId: userId,
      });

      // Second occurrence is on line 5 -> occurrenceIndex must be 1, duplicateCount must be 2
      const hashes = await server.ctx.artifactService.readRange(userId, createdCode.artifact.id, {
        startLine: 5,
        endLine: 5,
        targetHashes: 'true',
      }) as {
        expectedSnippetHash: string;
        contextBeforeHash: string;
        contextAfterHash: string;
        occurrenceIndex: number;
        duplicateCount: number;
      };
      expect(hashes.occurrenceIndex).toBe(1);
      expect(hashes.duplicateCount).toBe(2);

      const codeAdapter = new FormatAdapterRegistry().resolve('app.ts', 'code');
      const codeMeta = { filename: 'app.ts', relPath: 'app.ts', mimeType: 'text/typescript' };

      // Missing occurrenceIndex on code_line_range MUST fail closed with needs_review
      const missingOcc = codeAdapter.resolveTarget(Buffer.from(codeV1, 'utf8'), {
        kind: 'code_line_range',
        startLine: 5,
        endLine: 5,
        expectedSnippetHash: hashes.expectedSnippetHash,
        contextBeforeHash: hashes.contextBeforeHash,
        contextAfterHash: hashes.contextAfterHash,
      }, codeMeta);
      expect(missingOcc.status).toBe('needs_review');
      expect(missingOcc.reason).toBe('missing_occurrence_index');

      // Exact selector with occurrenceIndex=1 resolves cleanly
      const validCodeRes = codeAdapter.resolveTarget(Buffer.from(codeV1, 'utf8'), {
        kind: 'code_line_range',
        startLine: 5,
        endLine: 5,
        expectedSnippetHash: hashes.expectedSnippetHash,
        contextBeforeHash: hashes.contextBeforeHash,
        contextAfterHash: hashes.contextAfterHash,
        occurrenceIndex: hashes.occurrenceIndex,
      }, codeMeta);
      expect(validCodeRes.status).toBe('resolved');

      // Inserting an extra identical line earlier shifts occurrenceIndex from 1 -> 2 => MUST return needs_review
      const codeInsertedDup = [
        'return compute();',
        'const header = true;',
        'return compute();',
        'const middleA = 1;',
        'const middleB = 2;',
        'return compute();',
        'const footer = true;',
      ].join('\n');
      const shiftedRes = codeAdapter.resolveTarget(Buffer.from(codeInsertedDup, 'utf8'), {
        kind: 'code_line_range',
        startLine: 5,
        endLine: 5,
        expectedSnippetHash: hashes.expectedSnippetHash,
        contextBeforeHash: hashes.contextBeforeHash,
        contextAfterHash: hashes.contextAfterHash,
        occurrenceIndex: hashes.occurrenceIndex,
      }, codeMeta);
      expect(shiftedRes.status).toBe('needs_review');
      expect(shiftedRes.reason).toBe('occurrence_index_changed');

      // Same contract for Markdown md_text_range
      const mdV1 = '# Title\n\nShared note\n\nSection A\n\nShared note\n\nEnd\n';
      const createdMd = await server.ctx.artifactService.createArtifact({
        userId, scopeKind: 'chat', chatId, relPath: 'doc.md', content: Buffer.from(mdV1, 'utf8'), actorKind: 'user', actorId: userId,
      });
      const mdHashes = await server.ctx.artifactService.readRange(userId, createdMd.artifact.id, {
        startLine: 7,
        endLine: 7,
        targetHashes: 'true',
      }) as {
        expectedSnippetHash: string;
        contextBeforeHash: string;
        contextAfterHash: string;
        occurrenceIndex: number;
      };
      expect(mdHashes.occurrenceIndex).toBe(1);
      const mdAdapter = new FormatAdapterRegistry().resolve('doc.md', 'markdown');
      const mdMeta = { filename: 'doc.md', relPath: 'doc.md', mimeType: 'text/markdown' };
      expect(mdAdapter.resolveTarget(Buffer.from(mdV1, 'utf8'), {
        kind: 'md_text_range',
        startLine: 7,
        endLine: 7,
        expectedSnippetHash: mdHashes.expectedSnippetHash,
        contextBeforeHash: mdHashes.contextBeforeHash,
        contextAfterHash: mdHashes.contextAfterHash,
      }, mdMeta).status).toBe('needs_review');
      expect(mdAdapter.resolveTarget(Buffer.from(mdV1, 'utf8'), {
        kind: 'md_text_range',
        startLine: 7,
        endLine: 7,
        expectedSnippetHash: mdHashes.expectedSnippetHash,
        contextBeforeHash: mdHashes.contextBeforeHash,
        contextAfterHash: mdHashes.contextAfterHash,
        occurrenceIndex: mdHashes.occurrenceIndex,
      }, mdMeta).status).toBe('resolved');
    } finally {
      await server.cleanup();
    }
  });

  it('Workstream 1 (DOCX, PDF text range & XLSX selectors): enforces optional blockIndex with paraId, pdf_text_range context/occurrence, and xlsx_row_col/xlsx_sheet/orderKeys', () => {
    const registry = new FormatAdapterRegistry();

    // 1. DOCX docx_paragraph with paraId and omitted blockIndex (Spec §5.2)
    const docxBuf = buildMinimalDocx([
      { text: 'Lead paragraph', paraId: '1111AAAA' },
      { text: 'Target paragraph', paraId: '2222BBBB' },
    ]);
    const docxTargets = readDocxAllParagraphTargets(docxBuf);
    const targetPara = docxTargets.paragraphs[1];
    const docxAdapter = registry.resolve('spec.docx', 'docx');
    const docxMeta = { filename: 'spec.docx', relPath: 'spec.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    const paraIdOnlyRes = docxAdapter.resolveTarget(docxBuf, {
      kind: 'docx_paragraph',
      paraId: targetPara.paraId,
      expectedBlockHash: targetPara.fingerprint,
    }, docxMeta);
    expect(paraIdOnlyRes.status).toBe('resolved');

    // 2. PDF pdf_text_range with contextBeforeHash, contextAfterHash & occurrenceIndex
    const pdfBuf = buildMinimalPdf([{ width: 600, height: 800, text: 'Alpha ITEM Beta ITEM Gamma' }]);
    const pdfDoc = inspectPdfDocument(pdfBuf);
    const page0 = pdfDoc.pages[0];
    const secondIdx = page0.text.lastIndexOf('ITEM');
    const slice = page0.text.slice(secondIdx, secondIdx + 4);
    const before = page0.text.slice(Math.max(0, secondIdx - 64), secondIdx);
    const after = page0.text.slice(secondIdx + 4, Math.min(page0.text.length, secondIdx + 4 + 64));
    const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
    const pdfAdapter = registry.resolve('text.pdf', 'pdf');
    const pdfMeta = { filename: 'text.pdf', relPath: 'text.pdf', mimeType: 'application/pdf' };

    expect(pdfAdapter.resolveTarget(pdfBuf, {
      kind: 'pdf_text_range',
      pageIndex: 0,
      expectedPageCount: 1,
      expectedPageContentHash: page0.pageContentHash,
      quadsPt: [[72, 70, 100, 70, 72, 90, 100, 90]],
      textOffsetStart: secondIdx,
      textOffsetEnd: secondIdx + 4,
      expectedSnippetHash: sha(slice),
      contextBeforeHash: sha(before),
      contextAfterHash: sha(after),
      occurrenceIndex: 1,
    }, pdfMeta).status).toBe('resolved');

    // Wrong occurrenceIndex -> needs_review
    expect(pdfAdapter.resolveTarget(pdfBuf, {
      kind: 'pdf_text_range',
      pageIndex: 0,
      expectedPageCount: 1,
      expectedPageContentHash: page0.pageContentHash,
      quadsPt: [[72, 70, 100, 70, 72, 90, 100, 90]],
      textOffsetStart: secondIdx,
      textOffsetEnd: secondIdx + 4,
      expectedSnippetHash: sha(slice),
      contextBeforeHash: sha(before),
      contextAfterHash: sha(after),
      occurrenceIndex: 0,
    }, pdfMeta).status).toBe('needs_review');

    // 3. XLSX expectedOrderKeysHash, xlsx_row_col, and xlsx_sheet
    const xlsxBuf = buildMinimalXlsx({
      sharedStrings: ['Alpha', 'Beta'],
      sheets: [{
        name: 'Data',
        rows: [
          { r: 1, cells: [{ ref: 'A1', v: 0, sharedString: true }, { ref: 'B1', v: 10 }] },
          { r: 2, cells: [{ ref: 'A2', v: 1, sharedString: true }, { ref: 'B2', v: 20 }] },
        ],
      }],
    });
    const xlsxAdapter = registry.resolve('data.xlsx', 'table');
    const xlsxMeta = { filename: 'data.xlsx', relPath: 'data.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    const rangeTarget = readXlsxRangeTarget(xlsxBuf, '1', 'A1:B2')!;
    expect(xlsxAdapter.resolveTarget(xlsxBuf, {
      kind: 'xlsx_range',
      sheetId: '1',
      rangeA1: 'A1:B2',
      expectedSheetStructHash: rangeTarget.expectedSheetStructHash,
      expectedRangeValuesHash: rangeTarget.expectedRangeValuesHash,
      expectedOrderKeysHash: rangeTarget.expectedOrderKeysHash,
    }, xlsxMeta).status).toBe('resolved');
    expect(xlsxAdapter.resolveTarget(xlsxBuf, {
      kind: 'xlsx_range',
      sheetId: '1',
      rangeA1: 'A1:B2',
      expectedSheetStructHash: rangeTarget.expectedSheetStructHash,
      expectedRangeValuesHash: rangeTarget.expectedRangeValuesHash,
      expectedOrderKeysHash: '0'.repeat(64),
    }, xlsxMeta).status).toBe('needs_review');

    const rowTarget = readXlsxRowColTarget(xlsxBuf, '1', 'row', 0)!;
    expect(xlsxAdapter.resolveTarget(xlsxBuf, {
      kind: 'xlsx_row_col',
      sheetId: '1',
      axis: 'row',
      index: 0,
      expectedSheetStructHash: rowTarget.expectedSheetStructHash,
      expectedSliceHash: rowTarget.expectedSliceHash,
    }, xlsxMeta).status).toBe('resolved');

    const sheetTarget = readXlsxSheetTarget(xlsxBuf, '1')!;
    expect(xlsxAdapter.resolveTarget(xlsxBuf, {
      kind: 'xlsx_sheet',
      sheetId: '1',
      expectedSheetStructHash: sheetTarget.expectedSheetStructHash,
      expectedSheetContentHash: sheetTarget.expectedSheetContentHash,
    }, xlsxMeta).status).toBe('resolved');
  });

  it('Workstream 5 (PERF-03 & Multi-Block Isolation): normal chat entry has zero static imports of heavy workspace/rich/editor packages, and multiple Rich blocks isolate updates cleanly', () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const webSrc = path.join(repoRoot, 'web/src');
    const visited = new Set<string>();
    const staticPackages = new Set<string>();

    const walkStatic = (absFile: string) => {
      if (visited.has(absFile) || !fs.existsSync(absFile)) return;
      visited.add(absFile);
      const source = fs.readFileSync(absFile, 'utf8');
      const sf = ts.createSourceFile(absFile, source, ts.ScriptTarget.Latest, true, absFile.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
          const bindings = node.importClause?.namedBindings;
          const allTypeOnly = !node.importClause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly);
          if (!allTypeOnly) {
            const spec = node.moduleSpecifier.text;
            if (spec.startsWith('.')) {
              const base = path.resolve(path.dirname(absFile), spec.replace(/\.js$/, ''));
              for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
                if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
                  walkStatic(cand);
                  break;
                }
              }
            } else {
              staticPackages.add(spec);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    };

    walkStatic(path.join(webSrc, 'main.tsx'));
    const relVisited = [...visited].map((f) => path.relative(repoRoot, f).split(path.sep).join('/'));

    // Normal chat entry must NOT statically load ArtifactWorkspace, RichRenderer, or heavy editor/chart/PDF libraries
    expect(relVisited.some((f) => f.includes('ArtifactWorkspace'))).toBe(false);
    expect(relVisited.some((f) => f.includes('RichRenderer'))).toBe(false);
    for (const forbiddenPkg of ['d3', 'dagre', '@tiptap/react', '@codemirror/view', 'pdfjs-dist', '@tanstack/react-virtual']) {
      expect([...staticPackages].some((p) => p === forbiddenPkg || p.startsWith(`${forbiddenPkg}/`))).toBe(false);
    }

    // Multiple Rich blocks operating concurrently isolate state updates & budgets
    const makeBlock = (seed: number): RichDocumentV1 => ({
      schemaVersion: 1,
      state: { slider: seed, data: Array.from({ length: 100 }, (_, i) => ({ v: i + seed })) },
      computed: {
        active: '$state.slider * 2',
        total: 'sum(pluck($state.data, "v"))',
      },
      root: {
        id: `root-${seed}`,
        type: 'stack',
        direction: 'col',
        children: [
          { id: `kpi-a-${seed}`, type: 'kpi_card', label: 'Active', value: { expr: '$computed.active' } },
          { id: `kpi-b-${seed}`, type: 'kpi_card', label: 'Total', value: { expr: '$computed.total' } },
        ],
      },
    });
    const stores = [new RichStateStore(makeBlock(1)), new RichStateStore(makeBlock(2)), new RichStateStore(makeBlock(3))];
    const listeners = stores.map((s) => {
      const fn = vi.fn();
      s.subscribeProjection(['computed:active'], fn);
      return fn;
    });
    for (let i = 2; i <= 51; i++) stores[0].set('slider', i);
    expect(listeners[0]).toHaveBeenCalledTimes(50);
    expect(listeners[1]).not.toHaveBeenCalled();
    expect(listeners[2]).not.toHaveBeenCalled();
  });
});

describe('PR 3A target identity and large inputs', () => {
  const registry = new FormatAdapterRegistry();
  const meta = { filename: 'target', relPath: 'target', mimeType: 'application/octet-stream' };
  const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

  it('rejects duplicate Markdown, code and DOCX targets with identical surrounding context', () => {
    const lines = ['lead 1', 'lead 2', 'target', 'after 1', 'after 2'];
    const text = ['title', ...lines, 'separator', ...lines, 'end'].join('\n');
    for (const [filename, format, kind] of [
      ['target.md', 'markdown', 'md_text_range'],
      ['target.ts', 'code', 'code_line_range'],
    ] as const) {
      const adapter = registry.resolve(filename, format);
      const selector = {
        kind, startLine: 4, endLine: 4, expectedSnippetHash: sha('target'),
        contextBeforeHash: sha('lead 1\nlead 2'), contextAfterHash: sha('after 1\nafter 2'), occurrenceIndex: 0,
      };
      expect(adapter.resolveTarget(Buffer.from(text), selector, meta)).toMatchObject({
        status: 'needs_review', reason: 'ambiguous_multiple_matches',
      });
      expect(adapter.resolveTarget(Buffer.from(text), { ...selector, contextAfterHash: undefined }, meta)).toMatchObject({
        status: 'needs_review', reason: 'invalid_context_hash',
      });
    }
    const docx = buildMinimalDocx(text.split('\n').map(text => ({ text })));
    const target = readDocxAllParagraphTargets(docx).byBlockIndex.get(3)!;
    expect(registry.resolve('target.docx', 'docx').resolveTarget(docx, {
      kind: 'docx_paragraph', ...target, expectedBlockHash: target.fingerprint,
    }, meta)).toMatchObject({ status: 'needs_review', reason: 'ambiguous_duplicate_paragraph' });
  });

  it('detects PPTX theme drift through the slide layout and master', () => {
    const p = 'http://schemas.openxmlformats.org/presentationml/2006/main';
    const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const packageRel = 'http://schemas.openxmlformats.org/package/2006/relationships';
    const rel = (type: string, target: string) =>
      `<Relationships xmlns="${packageRel}"><Relationship Id="rId1" Type="${r}/${type}" Target="${target}"/></Relationships>`;
    const build = (color: string) => Buffer.from(zipSync(Object.fromEntries(Object.entries({
      'ppt/presentation.xml': `<p:presentation xmlns:p="${p}" xmlns:r="${r}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
      'ppt/_rels/presentation.xml.rels': rel('slide', 'slides/slide1.xml'),
      'ppt/slides/slide1.xml': `<p:sld xmlns:p="${p}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="4"/></p:nvSpPr></p:sp></p:spTree></p:cSld></p:sld>`,
      'ppt/slides/_rels/slide1.xml.rels': rel('slideLayout', '../slideLayouts/slideLayout1.xml'),
      'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout xmlns:p="${p}"/>`,
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rel('slideMaster', '../slideMasters/slideMaster1.xml'),
      'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster xmlns:p="${p}"/>`,
      'ppt/slideMasters/_rels/slideMaster1.xml.rels': rel('theme', '../theme/theme1.xml'),
      'ppt/theme/theme1.xml': `<theme><accent val="${color}"/></theme>`,
    }).map(([name, xml]) => [name, strToU8(xml)]))));
    const before = build('001122');
    const selected = readPptxSlideTargets(before, 'ppt/slides/slide1.xml');
    const adapter = registry.resolve('target.pptx', 'pptx');
    const selector = { kind: 'pptx_element', slideId: selected.slideId, shapeId: '4', expectedElementFingerprint: selected.shapes[0].fingerprint };
    expect(adapter.resolveTarget(before, selector, meta).status).toBe('resolved');
    expect(adapter.resolveTarget(build('998877'), selector, meta).status).toBe('needs_review');
  });

  it('hashes a sparse selection across the entire XLSX grid and detects a far-corner change', () => {
    const build = (v: number) => buildMinimalXlsx({ sheets: [{ name: 'Data', rows: [
      { r: 1, cells: [{ ref: 'A1', v: 1 }] },
      { r: 1_048_576, cells: [{ ref: 'XFD1048576', v }] },
    ] }] });
    const fullSheet = 'A1:XFD1048576';
    const before = readXlsxRangeTarget(build(2), '1', fullSheet)!;
    const after = readXlsxRangeTarget(build(3), '1', fullSheet)!;
    expect(before.cells.map(cell => cell.address)).toEqual(['A1', 'XFD1048576']);
    expect(before.expectedSheetStructHash).toBe(after.expectedSheetStructHash);
    expect(before.expectedRangeValuesHash).not.toBe(after.expectedRangeValuesHash);
  });

  it('counts a deep, large PDF tree completely and only inspects the selected page', () => {
    const pageCount = 20_001;
    const depth = 75;
    const firstPage = depth + 2;
    const build = (lastKid: string, count = pageCount) => Buffer.from([
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      ...Array.from({ length: depth }, (_, index) => {
        const id = index + 2;
        const kids = index === depth - 1
          ? Array.from({ length: pageCount }, (_, n) => n === pageCount - 1 ? lastKid : `${firstPage + n} 0 R`).join(' ')
          : `${id + 1} 0 R`;
        return `${id} 0 obj << /Type /Pages /Count ${count} /Kids [${kids}] /MediaBox [0 0 300 400] >> endobj`;
      }),
      ...Array.from({ length: pageCount }, (_, n) =>
        `${firstPage + n} 0 obj << /Type /Page${n === 0 ? '' : ' /Contents 50000 0 R'} >> endobj`),
      'trailer << /Root 1 0 R >>',
      '%%EOF',
    ].join('\n'));
    const doc = build(`${firstPage + pageCount - 1} 0 R`);
    const target = readPdfPageTarget(doc, 0);
    expect(target).toMatchObject({ pageIndex: 0, pageCount, widthPt: 300 });
    expect(readPdfPageTarget(doc, 1)).toBeNull();
    expect(readPdfPageTarget(build('60000 0 R'), 0)).toBeNull();
    expect(readPdfPageTarget(build(`${firstPage + pageCount - 1} 0 R`, pageCount - 1), 0)).toBeNull();
    expect(registry.resolve('target.pdf', 'pdf').resolveTarget(build('2 0 R'), {
      kind: 'pdf_page', pageIndex: 0, expectedPageCount: pageCount, expectedPageContentHash: target!.pageContentHash,
    }, meta).status).toBe('needs_review');
  });
});

it('keeps cell edits mapped to the saved and inserted coordinates through structural changes', () => {
  const insertRow: DraftEntry = {
    key: 'grid-structure:1', label: 'Insert row', operation: { op: 'insert_row', index: 0, values: ['', ''] },
  };
  const rowChanges = gridAxisChanges([insertRow], 'csv', 'row');
  const inserted = savedGridOrigin(0, rowChanges);
  const original = savedGridOrigin(1, rowChanges);
  const insertColumn: DraftEntry = {
    key: 'grid-structure:2', label: 'Insert column', operation: { op: 'insert_col', index: 0 },
  };
  const entries: DraftEntry[] = [
    insertRow,
    {
      key: 'inserted', label: 'New row',
      operation: { op: 'set_cell', value: 'New row' },
      gridLocation: { sheetId: 'csv', row: inserted, col: { index: 0 }, after: insertRow.key },
    },
    insertColumn,
    {
      key: 'existing', label: 'Original row',
      operation: { op: 'set_cell', value: 'Original row' },
      gridLocation: { sheetId: 'csv', row: original, col: { index: 0 }, after: insertColumn.key },
    },
  ];
  expect(prepareGridOperations(entries)).toEqual([
    insertRow.operation,
    { op: 'set_cell', row: 0, col: 0, value: 'New row' },
    insertColumn.operation,
    { op: 'set_cell', row: 1, col: 1, value: 'Original row' },
  ]);
  expect(prepareGridOperations(entries.filter(entry => entry !== insertColumn)).at(-1)).toEqual(
    { op: 'set_cell', row: 1, col: 0, value: 'Original row' },
  );
});

it('binds edits on a new worksheet to the sheet created earlier in the same draft', () => {
  const sheet = 'grid-structure:1';
  const entries: DraftEntry[] = [
    { key: sheet, label: 'New sheet', operation: { op: 'xlsx.add_sheet', name: 'New sheet' } },
    {
      key: sheet + ':A1', label: 'Cell A1',
      operation: { op: 'xlsx.set_cell', address: 'A1', value: 'Draft value' },
      gridLocation: { sheetId: sheet, row: { index: 0 }, col: { index: 0 }, after: sheet },
    },
  ];
  expect(prepareGridOperations(entries)).toEqual([
    { op: 'xlsx.add_sheet', name: 'New sheet', draftSheetKey: sheet },
    { op: 'xlsx.set_cell', address: 'A1', value: 'Draft value', draftSheetKey: sheet },
  ]);
});
