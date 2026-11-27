import zlib from 'node:zlib';

export interface PdfPageSpec {
  width: number;
  height: number;
  label?: string;
  rotate?: 90 | 180 | 270;
}

/**
 * Builds a minimal, valid PDF 1.4 document with arbitrary page counts and
 * per-page MediaBox dimensions (portrait, landscape, 16:9 slides, etc.).
 * Parsed and rendered cleanly by pdfjs-dist without external fixture files.
 */
export function buildSyntheticPdf(pages: readonly PdfPageSpec[]): Buffer {
  const objects: string[] = [];
  const pageObjIds: number[] = [];

  // Object 1: Catalog, Object 2: Pages, Object 3: Helvetica Font
  objects.push(''); // placeholder for 1
  objects.push(''); // placeholder for 2
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); // 3

  for (let i = 0; i < pages.length; i += 1) {
    const spec = pages[i];
    const safeLabel = (spec.label ?? `Page ${i + 1}`).replace(/[()\\]/g, '');
    const streamContent = [
      '0.96 0.97 0.99 rg',
      `18 18 ${Math.max(10, spec.width - 36)} ${Math.max(10, spec.height - 36)} re f`,
      '0.15 0.25 0.45 RG 2 w',
      `24 24 ${Math.max(10, spec.width - 48)} ${Math.max(10, spec.height - 48)} re S`,
      '0.1 0.1 0.12 rg',
      'BT /F1 24 Tf',
      `48 ${Math.max(40, spec.height - 72)} Td`,
      `(${safeLabel}) Tj ET`,
    ].join('\n');

    const contentObjId = objects.length + 1;
    objects.push(`<< /Length ${Buffer.byteLength(streamContent, 'ascii')} >>\nstream\n${streamContent}\nendstream`);

    const pageObjId = objects.length + 1;
    pageObjIds.push(pageObjId);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${spec.width} ${spec.height}]${spec.rotate ? ` /Rotate ${spec.rotate}` : ''} /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjId} 0 R >>`
    );
  }

  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Count ${pageObjIds.length} /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] >>`;

  const chunks: string[] = ['%PDF-1.4\n'];
  const offsets: number[] = [0];
  let byteLen = Buffer.byteLength(chunks[0], 'ascii');

  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(byteLen);
    const body = `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    chunks.push(body);
    byteLen += Buffer.byteLength(body, 'ascii');
  }

  const xrefOffset = byteLen;
  chunks.push(`xref\n0 ${objects.length + 1}\n`);
  chunks.push('0000000000 65535 f \n');
  for (let i = 1; i <= objects.length; i += 1) {
    chunks.push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.from(chunks.join(''), 'ascii');
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Generates a valid RGB PNG image of exact dimensions for real browser viewer tests.
 */
export function buildSyntheticPng(width: number, height: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowOff = y * stride;
    raw[rowOff] = 0; // filter: None
    const isGridY = y % 80 < 2;
    for (let x = 0; x < width; x += 1) {
      const px = rowOff + 1 + x * 3;
      const isGridX = x % 80 < 2;
      if (isGridX || isGridY) {
        raw[px] = 45;
        raw[px + 1] = 95;
        raw[px + 2] = 180;
      } else {
        raw[px] = 236;
        raw[px + 1] = 242;
        raw[px + 2] = 250;
      }
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 1 });
  return Buffer.concat([
    sig,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function buildSyntheticSvg(width = 1200, height = 800): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `  <rect x="0" y="0" width="${width}" height="${height}" fill="#f8fafc" />`,
    `  <rect x="32" y="32" width="${width - 64}" height="${height - 64}" rx="16" fill="#ffffff" stroke="#2563eb" stroke-width="4" />`,
    `  <text x="${width / 2}" y="120" text-anchor="middle" font-family="sans-serif" font-size="36" fill="#0f172a">Architecture Diagram (${width}x${height})</text>`,
    `  <rect x="120" y="220" width="280" height="140" rx="12" fill="#dbeafe" stroke="#1d4ed8" stroke-width="2" />`,
    `  <rect x="460" y="220" width="280" height="140" rx="12" fill="#dcfce7" stroke="#15803d" stroke-width="2" />`,
    `  <rect x="800" y="220" width="280" height="140" rx="12" fill="#fef3c7" stroke="#b45309" stroke-width="2" />`,
    `</svg>`,
  ].join('\n');
}


/**
 * Builds a minimal, valid Office Open XML DOCX as a stored ZIP archive,
 * without external dependencies. Mammoth converts its paragraphs to HTML
 * so browser E2E tests exercise the real DOCX preview and text zoom.
 */
export function buildSyntheticDocx(): Buffer {
  const files: Array<[string, string]> = [
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        + '</Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        + '</Relationships>',
    ],
    [
      'word/document.xml',
      '<?xml version="1.0" encoding="UTF-8"?>'
        + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        + '<w:body>'
        + '<w:p><w:r><w:t>DOCX viewer zoom fixture</w:t></w:r></w:p>'
        + '<w:p><w:r><w:t>本文の文字サイズだけを拡大し、モーダルと操作UIの位置を維持する検査</w:t></w:r></w:p>'
        + '<w:p><w:r><w:t>Zoomed text must remain readable inside the document preview.</w:t></w:r></w:p>'
        + '<w:sectPr/>'
        + '</w:body></w:document>',
    ],
  ];

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const [filename, content] of files) {
    const name = Buffer.from(filename, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}
