import { Composer, CST, LineCounter, Parser, isScalar, visit } from 'yaml';
import type { AdapterVerifyCheck, AdapterVerifyIssue } from '../types.js';
import {
  MAX_VERIFY_DEPTH, MAX_VERIFY_DIAGNOSTICS, MAX_VERIFY_NODES, VerificationLimit, verificationMessage,
} from './text-verification.js';

const MAX_YAML_COLLECTION_ITEMS = 1_024;

export function validateYamlSyntax(text: string): { checks: AdapterVerifyCheck[]; issues: AdapterVerifyIssue[] } {
  const lines = new LineCounter();
  const parser = new Parser((offset) => lines.addNewLine(offset));
  const composer = new Composer({ strict: true, prettyErrors: false });
  const issues: AdapterVerifyIssue[] = [];
  let nodeCount = 0;
  let documents = 0;
  let errors = 0;
  let warnings = 0;
  let complexKeys = false;

  function* boundedTokens() {
    for (const token of parser.parse(text)) {
      const pending: Array<{ node: CST.Token; depth: number }> = [{ node: token, depth: 0 }];
      while (pending.length) {
        const { node, depth } = pending.pop()!;
        if (++nodeCount > MAX_VERIFY_NODES || depth > MAX_VERIFY_DEPTH) {
          throw new VerificationLimit(`YAML exceeds the ${MAX_VERIFY_NODES}-node or ${MAX_VERIFY_DEPTH}-level budget.`);
        }
        if (node.type === 'document' && node.value) pending.push({ node: node.value, depth: depth + 1 });
        if (!CST.isCollection(node)) continue;
        // The library checks duplicate scalar keys against previous keys in the same collection.
        if (node.type !== 'block-seq' && node.items.length > MAX_YAML_COLLECTION_ITEMS) {
          throw new VerificationLimit(`YAML map or flow collection exceeds ${MAX_YAML_COLLECTION_ITEMS} entries.`);
        }
        for (const item of node.items) {
          if (item.key) pending.push({ node: item.key, depth: depth + 1 });
          if (item.value) pending.push({ node: item.value, depth: depth + 1 });
        }
      }
      yield token;
    }
  }

  function addIssue(severity: 'error' | 'warning', code: string, message: string, offset: number) {
    if (severity === 'error') errors++;
    else warnings++;
    if (issues.length < MAX_VERIFY_DIAGNOSTICS) {
      issues.push({ severity, code, message: verificationMessage(message), location: `line:${lines.linePos(offset).line}` });
    }
  }

  let incomplete: string | undefined;
  try {
    for (const doc of composer.compose(boundedTokens(), true, text.length)) {
      documents++;
      for (const error of doc.errors) addIssue('error', `YAML_${error.code}`, error.message, error.pos[0]);
      for (const warning of doc.warnings) addIssue('warning', `YAML_${warning.code}`, warning.message, warning.pos[0]);
      const anchors = new Set<string>();
      // Work on the syntax tree. Resolving aliases to JS values can expand the input.
      visit(doc, {
        Node(_, node) {
          if ('anchor' in node && node.anchor) anchors.add(node.anchor);
        },
        Alias(_, alias) {
          if (!anchors.has(alias.source)) {
            addIssue('error', 'YAML_UNRESOLVED_ALIAS', `Alias references an anchor that has not been declared: ${alias.source}`, alias.range?.[0] ?? 0);
          }
        },
        Pair(_, pair) {
          if (pair.key != null && !isScalar(pair.key)) complexKeys = true;
        },
      });
    }
  } catch (error) {
    if (!(error instanceof VerificationLimit || error instanceof RangeError)) throw error;
    incomplete = error instanceof VerificationLimit ? error.message : 'YAML parser nesting limit was reached.';
  }
  const remaining = [
    incomplete,
    warnings ? 'Some directives or tags could not be validated.' : undefined,
    complexKeys ? 'Uniqueness of complex or alias mapping keys could not be verified.' : undefined,
  ].filter(Boolean).join(' ');
  const checks: AdapterVerifyCheck[] = [{
    id: 'yaml_syntax',
    status: errors ? 'failed' : remaining ? 'unverified' : 'passed',
    evidence: `YAML parser processed ${documents} document(s) with ${errors} error(s) and ${warnings} warning(s). ${remaining}`.trimEnd(),
  }];
  if (errors && remaining) checks.push({ id: 'yaml_syntax_remaining', status: 'unverified', evidence: remaining });
  return { checks, issues };
}
