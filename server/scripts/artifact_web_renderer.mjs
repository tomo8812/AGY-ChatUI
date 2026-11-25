import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const inputDir = process.env.AGY_WORKER_IN_DIR;
const outputDir = process.env.AGY_WORKER_OUT_DIR;
const runtimeDir = process.env.AGY_DOC_RUNTIME_DIR;
const require = createRequire(path.join(runtimeDir, 'node/package.json'));
const { chromium } = require('playwright');

const { format, entry = "index.html", assets = [] } = JSON.parse(await fs.readFile(path.join(inputDir, 'request.json'), 'utf8'));
const source = await fs.readFile(path.join(inputDir, 'document'), 'utf8');
if (source.length > 1_000_000) throw new Error('Source exceeds the rendering limit');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 960 },
    javaScriptEnabled: format === 'mermaid',
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  const origin = 'https://artifact.invalid';
  const resourceUrl = (relPath) => new URL(relPath.split('/').map(encodeURIComponent).join('/'), origin).href;
  const entryUrl = resourceUrl(entry);
  const localAssets = new Map(assets.map((asset) => [resourceUrl(asset.relPath), asset]));
  const policy = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'";
  const { marked } = format === 'markdown' ? await import(pathToFileURL(require.resolve('marked'))) : {};
  let servedEntry = false;
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    url.search = '';
    url.hash = '';
    if (request.method() !== 'GET' || url.origin !== origin) return route.abort();
    if (!servedEntry && url.href === entryUrl && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      servedEntry = true;
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        headers: { 'content-security-policy': policy },
        body: marked ? marked.parse(source) : source,
      });
    }
    const asset = localAssets.get(url.href);
    if (!asset || request.isNavigationRequest() || !['stylesheet', 'image', 'font'].includes(request.resourceType()) ||
        (request.resourceType() === 'stylesheet' && !/\.css$/i.test(asset.relPath))) {
      return route.abort();
    }
    return route.fulfill({
      contentType: request.resourceType() === 'stylesheet' ? 'text/css' : asset.mimeType,
      headers: { 'x-content-type-options': 'nosniff', 'content-security-policy': policy },
      body: await fs.readFile(path.join(inputDir, asset.sandboxName)),
    });
  });
  if (format === 'mermaid') {
    await page.setContent('<div id="diagram"></div>');
    await page.addScriptTag({ path: require.resolve('mermaid/dist/mermaid.min.js') });
    await page.evaluate(async (text) => {
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
    }, source);
  } else if (format === 'html' || format === 'markdown') {
    await page.goto(entryUrl, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
  } else {
    throw new Error('Unsupported web rendering format');
  }
  await page.screenshot({
    path: path.join(outputDir, 'result'),
    type: 'png',
    animations: 'disabled',
    timeout: 10_000,
  });
} finally {
  await browser.close();
}
