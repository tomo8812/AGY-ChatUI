import type { AdapterVerifyCheck, AdapterVerifyIssue, AdapterVerifyResult } from '../types.js';

export const MAX_TEXT_VERIFY_BYTES = 512 * 1024;
export const MAX_VERIFY_DIAGNOSTICS = 25;
export const MAX_VERIFY_NODES = 12_000;
export const MAX_VERIFY_DEPTH = 128;

export class VerificationLimit extends Error {}

export function verificationMessage(message: string): string {
  return message.length > 240 ? message.slice(0, 239) + '…' : message;
}

export function textVerificationReport(
  checks: AdapterVerifyCheck[],
  issues: AdapterVerifyIssue[],
  metrics?: Record<string, unknown>
): AdapterVerifyResult {
  return {
    ok: checks.every((check) => check.status === 'passed') && !issues.some((issue) => issue.severity === 'error'),
    coverage: checks.some((check) => check.status === 'unverified') ? 'partial' : 'complete',
    checks,
    issues,
    ...(metrics ? { metrics } : {}),
  };
}

export function skippedTextVerification(checkIds: string[], evidence: string): AdapterVerifyResult {
  return textVerificationReport(checkIds.map((id) => ({ id, status: 'unverified', evidence })), []);
}

export function decodeVerificationText(
  buffer: Buffer,
  checkIds: [string, ...string[]]
): { text: string } | { report: AdapterVerifyResult } {
  if (buffer.length > MAX_TEXT_VERIFY_BYTES) {
    return { report: skippedTextVerification(checkIds, `Source exceeds the ${MAX_TEXT_VERIFY_BYTES}-byte verification budget.`) };
  }
  let message: string;
  let code: string;
  if (buffer.includes(0)) {
    message = 'NUL byte detected in the UTF-8 input.';
    code = 'BINARY_NULL_BYTE';
  } else {
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer) };
    } catch {
      message = 'Invalid UTF-8 byte sequence.';
      code = 'INVALID_UTF8';
    }
  }
  const [encodingId, ...syntaxIds] = checkIds;
  const checks: AdapterVerifyCheck[] = [{ id: encodingId, status: 'failed', evidence: message }];
  for (const id of syntaxIds) checks.push({ id, status: 'unverified', evidence: 'UTF-8 decoding did not succeed.' });
  return { report: textVerificationReport(checks, [{ severity: 'error', code, message }]) };
}
