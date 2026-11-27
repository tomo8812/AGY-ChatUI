import { expect, test } from '@playwright/test';
import { createTestServer, seedAuthenticatedMockProfile, TestApiClient } from '../server/tests/helpers/test-harness.js';

test('LAN HTTP submits a UUID and discards source selections returned out of order', async ({ page }, info) => {
  test.skip(info.project.name !== 'pc-chromium');
  const server = await createTestServer({ INSTALL_DOC_RUNTIME: '0' });
  try {
    const client = new TestApiClient(server.baseUrl);
    const { data: { user } } = await client.request<{ user: { id: string } }>('POST', '/api/auth/register', {
      username: 'lan', displayName: 'LAN', password: 'password123',
    });
    const userId = user.id;
    seedAuthenticatedMockProfile(server.ctx, userId);
    const { data: { chat } } = await client.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'LAN requests' });
    const { artifact } = await server.ctx.artifactService.createArtifact({
      userId, chatId: chat.id, scopeKind: 'chat', relPath: 'notes.txt', actorKind: 'user', actorId: userId,
      content: Buffer.from('First target\nSecond target\nThird target'),
    });
    const lan = 'http://workspace.test';
    const releaseFirst = Promise.withResolvers<void>();
    const firstReceived = Promise.withResolvers<void>();
    const firstReturned = Promise.withResolvers<void>();
    let id = '';
    await page.addInitScript(value => {
      if (location.origin !== 'http://workspace.test') return;
      Object.assign(window, {
        __pr3aFixtureArtifact: value,
        __pr3aFixtureRichDocument: {
          schemaVersion: 1,
          root: { id: 'copy', type: 'button', label: 'Copy selection', onClick: [{ type: 'copy_text', textExpr: '"Selected text"' }] },
        },
      });
    }, artifact);
    await page.route(lan + '/**', async route => {
      const req = route.request();
      const url = new URL(req.url());
      const backend = url.pathname.startsWith('/api/');
      const first = backend && url.pathname.endsWith('/range') &&
        url.searchParams.get('targetHashes') === 'true' && url.searchParams.get('startLine') === '1';
      if (first) { firstReceived.resolve(); await releaseFirst.promise; }
      if (url.pathname.endsWith('/send-batch')) id = req.postDataJSON().clientMessageId;
      const result = await route.fetch({
        url: (backend ? server.baseUrl : 'http://127.0.0.1:4174') + url.pathname + url.search,
        headers: backend ? { ...req.headers(), cookie: client.cookieHeader, 'x-csrf-token': decodeURIComponent(client.csrfToken) } : undefined,
      });
      await route.fulfill({ response: result });
      if (first) firstReturned.resolve();
    });
    await page.goto(lan + '/?kind=code');
    expect(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID, random: typeof crypto.getRandomValues })))
      .toEqual({ secure: false, uuid: 'undefined', random: 'function' });
    await page.getByRole('button', { name: '依頼', exact: true }).click();
    const pin = page.getByRole('button', { name: '選択行を対象にする' });
    await page.locator('.cm-line').nth(0).click();
    await pin.click();
    await firstReceived.promise;
    await page.locator('.cm-line').nth(1).click();
    await pin.click();
    await expect(page.locator('.workspace-selection')).toContainText('2–2 行');
    releaseFirst.resolve();
    await firstReturned.promise;

    await page.getByRole('textbox', { name: '変更内容' }).fill('Review the second line');
    await page.getByRole('button', { name: '依頼を追加' }).click();
    await expect(page.locator('.workspace-request-item')).toContainText('Review the second line');
    const [request] = server.ctx.editRequestService.listRequests(userId, chat.id);
    expect(request.selector).toMatchObject({ startLine: 2, endLine: 2 });
    await page.getByRole('button', { name: '対象へ移動' }).click();
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toContain('Second target');

    await page.getByRole('button', { name: '編集依頼を一括送信' }).click();
    await expect(page.locator('.workspace-request-item')).toContainText('送信済み');
    expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(server.ctx.editRequestService.getRequest(userId, chat.id, request.id)?.sentMessageId)
      .toBe(server.ctx.db.findMessageByClientId(userId, chat.id, id)?.id);

    await page.goto(lan + '/?kind=rich');
    expect(await page.evaluate(() => typeof navigator.clipboard)).toBe('undefined');
    await page.evaluate(() => {
      document.execCommand = command => {
        const field = document.activeElement;
        return command === 'copy' && field instanceof HTMLTextAreaElement &&
          field.value.slice(field.selectionStart, field.selectionEnd) === 'Selected text';
      };
    });
    await page.getByRole('button', { name: 'Copy selection' }).click();
    await expect(page.getByRole('status')).toContainText('コピーしました。');
    await page.evaluate(() => { document.execCommand = () => false; });
    await page.getByRole('button', { name: 'Copy selection' }).click();
    await expect(page.getByRole('alert')).toContainText('コピーできませんでした。');
  } finally {
    await server.cleanup();
  }
});
