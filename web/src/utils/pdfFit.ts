export const PDF_MANUAL_MIN_SCALE = 0.25;
export const PDF_MANUAL_MAX_SCALE = 3.0;

/**
 * Computes the auto-fit PDF scale for a page inside a scroll container.
 * Never clamps upward above the computed fit scale so wide landscape PDFs
 * fit cleanly without horizontal clipping even on iPhone 375px–430px screens.
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
  const availH = Math.max(1, containerSize.height - paddingPx);
  const widthScale = availW / pageSize.width;
  const isLandscape = pageSize.width > pageSize.height;
  let computed: number;
  if (isLandscape && containerSize.height > paddingPx) {
    const heightScale = availH / pageSize.height;
    // Fit both width and height on PC; on portrait iPhone widthScale < heightScale so it fills width cleanly
    computed = Math.min(widthScale, heightScale);
  } else {
    computed = Math.min(widthScale, 1.8);
  }
  const capped = Math.min(2.2, Math.max(0.05, computed));
  // Floor to 2 decimal places so rounding never pushes rendered width past availW
  return Math.max(0.05, Math.floor(capped * 100) / 100);
}
