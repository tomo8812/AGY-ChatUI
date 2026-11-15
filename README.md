# Antigravity Chat UI

Google の公式 CLI（[`agy`](https://antigravity.google)）を **無改変のまま** ACP (`@agentclientprotocol/sdk`) でラップし、PC・iPhone ブラウザ / PWA から快適かつ安全に利用できる ChatGPT ライクなセルフホスト型 AI チャットワークスペースです。

## 主な特徴

- **公式バイナリ＆プロトコル完全準拠**
  - 無改変の `agy acp` を stdio (`@agentclientprotocol/sdk` v1/stable) で実行。
  - トークンファイルの直接読取・復号・外部内部 API の直叩きは一切行いません。
- **Webログイン ⇔ サーバー上 `agy` アカウントの 1:1 紐付け**
  - Web 側はサーバー管理の軽量認証（`scrypt` + `HttpOnly` セッション Cookie + CSRF 検証）。
  - ログインした Web ユーザーごとに完全に分離された専用プロファイル（`DATA_ROOT/profiles/<userId>/agy-home`）を持ち、初回チャット前に **認証コード貼り付け**（`agy acp --login` の PTY 出力から Google OAuth URL を発行し、ブラウザ認証後にコードを貼り付ける方式）または任意の `GEMINI_API_KEY` で公式認証を完了します。
  - 複数ユーザーが異なる Antigravity / Google アカウントで同時に独立してチャット実行可能です。
- **ChatGPT ライクな集中 UI ＆ モバイル/PWA 対応**
  - Vanilla CSS（ライト / ダーク / システム追従テーマ）、レスポンシブ設計（iPhone Safari「ホーム画面に追加」PWA 対応・ノッチ領域対応）。
  - モデル切替 ＆ ACP `configOptions` に準拠した動的 Effort（推論レベル）連動。
  - ヘッダー統合の利用枠（Quota）モニター（公式 `agy -p /usage --output-format json` を手動オンデマンドで取得し、取得不可時は偽装せず正直に表示）。
- **プロジェクト（共有カスタム指示 ＆ 資料）**
  - プロジェクト配下のチャット作成時に資料を `.project-context/` へ Copy-on-Write で複製するため、チャット内の編集で原紙や別チャットが汚染されません。
  - プロジェクト更新時は既存チャットに「最新化」バナーを表示し、ユーザー操作で明示的に同期できます。
- **リッチな Markdown ＆ 多形式アーティファクトビューア**
  - コピー・折返し・保存付きコードブロック（Highlight.js）、KaTeX 数式、Mermaid 図（失敗時ソースフォールバック）、CSV/Markdown コピー可能なテーブル、引用ブロックコピー、ワークスペース内ファイルリンク解決。
  - Text / Code / Unified Diff / PDF (`pdfjs-dist` Canvas 描画で iPhone 対応) / Excel (`.xlsx`)・CSV・TSV テーブル / Word (`.docx` 注意バナー付き) / PowerPoint (`.pptx` LibreOffice 変換 + DL) / DOMPurify 済み SVG / 厳格 CSP `sandbox="allow-scripts"` HTML プレビュー / HTTP Range 対応音声・動画再生。
- **クロスデバイス・リアルタイム同期**
  - バックエンド主導のタスク実行・公平スケジューラ + SQLite (`node:sqlite` WAL) + 単調増分 `sinceSeq` 付き WebSocket リプレイにより、PC で送信した応答の途中から iPhone で参加したり、ツール承認カードをどちらの端末からでも競合安全（二重承認時 HTTP `409`）に操作できます。

## Oracle Cloud Always Free (Ubuntu) 推奨構成

- **最推奨**: **`VM.Standard.A1.Flex` (Ampere ARM64, 最大 2 OCPU / 12 GB RAM — 月 1,500 OCPU時間・9,000 GB時間)** — 1台の **2 OCPU / 12 GB VM** に集約する構成が最適です。12 GB RAM は Node 24 サーバー・`npm run build`・複数 `agy acp` ワーカー・`pdftoppm` に対して十分余裕がありますが、ローカルツール実行時は **2 コアの CPU がボトルネック** になりやすいため、デフォルトを **`MAX_CONCURRENT_ACP=2`、`MAX_ACP_PER_USER=2`、`IDLE_WORKER_MS=600000`（10分）、`INSTALL_LIBREOFFICE=0`** に最適化しています（主にチャット応答中心なら `MAX_CONCURRENT_ACP=3` も可、`.pptx` PDF変換が必要時のみ `INSTALL_LIBREOFFICE=1`）。
- **軽量単体向け**: **`VM.Standard.E2.1.Micro` (1/8 OCPU, 1 GB RAM)** — 2GB スワップ追加 + `MAX_CONCURRENT_ACP=1`、`MAX_ACP_PER_USER=1`、`IDLE_WORKER_MS=180000`、`INSTALL_LIBREOFFICE=0` で動作可能。
- 詳しい運用ノート（Tailscale Serve による HTTPS 公開と Ubuntu `iptables` 回避、7日間アイドル回収ルール、コンシューマ版 `oauth-personal` 利用規約上の注意）は [docs/architecture.md](docs/architecture.md) を参照してください。

## セットアップ ＆ ビルド

必要環境: **Node.js >= 24.0.0**, **Python 3**（PTY ログインブリッジ用・追加 pip パッケージ不要）, 公式 **`agy` CLI**（ローカル動作テスト時は `AGY_MODE=mock` 利用可）

```bash
# 1. 依存インストール（ネイティブ C++ ビルド不要）
npm install

# 2. 型チェック・自動テスト・本番ビルド
npm run typecheck
npm test
npm run build
```

### Ubuntu サーバー（Oracle Always Free）への導入手順

```bash
# 必要 OS パッケージ・Node 24・2GBスワップ(<=2GB環境時)・サービスユーザーを作成
sudo bash deploy/ubuntu-setup.sh

# リポジトリを /opt/antigravity-chat に配置してビルド後、systemd サービスを有効化
sudo cp deploy/antigravity-chat.service /etc/systemd/system/antigravity-chat.service
sudo systemctl daemon-reload
sudo systemctl enable --now antigravity-chat

# Tailscale で安全に HTTPS 公開（Oracle iptables やセキュリティリストのポート開放不要）
sudo tailscale serve --bg http://127.0.0.1:3000
```

## 開発サーバー（モックモード / 実機モード）

```bash
# オフライン・UI動作確認用モックモード（実 agy CLI 不要）
AGY_MODE=mock npm run dev
# 別ターミナルで Vite フロントエンド起動（http://127.0.0.1:5173）
npm run dev:web
```

本番ビルド後は `NODE_ENV=production node server/dist/index.js`（または `npm start`）1プロセスのみで API・WebSocket・ビルド済み SPA フロントエンドを配信できます。

## ディレクトリ構成

- `server/`: Fastify + WebSocket + `node:sqlite` バックエンド、ACP マネージャ、公平スケジューラ、ワークスペース分離、認証・PTY ログインブリッジ
- `web/`: React + TypeScript + Vanilla CSS フロントエンド（Vite + PWA）
- `deploy/`: Oracle Always Free Ubuntu 向けセットアップスクリプト ＆ systemd ユニット
- `docs/`: アーキテクチャ設計 ＆ 運用・コンプライアンス詳細 ([docs/architecture.md](docs/architecture.md))