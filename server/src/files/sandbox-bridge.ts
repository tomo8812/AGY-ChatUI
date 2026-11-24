/**
 * Sandboxed HTML zoom-gesture bridge.
 *
 * Runs strictly inside `sandbox="allow-scripts"` (opaque origin, no `allow-same-origin`,
 * no network/storage access) and forwards Ctrl/Meta+Wheel and 2-finger touch pinch
 * gestures to the parent unified zoom shell via `window.parent.postMessage`.
 */
export const SANDBOX_ZOOM_BRIDGE_SCRIPT =
  '<script>(function(){if(window.__agySandboxZoomBridge)return;window.__agySandboxZoomBridge=1;var p=window.parent;if(!p||p===window)return;var post=function(m){try{p.postMessage(m,"*");}catch(e){}};var active=false;window.addEventListener("wheel",function(e){if(!e.ctrlKey&&!e.metaKey)return;e.preventDefault();post({type:"agy-sandbox-zoom",kind:"wheel",deltaY:e.deltaY,deltaMode:e.deltaMode,localX:e.clientX,localY:e.clientY});},{passive:false,capture:true});var geom=function(t1,t2){var dx=t2.clientX-t1.clientX,dy=t2.clientY-t1.clientY;return{d:Math.hypot(dx,dy),x:(t1.clientX+t2.clientX)/2,y:(t1.clientY+t2.clientY)/2};};window.addEventListener("touchstart",function(e){if(e.touches.length===2){e.preventDefault();active=true;var g=geom(e.touches[0],e.touches[1]);post({type:"agy-sandbox-zoom",kind:"pinch-start",distance:g.d,localX:g.x,localY:g.y});}},{passive:false,capture:true});window.addEventListener("touchmove",function(e){if(e.touches.length===2){e.preventDefault();var g=geom(e.touches[0],e.touches[1]);post({type:"agy-sandbox-zoom",kind:active?"pinch-move":"pinch-start",distance:g.d,localX:g.x,localY:g.y});active=true;}},{passive:false,capture:true});var end=function(e){if(active&&e.touches.length<2){active=false;post({type:"agy-sandbox-zoom",kind:"pinch-end"});}};window.addEventListener("touchend",end,{passive:true,capture:true});window.addEventListener("touchcancel",end,{passive:true,capture:true});var gs=function(e){e.preventDefault();};window.addEventListener("gesturestart",gs,{passive:false,capture:true});window.addEventListener("gesturechange",gs,{passive:false,capture:true});window.addEventListener("gestureend",gs,{passive:false,capture:true});})();</script>';

const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp']);

function isTagNameChar(code: number): boolean {
  return (
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    (code >= 48 && code <= 57) // 0-9
  );
}

function isTagBoundary(ch: string | undefined): boolean {
  return ch === undefined || ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

/**
 * Finds the end index (exclusive, right after `>`) of an HTML tag starting at `start` (`<`),
 * properly respecting single- and double-quoted attribute values.
 */
function findTagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < html.length; i += 1) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i + 1;
    }
  }
  return html.length;
}

/**
 * Finds the end index (exclusive) of the matching closing tag for a raw-text element
 * such as `<script>`, `<style>`, `<textarea>`, `<title>`, or `<xmp>`.
 */
function findRawTextCloseEnd(html: string, lower: string, tagName: string, searchFrom: number): number {
  const needle = `</${tagName}`;
  let idx = searchFrom;
  while (idx < lower.length) {
    const found = lower.indexOf(needle, idx);
    if (found === -1) return html.length;
    const afterName = found + needle.length;
    if (isTagBoundary(lower[afterName])) {
      const closeGt = html.indexOf('>', afterName);
      return closeGt === -1 ? html.length : closeGt + 1;
    }
    idx = afterName;
  }
  return html.length;
}

/**
 * Safely injects `SANDBOX_ZOOM_BRIDGE_SCRIPT` into an HTML document using HTML
 * token-boundary scanning. Ignores `</body>` / `</html>` occurrences inside:
 * - HTML comments (`<!-- ... -->`)
 * - `<script>`, `<style>`, `<textarea>`, `<title>`, `<xmp>` raw-text blocks
 * - quoted tag attributes (e.g. `data-tpl="</body>"`)
 */
export function injectSandboxZoomBridge(html: string): string {
  const lower = html.toLowerCase();
  let lastBodyClose = -1;
  let lastHtmlClose = -1;

  let i = 0;
  const n = html.length;

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;

    // 1. HTML comment <!-- ... -->
    if (html.startsWith('<!--', lt)) {
      const commentEnd = html.indexOf('-->', lt + 4);
      i = commentEnd === -1 ? n : commentEnd + 3;
      continue;
    }

    // 2. DOCTYPE / CDATA / processing instruction <! ... > or <? ... >
    const nextCh = html[lt + 1];
    if (nextCh === '!' || nextCh === '?') {
      const gt = html.indexOf('>', lt + 2);
      i = gt === -1 ? n : gt + 1;
      continue;
    }

    // 3. Closing tag </tagName ...>
    if (nextCh === '/') {
      let nameEnd = lt + 2;
      while (nameEnd < n && isTagNameChar(html.charCodeAt(nameEnd))) {
        nameEnd += 1;
      }
      const tagName = lower.slice(lt + 2, nameEnd);
      const tagEnd = findTagEnd(html, lt);
      if (tagName === 'body' && isTagBoundary(html[nameEnd])) {
        lastBodyClose = lt;
      } else if (tagName === 'html' && isTagBoundary(html[nameEnd])) {
        lastHtmlClose = lt;
      }
      i = tagEnd;
      continue;
    }

    // 4. Opening tag <tagName ...>
    if (nextCh && isTagNameChar(html.charCodeAt(lt + 1))) {
      let nameEnd = lt + 1;
      while (nameEnd < n && isTagNameChar(html.charCodeAt(nameEnd))) {
        nameEnd += 1;
      }
      const tagName = lower.slice(lt + 1, nameEnd);
      const tagEnd = findTagEnd(html, lt);
      const isSelfClosing = tagEnd >= 2 && html[tagEnd - 2] === '/';
      if (!isSelfClosing && RAW_TEXT_TAGS.has(tagName) && isTagBoundary(html[nameEnd])) {
        i = findRawTextCloseEnd(html, lower, tagName, tagEnd);
      } else {
        i = tagEnd;
      }
      continue;
    }

    i = lt + 1;
  }

  const insertAt = lastBodyClose !== -1 ? lastBodyClose : lastHtmlClose;
  if (insertAt !== -1) {
    return `${html.slice(0, insertAt)}${SANDBOX_ZOOM_BRIDGE_SCRIPT}${html.slice(insertAt)}`;
  }
  return `${html}${SANDBOX_ZOOM_BRIDGE_SCRIPT}`;
}
