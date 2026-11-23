import { expect, type Page } from '@playwright/test';

export interface LayoutViolation {
  screen: string;
  viewport: string;
  rule: string;
  element: string;
  detail: string;
}

export interface AuditOptions {
  screen: string;
  viewport: string;
  expectModal?: boolean;
  viewerKind?: 'pdf' | 'pptx' | 'image' | 'svg';
  expectAutoFit?: boolean;
}

export interface ChromeRect {
  selector: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function formatViolations(violations: readonly LayoutViolation[]): string {
  return violations
    .map(
      (v, idx) =>
        `${idx + 1}. [${v.screen}] [${v.viewport}] (${v.rule}) ${v.element}\n   -> ${v.detail}`
    )
    .join('\n');
}

/**
 * Mechanically inspects DOM, CSS, bounding rects, text line counts, overlap,
 * clipping, scroll state, modal/viewer sizing, and content fit ratio.
 */
export async function auditPageLayout(page: Page, options: AuditOptions): Promise<LayoutViolation[]> {
  const raw = await page.evaluate((opts) => {
    const violations: Array<{ rule: string; element: string; detail: string }> = [];
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const describeEl = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      const cls =
        typeof el.className === 'string' && el.className.trim()
          ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
          : '';
      const label = (
        el.getAttribute('aria-label') ||
        (el as HTMLElement).innerText ||
        el.textContent ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 36);
      return label ? `${tag}${cls}("${label}")` : `${tag}${cls}`;
    };

    const isVisible = (el: Element): boolean => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
        return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 0.5 && r.height > 0.5;
    };

    const isInsideHorizontallyScrollable = (el: Element): boolean => {
      let cur = el.parentElement;
      while (cur && cur !== document.body) {
        const s = window.getComputedStyle(cur);
        if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && cur.scrollWidth > cur.clientWidth + 1) {
          return true;
        }
        cur = cur.parentElement;
      }
      return false;
    };

    const countRenderedTextLines = (el: Element): number => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const lineTops: number[] = [];
      let node = walker.nextNode();
      while (node) {
        const text = node.textContent?.trim();
        if (text) {
          const range = document.createRange();
          range.selectNodeContents(node);
          const rects = range.getClientRects();
          for (let i = 0; i < rects.length; i += 1) {
            const r = rects[i];
            if (r.width < 1 || r.height < 1) continue;
            const bucket = Math.round(r.top / 4);
            if (!lineTops.some((t) => Math.abs(t - bucket) <= 1)) {
              lineTops.push(bucket);
            }
          }
        }
        node = walker.nextNode();
      }
      return lineTops.length;
    };

    // 1. Unintended horizontal page overflow
    if (document.documentElement.scrollWidth > vw + 1) {
      violations.push({
        rule: 'no-horizontal-page-overflow',
        element: 'html',
        detail: `documentElement.scrollWidth=${document.documentElement.scrollWidth}px > innerWidth=${vw}px`,
      });
    }
    if (document.body.scrollWidth > vw + 1) {
      violations.push({
        rule: 'no-horizontal-page-overflow',
        element: 'body',
        detail: `body.scrollWidth=${document.body.scrollWidth}px > innerWidth=${vw}px`,
      });
    }

    // 2. Single-line interactive controls: awkward wrapping & text clipping
    const singleLineSelectors = [
      '.btn',
      '.pill-btn',
      '.seg-btn',
      '.chip-btn',
      '[role="tab"]',
      '.pdf-page-indicator',
      '.pdf-scale-indicator',
      '.sync-badge',
      '.composer-pill-btn',
    ].join(', ');

    const excludedControlClasses = [
      'artifact-card',
      'chat-item',
      'skill-list-item',
      'project-card',
      'workspace-file-link',
      'image-zoom-button',
    ];

    const controls = Array.from(document.querySelectorAll(singleLineSelectors));
    for (const el of controls) {
      if (!isVisible(el)) continue;
      if (el.getAttribute('data-allow-wrap') === 'true') continue;
      if (excludedControlClasses.some((c) => el.classList.contains(c))) continue;

      const rect = el.getBoundingClientRect();
      // Ignore offscreen controls inside closed drawers
      if (rect.right < 0 || rect.left > vw) continue;

      const lines = countRenderedTextLines(el);
      if (lines > 1) {
        violations.push({
          rule: 'no-control-text-wrap',
          element: describeEl(el),
          detail: `Rendered ${lines} text lines (expected 1) in ${Math.round(rect.width)}x${Math.round(rect.height)}px`,
        });
      }

      const style = window.getComputedStyle(el);
      const allowsEllipsis =
        el.classList.contains('truncate') ||
        style.textOverflow === 'ellipsis' ||
        Boolean(el.querySelector('.truncate'));
      if (!allowsEllipsis && el.scrollWidth > el.clientWidth + 2) {
        violations.push({
          rule: 'no-text-clipping',
          element: describeEl(el),
          detail: `scrollWidth=${el.scrollWidth}px > clientWidth=${el.clientWidth}px`,
        });
      }

      if (!isInsideHorizontallyScrollable(el) && (rect.left < -1.5 || rect.right > vw + 1.5)) {
        violations.push({
          rule: 'no-viewport-horizontal-overflow',
          element: describeEl(el),
          detail: `rect=[left:${Math.round(rect.left)}, right:${Math.round(rect.right)}] exceeds viewport [0, ${vw}]`,
        });
      }
    }

    // 3. Sibling overlap & intra-group row alignment in action groups / toolbars
    const groupSelectors = [
      '.header-bar',
      '.header-left',
      '.header-center',
      '.header-right',
      '.modal-head-actions',
      '.pdf-viewer-toolbar',
      '.pdf-toolbar-group',
      '.composer-toolbar',
      '.composer-toolbar-left',
      '.composer-toolbar-right',
      '.chat-zoom-pill',
      '.viewer-footer-actions',
    ];

    const strictSingleRowGroups = new Set([
      '.header-left',
      '.header-center',
      '.header-right',
      '.pdf-toolbar-group',
      '.chat-zoom-pill',
    ]);

    for (const sel of groupSelectors) {
      const containers = Array.from(document.querySelectorAll(sel));
      for (const container of containers) {
        if (!isVisible(container)) continue;
        const cRect = container.getBoundingClientRect();
        if (cRect.right < 0 || cRect.left > vw) continue;

        const children = Array.from(container.children).filter(isVisible);
        for (let i = 0; i < children.length; i += 1) {
          const a = children[i].getBoundingClientRect();
          for (let j = i + 1; j < children.length; j += 1) {
            const b = children[j].getBoundingClientRect();
            const overlapW = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const overlapH = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (overlapW > 2 && overlapH > 2) {
              violations.push({
                rule: 'no-sibling-overlap',
                element: `${sel} -> ${describeEl(children[i])} vs ${describeEl(children[j])}`,
                detail: `Overlap ${Math.round(overlapW)}x${Math.round(overlapH)}px`,
              });
            }
          }
        }

        if (strictSingleRowGroups.has(sel) && children.length >= 2) {
          const firstCenterY =
            children[0].getBoundingClientRect().top + children[0].getBoundingClientRect().height / 2;
          for (let i = 1; i < children.length; i += 1) {
            const r = children[i].getBoundingClientRect();
            const cy = r.top + r.height / 2;
            if (Math.abs(cy - firstCenterY) > 10) {
              violations.push({
                rule: 'control-group-alignment',
                element: `${sel} -> ${describeEl(children[i])}`,
                detail: `Wrapped onto another row inside single-row group (centerY delta=${Math.round(Math.abs(cy - firstCenterY))}px)`,
              });
            }
          }
        }
      }
    }

    // 4. Modal & Viewer display area adequacy
    if (opts.expectModal) {
      const modal = document.querySelector('.modal-card');
      if (!modal || !isVisible(modal)) {
        violations.push({
          rule: 'modal-visible',
          element: '.modal-card',
          detail: 'Expected modal to be visible but not found',
        });
      } else {
        const mr = modal.getBoundingClientRect();
        if (mr.left < -1.5 || mr.right > vw + 1.5 || mr.top < -1.5 || mr.bottom > vh + 1.5) {
          violations.push({
            rule: 'modal-viewport-bounds',
            element: '.modal-card',
            detail: `Modal [${Math.round(mr.left)},${Math.round(mr.top)},${Math.round(mr.right)},${Math.round(mr.bottom)}] exceeds viewport ${vw}x${vh}`,
          });
        }
      }
    }

    // 5. Viewer area adequacy & auto-fit content sizing / margin check
    if (opts.viewerKind) {
      const isPdfLike = opts.viewerKind === 'pdf' || opts.viewerKind === 'pptx';
      const scrollSel = isPdfLike ? '.pdf-canvas-scroll' : '.media-zoom-scroll';
      const contentSel = isPdfLike ? '.pdf-page-slot[data-page-number="1"]' : '.media-zoom-img';
      const scrollEl = document.querySelector(scrollSel);
      const contentEl = document.querySelector(contentSel);

      if (!scrollEl || !isVisible(scrollEl)) {
        violations.push({
          rule: 'viewer-area-adequacy',
          element: scrollSel,
          detail: 'Viewer scroll surface not visible',
        });
      } else {
        const sr = scrollEl.getBoundingClientRect();
        const minW = Math.min(300, vw * 0.8);
        const minH = Math.max(200, vh * 0.34);
        if (sr.width < minW || sr.height < minH) {
          violations.push({
            rule: 'viewer-area-adequacy',
            element: scrollSel,
            detail: `Viewer area ${Math.round(sr.width)}x${Math.round(sr.height)}px is smaller than minimum ${Math.round(minW)}x${Math.round(minH)}px`,
          });
        }

        if (opts.expectAutoFit && contentEl && isVisible(contentEl)) {
          const cr = contentEl.getBoundingClientRect();
          const style = window.getComputedStyle(scrollEl);
          const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
          const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
          const availW = Math.max(1, scrollEl.clientWidth - padX);
          const availH = Math.max(1, scrollEl.clientHeight - padY);

          if (cr.width > scrollEl.clientWidth + 2) {
            violations.push({
              rule: 'content-fit-no-horizontal-clipping',
              element: contentSel,
              detail: `Auto-fit content width=${Math.round(cr.width)}px exceeds scroll clientWidth=${scrollEl.clientWidth}px`,
            });
          }

          const widthRatio = cr.width / availW;
          const heightRatio = cr.height / availH;
          const dominantRatio = Math.max(widthRatio, heightRatio);
          // For standard large content (PDF/PPTX/1600x900 PNG/1200x800 SVG), dominant axis should fill >= 78% of available viewer area
          if (dominantRatio < 0.78) {
            violations.push({
              rule: 'content-no-extreme-shrinkage',
              element: contentSel,
              detail: `Auto-fit content is overly shrunk: ${Math.round(cr.width)}x${Math.round(cr.height)}px in avail ${Math.round(availW)}x${Math.round(availH)}px (dominant ratio=${dominantRatio.toFixed(2)})`,
            });
          }
        }
      }
    }

    return violations;
  }, options);

  return raw.map((v) => ({
    screen: options.screen,
    viewport: options.viewport,
    ...v,
  }));
}

export async function assertNoLayoutViolations(page: Page, options: AuditOptions): Promise<void> {
  const violations = await auditPageLayout(page, options);
  expect(violations, formatViolations(violations)).toEqual([]);
}

export async function snapshotUiChrome(page: Page, selectors: readonly string[]): Promise<ChromeRect[]> {
  return page.evaluate((sels) => {
    const rects: ChromeRect[] = [];
    for (const selector of sels) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      // Ignore offscreen mobile sidebar drawer
      if (r.right <= 0 || r.left >= window.innerWidth) continue;
      rects.push({
        selector,
        x: Math.round(r.x * 10) / 10,
        y: Math.round(r.y * 10) / 10,
        width: Math.round(r.width * 10) / 10,
        height: Math.round(r.height * 10) / 10,
      });
    }
    return rects;
  }, selectors);
}

export function assertUiChromeStable(
  before: readonly ChromeRect[],
  after: readonly ChromeRect[],
  context: string,
  tolerancePx = 1.5
): void {
  expect(after.length, `[${context}] UI chrome element count changed`).toBe(before.length);
  for (let i = 0; i < before.length; i += 1) {
    const b = before[i];
    const a = after[i];
    expect(a.selector, `[${context}] UI chrome selector mismatch`).toBe(b.selector);
    expect(Math.abs(a.x - b.x), `[${context}] ${b.selector} x shifted (${b.x} -> ${a.x})`).toBeLessThanOrEqual(
      tolerancePx
    );
    expect(Math.abs(a.y - b.y), `[${context}] ${b.selector} y shifted (${b.y} -> ${a.y})`).toBeLessThanOrEqual(
      tolerancePx
    );
    expect(
      Math.abs(a.width - b.width),
      `[${context}] ${b.selector} width changed (${b.width} -> ${a.width})`
    ).toBeLessThanOrEqual(tolerancePx);
    expect(
      Math.abs(a.height - b.height),
      `[${context}] ${b.selector} height changed (${b.height} -> ${a.height})`
    ).toBeLessThanOrEqual(tolerancePx);
  }
}

/**
 * Dispatches a synthetic two-finger pinch gesture on a target element inside WebKit/Chromium
 * to verify touch pinch zoom handling on iPhone viewports.
 */
export async function dispatchTouchPinch(
  page: Page,
  selector: string,
  startHalfSpan: number,
  endHalfSpan: number
): Promise<void> {
  await page.evaluate(
    ({ sel, startSpan, endSpan }) => {
      const target = document.querySelector(sel);
      if (!target) throw new Error(`Pinch target not found: ${sel}`);
      const r = target.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;

      const makeTouchPoint = (id: number, x: number, y: number) => {
        try {
          return new Touch({
            identifier: id,
            target,
            clientX: x,
            clientY: y,
            pageX: x,
            pageY: y,
          });
        } catch {
          return {
            identifier: id,
            target,
            clientX: x,
            clientY: y,
            pageX: x,
            pageY: y,
          };
        }
      };

      const dispatchSyntheticTouch = (
        type: 'touchstart' | 'touchmove' | 'touchend',
        touches: unknown[],
        changedTouches: unknown[]
      ) => {
        try {
          const ev = new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: touches as Touch[],
            targetTouches: touches as Touch[],
            changedTouches: changedTouches as Touch[],
          });
          target.dispatchEvent(ev);
        } catch {
          const ev = new Event(type, { bubbles: true, cancelable: true });
          Object.defineProperty(ev, 'touches', { value: touches });
          Object.defineProperty(ev, 'targetTouches', { value: touches });
          Object.defineProperty(ev, 'changedTouches', { value: changedTouches });
          target.dispatchEvent(ev);
        }
      };

      const makeTouchList = (halfSpan: number) => [
        makeTouchPoint(1, cx - halfSpan, cy),
        makeTouchPoint(2, cx + halfSpan, cy),
      ];

      const startTouches = makeTouchList(startSpan);
      dispatchSyntheticTouch('touchstart', startTouches, startTouches);

      const steps = 4;
      for (let i = 1; i <= steps; i += 1) {
        const span = startSpan + ((endSpan - startSpan) * i) / steps;
        const moveTouches = makeTouchList(span);
        dispatchSyntheticTouch('touchmove', moveTouches, moveTouches);
      }

      dispatchSyntheticTouch('touchend', [], makeTouchList(endSpan));
    },
    { sel: selector, startSpan: startHalfSpan, endSpan: endHalfSpan }
  );
}

/**
 * Dispatches a Ctrl+Wheel event over a target element at its center (or specified offset).
 */
export async function dispatchCtrlWheel(page: Page, selector: string, deltaY: number): Promise<void> {
  await page.evaluate(
    ({ sel, dy }) => {
      const target = document.querySelector(sel);
      if (!target) throw new Error(`Wheel target not found: ${sel}`);
      const r = target.getBoundingClientRect();
      target.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: dy,
          deltaMode: 0,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
        })
      );
    },
    { sel: selector, dy: deltaY }
  );
}
