export const PDF_MANUAL_MIN_SCALE = 0.25;
export const PDF_MANUAL_MAX_SCALE = 3.0;
export const PDF_AUTO_FIT_MIN_SCALE = 0.05;
export const PDF_AUTO_FIT_MAX_SCALE = 3.0;

/**
 * Computes the auto-fit PDF scale so the entire page fits inside the viewer
 * scroll container while preserving aspect ratio for both landscape and portrait pages.
 * Never clamps upward above the computed fit scale so pages fit cleanly without
 * horizontal or vertical clipping across all PC and iPhone viewports.
 */
export function computePdfAutoFitScale(
  pageSize: { width: number; height: number } | null,
  containerSize: { width: number; height: number },
  paddingPx = 24
): number {
  if (!pageSize || pageSize.width <= 0 || pageSize.height <= 0 || containerSize.width <= 0) {
    return 1.0;
  }
  const availW = Math.max(1, containerSize.width - paddingPx);
  const widthScale = availW / pageSize.width;
  let computed: number;
  if (containerSize.height > paddingPx) {
    const availH = Math.max(1, containerSize.height - paddingPx);
    const heightScale = availH / pageSize.height;
    computed = Math.min(widthScale, heightScale);
  } else {
    computed = widthScale;
  }
  const capped = Math.min(PDF_AUTO_FIT_MAX_SCALE, Math.max(PDF_AUTO_FIT_MIN_SCALE, computed));
  // Floor to 2 decimal places so rounding never pushes rendered dimensions past availW / availH
  return Math.max(PDF_AUTO_FIT_MIN_SCALE, Math.floor(capped * 100) / 100);
}

export interface PdfPageRect {
  pageNum: number;
  top: number;
  bottom: number;
}

/**
 * Determines which page is currently active in a continuously scrolled PDF viewer
 * based on the page whose vertical span covers (or is closest to) the top anchor
 * inside the scroll viewport.
 */
export function findActivePdfPage(
  containerTop: number,
  containerHeight: number,
  paddingTop: number,
  pageRects: readonly PdfPageRect[]
): number {
  if (pageRects.length === 0) return 1;
  const anchorY = containerTop + paddingTop + Math.min(80, Math.max(0, containerHeight * 0.2));
  let bestPage = pageRects[0].pageNum;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const rect of pageRects) {
    if (rect.top <= anchorY && rect.bottom >= anchorY) {
      return rect.pageNum;
    }
    const distance = anchorY < rect.top ? rect.top - anchorY : anchorY - rect.bottom;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPage = rect.pageNum;
    }
  }
  return bestPage;
}
