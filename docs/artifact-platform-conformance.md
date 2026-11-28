# Artifact Platform 機能棚卸し・適合性マトリクス（PR 3A）

本書は設計書 §11.1 の要件トレーサビリティ台帳。PR 1・PR 2 の履歴と PR 3A の実装・検証を収録する。

## 1. スコープおよびステータス定義

- **PR 1〜PR 3A**は、Core 基盤、形式別アダプターと内蔵 MCP、共通 UI、基本 Artifact 編集、PR 3A 対象セレクターを含む。
- **PR 3B**は、残りの形式と詳細セレクター、全起動経路、チャットへのリッチ回答統合を担当する。
- **PR 4**は、旧モーダル撤去と最終監査を担当する。
- **ステータス 4 区分**:
  - **対応済み**: 設計書の要求仕様通りに実装・動作確認が完了。
  - **部分実装**: コア機能または主要サブセットは実装・検証済みだが、形式固有の構造保護制約（例: SmartArt `chMax` 上限超過やスタブ `layoutDef` の安全拒否、保護ノード非破壊拒否）や後続フェーズの UI 側未実装が残るもの。
  - **未実装**: まだ未実装のもの（PR 3B・PR 4 予定の UI・最終監査項目を含む）。
  - **設計上許容された非対応**: 設計書 4.1〜4.3 節の形式方針または実ファイル技術調査に基づき、`unsupported_by_format` として非対応と確定したもの。

### 検証環境区分（設計書 11.2 節・未実行テスト非計上ルール）

- **`VERIFIED (REAL RUNTIME)`**: 実 SQLite（`WAL` + `synchronous=FULL`）・実 FS・実 Streamable HTTP MCP サーバー・実 **`bubblewrap` (`bwrap --unshare-all --unshare-net`) 厳格サンドボックス**・実ドキュメント/メディア/Web 処理ツール群（Python 3.12 / LibreOffice 24.2.7 Impress・Calc・Writer / `pdftoppm` / `pdftotext` / `qpdf` / `pandoc` / `rsvg-convert` / `ffmpeg` / Playwright Chromium + `mermaid` + `marked`）・実ビルド成果物による検証。
  - 環境変数 `AGY_TEST_FULL_RUNTIME_DIR` が未設定の CI/Base 実行では、Full Runtime テストは `it.skipIf(...)` により明示的に **SKIPPED** 扱いとし、未実行テストを成功（passed）として計上しない。
- **`VERIFIED (MOCK / EMULATION)`**: 拡張モック ACP クライアント（`agyMode: 'mock'`）またはブラウザエミュレーションによる検証（実 `agy`・実 Microsoft PowerPoint/Office デスクトップ・物理 iPhone の動作保証には含めない）。
- **`UNVERIFIED`**: 開発/CI 環境（Linux コンテナ）に実バイナリ／実機が存在しないため未検証の項目。具体的には **(a) 実 `agy` バイナリ**（再現スイート: `AGY_REAL_TEST=1 node scripts/verify-real-agy-artifact-mcp.mjs`）、**(b) 実 Microsoft PowerPoint / Word / Excel デスクトップアプリでの再開封・再編集確認**、**(c) 物理 iPhone（iOS Safari / PWA）実機確認** はすべて `UNVERIFIED` として厳格に区別する。

---

## 2. PR 2 サーバー側品質検証と PR 3A UI 視覚一致検証の明確な区別

設計書 4.3 節・第 10 章・11.1 節における検証責務を以下の通り厳格に分離する。

| 検証項目 | フェーズ | 責務・検証内容 | 実装箇所 |
| --- | --- | --- | --- |
| **PPTX 文字溢れ・枠外・重なり検査** | **PR 2（本 PR）** | 各図形の段落/フォントサイズ/行折り返しと `a:xfrm` 寸法からテキスト高さ超過（`PPTX_TEXT_OVERFLOW`）を算出し（20 スライド超過時は超過分を `unverified` 明示）、スライド外はみ出し（`PPTX_SHAPE_OUT_OF_BOUNDS`）・図形重なり（`PPTX_SHAPE_OVERLAP`）と合わせて検出する。 | `server/scripts/artifact_doc_worker.py` (`verify_pptx_text_overflow`, `verify_office`) |
| **PPTX サーバー側レイヤー分解視覚整合（SSIM / MAE）** | **PR 2（本 PR）** | `render_presentation_layer` が生成する背景プレート PNG と各透過スプライト PNG（空プレースホルダーの透過扱い含む）をサーバー側で合成し、LibreOffice Impress が出力した原本スライド全体 PNG とグレースケール 8×8 ブロック SSIM / MAE を比較検証する（チェック ID: `layer_visual_consistency`、`verificationLayer: "server_side_layer_decomposition"`）。`options: { slideIndices, maxSlides, maxShapesPerSlide }` により任意スライドを対象化可能とし、各スライドを **`verified` / `failed` / `skipped_resource_limit` / `unverified`** の 4 状態＋根拠（SSIM/MAE・図形数・予算理由）で返却する。**一部スライドのみ検証成功した場合は文書全体の成功（`passed`）として扱わず、`layer_visual_consistency: "unverified"`・`coverage: "partial"` を返す。** | `server/scripts/artifact_doc_worker.py` (`verify_pptx_layer_visual_consistency`, `compute_image_ssim_and_mae`), `server/src/artifacts/artifact-service.ts` (`verifyArtifact`), `server/src/mcp/builtin-artifact-mcp.ts` (`artifact_verify`), `server/src/routes/file-routes.ts` |
| **PPTX UI レイヤー分離キャンバス視覚一致（`UX-07`）** | **PR 3A** | ブラウザ上の `PptxModule.tsx` レイヤー分離キャンバス（背景プレート＋DOM/SVG 要素＋透過スプライト）の描画結果と、確定後 LibreOffice PNG との bbox＋SSIM 視覚一致およびゴースト 0 件を検証する。PR 2 のサーバー側レイヤー分解検証とは別レイヤーとして区別する。 | `web/src/components/ArtifactWorkspace/modules/PptxModule.tsx`（PR 3A） |
| **DOCX レイアウト品質検査** | **PR 2（本 PR）** | `sectPr` 余白・ページ幅と表/図形幅の超過（`docx_margin_overflow`）、過度な埋め込み画像サイズ（`docx_oversized_embed`）、LibreOffice PDF 出力の空白ページ（`docx_blank_page`）および保護ノード・リンク整合を検査する（チェック ID: `layout_quality`）。 | `server/scripts/artifact_doc_worker.py` (`verify_docx_layout_quality`) |
| **XLSX 数式 4 区分評価・文字切れ検査** | **PR 2（本 PR）** | 隔離コピーの LibreOffice Calc 再計算で数式セルを `evaluated_lo` / `cached_existing` / `unevaluated_unsupported` / `error_formula` の 4 区分で評価し（`formula_values`）、さらに列幅メトリクス＋LibreOffice PDF 出力の `###` 検出により数値/文字列の文字切れ（`text_truncation`）を検証する。 | `server/scripts/artifact_doc_worker.py` (`verify_workbook_formulas`, `verify_xlsx_text_truncation`) |

---

## 3. SmartArt ノード増減（`pptx.smartart.add_or_remove_node`）実ファイル・LibreOffice 技術調査結果

設計書 4.3 節の「`dgm:dataModel`＋`dgm:drawing` 幾何同期の成立可否を実ファイルと LibreOffice 描画で検証し、破綻なく動作する図種のみ対応、それ以外は `unsupported_by_format` を明示申告」に従い、LibreOffice 24.2 の DrawingML Diagram レイアウトエンジン（`DIAGRAM_IGNORE_EXTDRAWINGS=1`＋`dgm:layoutDef` 再評価）を含めた包括的技術調査を実施した。

### 3.1 調査環境・対象ファイルと 6 検証観点

1. **実 PowerPoint 生成フィクスチャ**: Apache POI 由来実ファイル `smartart-simple.pptx`（`layoutId = urn:microsoft.com/office/officeart/2005/8/layout/venn1`、`chMax = 7`、各ノードに背景円 `circN` と外部放射テキストボックス `circNTx` の 2 `pres` ポイントを持つ）
2. **OOXML 仕様準拠 `dgm:layoutDef` フィクスチャ**: `cycle4`（`alg="cycle"`）、`pyramid1`（`alg="pyra"`）、`matrix1`（`alg="snake"`）、`hierarchy1`（階層親子 `parentNodeId`＋ネスト `lin`）、`vList2` / `process1`（線形リスト・プロセス）、およびスタブ空 `layoutDef` を持つ `venn_stub`
3. **検証ツール**: LibreOffice Impress 24.2.7（`DIAGRAM_IGNORE_EXTDRAWINGS=1` `odp -> pptx` レイアウト再計算および通常 `impress_pdf_Export` / `impress_png_Export`）、`pypdf`、`validate_package`、`verify_office`
4. **6 検証観点の実測確認**:
   - **(1) `dataModel` のノード・接続関係変更**: `dgm:ptLst` / `dgm:cxnLst` において論理ノード（`node`）・`sibTrans`/`parTrans`・親子接続（`parentNodeId` 指定の階層追加/削除を含む）・`pres` サブツリー（`presOf` / `presParOf` / `circ1..circN` 等の連番 `presName` / `presStyleIdx` / `presStyleCnt`）を一貫更新。
   - **(2) `layoutDef` に基づくレイアウト再計算**: 対象 SmartArt の `p:graphicFrame` のみを抽出した隔離 PPTX から既存 `drawing*.xml` と `dsp:dataModelExt` を除去し、`DIAGRAM_IGNORE_EXTDRAWINGS=1` 付きで LibreOffice `pptx -> odp -> pptx` を実行すると、LibreOffice C++ Diagram エンジン（`oox/source/drawingml/diagram/`）が `dgm:layoutDef` を評価して新幾何の `<p:sp>` 群を出力することを実証。
   - **(3) 描画キャッシュの再生成・同期**: 再計算された `<p:sp>` 群を `p:graphicFrame/p:xfrm/a:off` 相対座標へ変換し、DFS 順で `pres` `modelId` を対応付けて `<dsp:drawing>`（`ppt/diagrams/drawing*.xml`）へ再構成し、元 PPTX に書き戻す（未存在時は `.rels` と `[Content_Types].xml` へ正規登録）。
   - **(4) OOXML としての保存整合性**: 元の `p:graphicFrame`・`dgm:relIds`・`layout*.xml`・`colors*.xml`・`quickStyle*.xml` を 100% 保持し、孤立画像参照（`r:embed`）を除去。`verify` の `package_structure` / `archive_security` / `relationship_ids` / `layer_visual_consistency` 全合格を確認。
   - **(5) 保存後の再読み込み・再編集・LibreOffice 描画**: 保存後に `artifact_read_range` で SmartArt ノード構造が取得でき、追加ノードへの `pptx.smartart.update_node_text` 再編集・連続 `add_or_remove_node` 削除・通常 LibreOffice PDF/PNG 描画（`DIAGRAM_IGNORE_EXTDRAWINGS` なし）まで破綻なく成立することを確認。
   - **(6) 既存 PowerPoint 生成ファイルとの互換性**: 実 PowerPoint 生成 `smartart-simple.pptx`（`venn1`）で 4→5 ノード追加（正五角形配置＋外部放射テキストボックス 10 図形生成）→追加ノードの `update_node_text`（`"Omega"`→`"Zeta"`）→`"def"` 削除→通常 LibreOffice 描画・`verify` 合格→`chMax=7` 超過（8 ノード目）の安全拒否（終了コード 4）まで全工程を確認。※実 Microsoft PowerPoint デスクトップアプリでの再開封・再編集は Linux 環境制約のため **`UNVERIFIED`**。

### 3.2 確定した対応／非対応図種マトリクス

| 図種カテゴリ | 対象レイアウト・条件 | 判定 | 採用エンジン・実装根拠 |
| --- | --- | --- | --- |
| **Venn 図（重畳円＋外部テキスト）** | `venn1` 等（計算可能な `dgm:layoutDef` を保持、`chMax` 範囲内） | **対応済み**（実 PowerPoint `smartart-simple.pptx` 検証済） | `libreoffice_layout_def`（`DIAGRAM_IGNORE_EXTDRAWINGS=1` 再計算＋`drawing*.xml` 同期） |
| **循環図（Cycle）** | `cycle4` 等（`alg="cycle"` 等の計算可能 `dgm:layoutDef`） | **対応済み** | `libreoffice_layout_def` |
| **ピラミッド図（Pyramid）** | `pyramid1` 等（`alg="pyra"` 等の計算可能 `dgm:layoutDef`） | **対応済み** | `libreoffice_layout_def` |
| **マトリクス / スネーク図（Matrix）** | `matrix1` 等（`alg="snake"` 等の計算可能 `dgm:layoutDef`） | **対応済み** | `libreoffice_layout_def` |
| **階層図（Hierarchy）** | `hierarchy1` 等（`parentNodeId` 指定による子ノード増減、計算可能 `dgm:layoutDef`） | **対応済み** | `libreoffice_layout_def` |
| **線形リスト・線形プロセス** | `vList*`, `hList*`, `bList*`, `lList*`, `process*`, `chevron*`, `arrow*` | **対応済み** | 計算可能 `layoutDef` 時は `libreoffice_layout_def`；スタブ `layoutDef` 時は決定論的 1D リフロー（`linear_reflow`、`sibTrans` 矢印同期含む） |
| **非対応境界（技術的根拠確定分のみ）** | (1) `dgm:layoutDef` の `<dgm:chMax>` 上限超過（例: `venn1` の 8 ノード目）、(2) 計算可能アルゴリズムを含まない空/スタブ `layoutDef` を持つ非線形図種、(3) LibreOffice 再計算後に全論理ノードのテキスト/図形が再現できない特殊レイアウト | **設計上許容された非対応** | `classify_smartart_layout` / `_recalculate_smartart_drawing_via_libreoffice` が検証し、`UnsupportedByFormatError`（終了コード 4 → API `unsupported_by_format`）で非破壊拒否 |

- 検証テスト: `server/tests/artifact_doc_worker_test.py` (`test_real_smartart_updates_data_and_cached_drawing`, `test_smartart_add_or_remove_node_supported_families_and_limits`) — **`VERIFIED (REAL RUNTIME)`**（実 Microsoft PowerPoint デスクトップでの開封確認は **`UNVERIFIED`**）

---

## 4. 全 14 形式＋軽量リッチ回答 操作単位棚卸し表

### 4.1 共通基盤・横断操作

| 操作 / 機能 | ステータス | 実装箇所 | 検証結果・区分 |
| --- | --- | --- | --- |
| `artifact_read_range` 大規模ファイル安全・部分読み取り（`MCP-05`） | **対応済み** | `server/src/artifacts/artifact-service.ts` (`openPinnedBlobMeta`, `readByteRangeFromBlob`, `streamLineRangeFromBlob`, `streamCsvRangeFromBlob`, `readRange`), `server/src/artifacts/document-worker.ts` (zero-copy immutable blob path input), `server/scripts/artifact_doc_worker.py` (`read_workbook_range` `XML.iterparse`, DOCX `word/document.xml` `XML.iterparse`) | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`: 40,000 行テキスト・バイトオフセット・40,000 行 CSV ストリーミング読取＋Base ChatUI 非稼働時ガード検証; `artifact_doc_worker_test.py`: 250 行 XLSX / 250 段落 DOCX ストリーミング読取) |
| `artifact_render` 領域指定描画（`region: { x, y, width, height, unit?: 'norm' \| 'px' \| 'pt' }`） | **対応済み** | `server/src/artifacts/types.ts` (`RenderRegion`), `server/src/artifacts/artifact-service.ts` (`renderPng`), `server/src/artifacts/document-worker.ts`, `server/src/mcp/builtin-artifact-mcp.ts` (`artifact_render`), `server/src/routes/file-routes.ts` (`GET /api/files/:artifactId/render`), `server/scripts/artifact_doc_worker.py` (`crop_png_region`), `server/scripts/artifact_web_renderer.mjs` (`computeClip`) | `VERIFIED (REAL RUNTIME)` (`artifact_doc_worker_test.py` `test_csv_table_png_render_and_region_cropping_across_formats`, `builtin-artifact-mcp.test.ts` Full Runtime テスト) |
| 能力 API（`artifact_capabilities` 3 プロファイル自動判定・理由付き返却） | **対応済み** | `server/src/artifacts/adapters/registry.ts`, `server/src/artifacts/resource-governor.ts`, `server/src/artifacts/artifact-service.ts` (`getCapabilities`) | `VERIFIED (REAL RUNTIME)` (`artifact-capabilities.test.ts`) |
| 外部ワーカー隔離（`bwrap --unshare-all --unshare-net --die-with-parent`・`/etc/libreoffice` RO マウント・RLIMIT・Pss/RSS 監視・タイムアウト・Zip Bomb/XXE 拒否） | **対応済み** | `server/src/artifacts/sandbox-worker.ts`, `server/src/artifacts/resource-governor.ts`, `server/scripts/artifact_doc_worker.py` (`validate_package`) | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts` strict `bwrap` 実稼働テスト: Python＋LibreOffice＋pandoc＋qpdf を `sandboxMode='strict'` / `allowUnsandboxedDocWorkers=false` で実行合格; `sandbox-and-drafts.test.ts`; `artifact_doc_worker_test.py`) |
| 3 プロファイル導入スクリプト（`full` / `compact` / `base`） | **対応済み** | `deploy/setup-doc-runtime.sh`, `server/src/artifacts/resource-governor.ts` (`detectRuntimeProfile`) | `VERIFIED (REAL RUNTIME)` (`doc-skills-and-runtime.test.ts`, `.github/workflows/ci-deploy.yml`) |

### 4.2 PPTX（`FUNC-01`）

| 操作 | ステータス | 実装箇所 | 検証結果・区分 |
| --- | --- | --- | --- |
| `create` / `structure` / `read_range` | **対応済み** | `server/scripts/artifact_doc_worker.py` (`create_presentation`, `pptx_structure`, `pptx_read_range`, `extract_pptx_slide_layers`) | `VERIFIED (REAL RUNTIME)` (`artifact_doc_worker_test.py`) |
| `pptx.set_shape_text`（複数段落・複数ラン・インライン書式・改行・グループ内図形対応） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`edit_presentation`, `_set_pptx_txbody`, `find_pptx_shape_with_parent`) | `VERIFIED (REAL RUNTIME)` (`test_pptx_advanced_multi_run_rich_style_non_contiguous_group_and_scaled_ungroup`) |
| `pptx.set_shape_style`（単色/グラデーション/透過塗り・線種/破線・文字色/下線/取消線/CJK フォント・段落配置/行間/箇条書き/余白・影/光彩/ぼかし・反転） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`edit_presentation`, `_apply_pptx_shape_style`) | `VERIFIED (REAL RUNTIME)` (`test_pptx_advanced_multi_run_rich_style_non_contiguous_group_and_scaled_ungroup`) |
| `pptx.add_shape`（20 種以上のプリセット図形＋初期テキスト・書式）／`pptx.remove_shape` | **対応済み** | `server/scripts/artifact_doc_worker.py` (`PPTX_PRESET_SHAPES`, `edit_presentation`) | `VERIFIED (REAL RUNTIME)` (`test_pptx_advanced_multi_run_rich_style_non_contiguous_group_and_scaled_ungroup`) |
| `pptx.set_shape_bounds`（プレースホルダー安全・浮動小数点 pt 座標・回転対応） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`edit_presentation`) | `VERIFIED (REAL RUNTIME)` (`test_pptx_advanced_multi_run_rich_style_non_contiguous_group_and_scaled_ungroup`) |
| `pptx.move_shape`（Z 順 `front`/`back`/`forward`/`backward`/数値インデックス） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`edit_presentation`) | `VERIFIED (REAL RUNTIME)` (`test_pptx_advanced_multi_run_rich_style_non_contiguous_group_and_scaled_ungroup`) |
| `pptx.group_shapes`（非連続図形グループ化）／`pptx.ungroup_shapes`（アフィン変換展開: 拡縮・平行移動・反転・回転合成） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`edit_presentation`) | `VERIFIED (REAL RUNTIME)` (`test_pptx_advanced_multi_run_rich_style_non_contiguous_group_and_scaled_ungroup`) |
| `pptx.add_image` / `pptx.add_table` / `pptx.set_table_cell`（複数ラン・セル書式） | **部分実装**（画像は PNG/JPEG 対応） | `server/scripts/artifact_doc_worker.py` (`edit_presentation`) | `VERIFIED (REAL RUNTIME)` (`artifact_doc_worker_test.py`) |
| `pptx.add_slide` / `pptx.reorder_slide` / `pptx.remove_slide` / `pptx.set_notes` | **対応済み** | `server/scripts/artifact_doc_worker.py` (`edit_presentation`) | `VERIFIED (REAL RUNTIME)` (`artifact_doc_worker_test.py`) |
| `pptx.smartart.get_structure` / `pptx.smartart.update_node_text`（`dataModel`＋`drawing` 同時同期） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`edit_smartart_text`) | `VERIFIED (REAL RUNTIME)` (`test_real_smartart_updates_data_and_cached_drawing`, `test_smartart_add_or_remove_node_supported_families_and_limits`) |
| `pptx.smartart.add_or_remove_node`（LibreOffice `DIAGRAM_IGNORE_EXTDRAWINGS=1` により Venn・循環・ピラミッド・マトリクス・階層＋線形リスト/プロセス対応；`chMax` 超過やスタブ非線形 `layoutDef` のみ `unsupported_by_format`） | **部分実装**（第 3 節の調査確定範囲・`chMax` 保護） | `server/scripts/artifact_doc_worker.py` (`classify_smartart_layout`, `_smartart_mutate_data_model`, `_recalculate_smartart_drawing_via_libreoffice`, `edit_smartart_add_or_remove_node`) | `VERIFIED (REAL RUNTIME)` (`test_smartart_add_or_remove_node_supported_families_and_limits`；PowerPoint デスクトップ再開封確認は `UNVERIFIED`) |
| `chart.create` / `update_title_and_legend` / `update_series_data`（埋込 XLSX＋キャッシュ同時同期） / `update_series_style` / `add_or_remove_series` | **部分実装**（棒/縦棒/折線/円/ドーナツ/面/散布/複合・第 2 軸対応；3D 特殊曲面等は非対応） | `server/scripts/artifact_doc_worker.py` (`edit_chart`) | `VERIFIED (REAL RUNTIME)` (`test_pptx_chart_updates_match_embedded_workbook`) |
| `render_png`（領域指定対応） / `export:pdf` / `export:png` | **対応済み** | `server/scripts/artifact_doc_worker.py` (`render_presentation_layer`, `render_office`, `crop_png_region`) | `VERIFIED (REAL RUNTIME)` (`artifact_doc_worker_test.py`) |
| `verify`（OOXML 構造・文字溢れ・枠外・重なり・任意スライド指定可能なサーバー側レイヤー分解 SSIM/MAE 4 状態検証） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`verify_pptx_text_overflow`, `verify_pptx_layer_visual_consistency`, `verify_office`), `server/src/mcp/builtin-artifact-mcp.ts` (`artifact_verify`), `server/src/routes/file-routes.ts` | `VERIFIED (REAL RUNTIME)` (`test_pptx_visual_consistency_arbitrary_slides_and_resource_budgets`, `test_office_verification_detects_pptx_overflow_docx_layout_and_xlsx_truncation`, `builtin-artifact-mcp.test.ts` Full Runtime＋strict `bwrap` テスト) |
| レイヤー分離キャンバス直接編集 UI（`PptxModule.tsx`） | **部分実装**（PR 3A の基本操作を実装） | `web/src/components/ArtifactWorkspace/modules/PptxModule.tsx`（PR 3A） | PR 3A 検証ゲート対象 |

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
| Tiptap 直接編集 UI（`DocxModule.tsx`） | **部分実装**（PR 3A の基本操作を実装） | `web/src/components/ArtifactWorkspace/modules/DocxModule.tsx`（PR 3A） | PR 3A 検証ゲート対象 |

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
| 2D 仮想グリッド直接編集 UI（`GridModule.tsx`） | **部分実装**（PR 3A の基本操作を実装） | `web/src/components/ArtifactWorkspace/modules/GridModule.tsx`（PR 3A） | PR 3A 検証ゲート対象 |

### 4.5 CSV / TSV（`FUNC-04`）

| 操作 | ステータス | 実装箇所 | 検証結果・区分 |
| --- | --- | --- | --- |
| `create` / `get_structure` / `read_range` / `edit`（セル・行・列・範囲・一括置換、Pure-JS） | **対応済み** | `server/src/artifacts/adapters/csv-adapter.ts` (`CsvAdapter`) | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`, `artifact-core-durability.test.ts`) |
| `verify`（文字コード/BOM/NUL 検査・引用符閉鎖・列数整合、Pure-JS） | **対応済み** | `server/src/artifacts/adapters/csv-adapter.ts` (`CsvAdapter.verify`) | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |
| `export:xlsx`（Pure-JS OOXML `.xlsx` 生成・`Base ChatUI` 稼働・先頭ゼロ/数式文字列の安全エスケープ）／`export:json` / `export:csv` / `export:tsv` | **対応済み** | `server/src/artifacts/adapters/csv-adapter.ts` (`buildXlsxFromRows`, `exportAs`) | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`: Base ChatUI 出力＋Full Runtime Python/LibreOffice 検証合格) |
| `render_png`（表 PNG 描画・CSV/TSV 切替・CJK フォント・領域指定対応、Compact/Full Runtime） | **対応済み** | `server/scripts/artifact_doc_worker.py` (`render_csv_table`, `crop_png_region`), `server/src/artifacts/artifact-service.ts` (`renderPng`) | `VERIFIED (REAL RUNTIME)` (`test_csv_table_png_render_and_region_cropping_across_formats`, `builtin-artifact-mcp.test.ts` Full Runtime テスト) |
| 2D 仮想グリッド直接編集 UI（`GridModule.tsx`） | **部分実装**（PR 3A の基本操作を実装） | `web/src/components/ArtifactWorkspace/modules/GridModule.tsx`（PR 3A） | PR 3A 検証ゲート対象 |

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
| 閲覧特化 UI（`PdfModule.tsx`、直接編集 UI は設計上非提供） | **部分実装**（PR 3A の基本操作を実装） | `web/src/components/ArtifactWorkspace/modules/PdfModule.tsx`（PR 3A） | PR 3A 検証ゲート対象 |

### 4.7 画像・SVG・HTML・Markdown・コード・Diff・Mermaid・動画/音声・Binary・軽量リッチ回答

| 形式 | 操作 | ステータス | 実装箇所 | 検証結果・区分 |
| --- | --- | --- | --- | --- |
| **画像（`FUNC-06`）** | `create` / `structure` / `verify` / `render_png`（領域指定対応） / `export:png\|jpg\|jpeg\|webp` / `image.crop\|resize\|rotate\|brightness\|annotate\|composite` | **対応済み** | `server/scripts/artifact_doc_worker.py` (`handle_image`, `crop_png_region`), `server/src/artifacts/adapters/registry.ts` | `VERIFIED (REAL RUNTIME)` (`artifact_doc_worker_test.py`) |
| **SVG（`FUNC-07`）** | 制作・構造・範囲・ソース／要素編集、XML・静的検証、Chromium の図形／テキスト検証、PNG | **対応済み**（検査領域・予算は下表） | `svg-adapter.ts`、`markup-edit.ts`、`svg-verifier.ts`、`artifact_web_verify.mjs` | `artifact-structure-edits.test.ts`、`builtin-artifact-mcp.test.ts`（strict bwrap） |
| **HTML（`FUNC-08`）** | ソース・パッチ・DOM 編集、永続依存、CSS セレクターによる対象再解決、構文検証・実ブラウザ CSP／依存検証、PNG | **対応済み**（実ブラウザは Full Runtime） | `html-adapter.ts`、`html-select.ts`、`markup-edit.ts`、`artifact_web_verify.mjs` | `artifact-structure-edits.test.ts`、`builtin-artifact-mcp.test.ts`（strict bwrap） |
| **Markdown（`FUNC-09`）** | `create` / `get_structure` / `read_range` / 全文・範囲・セクション・構文木編集 / `verify`（見出し段跳び・重複スラッグ・空リンク・アンカー切れ・フェンス閉鎖） | **対応済み** | `server/src/artifacts/adapters/markdown-adapter.ts` (`MarkdownAdapter`) | `VERIFIED (REAL RUNTIME)` (`artifact-structure-edits.test.ts`、`builtin-artifact-mcp.test.ts`) |
| **Markdown（`FUNC-09`）** | `export:html`（実 CommonMark/GFM レンダリング・`<pre>` スタブ撤去・Pure-JS） / `export:txt` | **対応済み** | `server/src/artifacts/adapters/markdown-adapter.ts` (`renderMarkdownToHtmlDocument`) | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |
| **Markdown（`FUNC-09`）** | `export:pdf`（Full: Chromium `page.pdf` / Compact: Pandoc+LibreOffice） / `export:docx`（Pandoc＋`python-docx` フォールバック） / `render_png`（領域指定対応） | **対応済み** | `server/scripts/artifact_web_renderer.mjs`, `server/scripts/artifact_doc_worker.py` (`export_markdown`), `server/src/artifacts/document-worker.ts`, `server/src/artifacts/artifact-service.ts` | `VERIFIED (REAL RUNTIME)` (`test_markdown_export_to_docx_and_pdf`, `builtin-artifact-mcp.test.ts` Full Runtime テスト) |
| **コード/テキスト（`FUNC-10`）** | `create` / `get_structure` / `read_range` / `edit`（範囲置換・検索置換・パッチ） / `verify`（UTF-8/NUL・JSON・YAML の構文・名前空間付き XML の整形式。DTD 依存 XML は未検証） | **検証は部分実装**（下表の範囲） | `server/src/artifacts/adapters/code-adapter.ts` (`CodeAdapter`), `server/src/artifacts/adapters/xml-validator.ts` | `VERIFIED (REAL RUNTIME)` (`adapter-verification.test.ts`, `artifact-core-durability.test.ts`) |
| **Diff（`FUNC-11`）** | `create` / `get_structure` / `read_range` / ソース・ハンク置換／削除 / `verify`（パッチ構文検査） | **対応済み** | `server/src/artifacts/adapters/diff-adapter.ts` (`DiffAdapter`) | `VERIFIED (REAL RUNTIME)` (`artifact-structure-edits.test.ts`、`artifact-core-durability.test.ts`) |
| **Mermaid（`FUNC-12`）** | `create` / `get_structure` / `read_range` / ソース・フローチャート構造編集 / `verify`（Base: 行番号付静的検査＋Full: 実 `mermaid.parse()` 構文エラー行番号検証） | **対応済み**（構造操作は `flowchart` / `graph`） | `server/src/artifacts/adapters/mermaid-adapter.ts` (`MermaidAdapter`), `server/scripts/artifact_web_renderer.mjs` (`action: 'verify'`), `server/src/artifacts/artifact-service.ts` (`verifyArtifact`) | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`: Base 静的検査＋Full Runtime 実 `mermaid.parse()` テスト) |
| **Mermaid（`FUNC-12`）** | `export:svg`（実 `mermaid.render()` SVG 出力） / `export:png` / `render_png`（領域指定対応、Full Runtime） | **対応済み** | `server/scripts/artifact_web_renderer.mjs`, `server/src/artifacts/artifact-service.ts` (`exportArtifact`, `renderPng`) | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts` Full Runtime テスト) |
| **動画/音声（`FUNC-13`）** | `structure` / `verify` / `render_png`（映像フレーム＋領域指定対応；音声のみは `unsupported_by_format`） / `media.trim`（1 連続区間） | **部分実装**（音声の映像フレーム抽出・非対応コンテナは設計上 `unsupported_by_format`） | `server/scripts/artifact_doc_worker.py` (`handle_media`), `server/src/artifacts/adapters/registry.ts` | `VERIFIED (REAL RUNTIME)` (`artifact_doc_worker_test.py`, `artifact-capabilities.test.ts`) |
| **Binary（`FUNC-14`）** | `get_structure`（メタ・SHA-256 のみ）；`create` / `edit` / `target_pin` は非対応明示 | **設計上許容された非対応**（閲覧・DL・履歴復元のみ） | `server/src/artifacts/adapters/binary-adapter.ts` (`BinaryAdapter`) | `VERIFIED (REAL RUNTIME)` (`artifact-capabilities.test.ts`) |
| **軽量リッチ回答（`FUNC-15`）** | サーバー・MCP 6 ツール・静的/動的上限・循環検出・SQLite 版管理・Artifact 保存（Pure-JS） | **部分実装**（PR 3A 共通描画を実装。チャット統合は PR 3B） | `server/src/rich/rich-content-service.ts`, `server/src/rich/rich-validator.ts`, `server/src/rich/rich-expr-evaluator.ts`, `server/src/routes/rich-routes.ts` | `VERIFIED (REAL RUNTIME)` (`rich-security-negative.test.ts`, `builtin-artifact-mcp.test.ts`) |

### 構造編集の操作契約

編集前の `artifact_get_structure` が返す要素・ブロック・ハンクに対し、`artifact_edit` の既存 Revision、冪等性、依存伝播、履歴の各検査を適用する。選択が不一致の場合は競合を返す。

| 設計書の操作 | API と選択条件 | 検証の根拠 |
| --- | --- | --- |
| SVG 図形・文字 | `svg.add_shape`、`svg.add_text`、`svg.set_text`。親 ID／構造インデックスを使う | SVG の名前空間、入れ子の同名タグ、属性値のエスケープを実ファイルの文字列と構造の両方で照合 |
| SVG 属性・スタイル・座標・階層 | `svg.set_attr`、`svg.set_style`、`svg.set_geometry`、`svg.insert_element`、`svg.replace_element`、`svg.remove_element`、`svg.move_element`。ID／インデックスと任意の期待 fingerprint を使う | 元の無関係な要素とコメントの保持、移動後の親要素、自己配下への移動拒否 |
| HTML ソース・パッチ・DOM | `replace_source`、`replace_range`、`html.apply_patch`、`html.set_attr`、`html.set_text`、`html.insert_element`、`html.replace_element`、`html.remove_element`、`html.move_element`。ブラウザに対応した CSS セレクターで対象を再解決 | `parse5` の位置に基づく部分更新、void 要素、入れ子、追加依存、期待 Revision 競合 |
| Markdown セクション・範囲・全文・構造 | `replace_source`、`replace_range`、`markdown.replace_section`、`markdown.insert_block`、`markdown.replace_block`、`markdown.remove_block`、`markdown.move_block`、`markdown.set_heading`、`markdown.set_code_block`、`markdown.set_table_cell` | CommonMark/GFM 構文木の位置を使用。フェンス内の見出しを対象外とし、Setext 見出しと表セルの区切りを検証 |
| Diff ハンク・ソース | `replace_source`、`diff.replace_hunk`、`diff.remove_hunk`。ファイル／ハンクインデックスまたは既存ヘッダー・ハッシュ | `diff` パーサーで前後を解析し、追加／削除行数と後続ハンクの新側座標を検証 |
| Mermaid ソース・ノード・エッジ・グループ | `replace_source`、`replace_range`、`mermaid.add_node`、`set_node`、`remove_node`、`move_node`、`add_edge`、`set_edge`、`remove_edge`、`add_group`、`set_group`、`remove_group`、`move_group`。構造編集はフローチャートのノード・エッジ・subgraph を対象にする | 構造、既存コメント、入れ子、連結エッジを Pure-JS テストで確認。保存後のソースを strict bwrap 実行の Mermaid パーサーで再解析 |

実行入口は `artifact-structure-edits.test.ts` と `builtin-artifact-mcp.test.ts`。構造編集の内容は既存の保存トランザクションを経由するため、PR 1 の Revision 管理、依存伝播、IPC／ACP 境界に専用の変更はない。

### YAML・XML・SVG・HTML の検証範囲

`artifact_verify` は対象 Revision の不変ブロブを検査する。下表の形式では、全チェックが `passed` なら `ok: true`、`failed` または `unverified` があれば `ok: false` とする。`coverage: complete` は全チェックの判定が確定した状態で、失敗を含み得る。判定できない範囲があれば `partial` を返す。検証済みの範囲に失敗があり、別に未検証の範囲がある場合は `*_remaining` にその根拠を返す。

| チェック | 確認する範囲 | 未検証の範囲・実装 |
| --- | --- | --- |
| `yaml_syntax` | `yaml` による複数文書、ディレクティブ、スカラー・コレクション構文、重複スカラーキー、エイリアスの宣言順序 | 複合キーの一意性と未知タグの意味。AST 上で検査し、エイリアスの実体は展開しない。 `yaml-validator.ts` |
| `xml_syntax`、`svg_xml_syntax` | `saxes` による整形式と名前空間、Unicode 名、定義済み実体・文字参照。テキストと属性の未定義実体を検出 | UTF-8（ASCII 宣言を含む）の入力を対象とする。DTD を含む文書は読み込み・展開を行わず `unverified`。XML Schema などのスキーマ適合性は対象外。 `xml-validator.ts` |
| `svg_overlap`、`svg_bounds` | 子要素の SVG 属性変換を親から合成し、矩形と凸多角形の交差および `viewBox` からのはみ出しを検査。回転後の外接矩形が重なるだけのケースを分離軸で除外 | テキスト、曲線、ストローク、参照描画、入れ子 viewport、CSS・クリップ等は未検証。定義や非表示のサブツリーは除外する。最初の `viewBox` と同寸の軸平行矩形は交差検査で背景として扱う。 `svg-verifier.ts` |
| `svg_security` | パース済み属性のイベントハンドラ、危険なリンクスキーム、スクリプト・`foreignObject` | CSS、アニメーション、リンク先や埋め込みの内容は未検証。 `svg-verifier.ts` |
| `html_syntax` | `parse5` の HTML5 診断と明示された要素の必須終了タグ。省略可能なタグや断片入力を許容 | 要素のコンテンツモデルとブラウザが診断なしに修復する全ケースの適合性は判定対象外。 `html-validator.ts` |
| `html_relative_refs`、`html_csp` | パース後の静的 URL と一部 CSS の `url()`・`@import`・フォントを、版の依存マニフェストと既存ビューアの応答ヘッダーに照合。相対画像は版に存在していてもビューアの CSP で遮断される | JavaScript の実行、追加の meta CSP と適用順序、`srcset` の候補選択、`base` の解決、未対応 CSS などは `unverified`。この検査のためのネットワーク読込は行わない。 `html-validator.ts`、`sandbox-bridge.ts`、`file-routes.ts` |

Full Runtime と strict bwrap の構成では、静的検査に次のチェックを追加する。

| チェック | 確認する範囲 | 検証根拠 |
| --- | --- | --- |
| `svg_browser_overlap`、`svg_browser_bounds` | Chromium の計算済み CSS、座標変換、曲線と図形の塗り／ストローク、文字ごとの配置を使う。見えている領域をサンプリングし、画面上の重なりと viewBox 外を報告 | 曲線と文字の重なり、装飾された楕円の範囲外、CSS で非表示にした図形、対象セレクターを strict bwrap 内で検証 |
| `html_browser_dom`、`html_browser_execution`、`html_browser_csp` | 既存 CSP とズームブリッジを配信し、同じ `allow-scripts` iframe で実行。初期ロードと 350 ms 間の動的 DOM、スクリプトエラー、CSP 違反を観測 | スクリプトによる重複 ID と接続遮断を実 Chromium で確認 |
| `html_browser_dependencies` | 同じ Revision の依存マニフェストをオフラインで再生し、Chromium が選ぶ HTML・CSS 資源を照合 | CSS の `@import` を通じた欠落を実 Chromium で確認 |

`artifact_verify.options` の `selector`、`elementOffset`、`maxElements` は検査対象を制限する。SVG は `metrics.browser.next` が次のウィンドウの開始位置を返す。ブラウザ検証はソース最大 1,000,000 バイト、依存 24 MiB、SVG 参照比較候補 1,200、比較上限 25,000 組、HTML 依存再生最大 1,500 リクエスト。対象外のウィンドウ、枚数や予算の超過、フィルター／クリップ／マーカー等のピクセル単位判定を網羅できない場合は `partial` とする。結果は検査した描画条件と初期ロードの観測に適用する。

検証専用の予算は 512 KiB、深さ 128、12,000 ノード（HTML は要素とコメント、XML は要素）。YAML のマップ・フローコレクションは 1,024 項目、SVG の交差判定は 400 図形と 200 万回の射影、HTML の CSS 検査は 1 ブロック 32,768 UTF-16 コード単位まで。診断は最大 25 件に抑え、検出数は可能な範囲で維持する。入力サイズは Revision のブロブを読み込む前に確認する。この予算は `artifact_verify` の検査に適用する。

Node.js 24 の単発計測では、上限付近の YAML（511 KiB）で CPU 10 ms・ヒープ増分 0.73 MiB、XML（511 KiB）で 32 ms・0.59 MiB、HTML（約 488 KiB）で 132 ms・12.60 MiB。HTML 11,500 要素で 143 ms・16.51 MiB、重なりの多い SVG 350 矩形で 132 ms・6.76 MiB だった。16 MiB の入力はパーサーに渡さず `partial` を返した。ヒープ増分は呼び出し前後の差で、ピーク使用量とは異なる。

既存ビューアを Chromium で開き、応答ヘッダーと `sandbox="allow-scripts"` の組み合わせを確認した。インラインスクリプト、インライン CSS、`data:` 画像が動作し、相対 URL の画像・スタイル・スクリプトと `fetch()` はブラウザが遮断した。再現コマンドは `PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium npm --workspace=server run test -- tests/adapter-verification.test.ts`。

---

## 5. 内蔵 MCP 22 ツール棚卸し（`MCP-01`〜`MCP-22`）

共通実装: `server/src/mcp/builtin-artifact-mcp.ts`, `server/src/mcp/mcp-service.ts`, `web/src/components/McpModal.tsx`

| ID | ツール名 | ステータス | 検証結果・区分 |
| --- | --- | --- | --- |
| `MCP-01` | `artifact_list` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |
| `MCP-02` | `artifact_capabilities` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`artifact-capabilities.test.ts`, `builtin-artifact-mcp.test.ts`) |
| `MCP-03` | `artifact_create` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |
| `MCP-04` | `artifact_get_structure` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |
| `MCP-05` | `artifact_read_range`（大規模ファイル向けストリーミング・バイト部分読取・不変 Blob ゼロコピー入力・XLSX/DOCX `iterparse`） | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts` 大規模テキスト/CSV テスト＋Base ChatUI 非稼働時ガード検証; `artifact_doc_worker_test.py` `test_streaming_xlsx_and_docx_range_reads`) |
| `MCP-06` | `artifact_edit` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |
| `MCP-07` | `artifact_batch_edit` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`) |
| `MCP-08` | `artifact_render`（領域指定 `region` 対応） | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts` Full Runtime テスト) |
| `MCP-09` | `artifact_verify`（Code JSON/YAML/XML・SVG XML/viewBox/XSS/重なり・HTML 構文/相対参照/CSP・任意スライド PPTX 4 状態検証・DOCX/XLSX/PDF/CSV/MD/Mermaid 検証） | **検証は形式・項目ごとに適用範囲あり** | `VERIFIED (REAL RUNTIME)` (`adapter-verification.test.ts`, `builtin-artifact-mcp.test.ts` Base＋Full Runtime＋strict `bwrap` テスト; `artifact_doc_worker_test.py`) |
| `MCP-10` | `artifact_export` | **対応済み** | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts` Base＋Full Runtime＋strict `bwrap` テスト) |
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
| `ARCH-11` | **部分実装**（PR 3A 共通シェルを実装。全起動経路は PR 3B） | PR 3A / 3B | `web/src/components/ArtifactWorkspace/*`（PR 3A） | PR 3A / 4 ゲート対象 |
| `ARCH-12` | **未実装**（PR 3B/4 移行・撤去対象） | PR 3B / 4 | `web/src/App.tsx`, `web/src/components/ArtifactViewerModal.tsx`（PR 4 撤去） | PR 3B / 4 ゲート対象 |
| `ARCH-13` | **対応済み** | PR 1 / 2 | `server/src/artifacts/render-cache.ts`, `server/src/artifacts/sandbox-worker.ts` | `VERIFIED (REAL RUNTIME)` (`sandbox-and-drafts.test.ts`, `builtin-artifact-mcp.test.ts` strict `bwrap` テスト) |
| `ARCH-14` | **対応済み** | PR 1 | `server/src/artifacts/undo-service.ts`, `server/src/artifacts/merge-policy.ts` | `VERIFIED (REAL RUNTIME)` (`artifact-core-durability.test.ts`) |
| `ARCH-15` | **対応済み** | PR 1 / 2 | `server/src/acp/client-manager.ts`, `server/src/mcp/mcp-service.ts` | `VERIFIED (MOCK / EMULATION)` (`acp-transparency.test.ts`, `builtin-artifact-mcp.test.ts`)＋`UNVERIFIED`（実 `agy`: `scripts/verify-real-agy-artifact-mcp.mjs`） |

### B. 軽量リッチ UI・対象指定・ACP 透過性（`RICH-ARCH-01`〜`07`, `PIN-01`〜`06`, `RICH-01`〜`08`, `ACP-01`〜`02`）

| 区分 / ID | ステータス | 計画 PR | 主実装箇所 | 検証結果・区分 |
| --- | --- | --- | --- | --- |
| `RICH-ARCH-02`, `03`, `05`, `06`, `07`（サーバー側） | **対応済み** | PR 1 / 2 | `server/src/rich/*`, `server/src/routes/rich-routes.ts`, `server/src/mcp/builtin-artifact-mcp.ts` | `VERIFIED (REAL RUNTIME)` (`rich-security-negative.test.ts`, `architecture-conformance.test.ts` `NEG-05`) |
| `RICH-ARCH-01`, `04` および `RICH-01`〜`08`（ブラウザ側描画・操作 UI） | **部分実装**（PR 3A 共通レンダラー実装、PR 3B チャット統合未実装） | PR 3A / 3B | `web/src/components/shared-ui/*`（PR 3A） | PR 3A / 3B ゲート対象 |
| `PIN-01`〜`PIN-06`（サーバー/MCP/再解決コア） | **部分実装**（サーバー・MCP 実装済み、UI パネルは PR 3A/3B） | PR 1 / 2 / 3A / 3B | `server/src/edit-requests/*`, `server/src/artifacts/adapters/*`, `server/src/mcp/builtin-artifact-mcp.ts` | `VERIFIED (REAL RUNTIME)` (`artifact-core-durability.test.ts`, `builtin-artifact-mcp.test.ts`) |
| `ACP-01`, `ACP-02` | **対応済み**（拡張モック検証済・実 `agy` 再現スクリプト提供済） | PR 2 | `server/src/acp/client-manager.ts`, `server/src/rich/rich-content-service.ts`, `scripts/verify-real-agy-artifact-mcp.mjs` | `VERIFIED (MOCK / EMULATION)` (`builtin-artifact-mcp.test.ts`, `acp-transparency.test.ts`)＋`UNVERIFIED`（実 `agy` バイナリ） |

### C. UI/UX・性能・セキュリティ・陰性自己テスト（`UX-01`〜`10`, `PERF-01`〜`06`, `SEC-01`〜`10`, `NEG-01`〜`11`）

| 区分 / ID | ステータス | 計画 PR | 主実装箇所 | 検証結果・区分 |
| --- | --- | --- | --- | --- |
| `UX-01`〜`UX-10` | **部分実装**（PR 3A プロトタイプ、5 解像度実測中；PR 3B/4 全体統合・監査対象） | PR 3A / 3B / 4 | `web/src/components/ArtifactWorkspace/*`, `web/src/components/shared-ui/*` | PR 3A / 3B / 4 ゲート対象（実機 iPhone 項目は `UNVERIFIED`） |
| `PERF-01`, `PERF-02`, `PERF-05` | **対応済み**（`artifact_read_range` ストリーミング/部分読取・ゼロコピー入力・不変 Revision 整合・リソース予算制御） | PR 1 / 2 | `server/src/artifacts/artifact-service.ts`, `server/src/artifacts/document-worker.ts`, `server/src/artifacts/resource-governor.ts`, `server/src/artifacts/sandbox-worker.ts`, `server/src/artifacts/blob-store.ts`, `server/scripts/artifact_doc_worker.py` | `VERIFIED (REAL RUNTIME)` (`builtin-artifact-mcp.test.ts`, `artifact_doc_worker_test.py`, `artifact-core-durability.test.ts`, `sandbox-and-drafts.test.ts`) |
| `PERF-03`, `PERF-04`, `PERF-06` | **未実装**（PR 3A/4 フロントエンド性能計画対象） | PR 3A / 4 | `web/src/components/shared-ui/*`, `web/src/utils/viewerCache.ts` | PR 3A / 4 ゲート対象 |
| `SEC-01`〜`SEC-06`, `SEC-09`（サーバー側）, `SEC-10` | **対応済み** | PR 1 / 2 | `server/src/artifacts/*`, `server/src/files/workspace.ts`, `server/src/mcp/builtin-artifact-mcp.ts`, `server/src/rich/rich-validator.ts`, `server/scripts/artifact_doc_worker.py` | `VERIFIED (REAL RUNTIME)` (`auth-and-rbac.test.ts`, `sandbox-and-drafts.test.ts`, `adapter-verification.test.ts`, `builtin-artifact-mcp.test.ts`, `rich-security-negative.test.ts`, `artifact_doc_worker_test.py`) |
| `SEC-07`, `SEC-08`（サーバー側静的/評価検証済・ブラウザ側実行経路は PR 3A） | **部分実装**（サーバー側対応済・ブラウザ側 PR 3A） | PR 1 / 3A | `server/src/rich/rich-validator.ts`, `server/src/rich/rich-expr-evaluator.ts` | `VERIFIED (REAL RUNTIME)` (`rich-security-negative.test.ts`) |
| `NEG-01`, `NEG-02`, `NEG-05`, `NEG-06`〜`NEG-11`（サーバー範囲） | **対応済み** | PR 1 / 2 | `server/tests/architecture-conformance.test.ts`, `server/tests/rich-security-negative.test.ts`, `server/tests/builtin-artifact-mcp.test.ts` | `VERIFIED (REAL RUNTIME)` (`architecture-conformance.test.ts`, `rich-security-negative.test.ts`) |
| `NEG-03`, `NEG-04`（UI 構成・旧モーダル撤去検査） | **未実装**（PR 3A/4 計画対象） | PR 3A / 4 | PR 3A / PR 4 で追加予定 | PR 3A / 4 ゲート対象 |

---

## 7. 実行証拠サマリおよび PR Lens 指摘監査

### 7.1 検証区分ごとの実測証拠

| 検証区分 | 実行スイート / 環境 | 結果 | 備考 |
| --- | --- | --- | --- |
| **`VERIFIED (REAL RUNTIME)`** | `AGY_TEST_FULL_RUNTIME_DIR=/tmp/agy-doc-runtime PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/google-chrome npx vitest run server/tests/builtin-artifact-mcp.test.ts` | **13 passed / 0 skipped / 0 failed** | Mermaid SVG・`mermaid.parse()` 行エラー・CSV 表 PNG＋領域指定・Markdown PDF/DOCX・PDF 差分検証・任意スライド PPTX 検証に加え、**`sandboxMode: 'strict'` / `allowUnsandboxedDocWorkers: false` による実 `bwrap` サンドボックス内での Python・LibreOffice・pandoc・qpdf 実行**まで合格（`bwrap` で `/etc/libreoffice` 未マウントにより LibreOffice が `NoSuchElementException` で異常終了する実バグを検出し `sandbox-worker.ts` で修正済み）。 |
| **`VERIFIED (REAL RUNTIME)`** | `AGY_TEST_SMARTART_FILE=/tmp/smartart-simple.pptx /tmp/agy-doc-runtime/venv/bin/python3 -m unittest server.tests.artifact_doc_worker_test -v` | **34 / 34 passed** | 実 PowerPoint `smartart-simple.pptx`（`venn1`）・`cycle4`・`pyramid1`・`matrix_snake`・`hierarchy1`・`process1` の SmartArt ノード増減＋再編集＋`chMax=7` 超過拒否（終了コード 4）、任意スライド PPTX 視覚整合＋リソース予算 4 状態、XLSX/DOCX `XML.iterparse` ストリーミング範囲読取を含む全 34 テスト合格。 |
| **`VERIFIED (REAL RUNTIME)`** | `npm run typecheck && npm run build && npm test`（`8122eeb` 時点の記録。`AGY_TEST_FULL_RUNTIME_DIR` 未設定の Base ChatUI モード） | **全 23 スイート合格（154 passed / Full Runtime 等 3 テストは明示的に `SKIPPED`）** | `adapter-verification.test.ts`（Code JSON/YAML/XML・SVG XML/viewBox/XSS/重なり・HTML 構文/相対参照/CSP の正常・異常テスト 9 件）および `architecture-conformance.test.ts`（0 違反）を含む全 23 スイート合格。`it.skipIf(...)` により、未実行の Full Runtime / strict `bwrap` テストが誤って `passed` として計上されないことを保証。 |
| **`VERIFIED (REAL RUNTIME)`** | 修正後の型チェック・ビルド、`adapter-verification.test.ts`、`artifact-capabilities.test.ts`、`layout-mode-and-sandbox.test.ts`、`architecture-conformance.test.ts` | **77 / 77 passed** | 既存 HTML ビューアを Chromium 156 で実行。構文の正常・異常、SVG の変換と除外、CSP と依存の区別、検証予算を確認。 |
| **`VERIFIED (REAL RUNTIME)`** | 修正後の `server.tests.artifact_doc_worker_test` | **34 / 34 passed** | ポータブル LibreOffice 26.2.7 と PowerPoint 生成の SmartArt フィクスチャを用いた Python ワーカーの実ファイル検証。 |
| **`UNVERIFIED`** | 旧環境での Full Runtime MCP の PPTX 視覚検証、strict `bwrap` | **PPTX テスト 1 件失敗、strict 1 件スキップ** | ワーカーの固定 PATH に LibreOffice がなく、PPTX の視覚検証は `scope: none` だった。入れ子実行環境の `bwrap` は UID マップ設定で起動に失敗した。 |
| **`VERIFIED (REAL RUNTIME)`** | `AGY_TEST_FULL_RUNTIME_DIR=/tmp/agy-pr2-strict-runtime AGY_REQUIRE_STRICT_ARTIFACT_RUNTIME=1 npm --workspace=server run test -- tests/builtin-artifact-mcp.test.ts -t 'Full Runtime\|strict bwrap'` | **3 / 3 passed** | Python 3.13、LibreOffice 26.2.7、qpdf 12.2、Pandoc、Chromium を read-only 配備。strict bwrap を必須にして、PPTX 対象スライドの SSIM、PDF、Markdown、Mermaid、および HTML/SVG のブラウザ検証を確認。 |
| **`VERIFIED (MOCK / EMULATION)`** | `acp-transparency.test.ts`, `builtin-artifact-mcp.test.ts`（ACP ターン帰属・`session/load`・`session/resume` 経路） | **passed** | `agyMode: 'mock'` の拡張モック ACP クライアントによる検証。 |
| **`UNVERIFIED`** | 実 `agy` バイナリ / 実 Microsoft PowerPoint・Word・Excel デスクトップアプリ / 物理 iPhone（iOS Safari・PWA） | **未検証（環境非搭載）** | LibreOffice やモック検証をもって検証済みと混同しない。実 `agy` 検証は `AGY_REAL_TEST=1 node scripts/verify-real-agy-artifact-mcp.mjs` を実機環境で実行すること。 |

### 7.2 PR #37 PR Lens 過去指摘の再照合結果

PR #37 に過去に記録された全 6 件の PR Lens 指摘について最新コードと再照合した：
- `#4688390115`（`edit_presentation` の `text is None` ガード）: 修正済み確認（`c771621` 以降継続維持）。
- `#4688390123`（`readActiveArtifactBytes` の 100MB 制限適用範囲）: 修正済み確認（`c771621` 以降継続維持、さらに `readRange` をストリーミング/部分読取化）。
- `#4688441346`（`deploy/setup-doc-runtime.sh` の RAM プローブ失敗時フォールバック）: 修正済み確認（`80446ff` 以降継続維持）。
- `#4688517338`（`artifact-service.ts` `readRange` における `this.documentWorker.available` 事前チェック欠落）: **本修正で解消**（`artifact-service.ts` に `this.documentWorker.available &&` ガードを追加し、`builtin-artifact-mcp.test.ts` で Base ChatUI 時の 422 `UNSUPPORTED_OPERATION` 返却をテスト化）。
- `#4689345173`（`MarkdownAdapter.verify` の `decodeURIComponent` 例外保護）: 修正済み確認（`bc6f405` 以降継続維持）。
- `#4689533352`（`MarkdownAdapter` `sanitizeHref` の二重 HTML エスケープ防止）: 修正済み確認（`88fe84e` 以降 `unescapeBasicHtmlEntities` により継続維持）。


## 8. PR #38 の操作単位検証

対象は添付設計書第10章の PR 3A。固定ベースは PR #37 HEAD `5c49b3a4914fd26073d66dc510e3f2acc0fb89f9`。各行は対象操作と証拠を対応付ける。最新のコミットと実行結果は [PR #38 の Checks](https://github.com/tomo8812/AGY-ChatUI/pull/38/checks) を参照する。

| 設計書 | 操作 | 検証証拠 |
|---|---|---|
| 4.2、FUNC-04、RICH-ARCH-06 | 追加ランタイムと外部ワーカーを無効にした構成で CSV/TSV の絞り込み・セル変更・行列追加、Markdown/Code の保存。ホストの既存 PPTX 閲覧で構造と座標から別々に編集依頼を作成。リッチ UI の状態変更・リセット | `e2e/pr3a-base.spec.ts`。実 Fastify、実ファイル、認証済み API。PPTX のワーカー能力が無効、対象再解決が成功し領域 PNG が空であることを確認 |
| 4.3、7.1、FUNC-01、UX-07 | PPTX の選択、F2 でキャンバス内編集、リサイズ、書式、図形・表・画像・スライド構造の保存。表と画像を一つの下書きに積み、一版で保存 | `e2e/pr3a-real.spec.ts`。SVG 基本図形、透明スプライト、グループ内の回転・透明度・影、画像、表、背景を含む実スライド。ブラウザーキャプチャと LibreOffice 出力を SSIM 0.95 以上、MAE 5 以下で比較 |
| 4.3、7.1、FUNC-03、FUNC-04 | 仮想グリッドのキーボード移動、セル番地への移動、全体検索、セル編集、表示外・別シート参照の未保存数式、CSV/TSV の全行フィルタ | `e2e/pr3a-real.spec.ts` の `A1+Z900+Other!B50`、`e2e/pr3a-base.spec.ts` のフィルタ越しの元行編集と複数構造操作。参照取得は Revision 固定で、外部ブック・許可外関数・循環参照を評価しない |
| 4.3、7.1、FUNC-02 | DOCX の見出し移動、書式、既存簡易表のセル保存、複数段落・表の追加順、保護要素の保持 | `e2e/pr3a-real.spec.ts` で元の混在書式、既存表のセル、追加ブロックと保存版を照合。画像は作成時にプレビューと幅調整が可能。埋め込み画像を含む複雑な段落は保護 |
| 4.2、4.3 | 文書編集時のサイズ制御 | Word の段落文字数・ラン数による UI 拒否および保存時の切り詰めを削除。画像の 6,000,000 バイトはワーカーと PPTX プレビュー API の Base64 8,000,000 文字から算出。個別画像の安全性と寸法の検証および編集リクエスト全体の上限を維持 |
| 5.1、5.2、PIN-04 | 先に保存して依頼、保存済み版へ依頼、既存下書きへの復帰。依頼一覧の修正、順序変更、削除。PDF のページ・本文・ピン・領域を指定 | `e2e/pr3a-base.spec.ts` の版選択、`e2e/pr3a-real.spec.ts` の実際の依頼作成と再解決。PPTX/DOCX は選択した XML 要素のフィンガープリント、PDF はページ内容と領域座標のダイジェストを保持。PDF は元の不変版を照合し、版が変われば再確認にする |
| 6.2、RICH-02〜08、PERF-03/04 | 遅延読込、動的属性、各ノード種別の描画、10 グラフ種別、欠損・出典、状態連動、明示操作 | `e2e/pr3a-rich-catalog.spec.ts` がノード描画と副作用の呼出し・確認取消を検証。`e2e/pr3a-rich.spec.ts` が画面外チャートの復帰と仮想表を検証。カタログのホストはテスト内で記録し、実チャット送信は実行しない |
| 7.1、第10章 | PC 1280×720、1440×900、1920×1080、iPhone 相当 WebKit 375×812、430×932。ライト/ダークのキャプチャ、キーボード操作、更新競合時の下書き・ズーム保持 | `e2e/pr3a-real.spec.ts`、`e2e/pr3a-prototype.spec.ts` と `pr3a-browser-captures`。`pr3a-evidence.json` が各画面の実操作、Revision、対象セレクター、PPTX 視覚値を記録 |

ブラウザー試験は Chromium と WebKit の CSS ビューポートで実行する。Office の実ブラウザー試験は CI の Compact テスト構成、Base 試験は追加ランタイムを無効にした構成を使用する。通常のチャット送信経路との統合、全形式と全 TargetSelector の統合は設計書第10章の PR 3B。物理 iPhone による最終監査は PR 4。

---

## 9. PR 3A 設計書との残存不一致是正・適合性検証記録

HEAD `807e4ff` 以降の設計書（4.3 節、5.2 節、6.2 節、7.1 節、PIN-02、FUNC-01、UX-01、UX-07、PERF-03/04）との残存不一致について、PR 3A スコープ内で以下の是正を実施・検証した。PR 3B / PR 4 担当範囲の前倒しは行わない。

### 9.1 是正項目と実装箇所

| 区分 | 対象設計要件 | 是正内容 | 主実装箇所 |
| --- | --- | --- | --- |
| **1. 対象指定の内容結合フィンガープリント** | 5.2 節・`PIN-02`（XLSX） | 全体 SHA-256 代用を廃止し、Pure-JS ストリーミング XML 解析でシート構造ハッシュ（`expectedSheetStructHash`）および対象範囲の値・数式・並び順を順序結合したハッシュ（`expectedRangeValuesHash`）を算出・照合。未設定・値変化・数式変化・行/列並び替え・構造変化を `needs_review` として検出。Base ChatUI（外部ワーカーなし）でも動作。 | `server/src/artifacts/adapters/ooxml-target.ts`, `server/src/artifacts/adapters/registry.ts`, `server/src/artifacts/artifact-service.ts`, `web/src/components/ArtifactWorkspace/modules/GridModule.tsx` |
| **1. 対象指定の内容結合フィンガープリント** | 5.2 節・`PIN-02`（CSV/TSV） | `csv_range` / `csv_row_col` に `expectedRowCount`・`expectedColCount`・`expectedHeaderHash`・`expectedRangeValuesHash` を必須化。`GridModule.tsx` から `targetHashes=true` で取得・付与し、`CsvAdapter.resolveTarget` で欠落および行列数・ヘッダー・範囲値・並び順変化をすべて `needs_review` 判定。 | `server/src/artifacts/adapters/csv-adapter.ts`, `server/src/artifacts/artifact-service.ts`, `web/src/components/ArtifactWorkspace/modules/GridModule.tsx` |
| **1. 対象指定の内容結合フィンガープリント** | 5.2 節・`PIN-02`（PDF） | 全体 SHA-256 依存を廃止し、Pure-JS PDF パーサー（xref / ObjStm / ページツリー / コンテンツストリーム / 回転 / 寸法 / リソース / 注釈）で実ページ単位の `expectedPageContentHash` および対象ページ結合の `expectedRegionDigest` を算出・再解決時に照合。他ページ編集では対象ページが `resolved` を維持し、対象ページ回転・寸法・内容変更・範囲逸脱を `needs_review` 検出。Base ChatUI でも外部ワーカー不要。 | `server/src/artifacts/adapters/pdf-target.ts`, `server/src/artifacts/adapters/registry.ts`, `server/src/artifacts/artifact-service.ts`, `web/src/components/ArtifactWorkspace/modules/PdfModule.tsx` |
| **1. 対象指定の内容結合フィンガープリント** | 5.2 節・`PIN-02`（DOCX） | `paraId` 非存在時の重複段落誤一致を防止するため、`contextBeforeHash`・`contextAfterHash`・`occurrenceIndex`・`duplicateCount` を算出し、`resolveTarget` で前後文脈および一意性を厳格検証。同一内容の重複段落が Revision 変更で位置移動した場合は `needs_review`（`ambiguous_duplicate_paragraph`）とし別段落を誤解決しない。 | `server/src/artifacts/adapters/ooxml-target.ts`, `server/src/artifacts/adapters/registry.ts`, `web/src/components/ArtifactWorkspace/modules/DocxModule.tsx` |
| **2. Base ChatUI・非 localhost HTTP 互換性** | Base 互換性 | `PdfModule.tsx`・`PdfCanvasCore.tsx` から `crypto.subtle.digest` 直接呼出しを全面撤去し、Pure-TS FIPS 180-4 SHA-256 実装（`sha256Hex`）へ統一。`window.crypto.subtle === undefined` の非 localhost HTTP 環境でも PDF ページ・ピン・領域の対象指定が完走。 | `web/src/utils/sha256.ts`, `web/src/components/ArtifactWorkspace/modules/PdfModule.tsx`, `web/src/components/shared-ui/document/PdfCanvasCore.tsx` |
| **3. PPTX 視覚整合性（bbox・領域単位・0 ゴースト）** | 4.3 節・`FUNC-01`・`UX-07` | 全体 SSIM のみでの局所破綻見落としを防止するため、Pure-Node PNG デコーダー＋領域別 SSIM/MAE 監査ヘルパー（`auditRegions`）と Python ワーカーの図形 bbox 単位検証を追加。`PptxModule.tsx` で削除済み図形（`removedShapeIds`）をレイヤー・ヒット領域・選択状態・リサイズハンドルから完全除外し、移動・削除後の残像 0 件を保証。 | `e2e/helpers/visualAudit.ts`, `server/scripts/artifact_doc_worker.py`, `web/src/components/ArtifactWorkspace/modules/PptxModule.tsx`, `e2e/pr3a-real.spec.ts` |
| **4. 基本編集 UI の設計適合性** | 4.3 節・7.1 節・`UX-01` | (a) `SourceEditor.tsx` にビューポート限定 `highlight.js` CodeMirror `ViewPlugin` を追加し、Python・JSON・YAML・XML・HTML・CSS・SQL・Bash・Rust・Go・Java・C/C++ 等の主要言語でライト/ダーク双方の構文強調を維持。(b) `DocxModule.tsx` の 40 ブロック単位ページ切替を廃止し、`CHUNK_SIZE=60`＋`IntersectionObserver` 遅延チャンク読込・見出し直接ジャンプ対応の連続文書キャンバスへ刷新。(c) `PptxModule.tsx` のサムネイル前後 4 枚制限を撤廃し、全スライド対応スクロール一覧＋遅延サムネイル＋スライド番号直接移動 UI を実装。 | `web/src/components/shared-ui/editor/SourceEditor.tsx`, `web/src/components/ArtifactWorkspace/modules/DocxModule.tsx`, `web/src/components/ArtifactWorkspace/modules/PptxModule.tsx`, `web/src/components/ArtifactWorkspace/workspace.css` |
| **5. リッチ UI の安全制限と性能** | 6.2 節・`PERF-03`・`PERF-04` | (a) `BlockRenderAccounting` によりブロック全体で累積展開ノード数（≤ 2,000）・総 SVG 要素数（≤ 2,000）・データ点数（≤ 10,000）・AST 評価ステップ（≤ 20,000）を兄弟ノード・動的 `repeat`・部分再描画・遅延読込（`SvgScene` / `RichChart` / `NodeEdgeDiagram`）横断で厳格保証。(b) `compileRichDynamicPlan` / `evaluateRichDynamicState` により AST キャッシュ・`computed` 依存グラフ差分再計算・未変更サブツリーメモ化を導入し、連続スライダー操作時の文書全体シリアライズ・再検証・不要再描画を排除。 | `server/src/rich/rich-validator.ts`, `web/src/components/shared-ui/RichExprEvaluator.ts`, `web/src/components/shared-ui/RichStateStore.ts`, `web/src/components/shared-ui/runtime.ts`, `web/src/components/shared-ui/RichRenderer.tsx`, `web/src/components/shared-ui/RichChartRenderer.tsx`, `web/src/components/shared-ui/NodeEdgeDiagram.tsx` |
| **6. PR Lens 指摘（検索中の版・シート変更検知）** | 整合性・競合安全 | `GridModule.tsx` の `nextMatch` に検索開始時の `revisionKey`・`sheetId`・`selectedRange` 保持および非同期完了時の再検証ガードと `AbortController` を適用し、検索中に版更新・シート切替が発生した際の陳腐化結果適用を防止。 | `web/src/components/ArtifactWorkspace/modules/GridModule.tsx` |

### 9.2 検証区分ごとの実測証拠（PR 3A 是正後）

| 検証区分 | 実行コマンド / スイート | 結果 | 確認内容 |
| --- | --- | --- | --- |
| **`VERIFIED (REAL RUNTIME)`** | `npm run typecheck && npm run build` | **0 errors**（`web` 本番ビルド＋`production-boundary` 検査＋`server` TypeScript ビルド） | 型安全性およびテストフィクスチャ本番混入ゼロ（`NEG-11`）を確認。 |
| **`VERIFIED (REAL RUNTIME)`** | `npm --workspace=server run test -- tests/pr3a-conformance-gaps.test.ts` | **8 / 8 passed** | XLSX/CSV/PDF/DOCX PIN-02 契約・Pure-TS SHA-256 既知ベクター・PPTX `auditRegions`（全体 SSIM ≥ 0.96 でも局所破綻 bbox を fail 検出）・`BlockRenderAccounting` ブロック横断上限・`RichStateStore` 連続 100 回スライダー更新（非依存購読通知 0 回・依存 `computed` のみ再計算・サブツリー再利用確認）。 |
| **`VERIFIED (REAL RUNTIME)`** | `npm --workspace=server run test -- tests/frontend-architecture-conformance.test.ts tests/architecture-conformance.test.ts tests/rich-state-store.test.ts tests/rich-security-negative.test.ts tests/rich-explicit-actions.test.ts tests/concurrency-and-sync.test.ts tests/viewer-cache.test.ts tests/web-user-sequence.test.ts tests/artifact-capabilities.test.ts tests/artifact-revision-reads.test.ts tests/artifact-structure-edits.test.ts tests/files-and-projects.test.ts tests/auth-and-rbac.test.ts tests/builtin-artifact-mcp.test.ts` | **全スイート合格**（Full Runtime 依存 4 テストのみ `SKIPPED`） | 既存サーバー・アーキテクチャ・認証・同期・Rich セキュリティ・内蔵 MCP（Base）に回帰なし。 |
| **`VERIFIED (REAL RUNTIME)`** | `e2e/pr3a-conformance-gaps.spec.ts` Test 1（実 Fastify Base ChatUI サーバー＋実 Chromium、`window.crypto.subtle = undefined`） | **1 / 1 passed** | 非 localhost HTTP 相当環境で PDF `pdf_region`（`expectedPageContentHash` ≠ 全体 SHA-256・`expectedRegionDigest`）および CSV `csv_range`（`expectedRowCount`・`expectedColCount`・`expectedHeaderHash`・`expectedRangeValuesHash`）の UI 依頼作成とサーバー再解決 `resolved` を実ブラウザで実証。 |
| **`VERIFIED (MOCK / EMULATION)`** | `PLAYWRIGHT_EXECUTABLE_PATH=... npx playwright test --project=pc-chromium e2e/pr3a-conformance-gaps.spec.ts e2e/pr3a-prototype.spec.ts e2e/pr3a-rich.spec.ts e2e/pr3a-rich-catalog.spec.ts` | **13 passed / 0 failed**（`iphone-webkit` 専用 4 件のみ環境未導入により `skipped`） | `pr3a-conformance-gaps.spec.ts` で 5 解像度（`1280×720`, `1440×900`, `1920×1080`, `375×812`, `430×932`）の `SourceEditor` Python hljs・`DocxModule` 130 ブロック連続キャンバス＆見出しジャンプ・`PptxModule` 15 スライド全一覧＆番号ジャンプ＆図形削除後 0 ゴースト（SVG・リサイズハンドル・bbox 差分）・`RichRenderer` 連続スライダー操作時非依存 DOM 変更 0 件を実 Chromium とスクリーンショット目視で確認。 |
| **`UNVERIFIED`** | Full / Compact Runtime（LibreOffice + Python doc-runtime による `e2e/pr3a-real.spec.ts`・`artifact_doc_worker_test.py`）、WebKit エンジン（`--project=iphone-webkit`）・物理 iPhone（iOS Safari / PWA）、実 `agy` バイナリ、Microsoft Office デスクトップ、GitHub PR Lens CI | **未検証（本 Linux コンテナ非搭載）** | 本環境には LibreOffice / Python doc-runtime venv / Playwright WebKit / `agy` / `gh` が未導入のため未実行。CI（Compact/Full ランタイム＋WebKit）および実機環境での実行結果をもって最終確定すること。 |


## 10. PR #38 の対象同一性・大規模文書・操作幅

起点は `733a78c284caea0d670a848be593ff59478ee5ab`。この修正の判定は、[PR #38 の Checks](https://github.com/tomo8812/AGY-ChatUI/pull/38/checks) でコミット SHA が最新 HEAD と一致する実行を参照する。

| 設計要件 | 実装と回帰検証 |
| --- | --- |
| 5.2・PIN-02 | Markdown／コードの行・文字範囲は必須の SHA-256 と前後文脈、出現順を検証する。同じ文脈で一致する候補が複数ある場合は `needs_review` とする。DOCX は一意の段落 ID または内容と文脈の一意一致が必要。PPTX はスライドの構造と、レイアウト・マスター・テーマ・画像・グラフ・埋め込みパートなどの依存関係を照合する。PDF と PPTX の旧フィンガープリントは、新方式との照合時に再確認が必要になる。 |
| 4.2・PERF-01 | OOXML の展開安全予算は 2,000 エントリ、200 MiB、圧縮比 100 倍。XLSX の広範囲は SAX で実セルだけを順序付きでハッシュ化する。旧形式の範囲ハッシュも照合できる。PDF はページツリーを反復走査して全枝の件数と循環を確認し、選択ページだけの本文・資源・注釈を処理する。本文選択はページ内オフセット、文脈、PDF.js の位置を含むセレクターとして保存する。展開は対象処理全体の 200 MiB 予算内で行う。 |
| 5.2・PERF-01／06 | 対象照合は ACP や外部レンダラーと独立した専用 Node.js プロセスで実行する。処理を 1 並列に保ち、材料となる版とディスク内容を照合する。行範囲の出現照合は線形のパターン照合を使い、抜粋の表示上限を超える範囲も全文をハッシュ化する。DOCX は表示付近とアクティブな選択を描画し、計測済みの高さと容量制限付きキャッシュでスクロールと下書きを維持する。 |
| 7.1・UX-01／02 | ソース編集、Word 書式、表移動の補助操作は表示幅に応じて開閉式のコマンドメニューへ移す。DOCX の見出しジャンプ、描画範囲外のアンマウントと復帰、表検索の途中でのシート切替をブラウザーで検証する。 |

ブラウザー検証は実ドキュメント処理とビューポートエミュレーションを併用する。CI の `pr3a-browser-captures` は Compact／Full の結果をディレクトリ別に保存し、`pr3a-evidence.json` にプロファイル、解像度、操作、Revision、PPTX の bbox 領域別 MAE／SSIM、移動・削除後の比較を記録する。露出したレイアウト背景とマスターヘッダーの画素は背景の基準で、下段の SVG 図形は図形の基準で照合する。対象は Chromium 1280×720・1440×900・1920×1080 と WebKit 375×812・430×932。ブラウザーハーネスの Office 操作は開発／CI 用の明示的な非隔離構成で実行する。物理 iPhone と実 `agy` の確認は §11.2 の環境区分に従う。


## 11. PR #38 の設計契約修正

確認起点は PR #38 の `95747dee77a5cb22485f621b92f0f632f43d13cb`。実行結果は下記の検証区分と対象コミットの Checks を参照。

| 要件・指摘 | 実装と検証経路 |
| --- | --- |
| PIN-02 · A-01、A-02 | PDF のページハッシュは Catalog の Optional Content とフォーム、ページの描画グループ、継承リソース、ページの内容・注釈を結合する。DOCX は段落の参照 ID、関係の種類と参照先、埋め込みパートとその依存を結合する。外部リンクはパッケージに記録された宛先を照合する。関係未解決時は対象を確定できない。回帰テストは `pr3a-conformance-gaps.test.ts`。 |
| PIN-02 · A-03 | XLSX・CSV・TSV の再解決は保存した元 Revision と現版の選択範囲、および行・列の文脈を照合する。対象行・列に同一候補が複数存在する場合は再確認が必要。元版を取得できない場合も対象を確定できない。実 Revision の回帰テストは `pr38-history-and-target-regressions.test.ts` と `pr3a-conformance-gaps.test.ts`。 |
| PIN-02、PIN-05、MCP-15 · A-04、A-05、V-01 | `target-resolver.ts` は系列候補の一意性、評価値、出典の実体、親スロットと所属タブを照合する。 `edit_request_get` は `untrustedTargetContent` に依頼時の状態・テーマ・抜粋と現在の抜粋を収録する。 `userInstruction` と再解決状態は別フィールド。保存時の照合後も、依頼完了はユーザーが確認する。HTTP MCP の回帰テストは `pr38-edit-request-contract.test.ts`。 |
| RICH-02、RICH-03、RICH-05〜08、SEC-08、NEG-07 · B-01、B-02、C-01〜04 | `rich-node-contract.ts` と `rich-validator.ts` をサーバーとブラウザで使用する。リテラルと評価後の型、出典・系列・タブ・SVG の ID、図解の接続、保存アクションの種類を検証する。二軸の積み上げ棒は軸ごとに描画枠を確保し、欠損と出典をページ送りで表示する。図解はラベルを折り返し、全項目も閲覧できる。コード下書きは言語を指定して共通エディターを遅延読み込みする。 |
| FUNC-01、UX-07、PIN-01 · D-02 | `PptxModule.tsx` は Base の変換 PDF 経路と、Compact/Full のキャンバス経路の双方で共通選択基盤（`shared-ui/pin/`）を用い、スライド全体・ピン・矩形領域（`pptx_region` / `expectedSlideHash`）・構造要素を提供する。キャンバスでは回転・反転した境界、透過スプライトの描画境界、グループの子座標変換を使用する。編集後の LibreOffice との画素一致は `pr3a-real.spec.ts` の対象。 |
| FUNC-05、PIN-02 · D-01、V-03 | PDF の AI 編集依頼用対象指定は `pdf_page`・`pdf_pin`・`pdf_region` に統一し、通常の文字選択・全文検索・コピーおよび MCP の注釈・頁操作・検証機能を維持する。実 PDF の目次・内部リンク・フォーム・添付・注釈・メタデータ・Optional Content と描画比較は `artifact_doc_worker_test.py`。 |
| FUNC-10、PIN-01 · D-03 | `SourceEditor.tsx` から 1-based UTF-16 の排他的終端で文字範囲を指定できる。CRLF はハッシュ計算時に正規化。サロゲートペアを分割する境界は拒否する。複数行の範囲と抜粋・文脈の照合は `pr38-history-and-target-regressions.test.ts`。 |
| FUNC-03 · D-04 | `GridModule.tsx` は元セルの型を尊重し、数値入力の文字列を `valueType: "number"` でワーカーに渡す。 `artifact_doc_worker.py` は Excel の有効桁数を超える数値と JSON の安全整数範囲を超える裸の数値を編集前に拒否する。元の文字列、先頭ゼロ、空文字、真偽値、数式の区分を維持する。対象指定は共通選択基盤（`GridTargetControl`）経由で XLSX（`xlsx_range` / `xlsx_row_col` / `xlsx_sheet`）と CSV/TSV（`csv_range` / `csv_row_col`）を提供する。 |
| MCP-12、MCP-02 · E-01、E-02 | 単一復元は現在版と参照版の依存パスの和集合を比較する。UI・REST・MCP・`artifact_capabilities`・`rich_capabilities` は単一の選択方式レジストリ（`shared/target-selection-registry.ts`）を参照し、§5.2 確定の 29 種セレクターのみを公開・受理する。廃止方式は新規受理を拒否し、保存済み依頼は履歴を保持して再指定を促す。 |
| PERF-01、SEC-05 · V-02 | 専用解析プロセスは対象指定専用の 32 MiB 入力上限・固定 640 MiB RSS 上限を撤廃し、`ResourceGovernor`（`computeTargetInspectionBudget`）でホストの利用可能メモリと入力規模に応じた動的 RSS・V8 ヒープ・タイムアウト（30 秒 / 大規模 60 秒）を割り当てる。OOXML の 200 MiB 展開上限・Zip Bomb 対策・出力 4 MiB 安全上限は維持する。RAM 12GB 環境で 32 MiB 超の正常ファイル解析が成立し、低メモリ時は `503 RESOURCE_BUSY` で通常チャット・ACP・既存閲覧を保護する。 |

## 12. 改訂設計書（§4.2 / §5.2 / §7.1 / 第 10 章 / 第 11 章）適合改修

- **共通選択基盤・単一レジストリ契約（PIN-01）**: `shared/target-selection-registry.ts`（`TARGET_SELECTOR_REGISTRY` / `getRegisteredUiModesForFormat` / `extractSupportedSelectorKinds`）を選択方式・UI モード・対応ビューの唯一の情報源とし、`web/src/components/shared-ui/pin/` に共通操作部品（`SpatialPinOverlay`, `PinModeToolbar`, `WholeTargetControl`, `ElementTargetControl`, `TextRangeTargetControl`, `GridTargetControl`, `TimeRangeTargetControl`, `TargetErrorFallback`, `useRegisteredPinModes`, `useTargetSelection`）を整備。UI 側の独立定義・許可リスト（`PDF_PIN_OPTIONS`, `PPTX_PIN_OPTIONS`, `allowSheet`, `allowCharRange`, ハードコード `canPin`）を撤去し、レジストリおよび `artifact_capabilities` の変更が UI・REST・MCP・能力 API へ一貫反映される構成とした。
- **PR3A 対象形式の適合**: PPTX（全体・ピン・矩形 `pptx_region`［`expectedSlideHash`］・構造要素を Base/Compact/Full で整合）、XLSX（セル範囲・行列・シート）、CSV/TSV（セル範囲・行列）、PDF（ページ・ピン・矩形に統一しつつ通常文字選択/検索/コピーおよび MCP 注釈操作を維持）、DOCX（段落指定を PPTX と同一の共通 `ElementTargetControl` + `PinModeToolbar` へ接続し、既存の段落クリック・スクロール・閲覧・直接編集 UX を維持）、Markdown（ソース行範囲）、コード（行・文字範囲）、軽量リッチ回答（5 種・`rich_svg_element` 撤去）を共通基盤へ統合。
- **廃止方式の整理と履歴保持**: §5.2 表外の 30 種セレクター（`pdf_text_range`, `pdf_annotation`, `video_frame_region`, `image_freeform`, `svg_element`, `html_dom_element`, `html_text_range`, `html_viewport_region`, `md_heading`, `md_block`, `md_code_block`, `md_table`, `code_symbol`, `mermaid_node`, `mermaid_edge`, `mermaid_group`, `rich_svg_element` および Office 細分化セレクター）をスキーマ・アダプター・能力 API から撤去し、保存済み依頼は履歴を保持して `needs_review`（`deprecated_selector_kind`）として再指定・再確認を促す。
- **共通エラー処理（§4.2 / §5.2 / PERF-01）**: 共通シェル（`WorkspaceShell.tsx`）に `WorkspaceErrorBoundary` を集約し、PR3A 全対象形式（PPTX・PDF・DOCX・XLSX・CSV/TSV・Markdown・Code）でプレビュー不可時は `PreviewUnavailableFallback`（ダウンロード導線＋判明時のみの簡潔な理由＋再試行）、対象解析のみの失敗時はプレビューを維持したまま `TargetInspectionErrorBanner`（再試行・再選択・閉じる）へ統一。DOCX の対象解析エラーと画像エラーを分離し、破損・暗号化・容量超過等に対する形式別の特殊表示を撤去。
- **検証区分**: 実ファイル・SQLite・実 HTTP MCP・実ビルド・33 MiB 超ファイル対象解析・レジストリ単一情報源整合（UI モード導出・能力フィルタ連動）・廃止方式拒否/履歴保持・`pptx_region`・アーキテクチャ適合性検査は `VERIFIED (REAL RUNTIME)`。Playwright 実ブラウザ E2E（本環境は Playwright ブラウザ未導入）・実 `agy acp`・物理 iPhone・実機低 RAM 負荷試験は `UNVERIFIED (REQUIRES PLAYWRIGHT BROWSER / REAL AGY / PHYSICAL IPHONE)`。

