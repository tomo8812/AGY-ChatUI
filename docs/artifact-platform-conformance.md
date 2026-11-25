# Artifact Platform 機能棚卸し・適合性マトリクス（PR 2 時点）

本書は設計・実装計画書（4.1〜4.3 節、第 10 章、第 11 章）に対する **PR 2（`feat/artifact-platform-pr2`）時点の全機能・全操作の棚卸しおよび要件トレーサビリティ台帳** である（設計書 11.1 節 `docs/artifact-platform-conformance.md`）。

## 1. スコープおよびステータス定義

- **対象フェーズ**: PR 1（Core 基盤・単一 DB・復旧・軽量リッチ UI コア・アーキテクチャ検査）＋ PR 2（Rich 6 形式アダプター・高度 OOXML/PDF・22 ツール内蔵 MCP・外部ワーカーランタイム）
- **PR 3A / PR 3B / PR 4 境界**: 統合ビューアー UI（`web/src/components/ArtifactWorkspace/*`）・共通 UI コンポーネント（`web/src/components/shared-ui/*`）・旧 `ArtifactViewerModal.tsx` 撤去は設計書第 10 章に従い PR 3A 以降に属し、本 PR では前倒し実装を行わない。既存の `ArtifactService` 単一ゲートウェイ・`FormatAdapter` 隔離・`DocumentWorker` / `DocWorkerSandbox` アーキテクチャを維持する。
- **ステータス 4 区分**:
  - **対応済み**: 設計書の要求仕様通りに実装・動作確認が完了。
  - **部分実装**: コア機能または主要サブセットは実装・検証済みだが、形式固有の構造保護制約（例: SmartArt 線形図種のみノード増減対応、保護ノード非破壊拒否）や PR 3A 以降の UI 側未実装が残るもの。
  - **未実装**: まだ未実装のもの（PR 3A / PR 3B / PR 4 で実装予定の UI・最終監査項目を含む。PR 2 必須バックエンド/MCP 機能に未実装残置は 0 件）。
  - **設計上許容された非対応**: 設計書 4.1〜4.3 節の形式方針または実ファイル技術調査に基づき、`unsupported_by_format` として非対応と確定したもの。

### 検証環境区分（設計書 11.2 節）

- **`VERIFIED (REAL RUNTIME)`**: 実 SQLite（`WAL` + `synchronous=FULL`）・実 FS・実 Streamable HTTP MCP サーバー・実ドキュメント/メディア/Web 処理ツール群（Python 3.12 / LibreOffice 24.2 Impress・Calc・Writer / `pdftoppm` / `pdftotext` / `qpdf` / `pandoc` / `rsvg-convert` / `ffmpeg` / Playwright Chromium + `mermaid` + `marked`）・実ビルド成果物による検証。
- **`VERIFIED (MOCK / EMULATION)`**: 拡張モック ACP クライアントまたは Playwright ブラウザエミュレーションによる検証（実 `agy` および物理 iPhone の動作保証には含めない）。
- **`UNVERIFIED (REQUIRES REAL AGY / PHYSICAL IPHONE)`**: CI/開発環境に `agy` バイナリおよび物理 iPhone が存在しないため、実稼働環境でのみ確定可能な検証項目（実 `agy` 向け再現スイート: `AGY_REAL_TEST=1 node scripts/verify-real-agy-artifact-mcp.mjs`）。

---

## 2. PR 2 サーバー側品質検証と PR 3A UI 視覚一致検証の明確な区別

設計書 4.3 節・第 10 章・11.1 節における検証責務を以下の通り厳格に分離する。

| 検証項目 | フェーズ | 責務・検証内容 | 実装箇所 |
| --- | --- | --- | --- |
| **PPTX 文字溢れ・枠外・重なり検査** | **PR 2（本 PR）** | 各図形の段落/フォントサイズ/行折り返しと `a:xfrm` 寸法からテキスト高さ超過（`PPTX_TEXT_OVERFLOW`）を算出し、スライド外はみ出し（`PPTX_SHAPE_OUT_OF_BOUNDS`）・図形重なり（`PPTX_SHAPE_OVERLAP`）と合わせて検出する。 | `server/scripts/artifact_doc_worker.py` (`verify_pptx_text_overflow`, `verify_document`) |
| **PPTX サーバー側レイヤー分解視覚整合（SSIM / MAE）** | **PR 2（本 PR）** | `extract_pptx_slide_layers` が生成する背景プレート PNG と各透過スプライト PNG をサーバー側で合成し、LibreOffice Impress が出力した原本スライド全体 PNG とグレースケール 8×8 ブロック SSIM / MAE を比較検証する（チェック ID: `layer_visual_consistency`）。 | `server/scripts/artifact_doc_worker.py` (`verify_pptx_layer_visual_consistency`, `compute_image_ssim_and_mae`) |
| **PPTX UI レイヤー分離キャンバス視覚一致（`UX-07`）** | **PR 3A（次フェーズ）** | ブラウザ上の `PptxModule.tsx` レイヤー分離キャンバス（背景プレート＋DOM/SVG 要素＋透過スプライト）の描画結果と、確定後 LibreOffice PNG との bbox＋SSIM 視覚一致およびゴースト 0 件を検証する。 | `web/src/components/ArtifactWorkspace/modules/PptxModule.tsx`（PR 3A） |
| **DOCX レイアウト品質検査** | **PR 2（本 PR）** | `sectPr` 余白・ページ幅と表/図形幅の超過（`DOCX_MARGIN_OVERFLOW`）、過度な埋め込み画像サイズ（`DOCX_OVERSIZED_EMBED`）、LibreOffice PDF 出力の空白ページ（`DOCX_BLANK_PAGE`）および保護ノード・リンク整合を検査する（チェック ID: `docx_layout_quality`）。 | `server/scripts/artifact_doc_worker.py` (`verify_docx_layout_quality`) |
| **XLSX 数式 4 区分評価・文字切れ検査** | **PR 2（本 PR）** | 隔離コピーの LibreOffice Calc 再計算で数式セルを `evaluated_lo` / `cached_existing` / `unevaluated_unsupported` / `error_formula` の 4 区分で評価し（`formula_values`）、さらに列幅メトリクス＋LibreOffice PDF 出力の `###` 検出により数値/文字列の文字切れ（`XLSX_TEXT_TRUNCATION`、`xlsx_text_truncation`）を検証する。 | `server/scripts/artifact_doc_worker.py` (`verify_workbook_formulas`, `verify_xlsx_text_truncation`) |

---

## 3. SmartArt ノード増減（`pptx.smartart.add_or_remove_node`）実ファイル・LibreOffice 技術調査結果

設計書 4.3 節の「`dgm:dataModel`＋`dgm:drawing` 幾何同期の成立可否を実ファイルと LibreOffice 描画で検証し、破綻なく動作する図種のみ対応、それ以外は `unsupported_by_format` を明示申告」に従い、実 PowerPoint 生成ファイルおよび LibreOffice Impress 24.2（`impress_pdf_Export` + `pdftotext -bbox`）を用いて調査を実施した。

### 3.1 調査環境・対象ファイル

1. **実 PowerPoint 生成フィクスチャ**: Apache POI 由来実ファイル `smartart-simple.pptx`（`layoutId = urn:microsoft.com/office/officeart/2005/8/layout/venn1`）
2. **実 OOXML 準拠フィクスチャ**: `vList2`（垂直線形リスト 3 ノード）および `process1`（水平線形プロセス 3 ノード＋`sibTrans` 矢印 2 個）
3. **検証ツール**: LibreOffice Impress 24.2.7 + `pdftotext -bbox` + `validate_package`

### 3.2 技術的発見事項

- **LibreOffice Impress の描画仕様**: LibreOffice Impress は `dgm:layoutDef` の PowerPoint 制約ソルバーを再実行せず、`ppt/diagrams/drawing1.xml`（`dsp:spTree`）にキャッシュされた描画図形群をそのままレンダリングする。したがって、`dgm:dataModel`（`dgm:ptLst` / `dgm:cxnLst`）のみを変更すると表示が追従せず、逆に `dsp:spTree` を幾何学的に正しく同期再配置すれば LibreOffice・PowerPoint 双方で即時反映される。
- **Venn 図（`venn1`）が成立しない根拠**:
  - 実ファイル `smartart-simple.pptx` の解析により、1 つの論理ノードが `presOf` を介して **2 つの `pres` ポイント**（背景円とテキスト用）に紐付き、さらに各 `<dsp:sp>` が円の中心座標とは別に放射方向へオフセットした独立の `<dsp:txXfrm>`（テキスト専用変形行列）を持つことを確認した。
  - ノード数を増減すると円の交差領域・半径・中心角度・テキスト逃がし位置（`txXfrm`）を PowerPoint の 2 次元制約ソルバーで再計算する必要があり、単純な矩形リフローでは円交差とテキスト重なりが発生し視覚的に破綻する。
- **1 次元線形リスト（`vList2`）・線形プロセス（`process1`）が成立する根拠**:
  - 単一階層（1 論理ノード＝1 `pres` ポイント＝1 `dsp:sp`、独立 `dsp:txXfrm` なし）の 1 次元配列では、親コンテナ枠内（`dsp:spTree` 既存バウンディングボックス）で等間隔の水平/垂直リフローを決定論的に計算でき、`process*` / `chevron*` / `arrow*` では隣接ノード間の `sibTrans` コネクタ矢印数（$N - 1$ 個）と座標も同時に再配置できる。
  - **LibreOffice Impress + `pdftotext -bbox` 実測結果**:
    - `vList2`（3 → 4 ノード追加）: 各ラベルの Y 座標ピッチが `124.8pt` → `93.6pt` へ完全均等再配置、バウンディングボックス重なり 0 件、追加ノード `"Phase 4"` が描画テキストとして抽出可能。
    - `process1`（3 → 4 ノード追加＋`sibTrans` 矢印 2 → 3 個同期）: 各ラベルの X 座標ピッチが `205.1pt` → `153.8pt` へ完全均等再配置、バウンディングボックス重なり 0 件、削除時（4 → 3 ノード）も元ピッチへ整合復元。

### 3.3 確定した対応／非対応図種マトリクス

| 図種カテゴリ | 対象レイアウト ID 例（`dgm:layoutDef/@uniqueId`） | 判定 | 挙動・実装根拠 |
| --- | --- | --- | --- |
| **単一階層 1D 線形リスト** | `vList*`, `hList*`, `bList*`, `lList*`, `default`（独立 `dsp:txXfrm` なし、ネストなし） | **対応済み** | `dgm:dataModel`（`ptLst`/`cxnLst`）と `dsp:spTree` 座標・スタイルを同期リフロー（`edit_smartart_add_or_remove_node`） |
| **単一階層 1D 線形プロセス** | `process*`, `chevron*`, `arrow*`（独立 `dsp:txXfrm` なし、ネストなし） | **対応済み** | ノード図形＋`sibTrans` 矢印図形（$N-1$ 個）および `cxnLst` 接続を同期リフロー（`edit_smartart_add_or_remove_node`） |
| **2D 重畳・循環・階層・ピラミッド・マトリクス図種** | `venn*`, `cycle*`, `radial*`, `hierarchy*`, `orgChart*`, `pyramid*`, `matrix*`、多階層ツリー、独立 `<dsp:txXfrm>` を持つ図形 | **設計上許容された非対応** | `classify_smartart_layout` が事前検出し、`UnsupportedByFormatError`（終了コード 4 → API `unsupported_by_format`）で安全拒否 |

- 検証テスト: `server/tests/artifact_doc_worker_test.py` (`test_real_smartart_updates_data_and_cached_drawing`, `test_smartart_add_or_remove_node_supported_linear_and_rejects_venn`) — **`VERIFIED (REAL RUNTIME)`**

---

## 4. 全 14 形式＋軽量リッチ回答 操作単位棚卸し表

### 4.1 共通基盤・横断操作

| 操作 / 機能 | ステータス | 実装箇所 | 検証結果・区分 |
| --- | --- | --- | --- |
| `artifact_render` 領域指定描画（`region: { x, y, width, height, unit?: 'norm' \| 'px' \| 'pt' }`） | **対応済み** | `server/src/artifacts/types.ts` (`RenderRegion`), `server/src/artifacts/artifact-service.ts` (`renderPng`), `server/src/artifacts/document-worker.ts`, `server/src/mcp/builtin-artifact-mcp.ts` (`artifact_render`), `server/src/routes/file-routes.ts` (`GET /api/files/:artifactId/render`), `server/scripts/artifact_doc_worker.py` (`crop_png_region`), `server/scripts/artifact_web_renderer.mjs` (`computeClip`) | `VERIFIED (REAL RUNTIME)` (`artifact_doc_worker_test.py` `test_csv_table_png_render_and_region_cropping_across_formats`, `builtin-artifact-mcp.test.ts` Full Runtime テスト) |
| 能力 API（`artifact_capabilities` 3 プロファイル自動判定・理由付き返却） | **対応済み** | `server/src/artifacts/adapters/registry.ts`, `server/src/artifacts/resource-governor.ts`, `server/src/artifacts/artifact-service.ts` (`getCapabilities`) | `VERIFIED (REAL RUNTIME)` (`artifact-capabilities.test.ts`) |
| 外部ワーカー隔離（`bwrap --unshare-net --unshare-pid`・RLIMIT・Pss/RSS 監視・タイムアウト・Zip Bomb/XXE 拒否） | **対応済み** | `server/src/artifacts/sandbox-worker.ts`, `server/src/artifacts/resource-governor.ts`, `server/scripts/artifact_doc_worker.py` (`validate_package`) | `VERIFIED (REAL RUNTIME)` (`sandbox-and-drafts.test.ts`, `artifact_doc_worker_test.py`, `builtin-artifact-mcp.test.ts`) |
| 3 プロファイル導入スクリプト（`full` / `compact` / `base`） | **対応済み** | `deploy/setup-doc-runtime.sh`, `server/src/artifacts/resource-governor.ts` (`detectRuntimeProfile`) | `VERIFIED (REAL RUNTIME)` (`doc-skills-and-runtime.test.ts`, `.github/workflows/ci-deploy.yml`) |

### 4.2 PPTX（`FUNC-01`）

| 操作 | ステータス | 実装箇所 | 検証結果・区分 |
| --- | --- | --- | --- |
| `create` / `structure` / `read_range` | **対応済み** | `server/scripts/artifact_doc_worker.py` (`create_presentation`, `pptx_structure`, `pptx_read_range`, `extract_pptx_slide_layers`) | `VERIFIED (REAL RUNTIME)` (`artifact_doc_worker_test.py`) |
| `pptx.set_shape_text`（複数段落・複数ラン・インライン書式・改行・グループ内図形対応） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`edit_presentation`, `_set_pptx_txbody`, `find_pptx_shape_with_parent`) | `VERIFIED (REAL RUNTIME)` (`test_pptx_advanced_multi_run_styles_shapes_grouping_and_z_order`) |
| `pptx.set_shape_style`（単色/グラデーション/透過塗り・線種/破線・文字色/下線/取消線/CJK フォント・段落配置/行間/箇条書き/余白・影/光彩/ぼかし・反転） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`edit_presentation`, `_apply_pptx_shape_style`) | `VERIFIED (REAL RUNTIME)` (`test_pptx_advanced_multi_run_styles_shapes_grouping_and_z_order`) |
| `pptx.add_shape`（20 種以上のプリセット図形＋初期テキスト・書式）／`pptx.remove_shape` | **対応済み** | `server/scripts/artifact_doc_worker.py` (`PPTX_PRESET_SHAPES`, `edit_presentation`) | `VERIFIED (REAL RUNTIME)` (`test_pptx_advanced_multi_run_styles_shapes_grouping_and_z_order`) |
| `pptx.set_shape_bounds`（プレースホルダー安全・浮動小数点 pt 座標・回転対応） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`edit_presentation`) | `VERIFIED (REAL RUNTIME)` (`test_pptx_advanced_multi_run_styles_shapes_grouping_and_z_order`) |
| `pptx.move_shape`（Z 順 `front`/`back`/`forward`/`backward`/数値インデックス） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`edit_presentation`) | `VERIFIED (REAL RUNTIME)` (`test_pptx_advanced_multi_run_styles_shapes_grouping_and_z_order`) |
| `pptx.group_shapes`（非連続図形グループ化）／`pptx.ungroup_shapes`（アフィン変換展開: 拡縮・平行移動・反転・回転合成） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`edit_presentation`) | `VERIFIED (REAL RUNTIME)` (`test_pptx_advanced_multi_run_styles_shapes_grouping_and_z_order`) |
| `pptx.add_image` / `pptx.add_table` / `pptx.set_table_cell`（複数ラン・セル書式） | **部分実装**（画像は PNG/JPEG 対応） | `server/scripts/artifact_doc_worker.py` (`edit_presentation`) | `VERIFIED (REAL RUNTIME)` (`artifact_doc_worker_test.py`) |
| `pptx.add_slide` / `pptx.reorder_slide` / `pptx.remove_slide` / `pptx.set_notes` | **対応済み** | `server/scripts/artifact_doc_worker.py` (`edit_presentation`) | `VERIFIED (REAL RUNTIME)` (`artifact_doc_worker_test.py`) |
| `pptx.smartart.get_structure` / `pptx.smartart.update_node_text`（`dataModel`＋`drawing` 同時同期） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`extract_smartart_nodes`, `edit_smartart_update_node_text`) | `VERIFIED (REAL RUNTIME)` (`test_real_smartart_updates_data_and_cached_drawing`) |
| `pptx.smartart.add_or_remove_node`（線形リスト・線形プロセス対応／Venn・循環・階層等は `unsupported_by_format`） | **部分実装**（第 3 節の調査確定範囲） | `server/scripts/artifact_doc_worker.py` (`classify_smartart_layout`, `edit_smartart_add_or_remove_node`) | `VERIFIED (REAL RUNTIME)` (`test_smartart_add_or_remove_node_supported_linear_and_rejects_venn`) |
| `chart.create` / `update_title_and_legend` / `update_series_data`（埋込 XLSX＋キャッシュ同時同期） / `update_series_style` / `add_or_remove_series` | **部分実装**（棒/縦棒/折線/円/ドーナツ/面/散布/複合・第 2 軸対応；3D 特殊曲面等は非対応） | `server/scripts/artifact_doc_worker.py` (`edit_chart`) | `VERIFIED (REAL RUNTIME)` (`test_pptx_chart_updates_embedded_workbook_and_cache`) |
| `render_png`（領域指定対応） / `export:pdf` / `export:png` | **対応済み** | `server/scripts/artifact_doc_worker.py` (`render_presentation`, `export_presentation`, `crop_png_region`) | `VERIFIED (REAL RUNTIME)` (`artifact_doc_worker_test.py`) |
| `verify`（OOXML 構造・文字溢れ・枠外・重なり・サーバー側レイヤー分解 SSIM/MAE 整合） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`verify_pptx_text_overflow`, `verify_pptx_layer_visual_consistency`, `verify_document`) | `VERIFIED (REAL RUNTIME)` (`test_office_verification_pptx_overflow_ssim_docx_layout_xlsx_truncation`, `test_verification_reports_structural_findings_and_unverified_checks`) |
| レイヤー分離キャンバス直接編集 UI（`PptxModule.tsx`） | **未実装**（PR 3A 計画対象） | `web/src/components/ArtifactWorkspace/modules/PptxModule.tsx`（PR 3A） | PR 3A 検証ゲート対象 |

### 4.3 DOCX（`FUNC-02`）

| 操作 | ステータス | 実装箇所 | 検証結果・区分 |
| --- | --- | --- | --- |
| `create` / `structure` / `read_range` | **対応済み** | `server/scripts/artifact_doc_worker.py` (`create_word_document`, `docx_structure`, `docx_read_range`) | `VERIFIED (REAL RUNTIME)` (`artifact_doc_worker_test.py`) |
| `docx.set_paragraph_text`（複数ラン・`runIndex`・リッチ `runs`・`\n`→`<w:br/>`・保護ノード非破壊ガード） | **部分実装**（保護ノード含む段落は安全拒否） | `server/scripts/artifact_doc_worker.py` (`edit_word_document`, `_set_word_paragraph_runs`) | `VERIFIED (REAL RUNTIME)` (`test_docx_advanced_multi_run_direct_styles_lists_and_tables`, `test_docx_edits_word_parts_and_preserves_unrelated_xml`) |
| `docx.set_paragraph_style`（既存スタイル＋`Heading1..9` 自動補完＋直接段落書式: 整列・前後間隔・行間・インデント・背景網掛け・罫線・改頁制御） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`_apply_word_paragraph_props`, `_read_word_styles_readonly`) | `VERIFIED (REAL RUNTIME)` (`test_docx_advanced_multi_run_direct_styles_lists_and_tables`) |
| `docx.set_run_style`（`runIndex` 省略時は全非保護ラン適用、太字/斜体/下線/取消線/色/ハイライト/網掛け/上付下付/サイズ/フォント） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`_apply_word_run_props`) | `VERIFIED (REAL RUNTIME)` (`test_docx_advanced_multi_run_direct_styles_lists_and_tables`) |
| `docx.set_list`（`bullet`/`decimal`/`lowerLetter`/`upperRoman`/`none`・`word/numbering.xml` 自動生成） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`_ensure_word_numbering`, `edit_word_document`) | `VERIFIED (REAL RUNTIME)` (`test_docx_advanced_multi_run_direct_styles_lists_and_tables`) |
| `docx.add_paragraph`（`insertAt`・`runs`・直接書式）／`docx.remove_paragraph` | **対応済み** | `server/scripts/artifact_doc_worker.py` (`edit_word_document`) | `VERIFIED (REAL RUNTIME)` (`test_docx_advanced_multi_run_direct_styles_lists_and_tables`) |
| `docx.add_table` / `docx.set_table_cell`（複数ラン・改行・背景網掛け・垂直位置・幅・文字書式） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`edit_word_document`) | `VERIFIED (REAL RUNTIME)` (`test_docx_advanced_multi_run_direct_styles_lists_and_tables`) |
| `docx.add_image`（PNG/JPEG） / `docx.set_page_size` / `docx.set_page_layout` / `docx.patch_xml_text` | **部分実装**（画像は PNG/JPEG） | `server/scripts/artifact_doc_worker.py` (`edit_word_document`) | `VERIFIED (REAL RUNTIME)` (`artifact_doc_worker_test.py`) |
| `docx.add_header_footer`（`sectionIndex`/`overwrite`） / `docx.edit_header_footer` / `docx.add_footnote` / `docx.edit_footnote`（複数ラン対応） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`edit_word_document`) | `VERIFIED (REAL RUNTIME)` (`test_docx_edits_word_parts_and_preserves_unrelated_xml`) |
| `render_png`（領域指定対応） / `export:pdf` / `export:md` / `export:html` | **対応済み** | `server/scripts/artifact_doc_worker.py` (`render_word`, `export_word`, `crop_png_region`) | `VERIFIED (REAL RUNTIME)` (`artifact_doc_worker_test.py`) |
| `verify`（OOXML 構造・余白溢れ・空白ページ・過大埋込画像・リンク整合） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`verify_docx_layout_quality`, `verify_document`) | `VERIFIED (REAL RUNTIME)` (`test_office_verification_pptx_overflow_ssim_docx_layout_xlsx_truncation`) |
| Tiptap 直接編集 UI（`DocxModule.tsx`） | **未実装**（PR 3A 計画対象） | `web/src/components/ArtifactWorkspace/modules/DocxModule.tsx`（PR 3A） | PR 3A 検証ゲート対象 |

### 4.4 XLSX（`FUNC-03`）

| 操作 | ステータス | 実装箇所 | 検証結果・区分 |
| --- | --- | --- | --- |
| `create` / `structure` / `read_range`（LibreOffice 評価オプション付） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`create_workbook`, `xlsx_structure`, `xlsx_read_range`) | `VERIFIED (REAL RUNTIME)` (`artifact_doc_worker_test.py`) |
| `xlsx.set_cell` / `xlsx.set_formula`（依存数式 `<v>` 消去＋`fullCalcOnLoad="1"`＋`calcChain` 3 箇所整合除去） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`edit_workbook`, `remove_calc_chain`) | `VERIFIED (REAL RUNTIME)` (`test_xlsx_clears_formula_cache_and_all_chain_registrations`) |
| `xlsx.set_cell_style`（`xl/styles.xml` 新規スタイル生成: フォント/塗り/罫線/配置/折返し/回転/表示形式＋範囲一括適用） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`allocate_workbook_style_index`, `edit_workbook`) | `VERIFIED (REAL RUNTIME)` (`test_xlsx_advanced_rich_cell_style_conditional_formats_validation_and_sheet_ops`) |
| `xlsx.add_conditional_format`（2/3 色スケール・`dataBar`・`cellIs` 全演算子・`expression`・`top10`・`aboveAverage`・`duplicateValues`・`uniqueValues`＋`dxf` 書式割当） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`allocate_workbook_dxf`, `edit_worksheet_option`) | `VERIFIED (REAL RUNTIME)` (`test_xlsx_advanced_rich_cell_style_conditional_formats_validation_and_sheet_ops`) |
| `xlsx.set_data_validation`（インラインリスト・範囲数式リスト・数値/日付/テキスト長/カスタム式・入力/エラーメッセージ） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`edit_worksheet_option`) | `VERIFIED (REAL RUNTIME)` (`test_xlsx_advanced_rich_cell_style_conditional_formats_validation_and_sheet_ops`) |
| `xlsx.set_merge` / `xlsx.set_auto_filter` / `xlsx.set_column_width` / `xlsx.set_row_height` / `xlsx.set_freeze_panes` / `xlsx.set_page_setup`（余白・印刷範囲対応） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`edit_worksheet_option`) | `VERIFIED (REAL RUNTIME)` (`test_xlsx_advanced_rich_cell_style_conditional_formats_validation_and_sheet_ops`, `test_xlsx_edits_sheet_options_and_preserves_other_cells`) |
| `xlsx.mutate_rows` / `xlsx.mutate_columns`（ブック横断参照書換・ピボット/構造化テーブル/配列数式交差時 422 拒否） | **部分実装**（保護構造交差時は設計通り 422 拒否） | `server/scripts/artifact_doc_worker.py` (`mutate_sheet_grid`) | `VERIFIED (REAL RUNTIME)` (`test_spreadsheet_mutation_moves_cross_sheet_references`, `test_spreadsheet_mutation_refuses_array_formulas`) |
| `xlsx.add_sheet` / `xlsx.duplicate_sheet` / `xlsx.reorder_sheet` / `xlsx.rename_sheet` / `xlsx.remove_sheet`（非空シート対応・他シート参照保護） / `xlsx.remove_empty_sheet` / `xlsx.set_sheet_visibility` / `xlsx.set_defined_name`（シートローカル・数式対応） | **部分実装**（参照中/最終可視シートは保護拒否） | `server/scripts/artifact_doc_worker.py` (`update_sheet_metadata`) | `VERIFIED (REAL RUNTIME)` (`test_xlsx_advanced_rich_cell_style_conditional_formats_validation_and_sheet_ops`, `test_xlsx_renames_references_and_removes_an_empty_sheet`) |
| `chart.*`（5 操作群） | **部分実装**（棒/縦棒/折線/円/ドーナツ/面/散布/複合・第 2 軸対応） | `server/scripts/artifact_doc_worker.py` (`edit_chart`) | `VERIFIED (REAL RUNTIME)` (`test_xlsx_chart_updates_match_sheet_cells`) |
| `render_png`（領域指定対応） / `export:pdf` / `export:png` / `export:csv` | **対応済み** | `server/scripts/artifact_doc_worker.py` (`render_workbook`, `export_workbook`, `crop_png_region`) | `VERIFIED (REAL RUNTIME)` (`artifact_doc_worker_test.py`) |
| `verify`（OOXML 構造・LibreOffice 数式 4 区分評価・参照エラー・文字切れ/`###` 検証） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`verify_workbook_formulas`, `verify_xlsx_text_truncation`, `verify_document`) | `VERIFIED (REAL RUNTIME)` (`test_office_verification_pptx_overflow_ssim_docx_layout_xlsx_truncation`, `test_verification_reports_structural_findings_and_unverified_checks`) |
| レガシー `.xls` 編集・変換 | **設計上許容された非対応** | `server/src/artifacts/adapters/registry.ts` (`documentFormatConstraint`) | `VERIFIED (REAL RUNTIME)` (`artifact-capabilities.test.ts`) |
| 2D 仮想グリッド直接編集 UI（`XlsxModule.tsx`） | **未実装**（PR 3A 計画対象） | `web/src/components/ArtifactWorkspace/modules/XlsxModule.tsx`（PR 3A） | PR 3A 検証ゲート対象 |

### 4.5 CSV / TSV（`FUNC-04`）

| 操作 | ステータス | 実装箇所 | 検証結果・区分 |
| --- | --- | --- | --- |
| `create` / `get_structure` / `read_range` / `edit`（セル・行・列・範囲・一括置換、Pure-JS） | **対応済み** | `server/src/artifacts/adapters/csv-adapter.ts` (`CsvAdapter`) | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`, `artifact-core-durability.test.ts`) |
| `verify`（文字コード/BOM/NUL 検査・引用符閉鎖・列数整合、Pure-JS） | **対応済み** | `server/src/artifacts/adapters/csv-adapter.ts` (`CsvAdapter.verify`) | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |
| `export:xlsx`（Pure-JS OOXML `.xlsx` 生成・`Base ChatUI` 稼働・先頭ゼロ/数式文字列の安全エスケープ）／`export:json` / `export:csv` / `export:tsv` | **対応済み** | `server/src/artifacts/adapters/csv-adapter.ts` (`buildXlsxFromRows`, `exportAs`) | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`: Base ChatUI 出力＋Full Runtime Python/LibreOffice 検証合格) |
| `render_png`（表 PNG 描画・CSV/TSV 切替・CJK フォント・領域指定対応、Compact/Full Runtime） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`render_csv_table`, `crop_png_region`), `server/src/artifacts/artifact-service.ts` (`renderPng`) | `VERIFIED (REAL RUNTIME)` (`test_csv_table_png_render_and_region_cropping_across_formats`, `builtin-artifact-mcp.test.ts` Full Runtime テスト) |
| 2D 仮想グリッド直接編集 UI（`CsvModule.tsx`） | **未実装**（PR 3A 計画対象） | `web/src/components/ArtifactWorkspace/modules/CsvModule.tsx`（PR 3A） | PR 3A 検証ゲート対象 |

### 4.6 PDF（`FUNC-05`）

| 操作 | ステータス | 実装箇所 | 検証結果・区分 |
| --- | --- | --- | --- |
| `create`（新規生成＋複数 PDF 結合 `sourceArtifactIds`） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`create_pdf`), `server/src/artifacts/document-worker.ts` | `VERIFIED (REAL RUNTIME)` (`artifact_doc_worker_test.py`) |
| `structure`（頁数・寸法・回転・メタデータ・目次・注釈・フォーム項目・`pageContentHash`・暗号化 PDF の非クラッシュ解析）／`read_range` | **対応済み** | `server/scripts/artifact_doc_worker.py` (`pdf_structure`, `pdf_read_range`) | `VERIFIED (REAL RUNTIME)` (`test_pdf_structure_encryption_diff_verification_and_rich_overlays`) |
| `pdf.rotate_page` / `pdf.reorder_pages`（ネスト `/Pages` ツリー対応） / `pdf.remove_page` / `pdf.add_note` | **対応済み** | `server/scripts/artifact_doc_worker.py` (`edit_pdf`, `_flatten_pdf_pages`) | `VERIFIED (REAL RUNTIME)` (`test_pdf_structure_encryption_diff_verification_and_rich_overlays`, `artifact_doc_worker_test.py`) |
| `pdf.add_overlay`（複数行自動折返しテキスト・CJK フォント・`highlight`・`rect`・`line`・`stamp`・`image`・回転・透過・左上原点座標対応） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`_draw_pdf_overlay`, `edit_pdf`) | `VERIFIED (REAL RUNTIME)` (`test_pdf_structure_encryption_diff_verification_and_rich_overlays`) |
| `verify`（`qpdf --check` 構造検証・テキスト抽出検証・暗号化検出・前版とのテキスト/幾何/描画 SSIM・MAE 差分検証 `pdf_diff`） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`_verify_pdf`), `server/src/artifacts/artifact-service.ts` (`verifyArtifact`) | `VERIFIED (REAL RUNTIME)` (`test_pdf_structure_encryption_diff_verification_and_rich_overlays`, `builtin-artifact-mcp.test.ts` Full Runtime テスト) |
| `render_png`（`pdftoppm`＋領域指定対応） / `export:png` / `export:txt` | **対応済み** | `server/scripts/artifact_doc_worker.py` (`render_pdf`, `export_pdf`, `crop_png_region`) | `VERIFIED (REAL RUNTIME)` (`test_csv_table_png_render_and_region_cropping_across_formats`, `artifact_doc_worker_test.py`) |
| 既存本文の実削除・置換・リフロー（`edit_body_reflow` / `pdf.delete_text` / `pdf.reflow_text`） | **設計上許容された非対応** | `server/src/artifacts/adapters/registry.ts`, `server/scripts/artifact_doc_worker.py` (`UnsupportedByFormatError`) | `VERIFIED (REAL RUNTIME)` (`test_pdf_structure_encryption_diff_verification_and_rich_overlays`, `artifact-capabilities.test.ts`) |
| 閲覧特化 UI（`PdfModule.tsx`、直接編集 UI は設計上非提供） | **未実装**（PR 3A 計画対象） | `web/src/components/ArtifactWorkspace/modules/PdfModule.tsx`（PR 3A） | PR 3A 検証ゲート対象 |

### 4.7 画像・SVG・HTML・Markdown・コード・Diff・Mermaid・動画/音声・Binary・軽量リッチ回答

| 形式 | 操作 | ステータス | 実装箇所 | 検証結果・区分 |
| --- | --- | --- | --- | --- |
| **画像（`FUNC-06`）** | `create` / `structure` / `verify` / `render_png`（領域指定対応） / `export:png\|jpg\|jpeg\|webp` / `image.crop\|resize\|rotate\|brightness\|annotate\|composite` | **対応済み** | `server/scripts/artifact_doc_worker.py` (`handle_image`, `crop_png_region`), `server/src/artifacts/adapters/registry.ts` | `VERIFIED (REAL RUNTIME)` (`artifact_doc_worker_test.py`) |
| **SVG（`FUNC-07`）** | `create` / `get_structure` / `read_range` / `edit` / `verify`（XML/viewBox/XSS/危険属性） / `export:png` / `render_png`（領域指定対応） | **対応済み** | `server/src/artifacts/adapters/svg-adapter.ts`, `server/scripts/artifact_doc_worker.py` (`render_svg`), `server/src/artifacts/artifact-service.ts` | `VERIFIED (REAL RUNTIME)` (`test_svg_renders_styles_and_images_supplied_by_the_snapshot`, `artifact-capabilities.test.ts`) |
| **HTML（`FUNC-08`）** | `create` / `get_structure` / `read_range` / `edit` / `verify`（構文・相対参照・CSP） / `render_png`（領域指定対応） / `export:png`（Full Runtime） | **対応済み** | `server/src/artifacts/adapters/html-adapter.ts`, `server/scripts/artifact_web_renderer.mjs`, `server/src/files/sandbox-bridge.ts` | `VERIFIED (REAL RUNTIME)` (`artifact-capabilities.test.ts`, `layout-mode-and-sandbox.test.ts`) |
| **Markdown（`FUNC-09`）** | `create` / `get_structure` / `read_range` / `edit` / `verify`（見出し段跳び・重複スラッグ・空リンク・アンカー切れ・フェンス閉鎖） | **対応済み** | `server/src/artifacts/adapters/markdown-adapter.ts` (`MarkdownAdapter`) | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |
| **Markdown（`FUNC-09`）** | `export:html`（実 CommonMark/GFM レンダリング・`<pre>` スタブ撤去・Pure-JS） / `export:txt` | **対応済み** | `server/src/artifacts/adapters/markdown-adapter.ts` (`renderMarkdownToHtmlDocument`) | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |
| **Markdown（`FUNC-09`）** | `export:pdf`（Full: Chromium `page.pdf` / Compact: Pandoc+LibreOffice） / `export:docx`（Pandoc＋`python-docx` フォールバック） / `render_png`（領域指定対応） | **対応済み** | `server/scripts/artifact_web_renderer.mjs`, `server/scripts/artifact_doc_worker.py` (`export_markdown`), `server/src/artifacts/document-worker.ts`, `server/src/artifacts/artifact-service.ts` | `VERIFIED (REAL RUNTIME)` (`test_markdown_export_to_docx_and_pdf`, `builtin-artifact-mcp.test.ts` Full Runtime テスト) |
| **コード/テキスト（`FUNC-10`）** | `create` / `get_structure` / `read_range` / `edit`（範囲置換・検索置換・パッチ） / `verify`（JSON 等構文） | **対応済み** | `server/src/artifacts/adapters/code-adapter.ts` (`CodeAdapter`) | `VERIFIED (REAL RUNTIME)` (`artifact-core-durability.test.ts`) |
| **Diff（`FUNC-11`）** | `create` / `get_structure` / `read_range` / `edit` / `verify`（パッチ構文検査） | **対応済み** | `server/src/artifacts/adapters/diff-adapter.ts` (`DiffAdapter`) | `VERIFIED (REAL RUNTIME)` (`artifact-core-durability.test.ts`) |
| **Mermaid（`FUNC-12`）** | `create` / `get_structure` / `read_range` / `edit` / `verify`（Base: 行番号付静的検査＋Full: 実 `mermaid.parse()` 構文エラー行番号検証） | **対応済み** | `server/src/artifacts/adapters/mermaid-adapter.ts` (`MermaidAdapter`), `server/scripts/artifact_web_renderer.mjs` (`action: 'verify'`), `server/src/artifacts/artifact-service.ts` (`verifyArtifact`) | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`: Base 静的検査＋Full Runtime 実 `mermaid.parse()` テスト) |
| **Mermaid（`FUNC-12`）** | `export:svg`（実 `mermaid.render()` SVG 出力） / `export:png` / `render_png`（領域指定対応、Full Runtime） | **対応済み** | `server/scripts/artifact_web_renderer.mjs`, `server/src/artifacts/artifact-service.ts` (`exportArtifact`, `renderPng`) | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts` Full Runtime テスト) |
| **動画/音声（`FUNC-13`）** | `structure` / `verify` / `render_png`（映像フレーム＋領域指定対応；音声のみは `unsupported_by_format`） / `media.trim`（1 連続区間） | **部分実装**（音声の映像フレーム抽出・非対応コンテナは設計上 `unsupported_by_format`） | `server/scripts/artifact_doc_worker.py` (`handle_media`), `server/src/artifacts/adapters/registry.ts` | `VERIFIED (REAL RUNTIME)` (`artifact_doc_worker_test.py`, `artifact-capabilities.test.ts`) |
| **Binary（`FUNC-14`）** | `get_structure`（メタ・SHA-256 のみ）；`create` / `edit` / `target_pin` は非対応明示 | **設計上許容された非対応**（閲覧・DL・履歴復元のみ） | `server/src/artifacts/adapters/binary-adapter.ts` (`BinaryAdapter`) | `VERIFIED (REAL RUNTIME)` (`artifact-capabilities.test.ts`) |
| **軽量リッチ回答（`FUNC-15`）** | サーバー・MCP 6 ツール・静的/動的上限・循環検出・SQLite 版管理・Artifact 保存（Pure-JS） | **対応済み**（UI 共通描画コンポーネントは PR 3A 計画対象） | `server/src/rich/rich-content-service.ts`, `server/src/rich/rich-validator.ts`, `server/src/rich/rich-expr-evaluator.ts`, `server/src/routes/rich-routes.ts` | `VERIFIED (REAL RUNTIME)` (`rich-security-negative.test.ts`, `builtin-artifact-mcp.test.ts`) |

---

## 5. 内蔵 MCP 22 ツール棚卸し（`MCP-01`〜`MCP-22`）

共通実装: `server/src/mcp/builtin-artifact-mcp.ts`, `server/src/mcp/mcp-service.ts`, `web/src/components/McpModal.tsx`

| ID | ツール名 | ステータス | 検証結果・区分 |
| --- | --- | --- | --- |
| `MCP-01` | `artifact_list` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |
| `MCP-02` | `artifact_capabilities` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`artifact-capabilities.test.ts`, `builtin-artifact-mcp.test.ts`) |
| `MCP-03` | `artifact_create` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |
| `MCP-04` | `artifact_get_structure` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |
| `MCP-05` | `artifact_read_range` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |
| `MCP-06` | `artifact_edit` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |
| `MCP-07` | `artifact_batch_edit` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |
| `MCP-08` | `artifact_render`（領域指定 `region` 対応） | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts` Full Runtime テスト) |
| `MCP-09` | `artifact_verify` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts` Base＋Full Runtime テスト) |
| `MCP-10` | `artifact_export` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts` Base＋Full Runtime テスト) |
| `MCP-11` | `artifact_history` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |
| `MCP-12` | `artifact_restore` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`artifact-core-durability.test.ts`, `builtin-artifact-mcp.test.ts`) |
| `MCP-13` | `artifact_restore_bundle` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`artifact-core-durability.test.ts`, `builtin-artifact-mcp.test.ts`) |
| `MCP-14` | `edit_request_list` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |
| `MCP-15` | `edit_request_get` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |
| `MCP-16` | `edit_request_mark_applied` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |
| `MCP-17` | `rich_capabilities` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |
| `MCP-18` | `rich_validate` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`rich-security-negative.test.ts`, `builtin-artifact-mcp.test.ts`) |
| `MCP-19` | `rich_create` | **対応済み** | `VERIFIED (REAL RUNTIME)`＋`VERIFIED (MOCK / EMULATION)` (`builtin-artifact-mcp.test.ts`) |
| `MCP-20` | `rich_get` | **対応済み** | `VERIFIED (REAL RUNTIME)`＋`VERIFIED (MOCK / EMULATION)` (`builtin-artifact-mcp.test.ts`) |
| `MCP-21` | `rich_update` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |
| `MCP-22` | `rich_save_as_artifact` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |

---

## 6. 第 11 章 要件 ID トレーサビリティ（PR 2 時点）

### A. アーキテクチャ・永続化・保存整合性・同期（`ARCH-01`〜`ARCH-15`）

| ID | ステータス | 計画 PR | 主実装箇所 | 検証結果・区分 |
| --- | --- | --- | --- | --- |
| `ARCH-01` | **対応済み** | PR 1 | `server/src/artifacts/artifact-service.ts`, `server/src/routes/file-routes.ts`, `server/src/routes/project-routes.ts`, `server/src/mcp/builtin-artifact-mcp.ts` | `VERIFIED (REAL RUNTIME)` (`architecture-conformance.test.ts`) |
| `ARCH-02` | **対応済み** | PR 1 | `server/src/db/database.ts` | `VERIFIED (REAL RUNTIME)` (`artifact-core-durability.test.ts`) |
| `ARCH-03` | **対応済み** | PR 1 | `server/src/files/artifacts.ts`, `server/src/files/link-resolver.ts`, `server/src/artifacts/artifact-service.ts` | `VERIFIED (REAL RUNTIME)` (`files-and-projects.test.ts`, `architecture-conformance.test.ts`) |
| `ARCH-04` | **対応済み** | PR 1 | `server/src/artifacts/artifact-service.ts`, `server/src/files/workspace.ts` | `VERIFIED (REAL RUNTIME)` (`artifact-core-durability.test.ts`) |
| `ARCH-05` | **対応済み** | PR 1 | `server/src/artifacts/commit-recovery.ts`, `server/src/artifacts/artifact-service.ts` | `VERIFIED (REAL RUNTIME)` (`artifact-core-durability.test.ts`) |
| `ARCH-06` | **対応済み** | PR 1 | `server/src/artifacts/idempotency-coordinator.ts`, `server/src/artifacts/artifact-service.ts` | `VERIFIED (REAL RUNTIME)` (`artifact-core-durability.test.ts`) |
| `ARCH-07` | **対応済み** | PR 1 | `server/src/artifacts/blob-store.ts`, `server/src/artifacts/dep-propagation.ts`, `server/src/artifacts/batch-restore.ts` | `VERIFIED (REAL RUNTIME)` (`artifact-core-durability.test.ts`) |
| `ARCH-08` | **部分実装**（サーバー側配信済み・`viewerCache.ts` は PR 3A 拡張予定） | PR 1 / 3A | `server/src/routes/file-routes.ts`, `web/src/utils/viewerCache.ts` | `VERIFIED (REAL RUNTIME)` (`artifact-revision-reads.test.ts`, `viewer-cache.test.ts`) |
| `ARCH-09` | **部分実装**（サーバー `user_seq` 実装済み・`ws.ts` 再同期拡張は PR 3A） | PR 1 / 3A | `server/src/sync/hub.ts`, `web/src/api/ws.ts` | `VERIFIED (REAL RUNTIME)` (`concurrency-and-sync.test.ts`) |
| `ARCH-10` | **対応済み** | PR 1 / 2 | `server/src/artifacts/adapters/registry.ts`, `server/src/artifacts/adapters/*` | `VERIFIED (REAL RUNTIME)` (`architecture-conformance.test.ts` `NEG-02`) |
| `ARCH-11` | **未実装**（PR 3A/3B UI 構成対象） | PR 3A / 3B | `web/src/components/ArtifactWorkspace/*`（PR 3A） | PR 3A / 4 ゲート対象 |
| `ARCH-12` | **未実装**（PR 3B/4 移行・撤去対象） | PR 3B / 4 | `web/src/App.tsx`, `web/src/components/ArtifactViewerModal.tsx`（PR 4 撤去） | PR 3B / 4 ゲート対象 |
| `ARCH-13` | **対応済み** | PR 1 / 2 | `server/src/artifacts/render-cache.ts`, `server/src/artifacts/sandbox-worker.ts` | `VERIFIED (REAL RUNTIME)` (`sandbox-and-drafts.test.ts`) |
| `ARCH-14` | **対応済み** | PR 1 | `server/src/artifacts/undo-service.ts`, `server/src/artifacts/merge-policy.ts` | `VERIFIED (REAL RUNTIME)` (`artifact-core-durability.test.ts`) |
| `ARCH-15` | **対応済み** | PR 1 / 2 | `server/src/acp/client-manager.ts`, `server/src/mcp/mcp-service.ts` | `VERIFIED (MOCK / EMULATION)` (`acp-transparency.test.ts`, `builtin-artifact-mcp.test.ts`)＋`UNVERIFIED (REQUIRES REAL AGY / PHYSICAL IPHONE)`（`scripts/verify-real-agy-artifact-mcp.mjs`） |

### B. 軽量リッチ UI・対象指定・ACP 透過性（`RICH-ARCH-01`〜`07`, `PIN-01`〜`06`, `RICH-01`〜`08`, `ACP-01`〜`02`）

| 区分 / ID | ステータス | 計画 PR | 主実装箇所 | 検証結果・区分 |
| --- | --- | --- | --- | --- |
| `RICH-ARCH-02`, `03`, `05`, `06`, `07`（サーバー側） | **対応済み** | PR 1 / 2 | `server/src/rich/*`, `server/src/routes/rich-routes.ts`, `server/src/mcp/builtin-artifact-mcp.ts` | `VERIFIED (REAL RUNTIME)` (`rich-security-negative.test.ts`, `architecture-conformance.test.ts` `NEG-05`) |
| `RICH-ARCH-01`, `04` および `RICH-01`〜`08`（ブラウザ側描画・操作 UI） | **未実装**（PR 3A/3B 計画対象） | PR 3A / 3B | `web/src/components/shared-ui/*`（PR 3A） | PR 3A / 3B ゲート対象 |
| `PIN-01`〜`PIN-06`（サーバー/MCP/再解決コア） | **部分実装**（サーバー・MCP 実装済み、UI パネルは PR 3A/3B） | PR 1 / 2 / 3A / 3B | `server/src/edit-requests/*`, `server/src/artifacts/adapters/*`, `server/src/mcp/builtin-artifact-mcp.ts` | `VERIFIED (REAL RUNTIME)` (`artifact-core-durability.test.ts`, `builtin-artifact-mcp.test.ts`) |
| `ACP-01`, `ACP-02` | **対応済み**（拡張モック検証済・実 `agy` 再現スクリプト提供済） | PR 2 | `server/src/acp/client-manager.ts`, `server/src/rich/rich-content-service.ts`, `scripts/verify-real-agy-artifact-mcp.mjs` | `VERIFIED (MOCK / EMULATION)` (`builtin-artifact-mcp.test.ts`, `acp-transparency.test.ts`)＋`UNVERIFIED (REQUIRES REAL AGY / PHYSICAL IPHONE)` |

### C. UI/UX・性能・セキュリティ・陰性自己テスト（`UX-01`〜`10`, `PERF-01`〜`06`, `SEC-01`〜`10`, `NEG-01`〜`11`）

| 区分 / ID | ステータス | 計画 PR | 主実装箇所 | 検証結果・区分 |
| --- | --- | --- | --- | --- |
| `UX-01`〜`UX-10` | **未実装**（PR 3A/3B/4 UI 計画対象；既存 UI 非退行は維持） | PR 3A / 3B / 4 | `web/src/components/ArtifactWorkspace/*`, `web/src/components/shared-ui/*` | PR 3A / 3B / 4 ゲート対象（実機 iPhone 項目は `UNVERIFIED (REQUIRES REAL AGY / PHYSICAL IPHONE)`） |
| `PERF-01`, `PERF-02`, `PERF-05` | **対応済み** | PR 1 / 2 | `server/src/artifacts/resource-governor.ts`, `server/src/artifacts/sandbox-worker.ts`, `server/src/artifacts/blob-store.ts`, `server/src/rich/rich-content-service.ts` | `VERIFIED (REAL RUNTIME)` (`artifact-core-durability.test.ts`, `sandbox-and-drafts.test.ts`, `builtin-artifact-mcp.test.ts`) |
| `PERF-03`, `PERF-04`, `PERF-06` | **未実装**（PR 3A/4 フロントエンド性能計画対象） | PR 3A / 4 | `web/src/components/shared-ui/*`, `web/src/utils/viewerCache.ts` | PR 3A / 4 ゲート対象 |
| `SEC-01`〜`SEC-06`, `SEC-09`（サーバー側）, `SEC-10` | **対応済み** | PR 1 / 2 | `server/src/artifacts/*`, `server/src/files/workspace.ts`, `server/src/mcp/builtin-artifact-mcp.ts`, `server/src/rich/rich-validator.ts`, `server/scripts/artifact_doc_worker.py` | `VERIFIED (REAL RUNTIME)` (`auth-and-rbac.test.ts`, `sandbox-and-drafts.test.ts`, `builtin-artifact-mcp.test.ts`, `rich-security-negative.test.ts`, `artifact_doc_worker_test.py`) |
| `SEC-07`, `SEC-08`（サーバー側静的/評価検証済・ブラウザ側実行経路は PR 3A） | **部分実装**（サーバー側対応済・ブラウザ側 PR 3A） | PR 1 / 3A | `server/src/rich/rich-validator.ts`, `server/src/rich/rich-expr-evaluator.ts` | `VERIFIED (REAL RUNTIME)` (`rich-security-negative.test.ts`) |
| `NEG-01`, `NEG-02`, `NEG-05`, `NEG-06`〜`NEG-11`（サーバー範囲） | **対応済み** | PR 1 / 2 | `server/tests/architecture-conformance.test.ts`, `server/tests/rich-security-negative.test.ts`, `server/tests/builtin-artifact-mcp.test.ts` | `VERIFIED (REAL RUNTIME)` (`architecture-conformance.test.ts`, `rich-security-negative.test.ts`) |
| `NEG-03`, `NEG-04`（UI 構成・旧モーダル撤去検査） | **未実装**（PR 3A/4 計画対象） | PR 3A / 4 | PR 3A / PR 4 で追加予定 | PR 3A / 4 ゲート対象 |
