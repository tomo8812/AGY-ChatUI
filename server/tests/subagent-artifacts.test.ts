import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mockArtifactBytes } from '../src/acp/mock-artifact-fixtures.js';
import type { ArtifactRecord, MessageRecord } from '../src/types.js';
import { createTestServer, registerAndBindAgy } from './helpers/test-harness.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function references(text: string): string[] {
  return [...text.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]);
}

describe('subagent artifact delivery across file formats and ACP channels', () => {
  it('preserves links, bytes, metadata and isolation after end_turn across every content channel', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);
    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    const { client: bob } = await registerAndBindAgy(srv.baseUrl, 'bob', 'user:bob@gmail.com');
    await alice.connectWs();
    cleanups.push(() => alice.closeWs());
    const chat = (await alice.request<{ chat: { id: string; workspaceDir: string } }>(
      'POST', '/api/chats', { title: 'All subagent artifacts' }
    )).data.chat;
    await alice.request('POST', `/api/chats/${chat.id}/messages`, { text: '[SUBAGENT_FILES]' });
    await alice.waitForFrame(frame => frame.kind === 'event' &&
      (frame.event as { type: string }).type === 'run.finished');
    await alice.waitForFrame(frame => {
      const event = frame.event as { type: string; payload?: { message?: MessageRecord } } | undefined;
      const message = event?.payload?.message;
      return event?.type === 'message.updated' && message?.artifactIds.length === 21 &&
        message.toolCalls.some(tool => tool.subagentState === 'idle');
    }, 15000);
    const detail = (await alice.request<{ messages: MessageRecord[]; artifacts: ArtifactRecord[] }>(
      'GET', `/api/chats/${chat.id}`
    )).data;
    const message = detail.messages.find(item => item.role === 'assistant')!;
    const subagent = message.toolCalls.find(tool => tool.subagentContentText)!;
    const artifacts = detail.artifacts;
    expect(artifacts).toHaveLength(21);
    expect(subagent.status).toBe('completed');
    expect(subagent.subagentState).toBe('idle');
    const channels: Record<string, string> = {
      parent: message.contentText,
      parentThoughts: message.thoughtsText,
      child: subagent.subagentContentText!,
      thoughts: subagent.subagentThoughtsText!,
      tools: subagent.subagentToolCalls!.map(tool => tool.contentText).join('\n'),
      sessions: message.sessionMessages!.map(item => item.contentText).join('\n'),
    };
    for (const [channel, text] of Object.entries(channels)) {
      expect(text, channel).not.toMatch(/\.gemini|generated\/\//);
      expect(references(text).length, channel).toBeGreaterThanOrEqual(channel === 'parentThoughts' ? 8 : 20);
      for (const reference of new Set(references(text))) {
        const response = await alice.request<{ artifact: ArtifactRecord; previewUrl: string }>(
          'POST', `/api/chats/${chat.id}/resolve-link`, { reference }
        );
        expect(response.status, `${channel}: ${reference}`).toBe(200);
        const bytes = await fetch(`${srv.baseUrl}${response.data.previewUrl}`, {
          headers: { Cookie: alice.cookieHeader },
        });
        expect(bytes.status).toBe(200);
        expect(Buffer.from(await bytes.arrayBuffer())).toEqual(
          fs.readFileSync(path.join(chat.workspaceDir, response.data.artifact.relPath))
        );
      }
    }
    const previewKinds = {
      png: 'image', svg: 'svg', pdf: 'pdf', docx: 'docx', xlsx: 'table', pptx: 'pptx',
      zip: 'binary', md: 'markdown', csv: 'table', html: 'html', wav: 'audio', mp4: 'video',
    };
    for (const [ext, previewKind] of Object.entries(previewKinds)) {
      const filename = `report (v1) [final] #50%.${ext}`;
      const artifact = artifacts.find(item => item.filename === filename)!;
      expect(artifact, ext).toBeDefined();
      expect(artifact.previewKind).toBe(previewKind);
      expect(fs.readFileSync(path.join(chat.workspaceDir, artifact.relPath))).toEqual(mockArtifactBytes(ext as Parameters<typeof mockArtifactBytes>[0]));
      const legacyUri = `file:///workspace/generated//brain/old-session/${encodeURIComponent(filename)}`;
      const legacy = await alice.request<{ artifact: ArtifactRecord }>(
        'POST', `/api/chats/${chat.id}/resolve-link`, { reference: legacyUri }
      );
      expect(legacy.status, ext).toBe(200);
      expect(legacy.data.artifact.id).toBe(artifact.id);
    }
    for (const tool of subagent.subagentToolCalls!.filter(tool => tool.locations?.length)) {
      const location = tool.locations![0].path;
      expect(location).not.toContain('.gemini');
      expect((tool.rawOutput as { path: string }).path).toBe(location);
      expect((await alice.request('POST', `/api/chats/${chat.id}/resolve-link`, { reference: location })).status).toBe(200);
    }
    const inlinePdf = artifacts.find(item => item.filename === 'inline document.bin')!;
    expect(inlinePdf.mimeType).toBe('application/pdf');
    expect(inlinePdf.previewKind).toBe('pdf');
    expect(fs.readFileSync(path.join(chat.workspaceDir, inlinePdf.relPath))).toEqual(mockArtifactBytes('pdf'));
    const shared = artifacts.filter(item => item.filename === 'shared.bin');
    expect(shared).toHaveLength(2);
    expect(shared.map(item => item.mimeType).sort()).toEqual(['application/octet-stream', 'image/png']);
    expect(new Set(shared.map(item => item.relPath)).size).toBe(2);
    const empty = artifacts.find(item => item.filename === 'empty.txt')!;
    expect(empty.sizeBytes).toBe(0);
    expect(artifacts.filter(item => item.mimeType === 'image/png' && item.filename === 'generated.png')).toHaveLength(2);
    const inlineImageBytes = artifacts.filter(item => item.filename === 'generated.png').map(item =>
      fs.readFileSync(path.join(chat.workspaceDir, item.relPath)).toString('base64')
    );
    expect(inlineImageBytes.sort()).toEqual([mockArtifactBytes('png').toString('base64'), mockArtifactBytes('pngAlternate').toString('base64')].sort());
    const declared = artifacts.find(item => item.filename === 'declared image.bin')!;
    expect(declared.mimeType).toBe('image/png');
    expect(declared.previewKind).toBe('image');
    expect(fs.readFileSync(path.join(chat.workspaceDir, declared.relPath))).toEqual(mockArtifactBytes('png'));
    expect(alice.wsFrames.some(frame => {
      const event = frame.event as { type: string; payload?: { artifact?: ArtifactRecord } } | undefined;
      const artifact = event?.payload?.artifact;
      return event?.type === 'artifact.created' && artifact?.id === declared.id &&
        artifact.filename === 'declared image.bin' && artifact.mimeType === 'image/png';
    })).toBe(true);
    expect(message.sessionMessages!.every(item => item.done)).toBe(true);
    const otherChat = (await alice.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'Other chat' })).data.chat;
    for (const artifact of artifacts) {
      expect((await bob.request('GET', `/api/files/${artifact.id}/content`)).status).toBe(404);
      expect((await alice.request('POST', `/api/chats/${otherChat.id}/resolve-link`, { reference: artifact.relPath })).status).toBe(404);
    }
  });
});
