import { SaxesParser } from 'saxes';
import type { AdapterVerifyCheck, AdapterVerifyIssue } from '../types.js';
import { MAX_VERIFY_DEPTH, MAX_VERIFY_NODES, VerificationLimit, verificationMessage } from './text-verification.js';

export interface XmlParsedElement {
  name: string;
  namespace: string;
  line: number;
  attrs: Record<string, string>;
  parentIndex: number | null;
}

export interface XmlValidationResult {
  status: AdapterVerifyCheck['status'];
  evidence: string;
  root?: XmlParsedElement;
  elements: XmlParsedElement[];
  elementCount: number;
  hasStylesheet: boolean;
  issues: AdapterVerifyIssue[];
}

class XmlParseFailure extends Error {}

export function validateXmlWellFormedness(text: string, collectElements = false): XmlValidationResult {
  const parser = new SaxesParser({ xmlns: true });
  const elements: XmlParsedElement[] = [];
  const parents: number[] = [];
  let root: XmlParsedElement | undefined;
  let elementCount = 0;
  let line = 1;
  let hasStylesheet = false;

  parser.on('error', (error) => { throw new XmlParseFailure(error.message); });
  parser.on('doctype', () => {
    // DTDs can change entity declarations, default attributes and namespaces. Saxes
    // does not validate them. Stop before reaching any DTD-dependent document content.
    throw new VerificationLimit('DOCTYPE and DTD-dependent documents are outside this XML check. No DTD was loaded or expanded.');
  });
  parser.on('xmldecl', ({ encoding }) => {
    if (encoding && !/^utf-8$/i.test(encoding) && !(/^us-ascii$/i.test(encoding) && /^[\x00-\x7f]*$/.test(text))) {
      throw new VerificationLimit('This check supports UTF-8 documents and ASCII documents declared as US-ASCII.');
    }
  });
  parser.on('processinginstruction', ({ target }) => { hasStylesheet ||= target === 'xml-stylesheet'; });
  parser.on('opentagstart', () => {
    line = parser.line;
    if (parents.length >= MAX_VERIFY_DEPTH) throw new VerificationLimit(`XML nesting exceeds ${MAX_VERIFY_DEPTH}.`);
    if (++elementCount > MAX_VERIFY_NODES) throw new VerificationLimit(`XML element count exceeds ${MAX_VERIFY_NODES}.`);
  });
  parser.on('opentag', (tag) => {
    if (collectElements || !root) {
      const attrs: Record<string, string> = Object.create(null);
      for (const attr of Object.values(tag.attributes)) attrs[attr.name] = attr.value;
      const element = {
        name: tag.local,
        namespace: tag.uri,
        line,
        attrs,
        parentIndex: parents.at(-1) ?? null,
      };
      root ??= element;
      if (collectElements) elements.push(element);
    }
    parents.push(elementCount - 1);
  });
  parser.on('closetag', () => { parents.pop(); });

  let status: XmlValidationResult['status'] = 'passed';
  let evidence: string;
  const issues: AdapterVerifyIssue[] = [];
  try {
    parser.write(text).close();
    evidence = `Parsed namespace-aware XML with saxes (${elementCount} elements); schema validation was outside this check.`;
  } catch (error) {
    if (!(error instanceof VerificationLimit || error instanceof XmlParseFailure)) throw error;
    evidence = verificationMessage(error.message);
    status = error instanceof VerificationLimit ? 'unverified' : 'failed';
    if (status === 'failed') {
      issues.push({ severity: 'error', code: 'XML_SYNTAX_ERROR', message: evidence, location: `line:${parser.line}` });
    }
  }
  return { status, evidence, root, elements, elementCount, hasStylesheet, issues };
}
