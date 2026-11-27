import crypto from 'node:crypto';
import zlib from 'node:zlib';

export interface PdfAnnotationTarget {
  uid: string;
  subtype: string;
  rect: [number, number, number, number] | null;
  contents: string;
  fingerprint: string;
}

export interface PdfPositionedItem {
  kind: 'text' | 'rect' | 'xobj';
  x: number;
  y: number;
  w: number;
  h: number;
  value: string;
}

export interface PdfPageTargetInfo {
  pageIndex: number;
  pageCount: number;
  mediaBox: [number, number, number, number];
  cropBox: [number, number, number, number];
  rotate: number;
  userUnit: number;
  widthPt: number;
  heightPt: number;
  pageContentHash: string;
  text: string;
  items: PdfPositionedItem[];
  annotations: PdfAnnotationTarget[];
}

export interface PdfDocumentTargets {
  pageCount: number;
  pages: PdfPageTargetInfo[];
}

interface PdfRef {
  __ref: true;
  obj: number;
  gen: number;
}

interface PdfDict {
  [key: string]: PdfVal;
}

interface PdfStream {
  __stream: true;
  dict: PdfDict;
  rawBytes: Buffer;
}

type PdfVal =
  | null
  | boolean
  | number
  | string
  | PdfRef
  | PdfStream
  | PdfVal[]
  | PdfDict;

// Bound expansion across the selected page and its object streams, including intermediate filter output.
const PDF_EXPANSION_BUDGET_BYTES = 200 * 1024 * 1024;

function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isRef(v: PdfVal | undefined): v is PdfRef {
  return Boolean(v && typeof v === 'object' && '__ref' in v);
}

function isStream(v: PdfVal | undefined): v is PdfStream {
  return Boolean(v && typeof v === 'object' && '__stream' in v);
}

function isDict(v: PdfVal | undefined): v is Record<string, PdfVal> {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v) && !('__ref' in v) && !('__stream' in v));
}

function isWhitespace(b: number): boolean {
  return b === 0x00 || b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b === 0x20;
}

function isDelimiter(b: number): boolean {
  return (
    b === 0x28 || b === 0x29 || // ( )
    b === 0x3c || b === 0x3e || // < >
    b === 0x5b || b === 0x5d || // [ ]
    b === 0x7b || b === 0x7d || // { }
    b === 0x2f || b === 0x25    // / %
  );
}

class PdfTokenizer {
  pos: number;
  readonly end: number;

  constructor(readonly buf: Buffer, start = 0, end = buf.length) {
    this.pos = start;
    this.end = end;
  }

  skipWs(): void {
    while (this.pos < this.end) {
      const b = this.buf[this.pos];
      if (isWhitespace(b)) {
        this.pos++;
      } else if (b === 0x25) {
        // % comment until EOL
        this.pos++;
        while (this.pos < this.end && this.buf[this.pos] !== 0x0a && this.buf[this.pos] !== 0x0d) {
          this.pos++;
        }
      } else {
        break;
      }
    }
  }

  readName(): string {
    // Assumes current byte is '/'
    this.pos++;
    const start = this.pos;
    while (this.pos < this.end && !isWhitespace(this.buf[this.pos]) && !isDelimiter(this.buf[this.pos])) {
      this.pos++;
    }
    const raw = this.buf.subarray(start, this.pos).toString('latin1');
    return '/' + raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }

  readLiteralString(): string {
    // Assumes current byte is '('
    this.pos++;
    let depth = 1;
    const bytes: number[] = [];
    while (this.pos < this.end && depth > 0) {
      const b = this.buf[this.pos++];
      if (b === 0x5c) {
        // backslash escape
        if (this.pos >= this.end) break;
        const next = this.buf[this.pos++];
        if (next === 0x6e) bytes.push(0x0a);
        else if (next === 0x72) bytes.push(0x0d);
        else if (next === 0x74) bytes.push(0x09);
        else if (next === 0x62) bytes.push(0x08);
        else if (next === 0x66) bytes.push(0x0c);
        else if (next === 0x0d) {
          if (this.pos < this.end && this.buf[this.pos] === 0x0a) this.pos++;
        } else if (next === 0x0a) {
          // line continuation
        } else if (next >= 0x30 && next <= 0x37) {
          let oct = String.fromCharCode(next);
          for (let i = 0; i < 2 && this.pos < this.end; i++) {
            const c = this.buf[this.pos];
            if (c >= 0x30 && c <= 0x37) {
              oct += String.fromCharCode(c);
              this.pos++;
            } else break;
          }
          bytes.push(parseInt(oct, 8) & 0xff);
        } else {
          bytes.push(next);
        }
      } else if (b === 0x28) {
        depth++;
        bytes.push(b);
      } else if (b === 0x29) {
        depth--;
        if (depth > 0) bytes.push(b);
      } else {
        bytes.push(b);
      }
    }
    return decodePdfStringBytes(Buffer.from(bytes));
  }

  readHexString(): string {
    // Assumes current byte is '<' (and not '<<')
    this.pos++;
    let hex = '';
    while (this.pos < this.end) {
      const b = this.buf[this.pos++];
      if (b === 0x3e) break;
      if (!isWhitespace(b)) hex += String.fromCharCode(b);
    }
    if (hex.length % 2 === 1) hex += '0';
    const bytes = Buffer.alloc(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
    }
    return decodePdfStringBytes(bytes);
  }

  readWord(): string {
    const start = this.pos;
    while (this.pos < this.end && !isWhitespace(this.buf[this.pos]) && !isDelimiter(this.buf[this.pos])) {
      this.pos++;
    }
    return this.buf.subarray(start, this.pos).toString('latin1');
  }

  readValue(depth = 0): PdfVal | undefined {
    if (depth > 48) throw new Error('PDF object nesting exceeds the parser budget');
    this.skipWs();
    if (this.pos >= this.end) return undefined;
    const b = this.buf[this.pos];
    if (b === 0x2f) return this.readName();
    if (b === 0x28) return this.readLiteralString();
    if (b === 0x3c) {
      if (this.pos + 1 < this.end && this.buf[this.pos + 1] === 0x3c) {
        return this.readDict(depth + 1);
      }
      return this.readHexString();
    }
    if (b === 0x5b) {
      return this.readArray(depth + 1);
    }
    if (b === 0x3e || b === 0x5d) {
      return undefined;
    }
    const save = this.pos;
    const word = this.readWord();
    if (!word) return undefined;
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) {
      const num = Number(word);
      // Lookahead for indirect ref: N G R
      if (Number.isInteger(num) && num >= 0) {
        const afterFirst = this.pos;
        this.skipWs();
        const genWord = this.readWord();
        if (/^\d+$/.test(genWord)) {
          this.skipWs();
          const rWord = this.readWord();
          if (rWord === 'R') {
            return { __ref: true, obj: num, gen: Number(genWord) };
          }
        }
        this.pos = afterFirst;
      }
      return num;
    }
    if (word === 'endobj' || word === 'endstream' || word === '>>') {
      this.pos = save;
      return undefined;
    }
    return word;
  }

  readArray(depth: number): PdfVal[] {
    this.pos++; // '['
    const arr: PdfVal[] = [];
    while (this.pos < this.end) {
      this.skipWs();
      if (this.buf[this.pos] === 0x5d) {
        this.pos++;
        return arr;
      }
      const val = this.readValue(depth);
      if (val === undefined) break;
      arr.push(val);
    }
    throw new Error('Unterminated PDF array');
  }

  readDict(depth: number): Record<string, PdfVal> {
    this.pos += 2; // '<<'
    const dict: Record<string, PdfVal> = {};
    while (this.pos < this.end) {
      this.skipWs();
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) {
        this.pos += 2;
        return dict;
      }
      if (this.buf[this.pos] !== 0x2f) break;
      const key = this.readName();
      const val = this.readValue(depth);
      if (val === undefined || Object.hasOwn(dict, key)) break;
      dict[key] = val;
    }
    throw new Error('Incomplete or ambiguous PDF dictionary');
  }
}

function decodePdfStringBytes(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // UTF-16BE BOM
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return out;
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le');
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8');
  }
  return bytes.toString('latin1');
}

function decodeAsciiHex(buf: Buffer): Buffer {
  let hex = '';
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === 0x3e) break;
    if (!isWhitespace(c)) hex += String.fromCharCode(c);
  }
  if (hex.length % 2 === 1) hex += '0';
  return Buffer.from(hex, 'hex');
}

function decodeAscii85(buf: Buffer): Buffer {
  const out: number[] = [];
  let group: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (isWhitespace(c)) continue;
    if (c === 0x7e && i + 1 < buf.length && buf[i + 1] === 0x3e) break; // ~>
    if (c === 0x7a && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 33 || c > 117) continue;
    group.push(c - 33);
    if (group.length === 5) {
      let val = 0;
      for (const d of group) val = val * 85 + d;
      out.push((val >>> 24) & 0xff, (val >>> 16) & 0xff, (val >>> 8) & 0xff, val & 0xff);
      group = [];
    }
  }
  if (group.length > 1) {
    const pad = 5 - group.length;
    for (let i = 0; i < pad; i++) group.push(84);
    let val = 0;
    for (const d of group) val = val * 85 + d;
    const full = [(val >>> 24) & 0xff, (val >>> 16) & 0xff, (val >>> 8) & 0xff, val & 0xff];
    for (let i = 0; i < 4 - pad; i++) out.push(full[i]);
  }
  return Buffer.from(out);
}

function applyPngPredictor(raw: Buffer, predictor: number, columns: number): Buffer {
  if (predictor < 10 || columns <= 0) return raw;
  const stride = columns + 1;
  const rows = Math.floor(raw.length / stride);
  const out = Buffer.alloc(rows * columns);
  let prev = Buffer.alloc(columns);
  for (let r = 0; r < rows; r++) {
    const rowOff = r * stride;
    const filter = raw[rowOff];
    const cur = Buffer.alloc(columns);
    for (let i = 0; i < columns; i++) {
      const x = raw[rowOff + 1 + i];
      const a = i > 0 ? cur[i - 1] : 0;
      const b = prev[i];
      const c = i > 0 ? prev[i - 1] : 0;
      if (filter === 0) cur[i] = x;
      else if (filter === 1) cur[i] = (x + a) & 0xff;
      else if (filter === 2) cur[i] = (x + b) & 0xff;
      else if (filter === 3) cur[i] = (x + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        cur[i] = (x + pr) & 0xff;
      } else {
        cur[i] = x;
      }
    }
    cur.copy(out, r * columns);
    prev = cur;
  }
  return out;
}

class PdfReader {
  readonly objects = new Map<number, PdfVal>();
  rootRef: PdfRef | null = null;
  private expansionRemaining = PDF_EXPANSION_BUDGET_BYTES;

  constructor(readonly buf: Buffer) {
    this.parseAllObjects();
    this.unpackObjectStreams();
    this.findRoot();
  }

  private parseAllObjects(): void {
    // Scan indirect objects: <obj> <gen> obj ... endobj (later definitions win for incremental updates).
    const text = this.buf.toString('latin1');
    const objRe = /(?:^|[\r\n\t\f\0 ])(\d+)\s+(\d+)\s+obj(?=[ \t\r\n\f\0<\[/(%])/g;
    let m: RegExpExecArray | null;
    while ((m = objRe.exec(text)) !== null) {
      const objNum = Number(m[1]);
      const bodyStart = m.index + m[0].length;
      const tok = new PdfTokenizer(this.buf, bodyStart, this.buf.length);
      const val = tok.readValue();
      if (val === undefined) continue;
      tok.skipWs();
      if (isDict(val) && this.buf.subarray(tok.pos, tok.pos + 6).toString('latin1') === 'stream') {
        let streamStart = tok.pos + 6;
        if (this.buf[streamStart] === 0x0d && this.buf[streamStart + 1] === 0x0a) streamStart += 2;
        else if (this.buf[streamStart] === 0x0a || this.buf[streamStart] === 0x0d) streamStart += 1;

        let streamEnd = -1;
        const lenVal = val['/Length'];
        if (typeof lenVal === 'number' && Number.isInteger(lenVal) && lenVal >= 0 && streamStart + lenVal <= this.buf.length) {
          const candidateEnd = streamStart + lenVal;
          // Verify endstream follows shortly after declared length
          const probe = this.buf.subarray(candidateEnd, Math.min(this.buf.length, candidateEnd + 32)).toString('latin1');
          if (/^\s*endstream/.test(probe)) {
            streamEnd = candidateEnd;
          }
        }
        if (streamEnd < 0) {
          streamEnd = this.buf.indexOf('endstream', streamStart, 'latin1');
          if (streamEnd >= streamStart) {
            if (streamEnd > streamStart && this.buf[streamEnd - 1] === 0x0a) streamEnd--;
            if (streamEnd > streamStart && this.buf[streamEnd - 1] === 0x0d) streamEnd--;
          }
        }
        if (streamEnd >= streamStart) {
          const streamObj: PdfStream = {
            __stream: true,
            dict: val,
            rawBytes: this.buf.subarray(streamStart, streamEnd),
          };
          this.objects.set(objNum, streamObj);
          // Advance regex past stream bytes so binary stream data isn't misread as objects
          const afterEndStream = this.buf.indexOf('endobj', streamEnd, 'latin1');
          if (afterEndStream > objRe.lastIndex) {
            objRe.lastIndex = afterEndStream + 6;
          }
          continue;
        }
      }
      this.objects.set(objNum, val);
    }
  }

  private unpackObjectStreams(): void {
    // Support PDF 1.5+ /Type /ObjStm compressed object streams
    const streams: PdfStream[] = [];
    for (const val of this.objects.values()) {
      if (isStream(val) && val.dict['/Type'] === '/ObjStm') {
        streams.push(val);
      }
    }
    for (const stm of streams) {
      const n = Number(this.resolve(stm.dict['/N']));
      const first = Number(this.resolve(stm.dict['/First']));
      if (!Number.isInteger(n) || n <= 0 || !Number.isInteger(first) || first < 0) continue;
      const decoded = this.decodeStream(stm);
      if (!decoded || first > decoded.length) continue;
      const header = decoded.subarray(0, first).toString('latin1').trim().split(/\s+/).map(Number);
      for (let i = 0; i < n && i * 2 + 1 < header.length; i++) {
        const objNum = header[i * 2];
        const relOff = header[i * 2 + 1];
        if (!Number.isInteger(objNum) || !Number.isInteger(relOff) || first + relOff >= decoded.length) continue;
        // Direct top-level objects override earlier ObjStm entries; only fill if missing
        if (this.objects.has(objNum)) continue;
        const nextOff = i + 1 < n && (i + 1) * 2 + 1 < header.length ? first + header[(i + 1) * 2 + 1] : decoded.length;
        const tok = new PdfTokenizer(decoded, first + relOff, Math.min(decoded.length, nextOff));
        const val = tok.readValue();
        if (val !== undefined) this.objects.set(objNum, val);
      }
    }
  }

  private findRoot(): void {
    // 1. Check classic trailers from end of file backwards
    let idx = this.buf.lastIndexOf('trailer');
    while (idx >= 0) {
      const tok = new PdfTokenizer(this.buf, idx + 7, this.buf.length);
      const val = tok.readValue();
      if (isDict(val) && isRef(val['/Root'])) {
        if (val['/Encrypt']) throw new Error('Encrypted PDF');
        this.rootRef = val['/Root'];
        return;
      }
      idx = idx > 0 ? this.buf.lastIndexOf('trailer', idx - 1) : -1;
    }
    // 2. Check /Type /XRef stream dicts (PDF 1.5+ cross-reference streams)
    for (const val of this.objects.values()) {
      if (isStream(val) && val.dict['/Type'] === '/XRef' && isRef(val.dict['/Root'])) {
        if (val.dict['/Encrypt']) throw new Error('Encrypted PDF');
        this.rootRef = val.dict['/Root'];
      }
    }
    if (this.rootRef) return;
    // 3. Fallback: look for /Type /Catalog directly
    for (const [objNum, val] of this.objects.entries()) {
      if (isDict(val) && val['/Type'] === '/Catalog') {
        this.rootRef = { __ref: true, obj: objNum, gen: 0 };
        return;
      }
    }
  }

  resolve(value: PdfVal | undefined): PdfVal | undefined {
    if (!isRef(value)) return value;
    const seen = new Set<number>();
    while (isRef(value)) {
      if (seen.has(value.obj)) throw new Error('Cyclic PDF reference');
      seen.add(value.obj);
      value = this.objects.get(value.obj);
    }
    return value;
  }

  decodeStream(stm: PdfStream): Buffer | null {
    const rawFilter = this.resolve(stm.dict['/Filter']);
    const filters: string[] = Array.isArray(rawFilter)
      ? rawFilter.map((f) => String(this.resolve(f) ?? ''))
      : typeof rawFilter === 'string'
        ? [rawFilter]
        : [];
    const rawParms = this.resolve(stm.dict['/DecodeParms']);
    const parmsList: Array<Record<string, PdfVal> | null> = Array.isArray(rawParms)
      ? rawParms.map((p) => {
          const rp = this.resolve(p);
          return isDict(rp) ? rp : null;
        })
      : isDict(rawParms)
        ? [rawParms]
        : [];

    let data: Buffer = stm.rawBytes;
    for (let i = 0; i < filters.length; i++) {
      if (this.expansionRemaining < 1) return null;
      const f = filters[i];
      if (f === '/FlateDecode' || f === '/Fl') {
        try {
          data = zlib.inflateSync(data, { maxOutputLength: this.expansionRemaining });
        } catch {
          try {
            data = zlib.inflateRawSync(data, { maxOutputLength: this.expansionRemaining });
          } catch {
            return null;
          }
        }
        const parms = parmsList[i];
        if (parms) {
          const predictor = Number(this.resolve(parms['/Predictor']) ?? 1);
          const columns = Number(this.resolve(parms['/Columns']) ?? 1);
          if (predictor >= 10) {
            data = applyPngPredictor(data, predictor, columns);
          }
        }
      } else if (f === '/ASCIIHexDecode' || f === '/AHx') {
        data = decodeAsciiHex(data);
      } else if (f === '/ASCII85Decode' || f === '/A85') {
        data = decodeAscii85(data);
      } else {
        return null;
      }
      this.expansionRemaining -= data.length;
      if (this.expansionRemaining < 0) return null;
    }
    return data;
  }

  hashPageDependency(value: PdfVal | undefined, active = new Set<number>(), memo = new Map<number, string>()): string {
    if (isRef(value)) {
      if (active.has(value.obj)) return sha256(JSON.stringify(['cycle', value.obj, value.gen]));
      const cached = memo.get(value.obj);
      if (cached) return cached;
      const object = this.objects.get(value.obj);
      if (object === undefined) throw new Error('Missing PDF dependency');
      active.add(value.obj);
      const fingerprint = this.hashPageDependency(object, active, memo);
      active.delete(value.obj);
      memo.set(value.obj, fingerprint);
      return fingerprint;
    }
    const hash = crypto.createHash('sha256');
    const dict = isStream(value) ? value.dict : isDict(value) ? value : undefined;
    if (dict) {
      hash.update(isStream(value) ? 'stream' : 'dict');
      for (const key of Object.keys(dict).sort()) {
        // The annotation page backlink is not part of its appearance.
        if (key === '/P') {
          const parent = this.resolve(dict[key]);
          if (isDict(parent) && parent['/Type'] === '/Page') continue;
        }
        if (isStream(value) && key === '/Length') continue;
        hash.update(JSON.stringify(key)).update(this.hashPageDependency(dict[key], active, memo));
      }
      if (isStream(value)) hash.update(value.rawBytes);
    } else if (Array.isArray(value)) {
      hash.update('array');
      for (const item of value) hash.update(this.hashPageDependency(item, active, memo));
    } else {
      hash.update(JSON.stringify(value ?? null));
    }
    return hash.digest('hex');
  }
}

function parseBox(val: PdfVal | undefined, reader: PdfReader): [number, number, number, number] | null {
  const arr = reader.resolve(val);
  if (!Array.isArray(arr) || arr.length !== 4) return null;
  const nums = arr.map((v) => Number(reader.resolve(v)));
  if (!nums.every((n) => Number.isFinite(n))) return null;
  const x0 = Math.min(nums[0], nums[2]);
  const y0 = Math.min(nums[1], nums[3]);
  const x1 = Math.max(nums[0], nums[2]);
  const y1 = Math.max(nums[1], nums[3]);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

function normalizeRotate(val: PdfVal | undefined, reader: PdfReader): number {
  const raw = Number(reader.resolve(val) ?? 0);
  if (!Number.isFinite(raw) || raw % 90 !== 0) return 0;
  const norm = (raw % 360 + 360) % 360;
  return norm === 90 || norm === 180 || norm === 270 ? norm : 0;
}

/**
 * Transform PDF user-space point (x, y) into top-left visual page coordinates (vx, vy)
 * matching PDF.js viewport / Page pt coordinates.
 */
function pdfPointToVisualPt(
  px: number,
  py: number,
  cropBox: [number, number, number, number],
  rotate: number,
  userUnit: number,
): [number, number] {
  const [cx0, cy0, cx1, cy1] = cropBox;
  const w = cx1 - cx0;
  const h = cy1 - cy0;
  const rx = px - cx0;
  const ry = py - cy0;
  let vx: number;
  let vy: number;
  if (rotate === 90) {
    vx = ry;
    vy = rx;
  } else if (rotate === 180) {
    vx = w - rx;
    vy = ry;
  } else if (rotate === 270) {
    vx = h - ry;
    vy = w - rx;
  } else {
    vx = rx;
    vy = h - ry;
  }
  return [round2(vx * userUnit), round2(vy * userUnit)];
}

function extractContentItems(
  contentBytes: Buffer,
  cropBox: [number, number, number, number],
  rotate: number,
  userUnit: number,
): { text: string; items: PdfPositionedItem[] } {
  const tok = new PdfTokenizer(contentBytes, 0, contentBytes.length);
  const stack: PdfVal[] = [];
  const textParts: string[] = [];
  const items: PdfPositionedItem[] = [];

  // Track simple CTM + text matrix (e, f translation + scale)
  type Mat = [number, number, number, number, number, number];
  const mul = (m1: Mat, m2: Mat): Mat => [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
  let ctm: Mat = [1, 0, 0, 1, 0, 0];
  const ctmStack: Mat[] = [];
  let tm: Mat = [1, 0, 0, 1, 0, 0];
  let tlm: Mat = [1, 0, 0, 1, 0, 0];
  let leading = 12;
  let fontSize = 12;

  const pushText = (str: string) => {
    if (!str) return;
    textParts.push(str);
    const comb = mul(ctm, tm);
    const [vx, vy] = pdfPointToVisualPt(comb[4], comb[5], cropBox, rotate, userUnit);
    const estH = Math.max(4, Math.abs(fontSize * Math.hypot(comb[2], comb[3])) * userUnit);
    const estW = Math.max(4, str.length * estH * 0.55);
    items.push({
      kind: 'text',
      x: round2(vx),
      y: round2(Math.max(0, vy - estH)),
      w: round2(estW),
      h: round2(estH),
      value: str,
    });
  };

  while (tok.pos < tok.end) {
    tok.skipWs();
    if (tok.pos >= tok.end) break;
    const b = tok.buf[tok.pos];
    if (b === 0x2f || b === 0x28 || b === 0x3c || b === 0x5b) {
      const val = tok.readValue();
      if (val !== undefined) stack.push(val);
      continue;
    }
    if (b === 0x3e || b === 0x5d) {
      tok.pos++;
      continue;
    }
    const word = tok.readWord();
    if (!word) {
      tok.pos++;
      continue;
    }
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) {
      stack.push(Number(word));
      continue;
    }
    // Operator
    if (word === 'q') {
      ctmStack.push([...ctm]);
    } else if (word === 'Q') {
      const prev = ctmStack.pop();
      if (prev) ctm = prev;
    } else if (word === 'cm' && stack.length >= 6) {
      const [a, bb, c, d, e, f] = stack.slice(-6).map(Number);
      if ([a, bb, c, d, e, f].every(Number.isFinite)) {
        ctm = mul(ctm, [a, bb, c, d, e, f]);
      }
    } else if (word === 'BT') {
      tm = [1, 0, 0, 1, 0, 0];
      tlm = [1, 0, 0, 1, 0, 0];
    } else if (word === 'Tf' && stack.length >= 2) {
      const sz = Number(stack[stack.length - 1]);
      if (Number.isFinite(sz) && sz > 0) fontSize = sz;
    } else if (word === 'TL' && stack.length >= 1) {
      const tl = Number(stack[stack.length - 1]);
      if (Number.isFinite(tl)) leading = tl;
    } else if (word === 'Tm' && stack.length >= 6) {
      const [a, bb, c, d, e, f] = stack.slice(-6).map(Number);
      if ([a, bb, c, d, e, f].every(Number.isFinite)) {
        tm = [a, bb, c, d, e, f];
        tlm = [...tm];
      }
    } else if ((word === 'Td' || word === 'TD') && stack.length >= 2) {
      const tx = Number(stack[stack.length - 2]);
      const ty = Number(stack[stack.length - 1]);
      if (Number.isFinite(tx) && Number.isFinite(ty)) {
        if (word === 'TD') leading = -ty;
        tlm = mul(tlm, [1, 0, 0, 1, tx, ty]);
        tm = [...tlm];
      }
    } else if (word === 'T*') {
      tlm = mul(tlm, [1, 0, 0, 1, 0, -leading]);
      tm = [...tlm];
    } else if (word === 'Tj' && stack.length >= 1) {
      const s = stack[stack.length - 1];
      if (typeof s === 'string') pushText(s);
    } else if (word === "'" && stack.length >= 1) {
      tlm = mul(tlm, [1, 0, 0, 1, 0, -leading]);
      tm = [...tlm];
      const s = stack[stack.length - 1];
      if (typeof s === 'string') pushText(s);
    } else if (word === '"' && stack.length >= 3) {
      tlm = mul(tlm, [1, 0, 0, 1, 0, -leading]);
      tm = [...tlm];
      const s = stack[stack.length - 1];
      if (typeof s === 'string') pushText(s);
    } else if (word === 'TJ' && stack.length >= 1) {
      const arr = stack[stack.length - 1];
      if (Array.isArray(arr)) {
        const joined = arr.filter((v): v is string => typeof v === 'string').join('');
        pushText(joined);
      }
    } else if (word === 're' && stack.length >= 4) {
      const [rx, ry, rw, rh] = stack.slice(-4).map(Number);
      if ([rx, ry, rw, rh].every(Number.isFinite)) {
        const p1 = pdfPointToVisualPt(
          ctm[0] * rx + ctm[2] * ry + ctm[4],
          ctm[1] * rx + ctm[3] * ry + ctm[5],
          cropBox, rotate, userUnit,
        );
        const p2 = pdfPointToVisualPt(
          ctm[0] * (rx + rw) + ctm[2] * (ry + rh) + ctm[4],
          ctm[1] * (rx + rw) + ctm[3] * (ry + rh) + ctm[5],
          cropBox, rotate, userUnit,
        );
        items.push({
          kind: 'rect',
          x: round2(Math.min(p1[0], p2[0])),
          y: round2(Math.min(p1[1], p2[1])),
          w: round2(Math.abs(p2[0] - p1[0])),
          h: round2(Math.abs(p2[1] - p1[1])),
          value: `re:${round2(rw)}x${round2(rh)}`,
        });
      }
    } else if (word === 'Do' && stack.length >= 1) {
      const name = String(stack[stack.length - 1] ?? '');
      const p1 = pdfPointToVisualPt(ctm[4], ctm[5], cropBox, rotate, userUnit);
      const p2 = pdfPointToVisualPt(ctm[0] + ctm[2] + ctm[4], ctm[1] + ctm[3] + ctm[5], cropBox, rotate, userUnit);
      items.push({
        kind: 'xobj',
        x: round2(Math.min(p1[0], p2[0])),
        y: round2(Math.min(p1[1], p2[1])),
        w: round2(Math.abs(p2[0] - p1[0])),
        h: round2(Math.abs(p2[1] - p1[1])),
        value: name,
      });
    } else if (word === 'BI') {
      // Inline image — skip until EI
      const eiIdx = contentBytes.indexOf('EI', tok.pos, 'latin1');
      if (eiIdx >= 0) tok.pos = eiIdx + 2;
    }
    stack.length = 0;
  }

  return { text: textParts.join(' ').replace(/\s+/g, ' ').trim(), items };
}

export function inspectPdfDocument(buffer: Buffer, targetPageIndex?: number): PdfDocumentTargets | null {
  if (!buffer.subarray(0, 1024).includes('%PDF-')) return null;
  try {
    return inspectPageTree(new PdfReader(buffer), targetPageIndex);
  } catch {
    return null;
  }
}

function inspectPageTree(reader: PdfReader, targetPageIndex?: number): PdfDocumentTargets | null {
  const catalog = reader.resolve(reader.rootRef ?? undefined);
  if (!isDict(catalog) || !catalog['/Pages']) return null;

  interface Inherited {
    mediaBox: [number, number, number, number] | null;
    cropBox: [number, number, number, number] | null;
    rotate: number;
    userUnit: number;
    resources: PdfVal | undefined;
  }

  const selected: Array<{ dict: PdfDict; inh: Inherited; pageIndex: number }> = [];
  const visited = new Set<PdfDict>();
  type TreeEntry = { node: PdfVal; inherited: Inherited } | { count: number; offset: number };
  const stack: TreeEntry[] = [{
    node: catalog['/Pages'],
    inherited: { mediaBox: null, cropBox: null, rotate: 0, userUnit: 1, resources: undefined },
  }];
  let pageCount = 0;
  while (stack.length) {
    const entry = stack.pop()!;
    if ('count' in entry) {
      if (pageCount - entry.offset !== entry.count) return null;
      continue;
    }
    const inh = entry.inherited;
    const node = reader.resolve(entry.node);
    if (!isDict(node) || visited.has(node)) return null;
    visited.add(node);

    const userUnit = Number(reader.resolve(node['/UserUnit']));
    const nextInh: Inherited = {
      mediaBox: parseBox(node['/MediaBox'], reader) ?? inh.mediaBox,
      cropBox: parseBox(node['/CropBox'], reader) ?? inh.cropBox,
      rotate: node['/Rotate'] !== undefined ? normalizeRotate(node['/Rotate'], reader) : inh.rotate,
      userUnit: Number.isFinite(userUnit) && userUnit > 0 ? userUnit : inh.userUnit,
      resources: node['/Resources'] !== undefined ? node['/Resources'] : inh.resources,
    };

    const nodeType = reader.resolve(node['/Type']);
    const kids = reader.resolve(node['/Kids']);
    if (nodeType === '/Pages') {
      const count = reader.resolve(node['/Count']);
      if (!Array.isArray(kids) || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return null;
      stack.push({ count, offset: pageCount });
      for (let index = kids.length - 1; index >= 0; index--) {
        stack.push({ node: kids[index], inherited: nextInh });
      }
    } else if (nodeType === '/Page' && kids === undefined) {
      if (targetPageIndex === undefined || targetPageIndex === pageCount) {
        selected.push({ dict: node, inh: nextInh, pageIndex: pageCount });
      }
      pageCount++;
    } else {
      return null;
    }
  }

  if (!pageCount) return null;
  const pages = selected.map(({ dict, inh, pageIndex }) => {
    const mediaBox: [number, number, number, number] = inh.mediaBox ?? [0, 0, 612, 792];
    const requestedCropBox = inh.cropBox ?? mediaBox;
    const intersectedCropBox: [number, number, number, number] = [
      Math.max(mediaBox[0], requestedCropBox[0]), Math.max(mediaBox[1], requestedCropBox[1]),
      Math.min(mediaBox[2], requestedCropBox[2]), Math.min(mediaBox[3], requestedCropBox[3]),
    ];
    const cropBox = intersectedCropBox[2] > intersectedCropBox[0] && intersectedCropBox[3] > intersectedCropBox[1]
      ? intersectedCropBox : mediaBox;
    const rotate = inh.rotate;
    const userUnit = inh.userUnit;
    const rawW = (cropBox[2] - cropBox[0]) * userUnit;
    const rawH = (cropBox[3] - cropBox[1]) * userUnit;
    const widthPt = rotate === 90 || rotate === 270 ? rawH : rawW;
    const heightPt = rotate === 90 || rotate === 270 ? rawW : rawH;

    // Resolve and decode /Contents stream(s)
    const contentsVal = reader.resolve(dict['/Contents']);
    if (contentsVal === undefined && dict['/Contents'] !== undefined) throw new Error('Missing PDF content');
    const contentRefs: PdfVal[] = Array.isArray(contentsVal)
      ? contentsVal
      : contentsVal !== undefined
        ? [contentsVal]
        : [];
    let contentLength = 0;
    const decodedBuffers: Buffer[] = [];
    const streamHashes: string[] = [];
    for (const ref of contentRefs) {
      const stm = reader.resolve(ref);
      if (!isStream(stm)) throw new Error('Missing PDF content stream');
      const decoded = reader.decodeStream(stm);
      if (!decoded || (contentLength += decoded.length) > PDF_EXPANSION_BUDGET_BYTES) {
        throw new Error('PDF content could not be decoded within the expansion budget');
      }
      decodedBuffers.push(decoded);
      streamHashes.push(sha256(decoded));
    }
    const content = decodedBuffers.length === 1 ? decodedBuffers[0] : Buffer.concat(decodedBuffers, contentLength);
    const { text, items } = extractContentItems(content, cropBox, rotate, userUnit);

    // Resolve annotations
    const annotsVal = reader.resolve(dict['/Annots']);
    if (annotsVal === undefined && dict['/Annots'] !== undefined) throw new Error('Missing PDF annotations');
    const annotations: PdfAnnotationTarget[] = [];
    if (Array.isArray(annotsVal)) {
      for (let ai = 0; ai < annotsVal.length; ai++) {
        const annot = reader.resolve(annotsVal[ai]);
        if (!isDict(annot)) throw new Error('Invalid PDF annotation');
        const subtype = String(reader.resolve(annot['/Subtype']) ?? '');
        const rect = parseBox(annot['/Rect'], reader);
        const contents = String(reader.resolve(annot['/Contents']) ?? '');
        const nm = reader.resolve(annot['/NM']);
        const uid = typeof nm === 'string' && nm ? nm : `annot-${ai}`;
        const fingerprint = reader.hashPageDependency(annot);
        annotations.push({ uid, subtype, rect, contents, fingerprint });
      }
    }

    const resourcesHash = reader.hashPageDependency(inh.resources);
    const pageContentHash = sha256(
      JSON.stringify({
        v: 2,
        mediaBox,
        cropBox,
        rotate,
        userUnit: round2(userUnit),
        widthPt: round2(widthPt),
        heightPt: round2(heightPt),
        streamHashes,
        resourcesHash,
        annots: annotations.map((a) => a.fingerprint),
      }),
    );

    return {
      pageIndex,
      pageCount,
      mediaBox,
      cropBox,
      rotate,
      userUnit,
      widthPt,
      heightPt,
      pageContentHash,
      text,
      items,
      annotations,
    };
  });

  return { pageCount, pages };
}

export function pdfRectInPage(
  page: Pick<PdfPageTargetInfo, 'widthPt' | 'heightPt'>,
  [x, y, w, h]: [number, number, number, number],
): boolean {
  if (![x, y, w, h].every(n => Number.isFinite(n) && n >= 0) || (w === 0) !== (h === 0)) return false;
  // Limit tolerance to floating-point addition at the page edge.
  return x <= page.widthPt && y <= page.heightPt &&
    x + w <= page.widthPt + Number.EPSILON * page.widthPt &&
    y + h <= page.heightPt + Number.EPSILON * page.heightPt;
}

export function computePdfRegionDigest(
  page: PdfPageTargetInfo,
  rectPt: [number, number, number, number],
): string {
  const [rx, ry, rw, rh] = rectPt;
  const isPin = rw === 0 && rh === 0;
  const tol = isPin ? 12 : 2;
  const x0 = rx - tol;
  const y0 = ry - tol;
  const x1 = rx + rw + tol;
  const y1 = ry + rh + tol;

  const intersecting = page.items.filter((it) => {
    const ix1 = it.x + it.w;
    const iy1 = it.y + it.h;
    return ix1 >= x0 && it.x <= x1 && iy1 >= y0 && it.y <= y1;
  });

  return sha256(
    JSON.stringify({
      v: 2,
      pageContentHash: page.pageContentHash,
      widthPt: round2(page.widthPt),
      heightPt: round2(page.heightPt),
      rotate: page.rotate,
      rectPt: [rx, ry, rw, rh],
      items: intersecting.map((it) => [it.kind, it.x, it.y, it.w, it.h, it.value]),
    }),
  );
}

export function readPdfPageTarget(
  buffer: Buffer,
  pageIndex: number,
  rectPt?: [number, number, number, number],
): {
  pageIndex: number;
  pageCount: number;
  widthPt: number;
  heightPt: number;
  rotate: number;
  pageContentHash: string;
  text: string;
  regionDigest?: string;
} | null {
  const doc = inspectPdfDocument(buffer, pageIndex);
  const page = doc?.pages[0];
  if (!page || (rectPt && !pdfRectInPage(page, rectPt))) return null;
  return {
    pageIndex: page.pageIndex,
    pageCount: page.pageCount,
    widthPt: page.widthPt,
    heightPt: page.heightPt,
    rotate: page.rotate,
    pageContentHash: page.pageContentHash,
    text: page.text,
    ...(rectPt ? { regionDigest: computePdfRegionDigest(page, rectPt) } : {}),
  };
}
