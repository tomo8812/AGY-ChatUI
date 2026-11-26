import type { EditOperation } from '../../api/workspace';
import type { DraftEntry, GridAxisOrigin } from './types';

export function isGridStructureId(id: string): boolean {
  return /^grid-structure:[1-9][0-9]{0,14}$/.test(id);
}
export type GridAxis = 'row' | 'col';
export interface GridAxisChange {
  key: string;
  index: number;
  insert: boolean;
}

export function gridAxisChanges(entries: readonly DraftEntry[], sheetId: string, axis: GridAxis): GridAxisChange[] {
  const xlsxOperation = axis === 'row' ? 'xlsx.mutate_rows' : 'xlsx.mutate_columns';
  return entries.flatMap(({ key, operation }) => {
    if (operation.op === xlsxOperation && operation.sheetId === sheetId) {
      return [{ key, index: Number(operation.index) - 1, insert: operation.mode === 'insert' }];
    }
    if (sheetId === 'csv' && (operation.op === `insert_${axis}` || operation.op === `delete_${axis}`)) {
      return [{ key, index: Number(operation.index), insert: operation.op.startsWith('insert') }];
    }
    return [];
  });
}

export function savedGridOrigin(index: number, changes: readonly GridAxisChange[], fixedLength?: number): GridAxisOrigin {
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i];
    if ((change.insert && index === change.index) || (!change.insert && index === (fixedLength ?? 0) - 1)) {
      return { index, insertedBy: change.key };
    }
    if (index >= change.index) index += change.insert ? -1 : 1;
  }
  return { index };
}

export function projectedGridIndex(origin: GridAxisOrigin, changes: readonly GridAxisChange[]): number | undefined {
  const insertionIndex = origin.insertedBy ? changes.findIndex(change => change.key === origin.insertedBy) : -1;
  if (origin.insertedBy && insertionIndex < 0) return undefined;
  let index = origin.index;
  for (let i = insertionIndex + 1; i < changes.length; i++) {
    const change = changes[i];
    if (!change.insert && change.index === index) return undefined;
    if (change.index <= index) index += change.insert ? 1 : -1;
  }
  return index;
}

export function gridColumnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + (n - 1) % 26) + name;
  }
  return name;
}

export function gridAddress(row: number, col: number): string {
  return gridColumnName(col) + (row + 1);
}

export function prepareGridOperations(entries: readonly DraftEntry[]): EditOperation[] {
  const structure = entries.filter(entry => isGridStructureId(entry.key));
  const phaseEdits = new Map<string | undefined, EditOperation[]>();
  for (const { operation, gridLocation, key } of entries) {
    if (isGridStructureId(key)) continue;
    let phase = gridLocation?.after;
    let next = operation;
    if (gridLocation) {
      const phaseIndex = phase === undefined ? -1 : structure.findIndex(entry => entry.key === phase);
      const applied = phase && phaseIndex < 0 ? structure : structure.slice(0, phaseIndex + 1);
      phase = applied.at(-1)?.key;
      const row = projectedGridIndex(gridLocation.row, gridAxisChanges(applied, gridLocation.sheetId, 'row'));
      const col = projectedGridIndex(gridLocation.col, gridAxisChanges(applied, gridLocation.sheetId, 'col'));
      if (row === undefined || col === undefined) continue;
      next = gridLocation.sheetId === 'csv'
        ? { ...operation, row, col }
        : {
            ...operation, address: gridAddress(row, col),
            ...(isGridStructureId(gridLocation.sheetId) ? { draftSheetKey: gridLocation.sheetId } : {}),
          };
    }
    const list = phaseEdits.get(phase) ?? [];
    list.push(next);
    phaseEdits.set(phase, list);
  }
  return [
    ...(phaseEdits.get(undefined) ?? []),
    ...structure.flatMap(({ key, operation }) => {
      const draftSheetKey = operation.op === 'xlsx.add_sheet'
        ? key
        : typeof operation.sheetId === 'string' && isGridStructureId(operation.sheetId) ? operation.sheetId : undefined;
      return [draftSheetKey ? { ...operation, draftSheetKey } : operation, ...(phaseEdits.get(key) ?? [])];
    }),
  ];
}
