import FormulaParser from 'fast-formula-parser';

export type FormulaCell = { value: unknown; type?: string | null; formula?: string };
type Ref = { row: number; col: number; sheet?: string };
type Worksheet = { id: string; name: string; part: string };
type Primitive = string | number | boolean | null;
const safeFunctions = new Set([
  'SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'ABS', 'ROUND', 'ROUNDUP', 'ROUNDDOWN',
  'IF', 'IFERROR', 'AND', 'OR', 'NOT', 'SUMIF', 'COUNTIF', 'PRODUCT', 'MOD', 'SQRT', 'POWER',
]);

function allowed(formula: string) {
  // Reject external workbook references and array syntax before invoking either parser.
  const tokens = formula.replace(/"(?:[^"]|"")*"/g, '0').replace(/'(?:[^']|'')*'(?=!)/g, 'SHEET');
  return !/[\[\]]/.test(formula) && !/[^A-Za-z0-9_$.,:()+*/%^<>=!\-\s]/.test(tokens)
    && (tokens.match(/[A-Za-z_][A-Za-z0-9_.]*(?=\s*\()/g) ?? []).every(name => safeFunctions.has(name.toUpperCase()));
}

function column(n: number) {
  let name = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
  return name;
}

function coordinates(address: string) {
  const match = /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(address);
  if (!match) return null;
  return { row: Number(match[2]), col: [...match[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) };
}

export async function previewFormulas(options: {
  rootSheet: Worksheet;
  sheets: readonly Worksheet[];
  formulas: Iterable<string>;
  loadCell: (sheet: Worksheet, row: number, col: number) => Promise<FormulaCell | undefined>;
  signal: AbortSignal;
}) {
  const { rootSheet, sheets, formulas, loadCell, signal } = options;
  const byName = new Map(sheets.map(sheet => [sheet.name.toLowerCase(), sheet]));
  const results = new Map<string, string>();
  const values = new Map<string, Primitive>();
  const active = new Set<string>();
  const depParser = new FormulaParser.DepParser({ onVariable: () => { throw Error('Named references are unavailable'); } });
  let remainingReferences = 10_000;
  function worksheet(ref: Ref, fallback: Worksheet) {
    const sheet = ref.sheet ? byName.get(ref.sheet.toLowerCase()) : fallback;
    if (!sheet || !Number.isInteger(ref.row) || !Number.isInteger(ref.col) ||
      ref.row < 1 || ref.col < 1 || ref.row > 1_048_576 || ref.col > 16_384) throw Error('Invalid worksheet reference');
    return sheet;
  }
  const address = (ref: Ref) => column(ref.col) + ref.row;
  const key = (ref: Ref, sheet: Worksheet) => worksheet(ref, sheet).id + ':' + address(ref);
  function rangeRefs(from: Ref, to: Ref, sheet?: string) {
    const rows = to.row - from.row + 1, cols = to.col - from.col + 1;
    if (rows < 1 || cols < 1 || rows * cols > 10_000) throw Error('Reference budget exhausted');
    return Array.from({ length: rows }, (_, row) =>
      Array.from({ length: cols }, (_, col) => ({ row: from.row + row, col: from.col + col, sheet })));
  }
  async function read(ref: Ref, fallback: Worksheet): Promise<Primitive> {
    signal.throwIfAborted();
    const sheet = worksheet(ref, fallback), identity = key(ref, sheet);
    if (values.has(identity)) return values.get(identity)!;
    if (--remainingReferences < 0 || active.size >= 64 || active.has(identity)) throw Error('Cyclic or excessive references');
    const cell = await loadCell(sheet, ref.row - 1, ref.col - 1);
    if (!cell?.formula) {
      if (cell?.type === 'e') throw Error('Invalid source cell');
      const numeric = cell?.type === 'n' || cell?.type == null && typeof cell?.value === 'number';
      const value = !cell ? null : cell.type === 'b' ? String(cell.value) === '1' :
        numeric ? Number(cell.value) : String(cell.value ?? '');
      if (typeof value === 'number' && !Number.isFinite(value)) throw Error('Invalid numeric cell');
      values.set(identity, value);
      return value;
    }
    if (!allowed(cell.formula)) throw Error('Unsupported formula');
    active.add(identity);
    try {
      const position = { ...ref, sheet: sheet.name };
      for (const dependency of depParser.parse(cell.formula, position)) {
        if ('from' in dependency) {
          for (const row of rangeRefs(dependency.from, dependency.to, dependency.sheet)) {
            for (const item of row) await read(item, sheet);
          }
        } else await read(dependency, sheet);
      }
      const lookup = (dependency: Ref) => {
        const id = key(dependency, sheet);
        if (!values.has(id)) throw Error('Missing formula dependency');
        return values.get(id)!;
      };
      const parser = new FormulaParser({
        onCell: lookup,
        onRange: ({ from, to, sheet }) => rangeRefs(from, to, sheet).map(row => row.map(lookup)),
        onVariable: () => { throw Error('Named references are unavailable'); },
      });
      const value = parser.parse(cell.formula, position);
      if (!(typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value))) {
        throw Error('Unsupported formula result');
      }
      values.set(identity, value);
      return value;
    } finally {
      active.delete(identity);
    }
  }
  for (const candidate of formulas) {
    signal.throwIfAborted();
    const ref = coordinates(candidate);
    if (!ref) continue;
    try { results.set(candidate, String(await read(ref, rootSheet) ?? '')); }
    catch (error) { if (signal.aborted) throw error; results.set(candidate, '未評価'); }
  }
  return results;
}
