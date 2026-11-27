import type { ArtifactFormat } from './types.js';

export interface SemanticEditScope {
  format: ArtifactFormat;
  regionKeys?: string[];
  hasDynamicOrCrossSheetFormulas?: boolean;
  structuralChange?: boolean;
}

export interface MergeDecision {
  mergeable: boolean;
  reason: string;
}

/**
 * Static semantic non-interference proof checker (`ARCH-14`).
 * Any format or edit pair where semantic non-interference cannot be statically proven
 * MUST return `{ mergeable: false }` so the caller emits `409 ARTIFACT_CONFLICT`.
 */
export function evaluateSemanticNonInterference(
  editA: SemanticEditScope,
  editB: SemanticEditScope
): MergeDecision {
  if (editA.format !== editB.format) {
    return { mergeable: false, reason: 'format_mismatch' };
  }
  const fmt = editA.format;

  // Formats with document-wide syntactic or reflow coupling: ALWAYS 409 conflict
  if (
    fmt === 'docx' ||
    fmt === 'code' ||
    fmt === 'html' ||
    fmt === 'svg' ||
    fmt === 'mermaid' ||
    fmt === 'markdown' ||
    fmt === 'diff' ||
    fmt === 'image' ||
    fmt === 'media' ||
    fmt === 'binary'
  ) {
    return { mergeable: false, reason: `format_${fmt}_cannot_prove_non_interference` };
  }

  if (editA.structuralChange || editB.structuralChange) {
    return { mergeable: false, reason: 'structural_mutation_not_mergeable' };
  }

  if (fmt === 'xlsx' && (editA.hasDynamicOrCrossSheetFormulas || editB.hasDynamicOrCrossSheetFormulas)) {
    return { mergeable: false, reason: 'xlsx_formula_dependency_conflict' };
  }

  // For pptx (slideId), pdf (pageIndex), csv/xlsx (disjoint cell keys without structural/formula coupling),
  // require explicit non-empty regionKeys with zero intersection.
  const keysA = editA.regionKeys ?? [];
  const keysB = editB.regionKeys ?? [];
  if (keysA.length === 0 || keysB.length === 0) {
    return { mergeable: false, reason: 'missing_disjoint_region_proof' };
  }

  const setA = new Set(keysA);
  const sheetsWithCellsA = fmt === 'xlsx' ? new Set(keysA.filter(key => key.includes('#')).map(key => key.split('#')[0])) : null;
  for (const k of keysB) {
    const overlap = setA.has(k) || (sheetsWithCellsA !== null &&
      (k.includes('#') ? setA.has(k.split('#')[0]) : sheetsWithCellsA.has(k)));
    if (overlap) {
      return { mergeable: false, reason: `overlapping_region_${k}` };
    }
  }

  return { mergeable: true, reason: 'proven_disjoint_regions' };
}
