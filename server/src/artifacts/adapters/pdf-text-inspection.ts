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
    const { items, styles } = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    const wholeRuns = pdfTextLayout(items, viewport, undefined, styles);
    if (start === undefined || end === undefined || wholeRuns.quadsForRange(start, end)) return wholeRuns;

    const list = await page.getOperatorList();
    type Glyph = { unicode: string; width: number; isSpace: boolean; vmetric?: number[] };
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
        if (!glyphs.every(glyph => typeof glyph === 'number' || (glyph && typeof glyph.unicode === 'string'))) continue;
        const font = page.commonObjs.get(state.font) as { isType3Font?: boolean; fontMatrix?: number[]; vertical?: boolean };
        if (font?.isType3Font) continue;
        const scale = state.size * (font?.fontMatrix?.[0] ?? 0.001);
        const vertical = font?.vertical === true;
        let text = '', normalizedText = '', advance = 0;
        const glyphText: string[] = [];
        const offsets = new Map<number, number>([[0, 0]]);
        const normalizedOffsets = new Map<number, number>([[0, 0]]);
        for (const glyph of glyphs) {
          if (typeof glyph === 'number') {
            advance += (vertical ? glyph : -glyph) * state.size / 1000;
          } else {
            offsets.set(text.length, advance);
            normalizedOffsets.set(normalizedText.length, advance);
            text += glyph.unicode;
            glyphText.push(glyph.unicode);
            // A normalized ligature contributes one pair of glyph boundaries.
            normalizedText += glyph.unicode.normalize('NFKC');
            advance += (vertical ? -(glyph.vmetric?.[0] ?? -glyph.width) : glyph.width) * scale + state.charSpacing + (glyph.isSpace ? state.wordSpacing : 0);
            offsets.set(text.length, advance);
            normalizedOffsets.set(normalizedText.length, advance);
          }
        }
        if (!text || !Number.isFinite(advance) || advance <= 0) continue;
        for (const positions of [offsets, normalizedOffsets]) {
          for (const [offset, position] of positions) positions.set(offset, position / advance);
        }
        const register = (direction: string, value: string, positions: Map<number, number>) => {
          const key = JSON.stringify([state.font, direction, value]);
          const existing = runs.get(key);
          if (existing) existing.push(positions);
          else runs.set(key, [positions]);
        };
        register(vertical ? 'ttb' : 'ltr', text, offsets);
        if (text !== normalizedText) register(vertical ? 'ttb' : 'ltr', normalizedText, normalizedOffsets);
        if (!vertical && glyphText.every(value => /^[\p{Script=Hebrew}\p{Script=Arabic}]+$/u.test(value))) {
          let logicalOffset = 0, physicalOffset = text.length;
          const reversed = new Map<number, number>([[0, 1]]);
          for (const value of glyphText.reverse()) {
            logicalOffset += value.length;
            physicalOffset -= value.length;
            reversed.set(logicalOffset, offsets.get(physicalOffset)!);
          }
          register('rtl', glyphText.join(''), reversed);
        }
      }
    }
    return pdfTextLayout(items, viewport, (item, from, to) => {
      const candidates = runs.get(JSON.stringify([item.fontName, item.dir, item.str]));
      const start = candidates?.[0]?.get(from), end = candidates?.[0]?.get(to);
      if (start === undefined || end === undefined || start === end ||
          Math.min(start, end) < 0 || Math.max(start, end) > 1 ||
          candidates?.some(offsets => offsets.get(from) !== start || offsets.get(to) !== end)) return null;
      return [Math.min(start, end), Math.max(start, end)];
    }, styles);
  } catch {
    return null;
  } finally {
    await cleanup?.();
  }
}
