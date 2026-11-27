import path from 'node:path';
import { createRequire } from 'node:module';
import { pdfTextLayout, type PdfTextLayout } from './pdf-text-layout.js';

export async function inspectPdfText(bytes: Buffer, pageIndex: number, start?: number, end?: number): Promise<PdfTextLayout | null> {
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const require = createRequire(import.meta.url);
    const directory = path.dirname(require.resolve('pdfjs-dist/package.json'));
    const task = getDocument({
      data: Uint8Array.from(bytes),
      standardFontDataUrl: path.join(directory, 'standard_fonts') + path.sep,
      cMapUrl: path.join(directory, 'cmaps') + path.sep,
      cMapPacked: true,
      wasmUrl: path.join(directory, 'wasm') + path.sep,
      useSystemFonts: false,
      useWasm: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      disableFontFace: true,
      maxImageSize: 1,
      stopAtErrors: true,
    });
    cleanup = () => task.destroy();
    const document = await task.promise;
    if (pageIndex < 0 || pageIndex >= document.numPages) return null;
    const page = await document.getPage(pageIndex + 1);
    const { items } = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    const wholeRuns = pdfTextLayout(items, viewport);
    if (start === undefined || end === undefined || wholeRuns.quadsForRange(start, end)) return wholeRuns;

    const list = await page.getOperatorList();
    type Glyph = { unicode: string; width: number; isSpace: boolean; vmetric?: unknown };
    let state = { font: '', size: 0, charSpacing: 0, wordSpacing: 0 };
    const stack: (typeof state)[] = [];
    const runs = new Map<string, Array<Map<number, number>>>();
    for (let i = 0; i < list.fnArray.length; i++) {
      const op = list.fnArray[i], args = list.argsArray[i];
      if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push({ ...state });
      else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) state = stack.pop() ?? state;
      else if (op === OPS.setFont) [state.font, state.size] = args as [string, number];
      else if (op === OPS.setCharSpacing) state.charSpacing = Number(args[0]);
      else if (op === OPS.setWordSpacing) state.wordSpacing = Number(args[0]);
      else if (op === OPS.showText && state.size > 0 && Array.isArray(args?.[0])) {
        const glyphs = args[0] as Array<Glyph | number>;
        if (!glyphs.every(glyph => typeof glyph === 'number' || (glyph && !glyph.vmetric && typeof glyph.unicode === 'string'))) continue;
        const font = page.commonObjs.get(state.font) as { isType3Font?: boolean; fontMatrix?: number[] };
        if (font?.isType3Font) continue;
        const scale = state.size * (font?.fontMatrix?.[0] ?? 0.001);
        let text = '', advance = 0;
        const offsets = new Map<number, number>([[0, 0]]);
        for (const glyph of glyphs) {
          if (typeof glyph === 'number') {
            advance -= glyph * state.size / 1000;
          } else {
            offsets.set(text.length, advance);
            text += glyph.unicode;
            advance += glyph.width * scale + state.charSpacing + (glyph.isSpace ? state.wordSpacing : 0);
            offsets.set(text.length, advance);
          }
        }
        if (!text || !Number.isFinite(advance) || advance <= 0) continue;
        for (const [offset, position] of offsets) offsets.set(offset, position / advance);
        const key = JSON.stringify([state.font, text]);
        const existing = runs.get(key);
        if (existing) existing.push(offsets);
        else runs.set(key, [offsets]);
      }
    }
    return pdfTextLayout(items, viewport, (item, from, to) => {
      if (item.dir !== 'ltr') return null;
      const candidates = runs.get(JSON.stringify([item.fontName, item.str]));
      const left = candidates?.[0]?.get(from), right = candidates?.[0]?.get(to);
      if (left === undefined || right === undefined || left < 0 || right > 1 || right <= left ||
          candidates?.some(offsets => offsets.get(from) !== left || offsets.get(to) !== right)) return null;
      return [left, right];
    });
  } catch {
    return null;
  } finally {
    await cleanup?.();
  }
}
