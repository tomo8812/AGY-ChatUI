import { ArtifactError } from '../errors.js';
import type { AdapterOperation } from '../types.js';
import { inspectPdfDocument, type PdfPageTargetInfo } from './pdf-target.js';

function pages(bytes: Buffer): PdfPageTargetInfo[] | null {
  if (bytes.length > 8 * 1024 * 1024) return null;
  const first = inspectPdfDocument(bytes, 0);
  if (!first || first.pageCount > 256) return null;
  return inspectPdfDocument(bytes)?.pages ?? null;
}

export function provePdfRotationScope(before: Buffer, after: Buffer, operations: AdapterOperation[]) {
  if (operations.length === 0 || operations.some(op => op.op !== 'pdf.rotate_page')) return undefined;
  const previous = pages(before);
  const current = pages(after);
  if (!previous || !current || previous.length !== current.length) return undefined;
  const requested = new Set(operations.map(op => Number(op.pageIndex)));
  const regionKeys: string[] = [];
  for (const [index, page] of previous.entries()) {
    const next = current[index];
    if (page.pageContentHash === next.pageContentHash) continue;
    if (!requested.has(index) || page.rotate === next.rotate ||
        page.rotationIndependentHash !== next.rotationIndependentHash) return undefined;
    regionKeys.push(String(index));
  }
  return regionKeys.length ? { kind: 'pdf_rotation_v1', regionKeys } : undefined;
}

export async function replayPdfRotation(
  liveBytes: Buffer,
  fromBytes: Buffer,
  toBytes: Buffer,
  regions: string[],
  edit: (ops: AdapterOperation[]) => Promise<Buffer>,
): Promise<Buffer> {
  const conflict = () => new ArtifactError('UNDO_SEMANTIC_CONFLICT', '他の更新と競合するため、この操作を安全に変更できません。', 409);
  const live = pages(liveBytes);
  const from = pages(fromBytes);
  const to = pages(toBytes);
  if (!live || !from || !to || live.length !== from.length || from.length !== to.length || !regions.length) throw conflict();
  const expected = [...live];
  const operations = regions.map(region => {
    const pageIndex = Number(region);
    const before = from[pageIndex];
    const after = to[pageIndex];
    if (!before || !after || live[pageIndex].pageContentHash !== before.pageContentHash ||
        before.rotationIndependentHash !== after.rotationIndependentHash) throw conflict();
    expected[pageIndex] = after;
    return { op: 'pdf.rotate_page', pageIndex, degrees: after.rotate - before.rotate };
  });
  const edited = await edit(operations);
  const confirmed = pages(edited);
  if (!confirmed || confirmed.length !== expected.length ||
      confirmed.some((page, i) => page.pageContentHash !== expected[i].pageContentHash)) throw conflict();
  return edited;
}
