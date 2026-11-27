interface PdfTextItem {
  str: string;
  dir: string;
  width: number;
  height: number;
  transform: number[];
  fontName: string;
}

export interface PdfTextLayout {
  text: string;
  widthPt: number;
  heightPt: number;
  quadsForRange(start: number, end: number): number[][] | null;
}

/** Shared by PDF.js in the viewer and the target inspection worker. Offsets are UTF-16. */
export function pdfTextLayout(
  items: Array<PdfTextItem | { type: string }>,
  viewport: { width: number; height: number; convertToViewportPoint(x: number, y: number): number[] },
  glyphFractions?: (item: PdfTextItem, from: number, to: number) => [number, number] | null,
): PdfTextLayout {
  let text = '';
  const runs: Array<{ item: PdfTextItem; start: number; text: string; trimStart: number }> = [];
  for (const item of items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const value = item.str.trim();
    if (text) text += ' ';
    runs.push({ item, start: text.length, text: value, trimStart: item.str.length - item.str.trimStart().length });
    text += value;
  }

  return {
    text, widthPt: viewport.width, heightPt: viewport.height,
    quadsForRange(start, end) {
      if (start < 0 || end <= start || end > text.length) return null;
      const quads: number[][] = [];
      for (const run of runs) {
        if (run.start >= end) break;
        const from = Math.max(0, start - run.start);
        const to = Math.min(run.text.length, end - run.start);
        if (to <= from) continue;
        const { item } = run;
        const [a, b, c, d, x, y] = item.transform;
        const horizontal = Math.hypot(a, b), vertical = Math.hypot(c, d);
        if (!horizontal || !vertical || !item.width || !item.height || item.dir === 'ttb') return null;
        const fractions: [number, number] | null = from === 0 && to === item.str.length
          ? [0, 1] : glyphFractions?.(item, from + run.trimStart, to + run.trimStart) ?? null;
        if (!fractions) return null;
        const [left, right] = fractions;
        const point = (fraction: number, height: number) => viewport.convertToViewportPoint(
          x + a * item.width * fraction / horizontal + c * height / vertical,
          y + b * item.width * fraction / horizontal + d * height / vertical,
        );
        const quad = [...point(left, item.height), ...point(right, item.height), ...point(left, 0), ...point(right, 0)];
        if (quad.some((value, i) => !Number.isFinite(value) || value < 0 || value > (i % 2 ? viewport.height : viewport.width))) return null;
        quads.push(quad);
      }
      return quads.length ? quads : null;
    },
  };
}
