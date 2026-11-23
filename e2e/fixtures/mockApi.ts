import type { Page } from '@playwright/test';
import { buildSyntheticPdf, buildSyntheticPng, buildSyntheticSvg } from './syntheticAssets';

const NOW = 1763865600000;

export const FIXTURE_IDS = {
  chatId: 'chat_layout_audit_01',
  projectId: 'proj_layout_audit_01',
  pdfMixedId: 'art_pdf_mixed_120p',
  pptxId: 'art_pptx_landscape_16x9',
  imageId: 'art_img_1600x900',
  svgId: 'art_svg_1200x800',
  codeDiffId: 'art_code_long_diff',
} as const;

// Pre-build synthetic binary assets once per worker for fast test execution
const MIXED_120P_PDF = buildSyntheticPdf(
  Array.from({ length: 120 }, (_, idx) =>
    idx % 2 === 0
      ? { width: 595, height: 842, label: `Portrait Page ${idx + 1}` }
      : { width: 842, height: 595, label: `Landscape Page ${idx + 1}` }
  )
);

const PPTX_16X9_PDF = buildSyntheticPdf(
  Array.from({ length: 10 }, (_, idx) => ({
    width: 960,
    height: 540,
    label: `Slide ${idx + 1} - 16:9 Executive Review`,
  }))
);

const WIDE_PNG = buildSyntheticPng(1600, 900);
const ARCH_SVG = buildSyntheticSvg(1200, 800);

const SAMPLE_CODE = [
  'export function computeLayoutMetrics(width: number, height: number): { ratio: number; label: string } {',
  '  const ratio = Number((width / Math.max(1, height)).toFixed(3));',
  '  return { ratio, label: `${width}x${height} (${ratio})` };',
  '}',
].join('\n');

const SAMPLE_DIFF = [
  '--- a/src/layoutMetrics.ts',
  '+++ b/src/layoutMetrics.ts',
  '@@ -1,4 +1,5 @@',
  ' export function computeLayoutMetrics(width: number, height: number) {',
  '-  return width / height;',
  '+  const ratio = Number((width / Math.max(1, height)).toFixed(3));',
  '+  return { ratio, label: `${width}x${height}` };',
  ' }',
].join('\n');

export const FIXTURE_ARTIFACTS = [
  {
    id: FIXTURE_IDS.pdfMixedId,
    userId: 'user_1',
    chatId: FIXTURE_IDS.chatId,
    messageId: 'msg_assistant_1',
    runId: 'run_1',
    relPath: 'reports/2026_quarterly_mixed_orientation_document_120pages.pdf',
    filename: '2026_quarterly_mixed_orientation_document_120pages.pdf',
    mimeType: 'application/pdf',
    sizeBytes: MIXED_120P_PDF.length,
    sha256: 'a'.repeat(64),
    source: 'generated' as const,
    previewKind: 'pdf' as const,
    diffPatch: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: FIXTURE_IDS.pptxId,
    userId: 'user_1',
    chatId: FIXTURE_IDS.chatId,
    messageId: 'msg_assistant_1',
    runId: 'run_1',
    relPath: 'slides/2026年度_全社AI戦略レビュー_最終確定版_VeryLongPresentationName_v12.pptx',
    filename: '2026年度_全社AI戦略レビュー_最終確定版_VeryLongPresentationName_v12.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    sizeBytes: PPTX_16X9_PDF.length,
    sha256: 'b'.repeat(64),
    source: 'generated' as const,
    previewKind: 'pptx' as const,
    diffPatch: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: FIXTURE_IDS.imageId,
    userId: 'user_1',
    chatId: FIXTURE_IDS.chatId,
    messageId: 'msg_assistant_1',
    runId: 'run_1',
    relPath: 'images/dashboard_architecture_overview_1600x900_highres.png',
    filename: 'dashboard_architecture_overview_1600x900_highres.png',
    mimeType: 'image/png',
    sizeBytes: WIDE_PNG.length,
    sha256: 'c'.repeat(64),
    source: 'generated' as const,
    previewKind: 'image' as const,
    diffPatch: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: FIXTURE_IDS.svgId,
    userId: 'user_1',
    chatId: FIXTURE_IDS.chatId,
    messageId: 'msg_assistant_1',
    runId: 'run_1',
    relPath: 'diagrams/system_topology_vector_diagram_1200x800.svg',
    filename: 'system_topology_vector_diagram_1200x800.svg',
    mimeType: 'image/svg+xml',
    sizeBytes: Buffer.byteLength(ARCH_SVG, 'utf8'),
    sha256: 'd'.repeat(64),
    source: 'generated' as const,
    previewKind: 'svg' as const,
    diffPatch: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: FIXTURE_IDS.codeDiffId,
    userId: 'user_1',
    chatId: FIXTURE_IDS.chatId,
    messageId: 'msg_assistant_1',
    runId: 'run_1',
    relPath: 'src/components/very_long_module_name_for_header_overflow_verification_service.ts',
    filename: 'very_long_module_name_for_header_overflow_verification_service.ts',
    mimeType: 'text/typescript',
    sizeBytes: Buffer.byteLength(SAMPLE_CODE, 'utf8'),
    sha256: 'e'.repeat(64),
    source: 'generated' as const,
    previewKind: 'markdown' as const,
    diffPatch: SAMPLE_DIFF,
    createdAt: NOW,
    updatedAt: NOW,
  },
];

const LONG_MARKDOWN = [
  '# コンテンツ専用ズームおよびレスポンシブレイアウト検証レポート',
  '',
  'このメッセージは、チャット本文のみを拡大縮小した際にヘッダー・サイドバー・入力欄の配置が一切崩れないことを確認するためのサンプル本文です。長い日本語テキストや英数字トークン `super_long_identifier_without_spaces_for_wrap_check_2026_v1` が混在しても意図しない横スクロールが発生しないことを検証します。',
  '',
  '## 検証対象サマリー',
  '',
  '- PC標準解像度 (1280×720 / 1366×768 / 1440×900 / 1920×1080 / 2560×1440)',
  '- iPhone標準ポートレート解像度 (375×812 / 390×844 / 430×932)',
  '- PDF / PPTX の縦長・横長混在および複数ページ連続スクロール',
  '- 画像 (PNG) および SVG ベクター図のビューアー内ズームとパン操作',
  '',
  '| 画面 | 解像度 | 期待される挙動 | 備考 |',
  '| --- | --- | --- | --- |',
  '| チャット本文 | 全対応解像度 | 文字サイズのみ拡大縮小しUI配置を維持 | Ctrl+Wheel / ピンチ対応 |',
  '| PDF / PPTX | 全対応解像度 | ビューアー内で拡大縮小・ドラッグ移動 | 連続ページ閲覧を維持 |',
  '| 画像 / SVG | 全対応解像度 | 画面に合わせる・拡大縮小・パン操作 | 横切れ・過度な縮小なし |',
  '',
  '```typescript',
  SAMPLE_CODE,
  '```',
  '',
  '各成果物カードから PDF・PPTX・画像・SVG・差分付きファイルを開いてズームおよびレイアウト検査を実行できます。',
].join('\n');

export interface MockApiOptions {
  authenticated?: boolean;
}

export async function installMockApi(page: Page, options: MockApiOptions = {}): Promise<void> {
  const authenticated = options.authenticated ?? true;

  // Intercept WebSocket connections directly so static preview never hits the unconfigured backend WS proxy
  await page.routeWebSocket('**/api/ws*', (ws) => {
    ws.close({ code: 1006, reason: 'Mocked offline WS in UI layout test' });
  });

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const pathname = url.pathname;

    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(body),
      });

    if (pathname === '/api/auth/bootstrap') {
      if (!authenticated) {
        return json({
          userCount: 1,
          allowPublicSignup: true,
          agyMode: 'mock',
          buildId: 'test-build-001',
          version: '1.0.0',
          shortSha: 'abc1234',
          authenticated: false,
          user: null,
          agyProfile: null,
          preferences: null,
          loginFlow: null,
          sandbox: { mode: 'auto', active: true, backend: 'bwrap', reason: null, remediation: null },
        });
      }
      return json({
        userCount: 2,
        allowPublicSignup: true,
        agyMode: 'mock',
        buildId: 'test-build-001',
        version: '1.0.0',
        shortSha: 'abc1234',
        authenticated: true,
        user: {
          id: 'user_1',
          username: 'qa_admin',
          displayName: 'QA Administrator',
          role: 'admin',
          createdAt: NOW,
          updatedAt: NOW,
        },
        agyProfile: {
          userId: 'user_1',
          profileDir: '/tmp/qa_home',
          authStatus: 'authenticated',
          authMethod: 'oauth-personal',
          accountLabel: 'qa.administrator@example.com',
          lastVerifiedAt: NOW,
          lastError: null,
          updatedAt: NOW,
        },
        preferences: {
          userId: 'user_1',
          theme: 'light',
          notifyOnResponse: false,
          hapticFeedback: false,
          defaultModelId: 'gemini-2.5-pro',
          defaultEffortValue: 'medium',
          updatedAt: NOW,
        },
        loginFlow: {
          userId: 'user_1',
          status: 'idle',
          authUrl: null,
          outputLines: [],
          error: null,
          startedAt: NOW,
          updatedAt: NOW,
        },
        sandbox: { mode: 'auto', active: true, backend: 'bwrap', reason: null, remediation: null },
      });
    }

    if (pathname === '/api/projects') {
      return json({
        projects: [
          {
            id: FIXTURE_IDS.projectId,
            userId: 'user_1',
            name: '2026年度 全社アーキテクチャ刷新およびUI品質保証プロジェクト',
            description: 'PC・iPhone対応レイアウトおよびビューアー品質基準の共有資料',
            instructions: '日本語で簡潔に回答してください。',
            contextVersion: 2,
            files: [
              {
                id: 'pf_1',
                filename: 'design_guidelines_v2.md',
                relPath: 'design_guidelines_v2.md',
                mimeType: 'text/markdown',
                sizeBytes: 2048,
                sha256: '1'.repeat(64),
                createdAt: NOW,
              },
            ],
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      });
    }

    if (pathname === '/api/chats') {
      return json({
        chats: [
          {
            id: FIXTURE_IDS.chatId,
            userId: 'user_1',
            projectId: FIXTURE_IDS.projectId,
            title: '2026年度 コンテンツ専用ズーム・PDF/PPTX/画像ビューアーUI検査スレッド',
            acpSessionId: 'sess_1',
            workspaceDir: '/tmp/ws_1',
            projectContextVersion: 2,
            modelId: 'gemini-2.5-pro',
            effortValue: 'medium',
            availableCommands: [
              { name: 'review', description: '変更内容をレビューする' },
              { name: 'summarize', description: '要点を要約する' },
            ],
            status: 'idle',
            contextUsedTokens: 18500,
            contextSizeTokens: 200000,
            lastMessageAt: NOW,
            createdAt: NOW,
            updatedAt: NOW,
          },
          {
            id: 'chat_secondary_02',
            userId: 'user_1',
            projectId: null,
            title: '通常のチャットスレッド（短め）',
            acpSessionId: 'sess_2',
            workspaceDir: '/tmp/ws_2',
            projectContextVersion: 0,
            modelId: 'gemini-2.5-pro',
            effortValue: 'medium',
            availableCommands: [],
            status: 'idle',
            contextUsedTokens: 1000,
            contextSizeTokens: 200000,
            lastMessageAt: NOW - 3600_000,
            createdAt: NOW - 3600_000,
            updatedAt: NOW - 3600_000,
          },
        ],
      });
    }

    if (pathname === `/api/chats/${FIXTURE_IDS.chatId}`) {
      return json({
        chat: {
          id: FIXTURE_IDS.chatId,
          userId: 'user_1',
          projectId: FIXTURE_IDS.projectId,
          title: '2026年度 コンテンツ専用ズーム・PDF/PPTX/画像ビューアーUI検査スレッド',
          acpSessionId: 'sess_1',
          workspaceDir: '/tmp/ws_1',
          projectContextVersion: 2,
          modelId: 'gemini-2.5-pro',
          effortValue: 'medium',
          availableCommands: [{ name: 'review', description: '変更内容をレビューする' }],
          status: 'idle',
          contextUsedTokens: 18500,
          contextSizeTokens: 200000,
          createdAt: NOW,
          updatedAt: NOW,
        },
        messages: [
          {
            id: 'msg_user_1',
            chatId: FIXTURE_IDS.chatId,
            userId: 'user_1',
            clientMessageId: null,
            runId: 'run_1',
            role: 'user',
            contentText:
              'PDF（縦横混在120ページ）、PPTX（16:9横長スライド）、高解像度PNG画像、SVG図、差分付きファイルを生成して確認させてください。',
            thoughtsText: '',
            toolCalls: [],
            attachments: [],
            artifactIds: [],
            status: 'completed',
            errorMessage: null,
            createdAt: NOW - 60_000,
            updatedAt: NOW - 60_000,
          },
          {
            id: 'msg_assistant_1',
            chatId: FIXTURE_IDS.chatId,
            userId: 'user_1',
            clientMessageId: null,
            runId: 'run_1',
            role: 'assistant',
            contentText: LONG_MARKDOWN,
            thoughtsText: '',
            toolCalls: [],
            attachments: [],
            artifactIds: FIXTURE_ARTIFACTS.map((a) => a.id),
            status: 'completed',
            errorMessage: null,
            createdAt: NOW - 30_000,
            updatedAt: NOW - 30_000,
          },
        ],
        artifacts: FIXTURE_ARTIFACTS,
        pendingPermissions: [],
        pendingElicitations: [],
        activeRun: null,
        project: {
          id: FIXTURE_IDS.projectId,
          userId: 'user_1',
          name: '2026年度 全社アーキテクチャ刷新およびUI品質保証プロジェクト',
          description: 'PC・iPhone対応レイアウトおよびビューアー品質基準の共有資料',
          instructions: '日本語で簡潔に回答してください。',
          contextVersion: 2,
          files: [],
          createdAt: NOW,
          updatedAt: NOW,
        },
        sessionOptions: {
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'gemini-2.5-pro',
              options: [
                { value: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
                { value: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
              ],
            },
            {
              id: 'effort',
              name: 'Effort',
              category: 'thought_level',
              type: 'select',
              currentValue: 'medium',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' },
                { value: 'high', name: 'High' },
              ],
            },
          ],
          modelOptionId: 'model',
          effortOptionId: 'effort',
          currentModelId: 'gemini-2.5-pro',
          currentEffortValue: 'medium',
          availableCommands: [{ name: 'review', description: '変更内容をレビューする' }],
        },
      });
    }

    if (pathname === '/api/quota' || pathname === '/api/quota/refresh') {
      return json({
        quota: {
          userId: 'user_1',
          status: 'ok',
          buckets: [
            {
              model: 'gemini-2.5-pro',
              group: 'Gemini',
              windowLabel: '5h',
              remainingPercent: 84,
              usedPercent: 16,
              remainingLabel: '84%',
              resetAt: '2026-11-23T08:00:00Z',
              status: 'ok',
            },
          ],
          rawSummary: 'Gemini 2.5 Pro: 84%',
          errorMessage: null,
          fetchedAt: NOW,
        },
      });
    }

    if (pathname === '/api/agy/agent-mode') {
      return json({ agentMode: 'agent' });
    }

    if (pathname === '/api/agy/options') {
      return json({
        sessionOptions: {
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'gemini-2.5-pro',
              options: [{ value: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }],
            },
            {
              id: 'effort',
              name: 'Effort',
              category: 'thought_level',
              type: 'select',
              currentValue: 'medium',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' },
                { value: 'high', name: 'High' },
              ],
            },
          ],
          modelOptionId: 'model',
          effortOptionId: 'effort',
          currentModelId: 'gemini-2.5-pro',
          currentEffortValue: 'medium',
          availableCommands: [],
        },
      });
    }

    if (pathname === '/api/notifications/config') {
      return json({ vapidPublicKey: '', subscriptionCount: 0 });
    }

    if (pathname === '/api/skills') {
      const sampleSkills = [
        {
          slug: 'pdf-analysis',
          scope: 'global',
          origin: 'builtin',
          readOnly: true,
          enabled: true,
          name: 'PDF Document Analysis & Layout Verification',
          description: 'PDF・プレゼン資料の解析とレイアウト検証を行う組み込みスキルです。',
          path: '/tmp/skills/global/pdf-analysis/SKILL.md',
          updatedAt: NOW,
          fileCount: 2,
        },
        {
          slug: 'custom-code-review',
          scope: 'global',
          origin: 'custom',
          readOnly: false,
          enabled: true,
          name: 'Custom Code Review Checklist',
          description: 'チーム標準のレビュー観点を確認するカスタムスキル。',
          path: '/tmp/skills/global/custom-code-review/SKILL.md',
          updatedAt: NOW,
          fileCount: 1,
        },
      ];
      return json({
        global: sampleSkills,
        project: [],
        workspace: [],
        projectId: FIXTURE_IDS.projectId,
        chatId: FIXTURE_IDS.chatId,
        templates: [
          {
            id: 'tpl-review',
            name: 'コードレビュー',
            description: 'コード品質チェック用テンプレート',
            suggestedSlug: 'code-review',
            content: '# Code Review\n',
          },
        ],
        commands: [
          { name: 'pdf-analysis', description: 'PDF・プレゼン資料の解析' },
          { name: 'custom-code-review', description: 'コードレビュー確認' },
        ],
      });
    }

    if (pathname.startsWith('/api/skills/')) {
      return json({
        skill: {
          slug: 'pdf-analysis',
          scope: 'global',
          origin: 'builtin',
          readOnly: true,
          enabled: true,
          name: 'PDF Document Analysis & Layout Verification',
          description: 'PDF・プレゼン資料の解析とレイアウト検証を行う組み込みスキルです。',
          path: '/tmp/skills/global/pdf-analysis/SKILL.md',
          updatedAt: NOW,
          fileCount: 2,
          content: '# PDF Analysis\n\nVerify layout and zoom behavior cleanly.',
          files: [{ relPath: 'SKILL.md', sizeBytes: 120, updatedAt: NOW }],
        },
      });
    }

    if (pathname === '/api/mcp/servers') {
      return json({
        callbackUrl: 'http://127.0.0.1:4173/api/mcp/oauth/callback',
        servers: [
          {
            id: 'mcp_1',
            name: 'github-mcp-server',
            transport: 'http',
            enabled: true,
            url: 'https://mcp.example.com/github',
            headers: [],
            env: [],
            args: [],
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      });
    }

    if (pathname === `/api/files/${FIXTURE_IDS.pdfMixedId}/content`) {
      return route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        body: MIXED_120P_PDF,
      });
    }

    if (pathname === `/api/files/${FIXTURE_IDS.pptxId}/content`) {
      return route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        body: PPTX_16X9_PDF,
      });
    }

    if (pathname === `/api/files/${FIXTURE_IDS.imageId}/content`) {
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: WIDE_PNG,
      });
    }

    if (pathname === `/api/files/${FIXTURE_IDS.svgId}/content`) {
      return route.fulfill({
        status: 200,
        contentType: 'image/svg+xml; charset=utf-8',
        body: ARCH_SVG,
      });
    }

    if (pathname === `/api/files/${FIXTURE_IDS.codeDiffId}/content`) {
      return route.fulfill({
        status: 200,
        contentType: 'text/markdown; charset=utf-8',
        body: LONG_MARKDOWN,
      });
    }

    if (pathname === '/api/health') {
      return json({ ok: true, buildId: 'test-build-001' });
    }

    return json({ ok: true });
  });
}
