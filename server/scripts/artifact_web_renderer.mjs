import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { verifyHtmlBrowser, verifySvgBrowser } from './artifact_web_verify.mjs';

const inputDir = process.env.AGY_WORKER_IN_DIR;
const outputDir = process.env.AGY_WORKER_OUT_DIR;
const runtimeDir = process.env.AGY_DOC_RUNTIME_DIR;
const require = createRequire(path.join(runtimeDir, 'node/package.json'));
const { chromium } = require('playwright');

const request = JSON.parse(await fs.readFile(path.join(inputDir, 'request.json'), 'utf8'));
const {
  format,
  action = 'render',
  targetFormat,
  region,
  entry = 'index.html',
  assets = [],
  options = {},
  viewerPolicy,
} = request;
const source = await fs.readFile(path.join(inputDir, 'document'), 'utf8');
if (source.length > 1_000_000) throw new Error('Source exceeds the rendering limit');

function computeClip(regionSpec, viewportWidth, viewportHeight) {
  if (!regionSpec || typeof regionSpec !== 'object') return undefined;
  const unit = regionSpec.unit ?? 'norm';
  const rawX = Number(regionSpec.x);
  const rawY = Number(regionSpec.y);
  const rawW = Number(regionSpec.width);
  const rawH = Number(regionSpec.height);
  if (![rawX, rawY, rawW, rawH].every(Number.isFinite) || rawW <= 0 || rawH <= 0 || rawX < 0 || rawY < 0) {
    throw new Error('Invalid render region coordinates');
  }
  let x;
  let y;
  let width;
  let height;
  if (unit === 'norm') {
    if (rawX >= 1 || rawY >= 1 || rawX + rawW > 1.001 || rawY + rawH > 1.001) {
      throw new Error('Normalized render region exceeds [0, 1] bounds');
    }
    x = rawX * viewportWidth;
    y = rawY * viewportHeight;
    width = rawW * viewportWidth;
    height = rawH * viewportHeight;
  } else if (unit === 'pt') {
    const scale = 96 / 72;
    x = rawX * scale;
    y = rawY * scale;
    width = rawW * scale;
    height = rawH * scale;
  } else if (unit === 'px') {
    x = rawX;
    y = rawY;
    width = rawW;
    height = rawH;
  } else {
    throw new Error(`Unsupported render region unit: ${unit}`);
  }
  const clampedX = Math.max(0, Math.min(viewportWidth - 1, Math.floor(x)));
  const clampedY = Math.max(0, Math.min(viewportHeight - 1, Math.floor(y)));
  const clampedW = Math.max(1, Math.min(viewportWidth - clampedX, Math.round(width)));
  const clampedH = Math.max(1, Math.min(viewportHeight - clampedY, Math.round(height)));
  return { x: clampedX, y: clampedY, width: clampedW, height: clampedH };
}

function wrapMarkdownHtml(bodyHtml, title) {
  const safeTitle = String(title || 'Document').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    '<!DOCTYPE html>',
    '<html lang="ja">',
    '<head>',
    '  <meta charset="UTF-8" />',
    `  <title>${safeTitle}</title>`,
    '  <style>',
    '    body { font-family: "Noto Sans CJK JP", "DejaVu Sans", -apple-system, BlinkMacSystemFont, sans-serif; line-height: 1.65; color: #1f2937; margin: 28px 36px; }',
    '    h1, h2, h3, h4, h5, h6 { margin-top: 1.3em; margin-bottom: 0.45em; line-height: 1.3; }',
    '    pre { background: #f3f4f6; padding: 12px 16px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; }',
    '    code { font-family: "DejaVu Sans Mono", ui-monospace, monospace; background: #f3f4f6; padding: 0.12em 0.3em; border-radius: 4px; }',
    '    pre code { background: transparent; padding: 0; }',
    '    table { border-collapse: collapse; width: 100%; margin: 1em 0; }',
    '    th, td { border: 1px solid #d1d5db; padding: 6px 10px; text-align: left; }',
    '    th { background: #f9fafb; font-weight: 600; }',
    '    blockquote { border-left: 4px solid #cbd5e1; margin: 1em 0; padding: 0.25em 1em; color: #475569; }',
    '    img { max-width: 100%; height: auto; }',
    '  </style>',
    '</head>',
    '<body>',
    bodyHtml,
    '</body>',
    '</html>',
  ].join('\n');
}

const launchOptions = {
  headless: true,
  args: [
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    '--no-first-run',
    '--mute-audio',
    '--renderer-process-limit=1',
  ],
};
if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) {
  launchOptions.executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
}
const browser = await chromium.launch(launchOptions);
try {
  const viewportWidth = 1280;
  const viewportHeight = 960;
  const page = await browser.newPage({
    viewport: { width: viewportWidth, height: viewportHeight },
    javaScriptEnabled: format === 'mermaid' || (action === 'verify' && ['html', 'svg'].includes(format)),
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  const origin = 'https://artifact.invalid';
  const resourceUrl = (relPath) => new URL(relPath.split('/').map(encodeURIComponent).join('/'), origin).href;
  const entryUrl = resourceUrl(entry);
  const localAssets = new Map(assets.map((asset) => [resourceUrl(asset.relPath), asset]));
  const policy = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'";
  const { marked } = format === 'markdown' ? await import(pathToFileURL(require.resolve('marked'))) : {};
  const verifyHtml = format === 'html' && action === 'verify';
  const verifySvg = format === 'svg' && action === 'verify';
  const browserEntryUrl = origin + '/.agy-verify-shell';
  const authoringUrl = entryUrl + '?__agy_verify_manifest=1';
  const viewer = verifyHtml ? await fs.readFile(path.join(inputDir, 'viewer'), 'utf8') : undefined;
  const observations = {
    missing: new Set(), external: new Set(), served: 0, limited: false, requests: 0,
    violations: [], errors: [], ready: false,
  };
  let servedEntry = false;
  let servedViewer = false;
  let servedAuthoring = false;
  if (verifyHtml) {
    if (!viewerPolicy) throw new Error('A viewer CSP is required for HTML verification.');
    const nonce = randomUUID();
    await page.context().exposeBinding('__agyReportVerification', ({ frame }, supplied, kind, detail) => {
      if (supplied !== nonce || frame.parentFrame() !== page.mainFrame() || servedAuthoring) return;
      if (kind === 'ready') observations.ready = true;
      else if (kind === 'csp' && observations.violations.length < 50) observations.violations.push(detail);
      else if (kind === 'error' && observations.errors.length < 25) observations.errors.push(detail);
    });
    await page.context().addInitScript((token) => {
      const send = globalThis.__agyReportVerification;
      send(token, 'ready');
      addEventListener('securitypolicyviolation', (event) => {
        if (event.isTrusted) send(token, 'csp', { directive: event.effectiveDirective, blocked: event.blockedURI.slice(0, 150) });
      });
      addEventListener('error', (event) => {
        if (event.isTrusted && event.message) send(token, 'error', event.message.slice(0, 200));
      });
      addEventListener('unhandledrejection', (event) => {
        if (event.isTrusted) send(token, 'error', String(event.reason).slice(0, 200));
      });
    }, nonce);
  }
  await page.context().route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const query = url.search;
    url.search = '';
    url.hash = '';
    if ((verifyHtml || verifySvg) && ++observations.requests > 1_500) {
      observations.limited = true;
      return route.abort();
    }
    if (req.method() !== 'GET' || url.origin !== origin) {
      if (verifyHtml && observations.external.size < 100) observations.external.add(url.href.slice(0, 200));
      return route.abort();
    }
    if (verifyHtml && req.isNavigationRequest()) {
      if (url.href === browserEntryUrl && req.frame() === page.mainFrame() && !servedViewer) {
        const src = entryUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><iframe sandbox="allow-scripts" src="${src}"></iframe>` });
      }
      if (url.href === entryUrl && req.frame() !== page.mainFrame() && !servedViewer) {
        servedViewer = true;
        return route.fulfill({ contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': viewerPolicy }, body: viewer });
      }
      if (url.href === entryUrl && query === '?__agy_verify_manifest=1' && req.frame() === page.mainFrame() && !servedAuthoring) {
        servedAuthoring = true;
        return route.fulfill({ contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': policy }, body: source });
      }
      return route.abort();
    }
    if (!servedEntry && url.href === entryUrl && req.isNavigationRequest() && req.frame() === page.mainFrame()) {
      servedEntry = true;
      return route.fulfill({
        contentType: verifySvg ? 'image/svg+xml; charset=utf-8' : 'text/html; charset=utf-8',
        headers: { 'content-security-policy': policy },
        body: marked ? wrapMarkdownHtml(marked.parse(source), path.basename(entry)) : source,
      });
    }
    const asset = localAssets.get(url.href);
    if (
      !asset ||
      req.isNavigationRequest() ||
      !['stylesheet', 'image', 'font'].includes(req.resourceType()) ||
      (req.resourceType() === 'stylesheet' && !/\.css$/i.test(asset.relPath))
    ) {
      if (verifyHtml && servedAuthoring && ['stylesheet', 'image', 'font'].includes(req.resourceType()) && observations.missing.size < 100) {
        observations.missing.add(url.pathname.slice(0, 200));
      }
      return route.abort();
    }
    observations.served++;
    return route.fulfill({
      contentType: req.resourceType() === 'stylesheet' ? 'text/css' : asset.mimeType,
      headers: { 'x-content-type-options': 'nosniff', 'content-security-policy': policy },
      body: await fs.readFile(path.join(inputDir, asset.sandboxName)),
    });
  });

  if (verifyHtml || verifySvg) {
    const report = verifyHtml
      ? await verifyHtmlBrowser(page, { entryUrl, browserEntryUrl, authoringUrl, scope: options, observations })
      : await verifySvgBrowser(page, entryUrl, options);
    await fs.writeFile(path.join(outputDir, 'result'), JSON.stringify(report));
  } else if (format === 'mermaid') {
    await page.setContent('<!DOCTYPE html><html><body style="margin:0;padding:16px;background:#ffffff;"><div id="diagram"></div></body></html>');
    await page.addScriptTag({ path: require.resolve('mermaid/dist/mermaid.min.js') });

    if (action === 'verify') {
      const verification = await page.evaluate(async (text) => {
        const mermaid = globalThis.mermaid;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          maxTextSize: 50_000,
          maxEdges: 500,
          flowchart: { htmlLabels: false },
        });
        try {
          const parsed = await mermaid.parse(text);
          return { ok: true, diagramType: parsed?.diagramType ?? null, error: null };
        } catch (err) {
          const message = String(err?.message || err || 'Mermaid syntax error');
          const locLine = err?.hash?.loc?.first_line;
          const matchLine = /line\s+(\d+)/i.exec(message);
          const line = Number.isInteger(locLine) ? locLine : matchLine ? Number(matchLine[1]) : null;
          return { ok: false, diagramType: null, error: { message, line } };
        }
      }, source);
      const issues = verification.ok
        ? []
        : [
            {
              severity: 'error',
              code: 'MERMAID_SYNTAX_ERROR',
              message: verification.error.message,
              ...(verification.error.line ? { location: `line:${verification.error.line}` } : {}),
            },
          ];
      const report = {
        ok: verification.ok,
        coverage: 'complete',
        checks: [
          {
            id: 'mermaid_parser_syntax',
            status: verification.ok ? 'passed' : 'failed',
            evidence: verification.ok
              ? `Mermaid parser accepted diagram${verification.diagramType ? ` (${verification.diagramType})` : ''}.`
              : `Mermaid parser failed${verification.error.line ? ` at line ${verification.error.line}` : ''}: ${verification.error.message}`,
          },
        ],
        issues,
        metrics: {
          lineCount: source.split(/\r?\n/).length,
          ...(verification.diagramType ? { diagramType: verification.diagramType } : {}),
        },
      };
      await fs.writeFile(path.join(outputDir, 'result'), JSON.stringify(report), 'utf8');
      process.exitCode = 0;
    } else {
      const svgText = await page.evaluate(async (text) => {
        const mermaid = globalThis.mermaid;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          maxTextSize: 50_000,
          maxEdges: 500,
          flowchart: { htmlLabels: false },
        });
        const { svg } = await mermaid.render('artifact-diagram', text);
        document.querySelector('#diagram').innerHTML = svg;
        return svg;
      }, source);

      if (action === 'export' && targetFormat === 'svg') {
        await fs.writeFile(path.join(outputDir, 'result'), svgText, 'utf8');
      } else {
        const clip = computeClip(region, viewportWidth, viewportHeight);
        await page.screenshot({
          path: path.join(outputDir, 'result'),
          type: 'png',
          animations: 'disabled',
          timeout: 10_000,
          ...(clip ? { clip } : {}),
        });
      }
    }
  } else if (format === 'html' || format === 'markdown') {
    await page.goto(entryUrl, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    if (format === 'markdown' && action === 'export' && targetFormat === 'pdf') {
      await page.pdf({
        path: path.join(outputDir, 'result'),
        format: 'A4',
        printBackground: true,
        margin: { top: '16mm', right: '14mm', bottom: '16mm', left: '14mm' },
      });
    } else {
      const clip = computeClip(region, viewportWidth, viewportHeight);
      await page.screenshot({
        path: path.join(outputDir, 'result'),
        type: 'png',
        animations: 'disabled',
        timeout: 10_000,
        ...(clip ? { clip } : {}),
      });
    }
  } else {
    throw new Error('Unsupported web rendering format');
  }
} finally {
  await browser.close();
}
