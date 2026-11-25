import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const inputDir = process.env.AGY_WORKER_IN_DIR;
const outputDir = process.env.AGY_WORKER_OUT_DIR;
const runtimeDir = process.env.AGY_DOC_RUNTIME_DIR;
const require = createRequire(path.join(runtimeDir, 'node/package.json'));
const { chromium } = require('playwright');

const { format } = JSON.parse(await fs.readFile(path.join(inputDir, 'request.json'), 'utf8'));
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
  await page.route('**/*', (route) => route.abort());
  const policy = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; object-src 'none'; base-uri 'none'\">";
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
    const { marked } = format === 'markdown' ? await import(pathToFileURL(require.resolve('marked'))) : {};
    await page.setContent(policy + (marked ? marked.parse(source) : source), { waitUntil: 'domcontentloaded' });
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
