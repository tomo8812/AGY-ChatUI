export const RICH_MAX_EXPR_LENGTH = 512;
export const RICH_MAX_AST_STEPS = 20_000;

export class RichExprError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'RichExprError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface RichEvalBudget {
  steps: number;
  maxSteps: number;
}

export function createRichEvalBudget(maxSteps = RICH_MAX_AST_STEPS): RichEvalBudget {
  return { steps: 0, maxSteps };
}

export interface RichEvalContext {
  state: Record<string, unknown>;
  computed: Record<string, unknown>;
  item?: unknown;
  index?: number;
  theme?: 'light' | 'dark';
  aliases?: Record<string, unknown>;
}

const BLOCKED_PROPS = new Set([
  '__proto__',
  'prototype',
  'constructor',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

export const RICH_PERMITTED_FUNCTIONS = [
  'abs',
  'round',
  'floor',
  'ceil',
  'min',
  'max',
  'pow',
  'sqrt',
  'sin',
  'cos',
  'tan',
  'log',
  'clamp',
  'lerp',
  'sum',
  'avg',
  'count',
  'length',
  'slice',
  'filter',
  'sortBy',
  'pluck',
  'at',
  'concat',
  'upper',
  'lower',
  'trim',
  'formatNumber',
  'formatCurrency',
  'formatPercent',
  'coalesce',
  'isNull',
] as const;

const PERMITTED_FN_SET = new Set<string>(RICH_PERMITTED_FUNCTIONS);

type TokenKind =
  | 'number'
  | 'string'
  | 'ident'
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'comma'
  | 'dot'
  | 'question'
  | 'colon'
  | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
  pos: number;
}

function tokenize(input: string): Token[] {
  if (input.length > RICH_MAX_EXPR_LENGTH) {
    throw new RichExprError('RICH_EXPR_TOO_LONG', `Expression exceeds maximum length of ${RICH_MAX_EXPR_LENGTH} characters.`);
  }
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }

    if (ch >= '0' && ch <= '9') {
      const start = i;
      let sawDot = false;
      while (i < n && ((input[i] >= '0' && input[i] <= '9') || (!sawDot && input[i] === '.'))) {
        if (input[i] === '.') sawDot = true;
        i += 1;
      }
      if (i < n && (input[i] === 'e' || input[i] === 'E')) {
        i += 1;
        if (i < n && (input[i] === '+' || input[i] === '-')) i += 1;
        const expStart = i;
        while (i < n && input[i] >= '0' && input[i] <= '9') i += 1;
        if (i === expStart) {
          throw new RichExprError('RICH_EXPR_SYNTAX', `Invalid numeric exponent at position ${start}.`);
        }
      }
      tokens.push({ kind: 'number', value: input.slice(start, i), pos: start });
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i += 1;
      let out = '';
      let closed = false;
      while (i < n) {
        const c = input[i];
        if (c === '\\') {
          i += 1;
          if (i >= n) throw new RichExprError('RICH_EXPR_SYNTAX', `Unterminated escape in string at ${start}.`);
          const esc = input[i];
          if (esc === 'n') out += '\n';
          else if (esc === 'r') out += '\r';
          else if (esc === 't') out += '\t';
          else out += esc;
          i += 1;
        } else if (c === quote) {
          i += 1;
          closed = true;
          break;
        } else {
          out += c;
          i += 1;
        }
      }
      if (!closed) {
        throw new RichExprError('RICH_EXPR_SYNTAX', `Unterminated string literal at position ${start}.`);
      }
      tokens.push({ kind: 'string', value: out, pos: start });
      continue;
    }

    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$') {
      const start = i;
      i += 1;
      while (
        i < n &&
        ((input[i] >= 'a' && input[i] <= 'z') ||
          (input[i] >= 'A' && input[i] <= 'Z') ||
          (input[i] >= '0' && input[i] <= '9') ||
          input[i] === '_' ||
          input[i] === '$')
      ) {
        i += 1;
      }
      tokens.push({ kind: 'ident', value: input.slice(start, i), pos: start });
      continue;
    }

    const two = input.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '&&' || two === '||') {
      tokens.push({ kind: 'op', value: two, pos: i });
      i += 2;
      continue;
    }

    if ('+-*/%^<>!'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch, pos: i });
      i += 1;
      continue;
    }

    const singleMap: Record<string, TokenKind> = {
      '(': 'lparen',
      ')': 'rparen',
      '[': 'lbracket',
      ']': 'rbracket',
      ',': 'comma',
      '.': 'dot',
      '?': 'question',
      ':': 'colon',
    };
    const mapped = singleMap[ch];
    if (mapped) {
      tokens.push({ kind: mapped, value: ch, pos: i });
      i += 1;
      continue;
    }

    throw new RichExprError('RICH_EXPR_SYNTAX', `Unexpected character '${ch}' at position ${i}.`);
  }

  tokens.push({ kind: 'eof', value: '', pos: n });
  return tokens;
}

export type ExprAst =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'array'; items: ExprAst[] }
  | { kind: 'ident'; name: string }
  | { kind: 'member'; object: ExprAst; property: string }
  | { kind: 'index'; object: ExprAst; index: ExprAst }
  | { kind: 'unary'; op: '!' | '-' | '+'; operand: ExprAst }
  | { kind: 'binary'; op: string; left: ExprAst; right: ExprAst }
  | { kind: 'ternary'; condition: ExprAst; consequent: ExprAst; alternate: ExprAst }
  | { kind: 'call'; callee: string; args: ExprAst[] };

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private consume(): Token {
    return this.tokens[this.pos++];
  }

  private expect(kind: TokenKind): Token {
    const t = this.peek();
    if (t.kind !== kind) {
      throw new RichExprError('RICH_EXPR_SYNTAX', `Expected ${kind} but got ${t.kind} ('${t.value}') at ${t.pos}.`);
    }
    return this.consume();
  }

  parse(): ExprAst {
    const expr = this.parseTernary();
    if (this.peek().kind !== 'eof') {
      throw new RichExprError('RICH_EXPR_SYNTAX', `Unexpected token '${this.peek().value}' at ${this.peek().pos}.`);
    }
    return expr;
  }

  private withDepth<T>(fn: () => T): T {
    this.depth += 1;
    if (this.depth > 64) {
      throw new RichExprError('RICH_EXPR_SYNTAX', 'Expression nesting depth exceeded.');
    }
    try {
      return fn();
    } finally {
      this.depth -= 1;
    }
  }

  private parseTernary(): ExprAst {
    return this.withDepth(() => {
      const cond = this.parseOr();
      if (this.peek().kind === 'question') {
        this.consume();
        const consequent = this.parseTernary();
        this.expect('colon');
        const alternate = this.parseTernary();
        return { kind: 'ternary', condition: cond, consequent, alternate };
      }
      return cond;
    });
  }

  private parseOr(): ExprAst {
    let left = this.parseAnd();
    while (this.peek().kind === 'op' && this.peek().value === '||') {
      const op = this.consume().value;
      const right = this.parseAnd();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseAnd(): ExprAst {
    let left = this.parseEquality();
    while (this.peek().kind === 'op' && this.peek().value === '&&') {
      const op = this.consume().value;
      const right = this.parseEquality();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseEquality(): ExprAst {
    let left = this.parseComparison();
    while (this.peek().kind === 'op' && (this.peek().value === '==' || this.peek().value === '!=')) {
      const op = this.consume().value;
      const right = this.parseComparison();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseComparison(): ExprAst {
    let left = this.parseAdditive();
    while (
      this.peek().kind === 'op' &&
      (this.peek().value === '<' ||
        this.peek().value === '<=' ||
        this.peek().value === '>' ||
        this.peek().value === '>=')
    ) {
      const op = this.consume().value;
      const right = this.parseAdditive();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseAdditive(): ExprAst {
    let left = this.parseMultiplicative();
    while (this.peek().kind === 'op' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.consume().value;
      const right = this.parseMultiplicative();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseMultiplicative(): ExprAst {
    let left = this.parseExponent();
    while (
      this.peek().kind === 'op' &&
      (this.peek().value === '*' || this.peek().value === '/' || this.peek().value === '%')
    ) {
      const op = this.consume().value;
      const right = this.parseExponent();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseExponent(): ExprAst {
    const left = this.parseUnary();
    if (this.peek().kind === 'op' && this.peek().value === '^') {
      this.consume();
      const right = this.parseExponent(); // right-associative
      return { kind: 'binary', op: '^', left, right };
    }
    return left;
  }

  private parseUnary(): ExprAst {
    if (
      this.peek().kind === 'op' &&
      (this.peek().value === '!' || this.peek().value === '-' || this.peek().value === '+')
    ) {
      const op = this.consume().value as '!' | '-' | '+';
      const operand = this.parseUnary();
      return { kind: 'unary', op, operand };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): ExprAst {
    let node = this.parsePrimary();
    while (true) {
      if (this.peek().kind === 'dot') {
        this.consume();
        const prop = this.expect('ident').value;
        if (BLOCKED_PROPS.has(prop)) {
          throw new RichExprError('RICH_EXPR_FORBIDDEN_PROP', `Access to property '${prop}' is forbidden.`);
        }
        node = { kind: 'member', object: node, property: prop };
      } else if (this.peek().kind === 'lbracket') {
        this.consume();
        const idx = this.parseTernary();
        this.expect('rbracket');
        node = { kind: 'index', object: node, index: idx };
      } else {
        break;
      }
    }
    return node;
  }

  private parsePrimary(): ExprAst {
    const t = this.peek();
    if (t.kind === 'number') {
      this.consume();
      const val = Number(t.value);
      if (!Number.isFinite(val)) {
        throw new RichExprError('RICH_EXPR_SYNTAX', `Invalid number '${t.value}'.`);
      }
      return { kind: 'literal', value: val };
    }
    if (t.kind === 'string') {
      this.consume();
      return { kind: 'literal', value: t.value };
    }
    if (t.kind === 'lparen') {
      this.consume();
      const inner = this.parseTernary();
      this.expect('rparen');
      return inner;
    }
    if (t.kind === 'lbracket') {
      this.consume();
      const items: ExprAst[] = [];
      if (this.peek().kind !== 'rbracket') {
        items.push(this.parseTernary());
        while (this.peek().kind === 'comma') {
          this.consume();
          items.push(this.parseTernary());
        }
      }
      this.expect('rbracket');
      return { kind: 'array', items };
    }
    if (t.kind === 'ident') {
      this.consume();
      if (t.value === 'true') return { kind: 'literal', value: true };
      if (t.value === 'false') return { kind: 'literal', value: false };
      if (t.value === 'null') return { kind: 'literal', value: null };
      if (this.peek().kind === 'lparen') {
        if (!PERMITTED_FN_SET.has(t.value)) {
          throw new RichExprError('RICH_EXPR_UNKNOWN_FN', `Function '${t.value}' is not permitted.`);
        }
        this.consume();
        const args: ExprAst[] = [];
        if (this.peek().kind !== 'rparen') {
          args.push(this.parseTernary());
          while (this.peek().kind === 'comma') {
            this.consume();
            args.push(this.parseTernary());
          }
        }
        this.expect('rparen');
        return { kind: 'call', callee: t.value, args };
      }
      if (BLOCKED_PROPS.has(t.value)) {
        throw new RichExprError('RICH_EXPR_FORBIDDEN_PROP', `Identifier '${t.value}' is forbidden.`);
      }
      return { kind: 'ident', name: t.value };
    }
    throw new RichExprError('RICH_EXPR_SYNTAX', `Unexpected token '${t.value}' at position ${t.pos}.`);
  }
}

export function parseRichExpr(expr: string): ExprAst {
  const tokens = tokenize(expr);
  return new Parser(tokens).parse();
}

export function extractExprReferences(ast: ExprAst): {
  stateKeys: Set<string>;
  computedKeys: Set<string>;
} {
  const stateKeys = new Set<string>();
  const computedKeys = new Set<string>();

  const walk = (node: ExprAst) => {
    switch (node.kind) {
      case 'member':
        if (node.object.kind === 'ident') {
          if (node.object.name === '$state') stateKeys.add(node.property);
          if (node.object.name === '$computed') computedKeys.add(node.property);
        }
        walk(node.object);
        break;
      case 'index':
        if (node.object.kind === 'ident' && node.index.kind === 'literal' && typeof node.index.value === 'string') {
          if (node.object.name === '$state') stateKeys.add(node.index.value);
          if (node.object.name === '$computed') computedKeys.add(node.index.value);
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
  return { stateKeys, computedKeys };
}

function tick(budget: RichEvalBudget, cost = 1): void {
  budget.steps += cost;
  if (budget.steps > budget.maxSteps) {
    throw new RichExprError(
      'RICH_STEP_LIMIT_EXCEEDED',
      `Expression evaluation exceeded ${budget.maxSteps} AST steps.`,
      422
    );
  }
}

function safeGetProp(obj: unknown, key: string | number): unknown {
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) {
    const idx = typeof key === 'number' ? key : Number(key);
    if (!Number.isInteger(idx) || idx < 0 || idx >= obj.length) return null;
    return obj[idx];
  }
  if (typeof obj === 'object') {
    const prop = String(key);
    if (BLOCKED_PROPS.has(prop)) {
      throw new RichExprError('RICH_EXPR_FORBIDDEN_PROP', `Access to property '${prop}' is forbidden.`);
    }
    if (!Object.prototype.hasOwnProperty.call(obj, prop)) return null;
    return (obj as Record<string, unknown>)[prop];
  }
  return null;
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toNumList(args: unknown[], budget: RichEvalBudget): number[] {
  const out: number[] = [];
  for (const a of args) {
    if (Array.isArray(a)) {
      for (const item of a) {
        tick(budget);
        if (item !== null && item !== undefined && typeof item === 'number' && Number.isFinite(item)) {
          out.push(item);
        }
      }
    } else if (a !== null && a !== undefined && typeof a === 'number' && Number.isFinite(a)) {
      out.push(a);
    }
  }
  return out;
}

function invokePureFn(name: string, args: unknown[], budget: RichEvalBudget): unknown {
  tick(budget);
  switch (name) {
    case 'abs':
      return Math.abs(toNum(args[0]));
    case 'round': {
      const val = toNum(args[0]);
      const digits = args[1] !== undefined ? Math.max(0, Math.min(10, Math.trunc(toNum(args[1])))) : 0;
      const factor = 10 ** digits;
      return Math.round(val * factor) / factor;
    }
    case 'floor':
      return Math.floor(toNum(args[0]));
    case 'ceil':
      return Math.ceil(toNum(args[0]));
    case 'min': {
      const nums = toNumList(args, budget);
      return nums.length > 0 ? Math.min(...nums) : null;
    }
    case 'max': {
      const nums = toNumList(args, budget);
      return nums.length > 0 ? Math.max(...nums) : null;
    }
    case 'pow': {
      const r = Math.pow(toNum(args[0]), toNum(args[1]));
      return Number.isFinite(r) ? r : null;
    }
    case 'sqrt': {
      const x = toNum(args[0]);
      return x >= 0 ? Math.sqrt(x) : null;
    }
    case 'sin':
      return Math.sin(toNum(args[0]));
    case 'cos':
      return Math.cos(toNum(args[0]));
    case 'tan':
      return Math.tan(toNum(args[0]));
    case 'log': {
      const x = toNum(args[0]);
      return x > 0 ? Math.log(x) : null;
    }
    case 'clamp': {
      const x = toNum(args[0]);
      const lo = toNum(args[1]);
      const hi = toNum(args[2]);
      return Math.min(Math.max(x, lo), hi);
    }
    case 'lerp': {
      const a = toNum(args[0]);
      const b = toNum(args[1]);
      const t = toNum(args[2]);
      return a + (b - a) * t;
    }
    case 'sum': {
      const nums = toNumList(args, budget);
      return nums.reduce((acc, n) => acc + n, 0);
    }
    case 'avg': {
      const nums = toNumList(args, budget);
      return nums.length > 0 ? nums.reduce((acc, n) => acc + n, 0) / nums.length : null;
    }
    case 'count': {
      const arr = args[0];
      if (!Array.isArray(arr)) return 0;
      return arr.filter((v) => v !== null && v !== undefined).length;
    }
    case 'length': {
      const v = args[0];
      if (Array.isArray(v) || typeof v === 'string') return v.length;
      return 0;
    }
    case 'slice': {
      const v = args[0];
      const start = Math.trunc(toNum(args[1]));
      const end = args[2] !== undefined ? Math.trunc(toNum(args[2])) : undefined;
      if (Array.isArray(v)) {
        tick(budget, Math.min(v.length, 500));
        return v.slice(start, end);
      }
      if (typeof v === 'string') return v.slice(start, end);
      return [];
    }
    case 'filter': {
      const arr = args[0];
      const field = typeof args[1] === 'string' ? args[1] : '';
      const expected = args[2];
      if (!Array.isArray(arr)) return [];
      const out: unknown[] = [];
      for (const item of arr) {
        tick(budget);
        if (field) {
          if (safeGetProp(item, field) === expected) out.push(item);
        } else if (item === expected) {
          out.push(item);
        }
      }
      return out;
    }
    case 'sortBy': {
      const arr = args[0];
      const field = typeof args[1] === 'string' ? args[1] : '';
      const desc = String(args[2] ?? 'asc').toLowerCase() === 'desc';
      if (!Array.isArray(arr)) return [];
      tick(budget, Math.max(1, arr.length));
      return [...arr].sort((a, b) => {
        tick(budget);
        const av = field ? safeGetProp(a, field) : a;
        const bv = field ? safeGetProp(b, field) : b;
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
        return desc ? -cmp : cmp;
      });
    }
    case 'pluck': {
      const arr = args[0];
      const field = typeof args[1] === 'string' ? args[1] : '';
      if (!Array.isArray(arr)) return [];
      const out: unknown[] = [];
      for (const item of arr) {
        tick(budget);
        out.push(safeGetProp(item, field));
      }
      return out;
    }
    case 'at': {
      const arr = args[0];
      const idx = Math.trunc(toNum(args[1]));
      if (Array.isArray(arr)) {
        const resolved = idx < 0 ? arr.length + idx : idx;
        return resolved >= 0 && resolved < arr.length ? arr[resolved] : null;
      }
      if (typeof arr === 'string') {
        const resolved = idx < 0 ? arr.length + idx : idx;
        return resolved >= 0 && resolved < arr.length ? arr[resolved] : null;
      }
      return null;
    }
    case 'concat':
      return args.map((a) => (a === null || a === undefined ? '' : String(a))).join('');
    case 'upper':
      return String(args[0] ?? '').toUpperCase();
    case 'lower':
      return String(args[0] ?? '').toLowerCase();
    case 'trim':
      return String(args[0] ?? '').trim();
    case 'formatNumber': {
      const val = args[0];
      if (val === null || val === undefined || typeof val !== 'number' || !Number.isFinite(val)) return '—';
      const digits = args[1] !== undefined ? Math.max(0, Math.min(8, Math.trunc(toNum(args[1])))) : undefined;
      return new Intl.NumberFormat('en-US', digits !== undefined ? { minimumFractionDigits: digits, maximumFractionDigits: digits } : undefined).format(val);
    }
    case 'formatCurrency': {
      const val = args[0];
      if (val === null || val === undefined || typeof val !== 'number' || !Number.isFinite(val)) return '—';
      const currency = typeof args[1] === 'string' && /^[A-Z]{3}$/.test(args[1]) ? args[1] : 'JPY';
      try {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(val);
      } catch {
        return `${currency} ${val}`;
      }
    }
    case 'formatPercent': {
      const val = args[0];
      if (val === null || val === undefined || typeof val !== 'number' || !Number.isFinite(val)) return '—';
      const digits = args[1] !== undefined ? Math.max(0, Math.min(6, Math.trunc(toNum(args[1])))) : 1;
      return `${(val * 100).toFixed(digits)}%`;
    }
    case 'coalesce': {
      for (const a of args) {
        if (a !== null && a !== undefined) return a;
      }
      return null;
    }
    case 'isNull':
      return args[0] === null || args[0] === undefined;
    default:
      throw new RichExprError('RICH_EXPR_UNKNOWN_FN', `Function '${name}' is not permitted.`);
  }
}

export function evaluateRichAst(ast: ExprAst, ctx: RichEvalContext, budget: RichEvalBudget): unknown {
  tick(budget);
  switch (ast.kind) {
    case 'literal':
      return ast.value;
    case 'array':
      return ast.items.map((item) => evaluateRichAst(item, ctx, budget));
    case 'ident': {
      if (ast.name === '$state') return ctx.state;
      if (ast.name === '$computed') return ctx.computed;
      if (ast.name === '$item') return ctx.item ?? null;
      if (ast.name === '$index') return ctx.index ?? 0;
      if (ast.name === '$theme') return ctx.theme ?? 'light';
      if (ctx.aliases && Object.prototype.hasOwnProperty.call(ctx.aliases, ast.name)) {
        return ctx.aliases[ast.name];
      }
      return null;
    }
    case 'member': {
      const obj = evaluateRichAst(ast.object, ctx, budget);
      return safeGetProp(obj, ast.property);
    }
    case 'index': {
      const obj = evaluateRichAst(ast.object, ctx, budget);
      const idx = evaluateRichAst(ast.index, ctx, budget);
      if (typeof idx !== 'string' && typeof idx !== 'number') return null;
      return safeGetProp(obj, idx);
    }
    case 'unary': {
      const v = evaluateRichAst(ast.operand, ctx, budget);
      if (ast.op === '!') return !v;
      if (ast.op === '-') return -toNum(v);
      return +toNum(v);
    }
    case 'binary': {
      if (ast.op === '&&') {
        const l = evaluateRichAst(ast.left, ctx, budget);
        return l ? evaluateRichAst(ast.right, ctx, budget) : l;
      }
      if (ast.op === '||') {
        const l = evaluateRichAst(ast.left, ctx, budget);
        return l ? l : evaluateRichAst(ast.right, ctx, budget);
      }
      const l = evaluateRichAst(ast.left, ctx, budget);
      const r = evaluateRichAst(ast.right, ctx, budget);
      switch (ast.op) {
        case '+':
          if (typeof l === 'string' || typeof r === 'string') {
            return `${l ?? ''}${r ?? ''}`;
          }
          return toNum(l) + toNum(r);
        case '-':
          return toNum(l) - toNum(r);
        case '*':
          return toNum(l) * toNum(r);
        case '/': {
          const denom = toNum(r);
          return denom === 0 ? null : toNum(l) / denom;
        }
        case '%': {
          const denom = toNum(r);
          return denom === 0 ? null : toNum(l) % denom;
        }
        case '^': {
          const res = Math.pow(toNum(l), toNum(r));
          return Number.isFinite(res) ? res : null;
        }
        case '==':
          return l === r;
        case '!=':
          return l !== r;
        case '<':
          return toNum(l) < toNum(r);
        case '<=':
          return toNum(l) <= toNum(r);
        case '>':
          return toNum(l) > toNum(r);
        case '>=':
          return toNum(l) >= toNum(r);
        default:
          throw new RichExprError('RICH_EXPR_SYNTAX', `Unsupported operator '${ast.op}'.`);
      }
    }
    case 'ternary': {
      const cond = evaluateRichAst(ast.condition, ctx, budget);
      return cond
        ? evaluateRichAst(ast.consequent, ctx, budget)
        : evaluateRichAst(ast.alternate, ctx, budget);
    }
    case 'call': {
      const args = ast.args.map((a) => evaluateRichAst(a, ctx, budget));
      return invokePureFn(ast.callee, args, budget);
    }
  }
}

export function evaluateRichExpr(expr: string, ctx: RichEvalContext, budget = createRichEvalBudget()): unknown {
  const ast = parseRichExpr(expr);
  return evaluateRichAst(ast, ctx, budget);
}
