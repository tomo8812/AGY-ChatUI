import type {
  RichAction,
  RichDocumentV1,
  RichNode,
  RichSideEffectAction,
  RichStateAction,
  RichSvgElement,
  RichValue,
} from '../../../shared/rich-schema.js';
import {
  createRichEvalBudget,
  evaluateRichAst,
  extractExprReferences,
  parseRichExpr,
  RICH_MAX_AST_STEPS,
  RICH_MAX_EXPR_LENGTH,
  RichExprError,
  type ExprAst,
  type RichEvalBudget,
  type RichEvalContext,
} from './rich-expr-evaluator.js';

import {
  SVG_ATTRS, SVG_TAGS, validateSvgAttrValue, isSvgDefinition, validSvgViewBox,
  svgDefinitionElementCount, visitSvgDefinitionValues, svgRoleMatchesActions,
} from './rich-svg-contract.js';

export const RICH_LIMITS = {
  maxJsonBytes: 512 * 1024,
  maxStaticNodes: 500,
  maxTreeDepth: 12,
  maxRepeatNestingDepth: 2,
  maxArrayPoints: 10_000,
  maxStaticSvgElements: 1_000,
  maxExprLength: RICH_MAX_EXPR_LENGTH,
  maxExpandedNodes: 2_000,
  maxExpandedSvgElements: 2_000,
  maxAstSteps: RICH_MAX_AST_STEPS,
  maxStateBytes: 128 * 1024,
} as const;

export interface RichValidationIssue {
  code: string;
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface RichValidationResult {
  valid: boolean;
  statusCode: number;
  primaryErrorCode: string | null;
  issues: RichValidationIssue[];
  stats: {
    jsonBytes: number;
    staticNodes: number;
    staticSvgElements: number;
    expandedNodes: number;
    expandedSvgElements: number;
    astStepsUsed: number;
    computedOrder: string[];
  };
  referencedArtifactIds: string[];
}

const ALLOWED_NODE_TYPES = new Set<string>([
  // layout
  'stack',
  'grid',
  'columns',
  'container',
  'card',
  'divider',
  'spacer',
  'scroll_area',
  'carousel',
  'responsive_box',
  // display
  'text',
  'caption',
  'note',
  'quote',
  'emphasis',
  'heading',
  'markdown',
  'icon',
  'badge',
  'status',
  'stat',
  'kpi_card',
  'progress',
  'list',
  'checklist',
  'steps',
  'timeline',
  'data_table',
  'source_attribution',
  // diagram
  'mermaid',
  'svg_scene',
  'node_edge_diagram',
  // chart
  'chart',
  // control
  'button',
  'clickable',
  'selectable_card',
  'text_input',
  'textarea',
  'number_input',
  'slider',
  'checkbox',
  'toggle',
  'radio_group',
  'select',
  'segmented',
  'date_input',
  'tabs',
  'collapsible',
  'popover',
  'tooltip',
  'form',
  // media/doc
  'editable_draft',
  'code_block',
  'diff_block',
  'math_block',
  'media_asset',
]);

const STATE_ACTION_TYPES = new Set<RichStateAction['type']>([
  'set_state',
  'toggle_state',
  'increment_state',
  'reset_state',
]);

const SIDE_EFFECT_ACTION_TYPES = new Set<RichSideEffectAction['type']>([
  'copy_text',
  'open_external_url',
  'open_artifact',
  'save_to_artifact',
  'submit_to_chat',
  'start_pin_edit',
]);

const ALLOWED_CHART_TYPES = new Set([
  'line',
  'bar',
  'hbar',
  'pie',
  'donut',
  'scatter',
  'area',
  'stacked_bar',
  'stacked_area',
  'combo',
]);

const ALLOWED_SAVE_FORMATS = new Set(['svg', 'md', 'txt', 'csv', 'json', 'code']);

function isExprWrapper(v: unknown): v is { expr: string } {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { expr?: unknown }).expr === 'string');
}

export function isValidHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function validateRichMarkdownContent(content: string): string | null {
  // Rich UI strict markdown mode: forbid raw HTML tags and external/data image URLs
  if (
    /<\/?(?:script|iframe|object|embed|svg|foreignobject|img|style|link|meta|form|input|a|base|video|audio|source|button|textarea|select)\b/i.test(
      content
    )
  ) {
    return 'Raw HTML elements are forbidden inside rich UI markdown nodes.';
  }
  if (/\son[a-z]+\s*=/i.test(content)) {
    return 'Inline event handlers are forbidden inside rich UI markdown nodes.';
  }
  const normalizeScheme = (raw: string): string =>
    raw
      .replace(/^<|>$/g, '')
      .replace(/[\x00-\x20]+/g, '')
      .toLowerCase();

  // Markdown image syntax ![alt](url)
  const imgMatches = content.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g);
  for (const m of imgMatches) {
    const target = normalizeScheme(m[1]);
    if (
      target.startsWith('http://') ||
      target.startsWith('https://') ||
      target.startsWith('data:') ||
      target.startsWith('javascript:') ||
      target.startsWith('vbscript:') ||
      target.startsWith('//')
    ) {
      return `External or data-URI image reference '${m[1]}' is forbidden inside rich UI markdown nodes.`;
    }
  }
  // Inline markdown links [text](url)
  const linkMatches = content.matchAll(/(?<!!)\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g);
  for (const m of linkMatches) {
    const target = normalizeScheme(m[1]);
    if (target.startsWith('javascript:') || target.startsWith('vbscript:') || target.startsWith('data:')) {
      return `Forbidden URI scheme in markdown link '${m[1]}'.`;
    }
  }
  // Markdown autolinks <javascript:...> / <data:...> / <vbscript:...>
  const autoLinkMatches = content.matchAll(/<\s*([a-zA-Z][a-zA-Z0-9+.-]*:[^>]+)>/g);
  for (const m of autoLinkMatches) {
    const target = normalizeScheme(m[1]);
    if (target.startsWith('javascript:') || target.startsWith('vbscript:') || target.startsWith('data:')) {
      return `Forbidden URI scheme in markdown autolink '${m[1]}'.`;
    }
  }
  // Reference-style markdown links/images [ref]: url
  const refMatches = content.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm);
  for (const m of refMatches) {
    const target = normalizeScheme(m[1]);
    if (target.startsWith('javascript:') || target.startsWith('vbscript:') || target.startsWith('data:')) {
      return `Forbidden URI scheme in markdown reference '${m[1]}'.`;
    }
  }
  return null;
}

export function validateRichMermaidCode(code: string): string | null {
  const lower = code.toLowerCase();
  if (
    lower.includes('<script') ||
    lower.includes('<foreignobject') ||
    lower.includes('<image') ||
    lower.includes('<img') ||
    lower.includes('javascript:') ||
    lower.includes('@import') ||
    /url\s*\(\s*['"]?\s*(?:https?:|data:|javascript:|\/\/)/i.test(code)
  ) {
    return 'Forbidden script, HTML image, @import, or external url() inside rich UI mermaid node.';
  }
  if (/^\s*%%\{.*(?:['"]?securitylevel['"]?\s*:\s*['"]?loose|['"]?htmllabels['"]?\s*:\s*['"]?true)/im.test(code)) {
    return 'Mermaid directive attempting to weaken strict security settings is forbidden in rich UI.';
  }
  return null;
}

export function validateSafeFilename(filename: string): boolean {
  const trimmed = filename.trim();
  if (!trimmed || trimmed.length > 200) return false;
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\') || /[\x00-\x1f\x7f]/.test(trimmed)) {
    return false;
  }
  return true;
}

export function topologicalSortComputed(
  computed: Record<string, string>
): { order: string[]; asts: Map<string, ExprAst>; cycle?: string[] } {
  const keys = Object.keys(computed);
  const asts = new Map<string, ExprAst>();
  const deps = new Map<string, Set<string>>();

  for (const key of keys) {
    const ast = parseRichExpr(computed[key]);
    asts.set(key, ast);
    const refs = extractExprReferences(ast);
    const localDeps = new Set<string>();
    for (const cKey of refs.computedKeys) {
      if (Object.prototype.hasOwnProperty.call(computed, cKey)) {
        localDeps.add(cKey);
      }
    }
    deps.set(key, localDeps);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];
  let cycle: string[] | undefined;

  const dfs = (k: string, stack: string[]) => {
    if (cycle) return;
    if (visiting.has(k)) {
      const idx = stack.indexOf(k);
      cycle = [...stack.slice(idx), k];
      return;
    }
    if (visited.has(k)) return;
    visiting.add(k);
    stack.push(k);
    for (const d of deps.get(k) ?? []) {
      dfs(d, stack);
    }
    stack.pop();
    visiting.delete(k);
    visited.add(k);
    order.push(k);
  };

  for (const k of keys) {
    dfs(k, []);
    if (cycle) break;
  }

  return { order, asts, cycle };
}

export interface ValidateRichDocumentOptions {
  authorizedArtifactIds?: Set<string>;
  locale?: string;
  theme?: 'light' | 'dark';
}

export function validateRichDocument(
  rawDoc: unknown,
  opts: ValidateRichDocumentOptions = {}
): RichValidationResult {
  const issues: RichValidationIssue[] = [];
  const referencedArtifacts = new Set<string>();
  let jsonBytes = 0;
  let staticNodes = 0;
  let staticSvgElements = 0;
  let expandedNodes = 0;
  let expandedSvgElements = 0;
  let expandedDataPoints = 0;
  let computedOrder: string[] = [];
  const budget = createRichEvalBudget(RICH_LIMITS.maxAstSteps);

  const fail = (code: string, path: string, message: string, statusCode = 400): RichValidationResult => {
    issues.push({ code, path, message, severity: 'error' });
    return {
      valid: false,
      statusCode,
      primaryErrorCode: code,
      issues,
      stats: {
        jsonBytes,
        staticNodes,
        staticSvgElements,
        expandedNodes,
        expandedSvgElements,
        astStepsUsed: budget.steps,
        computedOrder,
      },
      referencedArtifactIds: [...referencedArtifacts],
    };
  };

  if (!rawDoc || typeof rawDoc !== 'object' || Array.isArray(rawDoc)) {
    return fail('RICH_INVALID_SCHEMA', '$', 'Rich document must be a JSON object.');
  }

  const serialized = JSON.stringify(rawDoc);
  jsonBytes = new TextEncoder().encode(serialized).byteLength;
  if (jsonBytes > RICH_LIMITS.maxJsonBytes) {
    return fail(
      'RICH_DOC_TOO_LARGE',
      '$',
      `Rich document size (${jsonBytes} bytes) exceeds limit of ${RICH_LIMITS.maxJsonBytes} bytes.`,
      413
    );
  }

  const doc = rawDoc as Partial<RichDocumentV1>;
  if (doc.schemaVersion !== 1) {
    return fail('RICH_UNSUPPORTED_SCHEMA_VERSION', '$.schemaVersion', 'Only schemaVersion 1 is supported.');
  }
  if (!doc.root || typeof doc.root !== 'object') {
    return fail('RICH_INVALID_SCHEMA', '$.root', 'Document root node is required.');
  }

  const declaredStateKeys = new Set<string>(Object.keys(doc.state ?? {}));
  const initialState: Record<string, unknown> = { ...(doc.state ?? {}) };
  const stateBytes = new TextEncoder().encode(JSON.stringify(initialState)).byteLength;
  if (stateBytes > RICH_LIMITS.maxStateBytes) {
    return fail(
      'RICH_STATE_TOO_LARGE',
      '$.state',
      `Initial state size (${stateBytes} bytes) exceeds limit of ${RICH_LIMITS.maxStateBytes} bytes.`,
      422
    );
  }

  // Count array points inside initial state
  let totalArrayPoints = 0;
  const countArrayPoints = (val: unknown, p: string) => {
    if (Array.isArray(val)) {
      totalArrayPoints += val.length;
      if (totalArrayPoints > RICH_LIMITS.maxArrayPoints) {
        issues.push({
          code: 'RICH_ARRAY_LIMIT_EXCEEDED',
          path: p,
          message: `Total array data points exceeded ${RICH_LIMITS.maxArrayPoints}.`,
          severity: 'error',
        });
        return;
      }
      for (let i = 0; i < val.length; i++) {
        if (Array.isArray(val[i])) countArrayPoints(val[i], `${p}[${i}]`);
      }
    }
  };
  for (const [k, v] of Object.entries(initialState)) {
    countArrayPoints(v, `$.state.${k}`);
  }

  // Validate sources
  if (doc.sources !== undefined) {
    if (!Array.isArray(doc.sources)) {
      issues.push({ code: 'RICH_INVALID_SCHEMA', path: '$.sources', message: 'sources must be an array.', severity: 'error' });
    } else {
      for (let i = 0; i < doc.sources.length; i++) {
        const src = doc.sources[i];
        if (!src || typeof src !== 'object' || !src.id || !src.name) {
          issues.push({
            code: 'RICH_INVALID_SCHEMA',
            path: `$.sources[${i}]`,
            message: 'Each source entry requires id and name.',
            severity: 'error',
          });
          continue;
        }
        if (src.url !== undefined && !isValidHttpUrl(src.url)) {
          issues.push({
            code: 'RICH_FORBIDDEN_URL',
            path: `$.sources[${i}].url`,
            message: `Source URL '${src.url}' must use http:// or https://.`,
            severity: 'error',
          });
        }
      }
    }
  }

  // Validate declared referencedArtifactIds
  if (Array.isArray(doc.referencedArtifactIds)) {
    for (const artId of doc.referencedArtifactIds) {
      if (typeof artId === 'string' && artId.trim()) {
        referencedArtifacts.add(artId.trim());
      }
    }
  }

  // Parse and topologically sort computed expressions (cycle detection -> 400 RICH_COMPUTED_CYCLE)
  const computedAsts = new Map<string, ExprAst>();
  if (doc.computed && typeof doc.computed === 'object') {
    try {
      const sorted = topologicalSortComputed(doc.computed);
      if (sorted.cycle) {
        return fail(
          'RICH_COMPUTED_CYCLE',
          '$.computed',
          `Circular dependency detected in computed expressions: ${sorted.cycle.join(' -> ')}`,
          400
        );
      }
      computedOrder = sorted.order;
      for (const [k, ast] of sorted.asts.entries()) {
        computedAsts.set(k, ast);
      }
    } catch (err) {
      if (err instanceof RichExprError) {
        return fail(err.code, '$.computed', err.message, err.statusCode);
      }
      return fail('RICH_EXPR_SYNTAX', '$.computed', String(err), 400);
    }
  }

  const seenNodeIds = new Set<string>();

  const checkExprSyntax = (expr: string, p: string): ExprAst | null => {
    try {
      return parseRichExpr(expr);
    } catch (err) {
      issues.push({
        code: err instanceof RichExprError ? err.code : 'RICH_EXPR_SYNTAX',
        path: p,
        message: err instanceof Error ? err.message : String(err),
        severity: 'error',
      });
      return null;
    }
  };

  const checkRichValueStatic = (val: unknown, p: string) => {
    if (isExprWrapper(val)) {
      checkExprSyntax(val.expr, `${p}.expr`);
    } else if (Array.isArray(val)) {
      countArrayPoints(val, p);
    }
  };

  const checkActionsStatic = (
    actions: unknown,
    p: string,
    allowSideEffects: boolean,
    requireNonEmpty = false
  ) => {
    if (!Array.isArray(actions)) {
      if (requireNonEmpty) {
        issues.push({
          code: 'RICH_NONFUNCTIONAL_CONTROL',
          path: p,
          message: 'Interactive control requires a non-empty action array.',
          severity: 'error',
        });
      }
      return;
    }
    if (requireNonEmpty && actions.length === 0) {
      issues.push({
        code: 'RICH_NONFUNCTIONAL_CONTROL',
        path: p,
        message: 'Interactive control action array cannot be empty.',
        severity: 'error',
      });
      return;
    }
    for (let i = 0; i < actions.length; i++) {
      const act = actions[i] as Partial<RichAction> | null;
      const ap = `${p}[${i}]`;
      if (!act || typeof act !== 'object' || typeof act.type !== 'string') {
        issues.push({ code: 'RICH_INVALID_ACTION', path: ap, message: 'Action must be an object with type.', severity: 'error' });
        continue;
      }
      if (SIDE_EFFECT_ACTION_TYPES.has(act.type as RichSideEffectAction['type'])) {
        if (!allowSideEffects) {
          issues.push({
            code: 'RICH_FORBIDDEN_SIDE_EFFECT',
            path: ap,
            message: `Side-effect action '${act.type}' is forbidden in this event context (only state actions are permitted).`,
            severity: 'error',
          });
          continue;
        }
        if (act.type === 'copy_text') checkExprSyntax(String((act as { textExpr?: unknown }).textExpr ?? ''), `${ap}.textExpr`);
        if (act.type === 'open_external_url') checkExprSyntax(String((act as { urlExpr?: unknown }).urlExpr ?? ''), `${ap}.urlExpr`);
        if (act.type === 'open_artifact') checkExprSyntax(String((act as { artifactIdExpr?: unknown }).artifactIdExpr ?? ''), `${ap}.artifactIdExpr`);
        if (act.type === 'save_to_artifact') {
          const sa = act as Extract<RichSideEffectAction, { type: 'save_to_artifact' }>;
          if (!ALLOWED_SAVE_FORMATS.has(sa.format)) {
            issues.push({ code: 'RICH_INVALID_ACTION', path: `${ap}.format`, message: `Unsupported save format '${sa.format}'.`, severity: 'error' });
          }
          checkExprSyntax(String(sa.filenameExpr ?? ''), `${ap}.filenameExpr`);
          checkExprSyntax(String(sa.contentExpr ?? ''), `${ap}.contentExpr`);
        }
        if (act.type === 'submit_to_chat') checkExprSyntax(String((act as { textExpr?: unknown }).textExpr ?? ''), `${ap}.textExpr`);
      } else if (STATE_ACTION_TYPES.has(act.type as RichStateAction['type'])) {
        if (act.type === 'set_state') {
          const sa = act as Extract<RichStateAction, { type: 'set_state' }>;
          if (!declaredStateKeys.has(sa.key)) {
            issues.push({ code: 'RICH_UNDECLARED_STATE_KEY', path: `${ap}.key`, message: `State key '${sa.key}' is not declared in document.state.`, severity: 'error' });
          }
          checkExprSyntax(String(sa.valueExpr ?? ''), `${ap}.valueExpr`);
        } else if (act.type === 'toggle_state' || act.type === 'increment_state') {
          const key = (act as { key?: string }).key ?? '';
          if (!declaredStateKeys.has(key)) {
            issues.push({ code: 'RICH_UNDECLARED_STATE_KEY', path: `${ap}.key`, message: `State key '${key}' is not declared in document.state.`, severity: 'error' });
          }
          if (act.type === 'increment_state' && act.deltaExpr) {
            checkExprSyntax(act.deltaExpr, `${ap}.deltaExpr`);
          }
        } else if (act.type === 'reset_state' && Array.isArray(act.keys)) {
          for (const k of act.keys) {
            if (!declaredStateKeys.has(k)) {
              issues.push({ code: 'RICH_UNDECLARED_STATE_KEY', path: `${ap}.keys`, message: `State key '${k}' is not declared in document.state.`, severity: 'error' });
            }
          }
        }
      } else {
        issues.push({ code: 'RICH_INVALID_ACTION', path: ap, message: `Unknown action type '${act.type}'.`, severity: 'error' });
      }
    }
  };

  const checkBind = (bindKey: unknown, p: string, required: boolean) => {
    if (bindKey === undefined || bindKey === null || bindKey === '') {
      if (required) {
        issues.push({
          code: 'RICH_NONFUNCTIONAL_CONTROL',
          path: p,
          message: 'Interactive control must declare a valid state bind.',
          severity: 'error',
        });
      }
      return;
    }
    if (typeof bindKey !== 'string' || !declaredStateKeys.has(bindKey)) {
      issues.push({
        code: 'RICH_UNDECLARED_STATE_KEY',
        path: p,
        message: `Bound state key '${String(bindKey)}' is not declared in document.state.`,
        severity: 'error',
      });
    }
  };

  const countStaticSvg = (count: number, p: string) => {
    staticSvgElements += count;
    if (staticSvgElements > RICH_LIMITS.maxStaticSvgElements) {
      issues.push({
        code: 'RICH_SVG_LIMIT_EXCEEDED', path: p,
        message: `Static SVG element count exceeded ${RICH_LIMITS.maxStaticSvgElements}.`, severity: 'error',
      });
    }
  };
  const checkSvgValue = (name: string, value: unknown, p: string, defs: ReadonlySet<string>) => {
    if (isExprWrapper(value)) checkExprSyntax(value.expr, p + '.expr');
    else {
      const err = validateSvgAttrValue(name, value, defs);
      if (err) issues.push({ code: 'RICH_UNSAFE_SVG_VALUE', path: p, message: err, severity: 'error' });
    }
  };
  const validateSvgElementStatic = (el: unknown, p: string, repeatDepth: number, defs: ReadonlySet<string>) => {
    if (!el || typeof el !== 'object') {
      issues.push({ code: 'RICH_INVALID_SVG', path: p, message: 'SVG element must be an object.', severity: 'error' });
      return;
    }
    countStaticSvg(1, p);
    if (staticSvgElements > RICH_LIMITS.maxStaticSvgElements) return;
    const svgEl = el as Partial<RichSvgElement> & Record<string, unknown>;
    if (typeof svgEl.tag !== 'string' || !SVG_TAGS.has(svgEl.tag)) {
      issues.push({
        code: 'RICH_FORBIDDEN_SVG_TAG',
        path: `${p}.tag`,
        message: `SVG tag '${String(svgEl.tag)}' is not permitted.`,
        severity: 'error',
      });
      return;
    }
    if (svgEl.visibleWhen) checkExprSyntax(svgEl.visibleWhen, `${p}.visibleWhen`);
    let nextRepeatDepth = repeatDepth;
    if (svgEl.repeat) {
      nextRepeatDepth += 1;
      if (nextRepeatDepth > RICH_LIMITS.maxRepeatNestingDepth) {
        issues.push({
          code: 'RICH_REPEAT_DEPTH_EXCEEDED',
          path: `${p}.repeat`,
          message: `repeat nesting depth exceeded ${RICH_LIMITS.maxRepeatNestingDepth}.`,
          severity: 'error',
        });
      }
      checkExprSyntax(svgEl.repeat.itemsExpr, `${p}.repeat.itemsExpr`);
    }
    if (svgEl.attrs && typeof svgEl.attrs === 'object') {
      for (const [k, v] of Object.entries(svgEl.attrs)) {
        if (!SVG_ATTRS.has(k)) {
          issues.push({
            code: 'RICH_FORBIDDEN_SVG_ATTR',
            path: `${p}.attrs.${k}`,
            message: `SVG attribute '${k}' is not permitted.`,
            severity: 'error',
          });
          continue;
        }
        checkSvgValue(k, v, `${p}.attrs.${k}`, defs);
      }
    }
    if (svgEl.textContent !== undefined) checkRichValueStatic(svgEl.textContent, `${p}.textContent`);
    if (svgEl.tooltip !== undefined) checkRichValueStatic(svgEl.tooltip, `${p}.tooltip`);
    if (svgEl.onClick !== undefined) {
      // SVG element click only permits state actions (never side effects)
      checkActionsStatic(svgEl.onClick, `${p}.onClick`, false, false);
    }
    if (Array.isArray(svgEl.children)) {
      if (svgEl.tag !== 'g' && svgEl.tag !== 'text') {
        issues.push({
          code: 'RICH_INVALID_SVG',
          path: `${p}.children`,
          message: `SVG children are only permitted inside 'g' or 'text', not '${svgEl.tag}'.`,
          severity: 'error',
        });
      } else {
        svgEl.children.forEach((child, idx) => validateSvgElementStatic(child, `${p}.children[${idx}]`, nextRepeatDepth, defs));
      }
    }
  };

  const validateSvgSceneStatic = (scene: Record<string, unknown>, p: string, repeatDepth: number) => {
    if (!validSvgViewBox(scene.viewBox)) {
      issues.push({ code: 'RICH_INVALID_SVG', path: `${p}.viewBox`, message: 'Invalid SVG viewBox.', severity: 'error' });
    }
    const ids = new Set<string>();
    if (scene.defs !== undefined && !Array.isArray(scene.defs)) {
      issues.push({ code: 'RICH_INVALID_SVG', path: `${p}.defs`, message: 'SVG definitions must be an array.', severity: 'error' });
    }
    const defs = (Array.isArray(scene.defs) ? scene.defs : []).filter((def, idx) => {
      if (!isSvgDefinition(def) || ids.has(def.id)) {
        issues.push({ code: 'RICH_INVALID_SVG', path: `${p}.defs[${idx}]`, message: 'Invalid or duplicate SVG definition.', severity: 'error' });
        return false;
      }
      ids.add(def.id);
      return true;
    });
    for (const [idx, def] of defs.entries()) {
      const dp = `${p}.defs[${idx}]`;
      countStaticSvg(svgDefinitionElementCount(def), dp);
      visitSvgDefinitionValues(def, (name, value, field) => {
        if (field.startsWith('attrs.') && !SVG_ATTRS.has(name)) {
          issues.push({ code: 'RICH_FORBIDDEN_SVG_ATTR', path: `${dp}.${field}`, message: 'Invalid clipPath attribute.', severity: 'error' });
        } else {
          checkSvgValue(name, value, `${dp}.${field}`, ids);
        }
      });
    }
    if (!Array.isArray(scene.elements)) {
      issues.push({ code: 'RICH_INVALID_SVG', path: `${p}.elements`, message: 'svg_scene requires an elements array.', severity: 'error' });
    } else {
      scene.elements.forEach((el, idx) => validateSvgElementStatic(el, `${p}.elements[${idx}]`, repeatDepth, ids));
      if (!svgRoleMatchesActions(scene.interactiveRole, scene.elements)) {
        issues.push({ code: 'RICH_INVALID_SVG_ROLE', path: `${p}.interactiveRole`,
          message: 'Only interactive SVG scenes can contain actions, and they require an action.', severity: 'error' });
      }
    }
  };

  const validateNodeStatic = (rawNode: unknown, p: string, depth: number, repeatDepth: number) => {
    if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) {
      issues.push({ code: 'RICH_INVALID_SCHEMA', path: p, message: 'Node must be an object.', severity: 'error' });
      return;
    }
    staticNodes += 1;
    if (staticNodes > RICH_LIMITS.maxStaticNodes) {
      issues.push({
        code: 'RICH_STATIC_NODE_LIMIT_EXCEEDED',
        path: p,
        message: `Static node count exceeded ${RICH_LIMITS.maxStaticNodes}.`,
        severity: 'error',
      });
      return;
    }
    if (depth > RICH_LIMITS.maxTreeDepth) {
      issues.push({
        code: 'RICH_DEPTH_LIMIT_EXCEEDED',
        path: p,
        message: `Node tree depth exceeded ${RICH_LIMITS.maxTreeDepth}.`,
        severity: 'error',
      });
      return;
    }

    const node = rawNode as Record<string, unknown>;
    const type = node.type;
    if (typeof type !== 'string' || !ALLOWED_NODE_TYPES.has(type)) {
      issues.push({
        code: 'RICH_UNKNOWN_NODE_TYPE',
        path: `${p}.type`,
        message: `Unsupported node type '${String(type)}'.`,
        severity: 'error',
      });
      return;
    }
    if (typeof node.id !== 'string' || !node.id.trim()) {
      issues.push({ code: 'RICH_MISSING_NODE_ID', path: `${p}.id`, message: 'Every node requires a non-empty unique id.', severity: 'error' });
    } else if (seenNodeIds.has(node.id)) {
      issues.push({ code: 'RICH_DUPLICATE_NODE_ID', path: `${p}.id`, message: `Duplicate node id '${node.id}'.`, severity: 'error' });
    } else {
      seenNodeIds.add(node.id);
    }

    if (typeof node.visibleWhen === 'string') checkExprSyntax(node.visibleWhen, `${p}.visibleWhen`);
    if (node.ariaLabel !== undefined) checkRichValueStatic(node.ariaLabel, `${p}.ariaLabel`);

    let nextRepeatDepth = repeatDepth;
    if (node.repeat && typeof node.repeat === 'object') {
      nextRepeatDepth += 1;
      if (nextRepeatDepth > RICH_LIMITS.maxRepeatNestingDepth) {
        issues.push({
          code: 'RICH_REPEAT_DEPTH_EXCEEDED',
          path: `${p}.repeat`,
          message: `repeat nesting depth exceeded ${RICH_LIMITS.maxRepeatNestingDepth}.`,
          severity: 'error',
        });
      }
      const rep = node.repeat as { itemsExpr?: unknown; as?: unknown };
      if (typeof rep.itemsExpr !== 'string' || typeof rep.as !== 'string' || !rep.as.trim()) {
        issues.push({ code: 'RICH_INVALID_SCHEMA', path: `${p}.repeat`, message: 'repeat requires itemsExpr and as.', severity: 'error' });
      } else {
        checkExprSyntax(rep.itemsExpr, `${p}.repeat.itemsExpr`);
      }
    }

    // Type-specific static checks
    switch (type) {
      case 'markdown': {
        checkRichValueStatic(node.content, `${p}.content`);
        if (typeof node.content === 'string') {
          const err = validateRichMarkdownContent(node.content);
          if (err) issues.push({ code: 'RICH_UNSAFE_MARKDOWN', path: `${p}.content`, message: err, severity: 'error' });
        }
        break;
      }
      case 'mermaid': {
        checkRichValueStatic(node.code, `${p}.code`);
        if (typeof node.code === 'string') {
          const err = validateRichMermaidCode(node.code);
          if (err) issues.push({ code: 'RICH_UNSAFE_MERMAID', path: `${p}.code`, message: err, severity: 'error' });
        }
        break;
      }
      case 'svg_scene': {
        validateSvgSceneStatic(node, p, nextRepeatDepth);
        break;
      }
      case 'node_edge_diagram': {
        checkRichValueStatic(node.nodes, `${p}.nodes`);
        checkRichValueStatic(node.edges, `${p}.edges`);
        if (node.selectedNodeBind !== undefined) checkBind(node.selectedNodeBind, `${p}.selectedNodeBind`, false);
        if (node.onNodeSelect !== undefined) checkActionsStatic(node.onNodeSelect, `${p}.onNodeSelect`, false, false);
        break;
      }
      case 'chart': {
        if (typeof node.chartType !== 'string' || !ALLOWED_CHART_TYPES.has(node.chartType)) {
          issues.push({ code: 'RICH_INVALID_SCHEMA', path: `${p}.chartType`, message: `Unsupported chartType '${String(node.chartType)}'.`, severity: 'error' });
        }
        if (node.categories !== undefined) checkRichValueStatic(node.categories, `${p}.categories`);
        if (!Array.isArray(node.series) || node.series.length === 0) {
          issues.push({ code: 'RICH_INVALID_SCHEMA', path: `${p}.series`, message: 'chart requires at least one series.', severity: 'error' });
        } else {
          for (let i = 0; i < node.series.length; i++) {
            const s = node.series[i] as Record<string, unknown>;
            checkRichValueStatic(s.label, `${p}.series[${i}].label`);
            checkRichValueStatic(s.data, `${p}.series[${i}].data`);
          }
        }
        if (node.selectedPointBind !== undefined) checkBind(node.selectedPointBind, `${p}.selectedPointBind`, false);
        if (node.onPointSelect !== undefined) checkActionsStatic(node.onPointSelect, `${p}.onPointSelect`, false, false);
        break;
      }
      case 'data_table': {
        checkRichValueStatic(node.rows, `${p}.rows`);
        if (node.selectedRowBind !== undefined) checkBind(node.selectedRowBind, `${p}.selectedRowBind`, false);
        if (node.onRowSelect !== undefined) checkActionsStatic(node.onRowSelect, `${p}.onRowSelect`, false, false);
        break;
      }
      case 'media_asset': {
        const sk = node.sourceKind;
        if (sk !== 'artifact' && sk !== 'inline_svg') {
          issues.push({
            code: 'RICH_FORBIDDEN_EXTERNAL_MEDIA',
            path: `${p}.sourceKind`,
            message: `media_asset sourceKind must be 'artifact' or 'inline_svg' (external URLs are forbidden).`,
            severity: 'error',
          });
        } else if (sk === 'artifact') {
          if (node.artifactId === undefined) {
            issues.push({ code: 'RICH_INVALID_SCHEMA', path: `${p}.artifactId`, message: 'media_asset(artifact) requires artifactId.', severity: 'error' });
          } else if (typeof node.artifactId === 'string') {
            if (/^(?:https?:|data:|blob:|\/\/)/i.test(node.artifactId.trim())) {
              issues.push({ code: 'RICH_FORBIDDEN_EXTERNAL_MEDIA', path: `${p}.artifactId`, message: 'External URLs are forbidden in media_asset.artifactId.', severity: 'error' });
            } else {
              referencedArtifacts.add(node.artifactId.trim());
            }
          } else {
            checkRichValueStatic(node.artifactId, `${p}.artifactId`);
          }
        } else if (sk === 'inline_svg') {
          if (!node.svgScene || typeof node.svgScene !== 'object') {
            issues.push({ code: 'RICH_INVALID_SCHEMA', path: `${p}.svgScene`, message: 'media_asset(inline_svg) requires svgScene.', severity: 'error' });
          } else {
            validateSvgSceneStatic(node.svgScene as Record<string, unknown>, `${p}.svgScene`, nextRepeatDepth);
          }
        }
        break;
      }
      // Controls — strictly enforce actionability (NEG-07) and event/side-effect separation (SEC-08 / NEG-06)
      case 'button': {
        checkRichValueStatic(node.label, `${p}.label`);
        if (typeof node.disabledWhen === 'string') checkExprSyntax(node.disabledWhen, `${p}.disabledWhen`);
        checkActionsStatic(node.onClick, `${p}.onClick`, true, true);
        break;
      }
      case 'clickable':
      case 'selectable_card': {
        if (typeof node.selectedWhen === 'string') checkExprSyntax(node.selectedWhen, `${p}.selectedWhen`);
        checkActionsStatic(node.onClick, `${p}.onClick`, false, true);
        break;
      }
      case 'form': {
        checkActionsStatic(node.onSubmit, `${p}.onSubmit`, true, true);
        break;
      }
      case 'text_input':
      case 'textarea':
      case 'checkbox':
      case 'toggle':
      case 'date_input': {
        checkBind(node.bind, `${p}.bind`, true);
        if (node.onChange !== undefined) checkActionsStatic(node.onChange, `${p}.onChange`, false, false);
        break;
      }
      case 'number_input':
      case 'slider': {
        checkBind(node.bind, `${p}.bind`, true);
        checkRichValueStatic(node.min, `${p}.min`);
        checkRichValueStatic(node.max, `${p}.max`);
        if (node.step !== undefined) checkRichValueStatic(node.step, `${p}.step`);
        if (node.onChange !== undefined) checkActionsStatic(node.onChange, `${p}.onChange`, false, false);
        break;
      }
      case 'radio_group':
      case 'select':
      case 'segmented': {
        checkBind(node.bind, `${p}.bind`, true);
        checkRichValueStatic(node.options, `${p}.options`);
        if (node.onChange !== undefined) checkActionsStatic(node.onChange, `${p}.onChange`, false, false);
        break;
      }
      case 'tabs': {
        if (node.bind !== undefined) checkBind(node.bind, `${p}.bind`, false);
        if (!Array.isArray(node.items) || node.items.length === 0) {
          issues.push({ code: 'RICH_NONFUNCTIONAL_CONTROL', path: `${p}.items`, message: 'tabs requires non-empty items.', severity: 'error' });
        } else {
          for (let i = 0; i < node.items.length; i++) {
            const tab = node.items[i] as Record<string, unknown>;
            if (Array.isArray(tab.content)) {
              tab.content.forEach((child, j) => validateNodeStatic(child, `${p}.items[${i}].content[${j}]`, depth + 1, nextRepeatDepth));
            }
          }
        }
        break;
      }
      case 'collapsible': {
        if (node.bind !== undefined) checkBind(node.bind, `${p}.bind`, false);
        checkRichValueStatic(node.title, `${p}.title`);
        break;
      }
      case 'popover':
      case 'tooltip': {
        if (node.trigger) validateNodeStatic(node.trigger, `${p}.trigger`, depth + 1, nextRepeatDepth);
        if (Array.isArray(node.content)) {
          node.content.forEach((child, i) => validateNodeStatic(child, `${p}.content[${i}]`, depth + 1, nextRepeatDepth));
        } else {
          checkRichValueStatic(node.content, `${p}.content`);
        }
        break;
      }
      case 'editable_draft': {
        checkBind(node.bind, `${p}.bind`, true);
        if (node.saveAction !== undefined) {
          checkActionsStatic([node.saveAction], `${p}.saveAction`, true, true);
        }
        break;
      }
      default: {
        // Common RichValue checks for display/layout nodes
        for (const field of ['content', 'title', 'subtitle', 'label', 'value', 'unit', 'delta', 'code', 'tex', 'oldText', 'newText', 'items']) {
          if (node[field] !== undefined) checkRichValueStatic(node[field], `${p}.${field}`);
        }
        break;
      }
    }

    // Recurse common child containers
    if (Array.isArray(node.children)) {
      node.children.forEach((child, i) => validateNodeStatic(child, `${p}.children[${i}]`, depth + 1, nextRepeatDepth));
    }
    if (node.headerAction) {
      validateNodeStatic(node.headerAction, `${p}.headerAction`, depth + 1, nextRepeatDepth);
    }
    if (node.footer) {
      validateNodeStatic(node.footer, `${p}.footer`, depth + 1, nextRepeatDepth);
    }
  };

  validateNodeStatic(doc.root, '$.root', 1, 0);

  if (issues.some((i) => i.severity === 'error')) {
    const first = issues.find((i) => i.severity === 'error')!;
    return {
      valid: false,
      statusCode: first.code === 'RICH_DOC_TOO_LARGE' ? 413 : 400,
      primaryErrorCode: first.code,
      issues,
      stats: {
        jsonBytes,
        staticNodes,
        staticSvgElements,
        expandedNodes,
        expandedSvgElements,
        astStepsUsed: budget.steps,
        computedOrder,
      },
      referencedArtifactIds: [...referencedArtifacts],
    };
  }

  // Stage 2 & 3: Dynamic expansion + Post-Evaluation validation via shared engine
  const plan = compileRichDynamicPlan(doc as RichDocumentV1, { computedOrder, computedAsts, declaredArtifactIds: referencedArtifacts });
  const dyn = evaluateRichDynamicState(plan, {
    state: initialState,
    theme: opts.theme ?? 'light',
    locale: opts.locale,
    authorizedArtifactIds: opts.authorizedArtifactIds,
    initialAstSteps: budget.steps,
  });

  for (const issue of dyn.issues) issues.push(issue);
  for (const artId of dyn.referencedArtifactIds) referencedArtifacts.add(artId);

  const firstErr = issues.find((i) => i.severity === 'error');
  return {
    valid: !firstErr,
    statusCode: firstErr
      ? dyn.statusCode !== 200
        ? dyn.statusCode
        : firstErr.code === 'RICH_FORBIDDEN_ARTIFACT_REF'
          ? 403
          : firstErr.code.includes('LIMIT')
            ? 422
            : 400
      : 200,
    primaryErrorCode: firstErr?.code ?? null,
    issues,
    stats: {
      jsonBytes,
      staticNodes,
      staticSvgElements,
      expandedNodes: dyn.stats.expandedNodes,
      expandedSvgElements: dyn.stats.expandedSvgElements,
      astStepsUsed: dyn.stats.astStepsUsed,
      computedOrder,
    },
    referencedArtifactIds: [...referencedArtifacts],
  };
}

export interface RichDependencySet {
  stateKeys: Set<string>;
  computedKeys: Set<string>;
  usesAllState: boolean;
  usesAllComputed: boolean;
  usesTheme: boolean;
}

export interface RichSubtreeCacheEntry {
  expandedNodes: number;
  expandedSvgElements: number;
  expandedDataPoints: number;
  astSteps: number;
  referencedArtifacts: string[];
}

export type RichSubtreeCache = Map<string, RichSubtreeCacheEntry>;

export interface RichDynamicPlan {
  readonly doc: RichDocumentV1;
  readonly computedOrder: string[];
  readonly computedAsts: Map<string, ExprAst>;
  readonly computedDeps: Map<string, RichDependencySet>;
  readonly exprAstCache: Map<string, ExprAst>;
  readonly subtreeDeps: WeakMap<RichNode, RichDependencySet>;
  readonly declaredArtifactIds: Set<string>;
  getAst(expr: string): ExprAst;
}

export interface RichDynamicStats {
  expandedNodes: number;
  expandedSvgElements: number;
  expandedDataPoints: number;
  astStepsUsed: number;
  computedStepsUsed: number;
  recomputedKeys: string[];
  evaluatedSubtrees: number;
  reusedSubtrees: number;
}

export interface RichDynamicEvalResult {
  valid: boolean;
  statusCode: number;
  primaryErrorCode: string | null;
  issues: RichValidationIssue[];
  computed: Record<string, unknown>;
  stats: RichDynamicStats;
  referencedArtifactIds: string[];
  subtreeCache: RichSubtreeCache;
  computedStepsByKey: Map<string, number>;
}

function emptyDeps(): RichDependencySet {
  return {
    stateKeys: new Set<string>(),
    computedKeys: new Set<string>(),
    usesAllState: false,
    usesAllComputed: false,
    usesTheme: false,
  };
}

function mergeDeps(target: RichDependencySet, source: RichDependencySet): void {
  for (const k of source.stateKeys) target.stateKeys.add(k);
  for (const k of source.computedKeys) target.computedKeys.add(k);
  if (source.usesAllState) target.usesAllState = true;
  if (source.usesAllComputed) target.usesAllComputed = true;
  if (source.usesTheme) target.usesTheme = true;
}

function collectAstDeps(ast: ExprAst, target: RichDependencySet): void {
  const walk = (node: ExprAst) => {
    switch (node.kind) {
      case 'ident':
        if (node.name === '$state') target.usesAllState = true;
        else if (node.name === '$computed') target.usesAllComputed = true;
        else if (node.name === '$theme') target.usesTheme = true;
        break;
      case 'member':
        if (node.object.kind === 'ident') {
          if (node.object.name === '$state') {
            target.stateKeys.add(node.property);
            return;
          }
          if (node.object.name === '$computed') {
            target.computedKeys.add(node.property);
            return;
          }
        }
        walk(node.object);
        break;
      case 'index':
        if (node.object.kind === 'ident' && node.index.kind === 'literal' && typeof node.index.value === 'string') {
          if (node.object.name === '$state') {
            target.stateKeys.add(node.index.value);
            return;
          }
          if (node.object.name === '$computed') {
            target.computedKeys.add(node.index.value);
            return;
          }
        }
        walk(node.object);
        walk(node.index);
        break;
      case 'unary':
        walk(node.operand);
        break;
      case 'binary':
        walk(node.left);
        walk(node.right);
        break;
      case 'ternary':
        walk(node.condition);
        walk(node.consequent);
        walk(node.alternate);
        break;
      case 'call':
        for (const arg of node.args) walk(arg);
        break;
      case 'array':
        for (const item of node.items) walk(item);
        break;
      default:
        break;
    }
  };
  walk(ast);
}

function isDepsDirty(
  deps: RichDependencySet,
  changedStateKeys: Set<string>,
  changedComputedKeys: Set<string>,
  themeChanged: boolean
): boolean {
  if (themeChanged && deps.usesTheme) return true;
  if (deps.usesAllState && changedStateKeys.size > 0) return true;
  if (deps.usesAllComputed && changedComputedKeys.size > 0) return true;
  for (const key of deps.stateKeys) {
    if (changedStateKeys.has(key)) return true;
  }
  for (const key of deps.computedKeys) {
    if (changedComputedKeys.has(key)) return true;
  }
  return false;
}

export function compileRichDynamicPlan(
  doc: RichDocumentV1,
  precomputed?: {
    computedOrder: string[];
    computedAsts: Map<string, ExprAst>;
    declaredArtifactIds?: Iterable<string>;
  }
): RichDynamicPlan {
  const exprAstCache = new Map<string, ExprAst>();
  const getAst = (expr: string): ExprAst => {
    let ast = exprAstCache.get(expr);
    if (!ast) {
      ast = parseRichExpr(expr);
      exprAstCache.set(expr, ast);
    }
    return ast;
  };

  let computedOrder: string[];
  let computedAsts: Map<string, ExprAst>;
  if (precomputed) {
    computedOrder = precomputed.computedOrder;
    computedAsts = precomputed.computedAsts;
  } else {
    const topo = topologicalSortComputed(doc.computed ?? {});
    if (topo.cycle) {
      throw new RichExprError('RICH_COMPUTED_CYCLE', 'Circular computed values.');
    }
    computedOrder = topo.order;
    computedAsts = topo.asts;
  }

  const computedDeps = new Map<string, RichDependencySet>();
  for (const key of computedOrder) {
    const deps = emptyDeps();
    const ast = computedAsts.get(key);
    if (ast) collectAstDeps(ast, deps);
    computedDeps.set(key, deps);
  }

  const subtreeDeps = new WeakMap<RichNode, RichDependencySet>();
  const addExprString = (expr: string, target: RichDependencySet) => {
    try {
      collectAstDeps(getAst(expr), target);
    } catch {
      target.usesAllState = true;
      target.usesAllComputed = true;
      target.usesTheme = true;
    }
  };
  const addRichValDeps = (val: unknown, target: RichDependencySet) => {
    if (isExprWrapper(val)) addExprString(val.expr, target);
  };
  const addSvgElementDeps = (el: RichSvgElement, target: RichDependencySet) => {
    if (el.repeat) addExprString(el.repeat.itemsExpr, target);
    if (el.visibleWhen) addExprString(el.visibleWhen, target);
    if (el.attrs) {
      for (const v of Object.values(el.attrs)) addRichValDeps(v, target);
    }
    if (Array.isArray(el.children)) {
      for (const child of el.children) addSvgElementDeps(child, target);
    }
  };
  const addActionsDeps = (actions: RichAction[] | undefined, target: RichDependencySet) => {
    if (!Array.isArray(actions)) return;
    for (const act of actions) {
      if (act.type === 'open_external_url') addExprString(act.urlExpr, target);
      else if (act.type === 'save_to_artifact') addExprString(act.filenameExpr, target);
      else if (act.type === 'open_artifact') addExprString(act.artifactIdExpr, target);
    }
  };

  const collectNodeDeps = (node: RichNode): RichDependencySet => {
    const deps = emptyDeps();
    if (node.repeat) addExprString(node.repeat.itemsExpr, deps);
    if (node.visibleWhen) addExprString(node.visibleWhen, deps);

    if (node.type === 'chart') {
      if (node.categories !== undefined) addRichValDeps(node.categories, deps);
      for (const series of node.series) addRichValDeps(series.data, deps);
    } else if (node.type === 'data_table') {
      addRichValDeps(node.rows, deps);
    } else if (node.type === 'node_edge_diagram') {
      addRichValDeps(node.nodes, deps);
      addRichValDeps(node.edges, deps);
    } else if (node.type === 'list' || node.type === 'checklist' || node.type === 'steps' || node.type === 'timeline') {
      if (node.items !== undefined) addRichValDeps(node.items, deps);
    } else if (node.type === 'radio_group' || node.type === 'select' || node.type === 'segmented') {
      addRichValDeps(node.options, deps);
    } else if (node.type === 'markdown') {
      addRichValDeps(node.content, deps);
    } else if (node.type === 'mermaid') {
      addRichValDeps(node.code, deps);
    } else if (node.type === 'svg_scene' || (node.type === 'media_asset' && node.sourceKind === 'inline_svg')) {
      const scene = node.type === 'svg_scene' ? node : node.svgScene;
      if (scene) {
        for (const def of scene.defs ?? []) visitSvgDefinitionValues(def, (_name, value) => addRichValDeps(value, deps));
        for (const el of scene.elements) addSvgElementDeps(el, deps);
      }
    } else if (node.type === 'media_asset' && node.artifactId !== undefined) {
      addRichValDeps(node.artifactId, deps);
    } else if (node.type === 'button') {
      addActionsDeps(node.onClick, deps);
    } else if (node.type === 'form') {
      addActionsDeps(node.onSubmit, deps);
    } else if (node.type === 'editable_draft' && node.saveAction) {
      addActionsDeps([node.saveAction], deps);
    }

    const anyNode = node as unknown as Record<string, unknown>;
    if (Array.isArray(anyNode.children)) {
      for (const child of anyNode.children) {
        mergeDeps(deps, collectNodeDeps(child as RichNode));
      }
    }
    if (node.type === 'tabs' && Array.isArray(node.items)) {
      for (const item of node.items) {
        if (Array.isArray(item?.content)) {
          for (const child of item.content) mergeDeps(deps, collectNodeDeps(child));
        }
      }
    }
    if (node.type === 'card') {
      if (node.headerAction) mergeDeps(deps, collectNodeDeps(node.headerAction));
      if (node.footer) mergeDeps(deps, collectNodeDeps(node.footer));
    }
    if (node.type === 'popover' || node.type === 'tooltip') {
      if (node.trigger) mergeDeps(deps, collectNodeDeps(node.trigger));
      if (Array.isArray(node.content)) {
        for (const child of node.content) mergeDeps(deps, collectNodeDeps(child));
      }
    }

    subtreeDeps.set(node, deps);
    return deps;
  };

  if (doc.root) collectNodeDeps(doc.root);

  const declaredArtifactIds = new Set<string>(precomputed?.declaredArtifactIds ?? []);
  if (Array.isArray(doc.referencedArtifactIds)) {
    for (const id of doc.referencedArtifactIds) {
      if (typeof id === 'string' && id.trim()) declaredArtifactIds.add(id.trim());
    }
  }

  return {
    doc,
    computedOrder,
    computedAsts,
    computedDeps,
    exprAstCache,
    subtreeDeps,
    declaredArtifactIds,
    getAst,
  };
}

export function evaluateRichDynamicState(
  plan: RichDynamicPlan,
  opts: {
    state: Record<string, unknown>;
    theme?: 'light' | 'dark';
    locale?: string;
    authorizedArtifactIds?: Set<string>;
    initialAstSteps?: number;
    previousState?: Record<string, unknown>;
    previousComputed?: Record<string, unknown>;
    previousTheme?: 'light' | 'dark';
    previousSubtreeCache?: RichSubtreeCache;
    previousComputedSteps?: Map<string, number>;
  }
): RichDynamicEvalResult {
  const issues: RichValidationIssue[] = [];
  const referencedArtifacts = new Set<string>(plan.declaredArtifactIds);
  const budget = createRichEvalBudget();
  if (opts.initialAstSteps && opts.initialAstSteps > 0) {
    budget.steps += opts.initialAstSteps;
  }
  const theme = opts.theme ?? 'light';
  const computedValues: Record<string, unknown> = Object.create(null);
  const rootCtx: RichEvalContext = {
    state: opts.state,
    computed: computedValues,
    theme,
    locale: opts.locale,
  };

  const incremental = Boolean(opts.previousState && opts.previousComputed);
  const themeChanged = !incremental || opts.previousTheme !== theme;
  const changedStateKeys = new Set<string>();
  if (incremental && opts.previousState) {
    const allKeys = new Set([...Object.keys(opts.previousState), ...Object.keys(opts.state)]);
    for (const key of allKeys) {
      if (!Object.is(opts.previousState[key], opts.state[key])) {
        changedStateKeys.add(key);
      }
    }
  }
  const changedComputedKeys = new Set<string>();
  const recomputedKeys: string[] = [];

  let expandedNodes = 0;
  let expandedSvgElements = 0;
  let expandedDataPoints = 0;
  let computedStepsUsed = 0;
  let evaluatedSubtrees = 0;
  let reusedSubtrees = 0;
  const nextSubtreeCache: RichSubtreeCache = new Map();
  const computedStepsByKey = new Map<string, number>();

  const fail = (code: string, path: string, message: string, statusCode: number): RichDynamicEvalResult => {
    issues.push({ code, path, message, severity: 'error' });
    return {
      valid: false,
      statusCode,
      primaryErrorCode: code,
      issues,
      computed: computedValues,
      stats: {
        expandedNodes,
        expandedSvgElements,
        expandedDataPoints,
        astStepsUsed: budget.steps,
        computedStepsUsed,
        recomputedKeys,
        evaluatedSubtrees,
        reusedSubtrees,
      },
      referencedArtifactIds: [...referencedArtifacts],
      subtreeCache: nextSubtreeCache,
      computedStepsByKey,
    };
  };

  try {
    const stepsBeforeComputed = budget.steps;
    for (const key of plan.computedOrder) {
      const deps = plan.computedDeps.get(key);
      const canReuse =
        incremental &&
        opts.previousComputed !== undefined &&
        Object.prototype.hasOwnProperty.call(opts.previousComputed, key) &&
        deps !== undefined &&
        !isDepsDirty(deps, changedStateKeys, changedComputedKeys, themeChanged);
      if (canReuse) {
        computedValues[key] = opts.previousComputed![key];
        const prevSteps = opts.previousComputedSteps?.get(key) ?? 0;
        computedStepsByKey.set(key, prevSteps);
        budget.steps += prevSteps;
        if (budget.steps > budget.maxSteps) {
          throw new RichExprError(
            'RICH_EXPR_BUDGET_EXCEEDED',
            `Expression evaluation exceeded the maximum budget of ${budget.maxSteps} AST steps.`,
            422
          );
        }
        continue;
      }
      const keyStartSteps = budget.steps;
      const ast = plan.computedAsts.get(key)!;
      const nextVal = evaluateRichAst(ast, rootCtx, budget);
      computedStepsByKey.set(key, budget.steps - keyStartSteps);
      recomputedKeys.push(key);
      if (incremental && opts.previousComputed && Object.prototype.hasOwnProperty.call(opts.previousComputed, key)) {
        const oldVal = opts.previousComputed[key];
        if (
          Object.is(oldVal, nextVal) ||
          (oldVal !== undefined &&
            nextVal !== undefined &&
            typeof oldVal === 'object' &&
            typeof nextVal === 'object' &&
            JSON.stringify(oldVal) === JSON.stringify(nextVal))
        ) {
          computedValues[key] = oldVal;
        } else {
          computedValues[key] = nextVal;
          changedComputedKeys.add(key);
        }
      } else {
        computedValues[key] = nextVal;
        changedComputedKeys.add(key);
      }
    }
    computedStepsUsed = budget.steps - stepsBeforeComputed;

    const evalRichVal = (val: unknown, ctx: RichEvalContext): unknown => {
      if (isExprWrapper(val)) {
        return evaluateRichAst(plan.getAst(val.expr), ctx, budget);
      }
      return val;
    };

    const countExpanded = (count: number, p: string) => {
      expandedDataPoints += count;
      if (expandedDataPoints > RICH_LIMITS.maxArrayPoints) {
        throw new RichExprError('RICH_EXPANDED_ARRAY_LIMIT_EXCEEDED', 'Expanded data point limit exceeded at ' + p, 422);
      }
    };
    const checkExpandedArray = (value: unknown, p: string, ctx: RichEvalContext, multiplier = 1) => {
      const result = evalRichVal(value, ctx);
      if (!Array.isArray(result)) throw new RichExprError('RICH_INVALID_SCHEMA', 'Expected evaluated array at ' + p);
      countExpanded(result.length * multiplier, p);
      return result;
    };

    const countExpandedSvg = (count: number) => {
      expandedSvgElements += count;
      if (expandedSvgElements > RICH_LIMITS.maxExpandedSvgElements) {
        throw new RichExprError(
          'RICH_EXPANDED_SVG_LIMIT_EXCEEDED',
          `Expanded SVG element count exceeded ${RICH_LIMITS.maxExpandedSvgElements}.`,
          422
        );
      }
    };

    const evalSvgElementPost = (
      el: RichSvgElement,
      p: string,
      ctx: RichEvalContext,
      defs: ReadonlySet<string>
    ) => {
      if (el.repeat) {
        const arr = evaluateRichAst(plan.getAst(el.repeat.itemsExpr), ctx, budget);
        if (!Array.isArray(arr)) return;
        for (let i = 0; i < arr.length; i++) {
          const nextCtx: RichEvalContext = {
            ...ctx,
            item: arr[i],
            index: i,
            aliases: { ...(ctx.aliases ?? {}), [el.repeat.as]: arr[i] },
          };
          evalSvgElementPost({ ...el, repeat: undefined }, `${p}[${i}]`, nextCtx, defs);
        }
        return;
      }
      if (el.visibleWhen) {
        const vis = evaluateRichAst(plan.getAst(el.visibleWhen), ctx, budget);
        if (!vis) return;
      }
      countExpandedSvg(1);
      if (el.attrs) {
        for (const [k, v] of Object.entries(el.attrs)) {
          const evaluated = evalRichVal(v, ctx);
          const err = validateSvgAttrValue(k, evaluated, defs);
          if (err) {
            issues.push({ code: 'RICH_POST_EVAL_UNSAFE_SVG', path: `${p}.attrs.${k}`, message: err, severity: 'error' });
          }
        }
      }
      if (Array.isArray(el.children)) {
        for (let i = 0; i < el.children.length; i++) {
          evalSvgElementPost(el.children[i], `${p}.children[${i}]`, ctx, defs);
        }
      }
    };

    const evalSvgScenePost = (scene: Extract<RichNode, { type: 'svg_scene' }>, p: string, ctx: RichEvalContext) => {
      const defs = new Set((scene.defs ?? []).map(def => def.id));
      for (const [i, def] of (scene.defs ?? []).entries()) {
        countExpandedSvg(svgDefinitionElementCount(def));
        visitSvgDefinitionValues(def, (name, value, field) => {
          const err = validateSvgAttrValue(name, evalRichVal(value, ctx), defs);
          if (err) issues.push({ code: 'RICH_POST_EVAL_UNSAFE_SVG', path: `${p}.defs[${i}].${field}`, message: err, severity: 'error' });
        });
      }
      scene.elements.forEach((el, i) => evalSvgElementPost(el, `${p}.elements[${i}]`, ctx, defs));
    };

    const evalActionsPost = (
      actions: RichAction[] | undefined,
      p: string,
      ctx: RichEvalContext,
      localArtifacts: string[]
    ) => {
      if (!Array.isArray(actions)) return;
      for (let i = 0; i < actions.length; i++) {
        const act = actions[i];
        const ap = `${p}[${i}]`;
        if (act.type === 'open_external_url') {
          const evaluated = String(evaluateRichAst(plan.getAst(act.urlExpr), ctx, budget) ?? '');
          if (evaluated && !isValidHttpUrl(evaluated)) {
            issues.push({
              code: 'RICH_POST_EVAL_FORBIDDEN_URL',
              path: `${ap}.urlExpr`,
              message: `Evaluated URL '${evaluated}' is not a valid http/https URL.`,
              severity: 'error',
            });
          }
        } else if (act.type === 'save_to_artifact') {
          const filename = String(evaluateRichAst(plan.getAst(act.filenameExpr), ctx, budget) ?? '');
          if (filename && !validateSafeFilename(filename)) {
            issues.push({
              code: 'RICH_POST_EVAL_INVALID_FILENAME',
              path: `${ap}.filenameExpr`,
              message: `Evaluated filename '${filename}' is invalid.`,
              severity: 'error',
            });
          }
        } else if (act.type === 'open_artifact') {
          const artId = String(evaluateRichAst(plan.getAst(act.artifactIdExpr), ctx, budget) ?? '').trim();
          if (artId) {
            referencedArtifacts.add(artId);
            localArtifacts.push(artId);
            if (opts.authorizedArtifactIds && !opts.authorizedArtifactIds.has(artId)) {
              issues.push({
                code: 'RICH_FORBIDDEN_ARTIFACT_REF',
                path: `${ap}.artifactIdExpr`,
                message: `Artifact '${artId}' is not authorized in this chat.`,
                severity: 'error',
              });
            }
          }
        }
      }
    };

    const evalNodePost = (
      node: RichNode,
      p: string,
      ctx: RichEvalContext,
      inRepeatScope: boolean,
      parentArtifacts: string[] | null
    ) => {
      const canMemoize = !inRepeatScope;
      const deps = canMemoize ? plan.subtreeDeps.get(node) : undefined;
      if (
        canMemoize &&
        incremental &&
        deps &&
        opts.previousSubtreeCache &&
        !isDepsDirty(deps, changedStateKeys, changedComputedKeys, themeChanged)
      ) {
        const cached = opts.previousSubtreeCache.get(p);
        if (cached) {
          expandedNodes += cached.expandedNodes;
          if (expandedNodes > RICH_LIMITS.maxExpandedNodes) {
            throw new RichExprError(
              'RICH_EXPANDED_NODE_LIMIT_EXCEEDED',
              `Expanded node count exceeded ${RICH_LIMITS.maxExpandedNodes}.`,
              422
            );
          }
          expandedSvgElements += cached.expandedSvgElements;
          if (expandedSvgElements > RICH_LIMITS.maxExpandedSvgElements) {
            throw new RichExprError(
              'RICH_EXPANDED_SVG_LIMIT_EXCEEDED',
              `Expanded SVG element count exceeded ${RICH_LIMITS.maxExpandedSvgElements}.`,
              422
            );
          }
          expandedDataPoints += cached.expandedDataPoints;
          if (expandedDataPoints > RICH_LIMITS.maxArrayPoints) {
            throw new RichExprError('RICH_EXPANDED_ARRAY_LIMIT_EXCEEDED', 'Expanded data point limit exceeded at ' + p, 422);
          }
          budget.steps += cached.astSteps;
          if (budget.steps > budget.maxSteps) {
            throw new RichExprError(
              'RICH_EXPR_BUDGET_EXCEEDED',
              `Expression evaluation exceeded the maximum budget of ${budget.maxSteps} AST steps.`,
              422
            );
          }
          for (const artId of cached.referencedArtifacts) {
            referencedArtifacts.add(artId);
            parentArtifacts?.push(artId);
          }
          nextSubtreeCache.set(p, cached);
          reusedSubtrees += 1;
          return;
        }
      }

      const startNodes = expandedNodes;
      const startSvg = expandedSvgElements;
      const startPoints = expandedDataPoints;
      const startSteps = budget.steps;
      const localArtifacts: string[] = [];
      evaluatedSubtrees += 1;

      if (node.repeat) {
        const arr = evaluateRichAst(plan.getAst(node.repeat.itemsExpr), ctx, budget);
        if (Array.isArray(arr)) {
          for (let i = 0; i < arr.length; i++) {
            const nextCtx: RichEvalContext = {
              ...ctx,
              item: arr[i],
              index: i,
              aliases: { ...(ctx.aliases ?? {}), [node.repeat.as]: arr[i] },
            };
            const clone = { ...node, repeat: undefined } as RichNode;
            evalNodePost(clone, `${p}[${i}]`, nextCtx, true, localArtifacts);
          }
          if (canMemoize) {
            nextSubtreeCache.set(p, {
              expandedNodes: expandedNodes - startNodes,
              expandedSvgElements: expandedSvgElements - startSvg,
              expandedDataPoints: expandedDataPoints - startPoints,
              astSteps: budget.steps - startSteps,
              referencedArtifacts: localArtifacts,
            });
            if (parentArtifacts) parentArtifacts.push(...localArtifacts);
          }
          return;
        }
      }

      if (node.visibleWhen) {
        const vis = evaluateRichAst(plan.getAst(node.visibleWhen), ctx, budget);
        if (!vis) {
          if (canMemoize) {
            nextSubtreeCache.set(p, {
              expandedNodes: expandedNodes - startNodes,
              expandedSvgElements: expandedSvgElements - startSvg,
              expandedDataPoints: expandedDataPoints - startPoints,
              astSteps: budget.steps - startSteps,
              referencedArtifacts: localArtifacts,
            });
          }
          return;
        }
      }

      expandedNodes += 1;
      if (expandedNodes > RICH_LIMITS.maxExpandedNodes) {
        throw new RichExprError(
          'RICH_EXPANDED_NODE_LIMIT_EXCEEDED',
          `Expanded node count exceeded ${RICH_LIMITS.maxExpandedNodes}.`,
          422
        );
      }

      if (node.type === 'chart') {
        if (node.categories !== undefined) checkExpandedArray(node.categories, p + '.categories', ctx);
        for (const series of node.series) checkExpandedArray(series.data, p + '.series.data', ctx);
      } else if (node.type === 'data_table') {
        checkExpandedArray(node.rows, p + '.rows', ctx, Math.max(1, node.columns?.length ?? 1));
      } else if (node.type === 'node_edge_diagram') {
        const vertices = checkExpandedArray(node.nodes, p + '.nodes', ctx);
        const edges = checkExpandedArray(node.edges, p + '.edges', ctx);
        if (vertices.length > 500 || edges.length > 1000) {
          throw new RichExprError('RICH_EXPANDED_ARRAY_LIMIT_EXCEEDED', 'Diagram exceeds vertex/edge limits.', 422);
        }
      } else if (node.type === 'list' || node.type === 'checklist' || node.type === 'steps' || node.type === 'timeline') {
        if (node.items !== undefined) checkExpandedArray(node.items, p + '.items', ctx);
      } else if (node.type === 'radio_group' || node.type === 'select' || node.type === 'segmented') {
        checkExpandedArray(node.options, p + '.options', ctx);
      } else if (node.type === 'markdown') {
        const evaluated = String(evalRichVal(node.content, ctx) ?? '');
        const err = validateRichMarkdownContent(evaluated);
        if (err) {
          issues.push({ code: 'RICH_POST_EVAL_UNSAFE_MARKDOWN', path: `${p}.content`, message: err, severity: 'error' });
        }
      } else if (node.type === 'mermaid') {
        const evaluated = String(evalRichVal(node.code, ctx) ?? '');
        const err = validateRichMermaidCode(evaluated);
        if (err) {
          issues.push({ code: 'RICH_POST_EVAL_UNSAFE_MERMAID', path: `${p}.code`, message: err, severity: 'error' });
        }
      } else if (node.type === 'svg_scene') {
        evalSvgScenePost(node, p, ctx);
      } else if (node.type === 'media_asset') {
        if (node.sourceKind === 'artifact' && node.artifactId !== undefined) {
          const evaluated = String(evalRichVal(node.artifactId, ctx) ?? '').trim();
          if (/^(?:https?:|data:|blob:|\/\/)/i.test(evaluated)) {
            issues.push({
              code: 'RICH_POST_EVAL_FORBIDDEN_MEDIA',
              path: `${p}.artifactId`,
              message: `Evaluated media_asset artifactId '${evaluated}' cannot be an external URL.`,
              severity: 'error',
            });
          } else if (evaluated) {
            referencedArtifacts.add(evaluated);
            localArtifacts.push(evaluated);
            if (opts.authorizedArtifactIds && !opts.authorizedArtifactIds.has(evaluated)) {
              issues.push({
                code: 'RICH_FORBIDDEN_ARTIFACT_REF',
                path: `${p}.artifactId`,
                message: `Artifact '${evaluated}' is not authorized in this chat.`,
                severity: 'error',
              });
            }
          }
        } else if (node.sourceKind === 'inline_svg' && node.svgScene) {
          evalSvgScenePost(node.svgScene, `${p}.svgScene`, ctx);
        }
      } else if (node.type === 'button') {
        evalActionsPost(node.onClick, `${p}.onClick`, ctx, localArtifacts);
      } else if (node.type === 'form') {
        evalActionsPost(node.onSubmit, `${p}.onSubmit`, ctx, localArtifacts);
      } else if (node.type === 'editable_draft' && node.saveAction) {
        evalActionsPost([node.saveAction], `${p}.saveAction`, ctx, localArtifacts);
      }

      const anyNode = node as unknown as Record<string, unknown>;
      if (Array.isArray(anyNode.children)) {
        for (let i = 0; i < anyNode.children.length; i++) {
          evalNodePost(anyNode.children[i] as RichNode, `${p}.children[${i}]`, ctx, inRepeatScope, localArtifacts);
        }
      }
      if (node.type === 'tabs' && Array.isArray(node.items)) {
        for (let i = 0; i < node.items.length; i++) {
          const tabContent = node.items[i]?.content;
          if (Array.isArray(tabContent)) {
            for (let j = 0; j < tabContent.length; j++) {
              evalNodePost(tabContent[j], `${p}.items[${i}].content[${j}]`, ctx, inRepeatScope, localArtifacts);
            }
          }
        }
      }
      if (node.type === 'card') {
        if (node.headerAction) evalNodePost(node.headerAction, `${p}.headerAction`, ctx, inRepeatScope, localArtifacts);
        if (node.footer) evalNodePost(node.footer, `${p}.footer`, ctx, inRepeatScope, localArtifacts);
      }
      if (node.type === 'popover' || node.type === 'tooltip') {
        if (node.trigger) evalNodePost(node.trigger, `${p}.trigger`, ctx, inRepeatScope, localArtifacts);
        if (Array.isArray(node.content)) {
          for (let i = 0; i < node.content.length; i++) {
            evalNodePost(node.content[i], `${p}.content[${i}]`, ctx, inRepeatScope, localArtifacts);
          }
        }
      }

      if (canMemoize) {
        nextSubtreeCache.set(p, {
          expandedNodes: expandedNodes - startNodes,
          expandedSvgElements: expandedSvgElements - startSvg,
          expandedDataPoints: expandedDataPoints - startPoints,
          astSteps: budget.steps - startSteps,
          referencedArtifacts: localArtifacts,
        });
      }
      if (parentArtifacts && localArtifacts.length > 0) {
        parentArtifacts.push(...localArtifacts);
      }
    };

    evalNodePost(plan.doc.root, '$.root', rootCtx, false, null);
  } catch (err) {
    if (err instanceof RichExprError) {
      return fail(err.code, '$', err.message, err.statusCode);
    }
    return fail('RICH_EVAL_ERROR', '$', err instanceof Error ? err.message : String(err), 422);
  }

  if (opts.authorizedArtifactIds) {
    for (const artId of referencedArtifacts) {
      if (!opts.authorizedArtifactIds.has(artId)) {
        issues.push({
          code: 'RICH_FORBIDDEN_ARTIFACT_REF',
          path: '$.referencedArtifactIds',
          message: `Artifact '${artId}' does not belong to this chat.`,
          severity: 'error',
        });
      }
    }
  }

  const firstErr = issues.find((i) => i.severity === 'error');
  return {
    valid: !firstErr,
    statusCode: firstErr
      ? firstErr.code === 'RICH_FORBIDDEN_ARTIFACT_REF'
        ? 403
        : firstErr.code.includes('LIMIT')
          ? 422
          : 400
      : 200,
    primaryErrorCode: firstErr?.code ?? null,
    issues,
    computed: computedValues,
    stats: {
      expandedNodes,
      expandedSvgElements,
      expandedDataPoints,
      astStepsUsed: budget.steps,
      computedStepsUsed,
      recomputedKeys,
      evaluatedSubtrees,
      reusedSubtrees,
    },
    referencedArtifactIds: [...referencedArtifacts],
    subtreeCache: nextSubtreeCache,
    computedStepsByKey,
  };
}
