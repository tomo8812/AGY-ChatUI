import type { AdapterVerifyIssue } from '../types.js';

export interface XmlParsedElement {
  index: number;
  tag: string;
  localName: string;
  line: number;
  attrs: Record<string, string>;
  selfClosing: boolean;
  parentIndex: number | null;
  depth: number;
  textContent: string;
}

export interface XmlValidationResult {
  ok: boolean;
  rootTag: string | null;
  rootLocalName: string | null;
  elementCount: number;
  elements: XmlParsedElement[];
  issues: AdapterVerifyIssue[];
}

const XML_NAME_RE = /^[A-Za-z_:][A-Za-z0-9._:-]*$/;
const VALID_ENTITY_RE = /^&(?:[A-Za-z_:][A-Za-z0-9._:-]*|#[0-9]+|#x[0-9a-fA-F]+);/;
const MAX_STORED_ELEMENTS = 20_000;
const MAX_ISSUES = 100;

function countNewlines(str: string, from: number, to: number): number {
  let count = 0;
  for (let i = from; i < to; i++) {
    if (str.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

function checkEntitiesInSegment(
  segment: string,
  startLine: number,
  pushIssue: (issue: AdapterVerifyIssue) => void,
  context: 'text' | 'attribute'
): void {
  let line = startLine;
  let idx = 0;
  while (idx < segment.length) {
    const ch = segment.charCodeAt(idx);
    if (ch === 10) {
      line += 1;
      idx += 1;
      continue;
    }
    if (ch === 38) {
      // '&'
      const slice = segment.slice(idx, idx + 64);
      if (!VALID_ENTITY_RE.test(slice)) {
        pushIssue({
          severity: 'error',
          code: 'XML_UNESCAPED_AMP',
          message: `Unescaped '&' or malformed entity reference in XML ${context}.`,
          location: `line:${line}`,
        });
      }
    }
    idx += 1;
  }
}

/**
 * Pure-JS XML 1.0 well-formedness validator and lightweight element tree collector.
 * Enforces single root, balanced nesting, quoted non-duplicate attributes, valid entities,
 * and rejects XXE / entity declarations (`SEC-05`).
 */
export function validateXmlWellFormedness(rawText: string): XmlValidationResult {
  const issues: AdapterVerifyIssue[] = [];
  const elements: XmlParsedElement[] = [];

  const pushIssue = (issue: AdapterVerifyIssue) => {
    if (issues.length < MAX_ISSUES) {
      issues.push(issue);
    }
  };

  // Strip optional UTF-8 BOM
  const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
  const n = text.length;

  if (text.trim().length === 0) {
    pushIssue({
      severity: 'error',
      code: 'XML_EMPTY',
      message: 'XML document is empty.',
      location: 'line:1',
    });
    return { ok: false, rootTag: null, rootLocalName: null, elementCount: 0, elements, issues };
  }

  let i = 0;
  let line = 1;
  let seenRootCount = 0;
  let rootTag: string | null = null;
  let rootLocalName: string | null = null;
  let seenNonXmlDeclContent = false;
  let elementCount = 0;

  const stack: Array<{ tag: string; line: number; elementIndex: number | null }> = [];

  while (i < n) {
    const lt = text.indexOf('<', i);
    const textEnd = lt === -1 ? n : lt;

    if (textEnd > i) {
      const seg = text.slice(i, textEnd);
      if (stack.length === 0) {
        if (seg.trim().length > 0) {
          seenNonXmlDeclContent = true;
          pushIssue({
            severity: 'error',
            code: 'XML_CONTENT_OUTSIDE_ROOT',
            message: 'Character data is not allowed outside the XML root element.',
            location: `line:${line}`,
          });
        }
      } else {
        if (seg.includes(']]>')) {
          pushIssue({
            severity: 'error',
            code: 'XML_INVALID_CDATA_END',
            message: "Sequence ']]>' is not allowed in XML character data.",
            location: `line:${line}`,
          });
        }
        checkEntitiesInSegment(seg, line, pushIssue, 'text');
        const top = stack[stack.length - 1];
        if (top.elementIndex !== null) {
          const el = elements[top.elementIndex];
          if (el.textContent.length < 4096) {
            el.textContent += seg;
          }
        }
      }
      line += countNewlines(text, i, textEnd);
      i = textEnd;
    }

    if (i >= n) break;

    // Now text[i] === '<'
    const tagStartLine = line;

    // 1. Comment <!-- ... -->
    if (text.startsWith('<!--', i)) {
      seenNonXmlDeclContent = true;
      const closeIdx = text.indexOf('-->', i + 4);
      if (closeIdx === -1) {
        pushIssue({
          severity: 'error',
          code: 'XML_UNCLOSED_COMMENT',
          message: 'Unclosed XML comment.',
          location: `line:${tagStartLine}`,
        });
        break;
      }
      const body = text.slice(i + 4, closeIdx);
      if (body.includes('--') || body.endsWith('-')) {
        pushIssue({
          severity: 'error',
          code: 'XML_INVALID_COMMENT',
          message: "XML comment cannot contain '--' or end with '---'.",
          location: `line:${tagStartLine}`,
        });
      }
      line += countNewlines(text, i, closeIdx + 3);
      i = closeIdx + 3;
      continue;
    }

    // 2. CDATA <![CDATA[ ... ]]>
    if (text.startsWith('<![CDATA[', i)) {
      seenNonXmlDeclContent = true;
      const closeIdx = text.indexOf(']]>', i + 9);
      if (closeIdx === -1) {
        pushIssue({
          severity: 'error',
          code: 'XML_UNCLOSED_CDATA',
          message: 'Unclosed XML CDATA section.',
          location: `line:${tagStartLine}`,
        });
        break;
      }
      if (stack.length === 0) {
        pushIssue({
          severity: 'error',
          code: 'XML_CONTENT_OUTSIDE_ROOT',
          message: 'CDATA section is not allowed outside the XML root element.',
          location: `line:${tagStartLine}`,
        });
      } else {
        const top = stack[stack.length - 1];
        if (top.elementIndex !== null) {
          const el = elements[top.elementIndex];
          if (el.textContent.length < 4096) {
            el.textContent += text.slice(i + 9, closeIdx);
          }
        }
      }
      line += countNewlines(text, i, closeIdx + 3);
      i = closeIdx + 3;
      continue;
    }

    // 3. Processing instruction / XML declaration <? ... ?>
    if (text.startsWith('<?', i)) {
      const closeIdx = text.indexOf('?>', i + 2);
      if (closeIdx === -1) {
        pushIssue({
          severity: 'error',
          code: 'XML_UNCLOSED_PI',
          message: 'Unclosed XML processing instruction.',
          location: `line:${tagStartLine}`,
        });
        break;
      }
      const piContent = text.slice(i + 2, closeIdx);
      const targetMatch = /^([A-Za-z_:][A-Za-z0-9._:-]*)/.exec(piContent);
      if (!targetMatch) {
        pushIssue({
          severity: 'error',
          code: 'XML_INVALID_PI',
          message: 'Malformed XML processing instruction target.',
          location: `line:${tagStartLine}`,
        });
      } else if (targetMatch[1].toLowerCase() === 'xml') {
        if (targetMatch[1] !== 'xml') {
          pushIssue({
            severity: 'error',
            code: 'XML_INVALID_DECL',
            message: "XML declaration target must be lowercase 'xml'.",
            location: `line:${tagStartLine}`,
          });
        } else if (i > 0 || seenNonXmlDeclContent) {
          pushIssue({
            severity: 'error',
            code: 'XML_MISPLACED_DECL',
            message: 'XML declaration must appear at the very beginning of the document.',
            location: `line:${tagStartLine}`,
          });
        }
      } else {
        seenNonXmlDeclContent = true;
      }
      line += countNewlines(text, i, closeIdx + 2);
      i = closeIdx + 2;
      continue;
    }

    // 4. DOCTYPE / ENTITY declaration <! ... >
    if (text.startsWith('<!', i)) {
      seenNonXmlDeclContent = true;
      let cursor = i + 2;
      let bracketDepth = 0;
      let quote: string | null = null;
      let foundEnd = false;
      while (cursor < n) {
        const c = text[cursor];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") {
          quote = c;
        } else if (c === '[') {
          bracketDepth += 1;
        } else if (c === ']') {
          bracketDepth = Math.max(0, bracketDepth - 1);
        } else if (c === '>' && bracketDepth === 0) {
          foundEnd = true;
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      if (!foundEnd) {
        pushIssue({
          severity: 'error',
          code: 'XML_UNCLOSED_DOCTYPE',
          message: 'Unclosed XML declaration or DOCTYPE.',
          location: `line:${tagStartLine}`,
        });
        break;
      }
      const decl = text.slice(i, cursor);
      if (/<!ENTITY\b/i.test(decl)) {
        pushIssue({
          severity: 'error',
          code: 'XML_ENTITY_DECLARATION',
          message: 'XML ENTITY declaration is disallowed (XXE protection).',
          location: `line:${tagStartLine}`,
        });
      }
      if (/^<!DOCTYPE\b/i.test(decl)) {
        if (seenRootCount > 0) {
          pushIssue({
            severity: 'error',
            code: 'XML_MISPLACED_DOCTYPE',
            message: 'DOCTYPE declaration must appear before the root element.',
            location: `line:${tagStartLine}`,
          });
        }
        if (/\b(?:SYSTEM|PUBLIC)\b/i.test(decl)) {
          pushIssue({
            severity: 'error',
            code: 'XML_EXTERNAL_DTD',
            message: 'External DTD reference (SYSTEM/PUBLIC) is disallowed in XML.',
            location: `line:${tagStartLine}`,
          });
        }
      } else if (!/^<!(?:ELEMENT|ATTLIST|NOTATION|ENTITY)\b/i.test(decl)) {
        pushIssue({
          severity: 'error',
          code: 'XML_INVALID_DECLARATION',
          message: 'Unknown or malformed XML markup declaration.',
          location: `line:${tagStartLine}`,
        });
      }
      line += countNewlines(text, i, cursor);
      i = cursor;
      continue;
    }

    // 5. Closing tag </name>
    if (text.startsWith('</', i)) {
      seenNonXmlDeclContent = true;
      const gt = text.indexOf('>', i + 2);
      if (gt === -1) {
        pushIssue({
          severity: 'error',
          code: 'XML_UNCLOSED_TAG',
          message: 'Unclosed XML closing tag.',
          location: `line:${tagStartLine}`,
        });
        break;
      }
      const rawName = text.slice(i + 2, gt).trim();
      if (!XML_NAME_RE.test(rawName)) {
        pushIssue({
          severity: 'error',
          code: 'XML_INVALID_TAG_NAME',
          message: `Invalid XML closing tag name '${rawName}'.`,
          location: `line:${tagStartLine}`,
        });
      } else if (stack.length === 0) {
        pushIssue({
          severity: 'error',
          code: 'XML_UNEXPECTED_CLOSING_TAG',
          message: `Unexpected closing tag '</${rawName}>' with no matching opening tag.`,
          location: `line:${tagStartLine}`,
        });
      } else {
        const top = stack[stack.length - 1];
        if (top.tag === rawName) {
          stack.pop();
        } else {
          // Check if an ancestor matches so we can report the mismatch and recover gracefully
          const matchIdx = stack.map((s) => s.tag).lastIndexOf(rawName);
          pushIssue({
            severity: 'error',
            code: 'XML_MISMATCHED_TAG',
            message: `Mismatched closing tag '</${rawName}>'; expected '</${top.tag}>' opened at line ${top.line}.`,
            location: `line:${tagStartLine}`,
          });
          if (matchIdx !== -1) {
            stack.length = matchIdx;
          }
        }
      }
      line += countNewlines(text, i, gt + 1);
      i = gt + 1;
      continue;
    }

    // 6. Opening / self-closing tag <name attr="val" ...>
    seenNonXmlDeclContent = true;
    let cursor = i + 1;
    // Read tag name
    let nameEnd = cursor;
    while (nameEnd < n && !/[\s/>]/.test(text[nameEnd])) {
      nameEnd += 1;
    }
    const tagName = text.slice(cursor, nameEnd);
    if (!tagName || !XML_NAME_RE.test(tagName)) {
      pushIssue({
        severity: 'error',
        code: 'XML_INVALID_TAG_NAME',
        message: `Invalid XML tag name '${tagName || text.slice(i, i + 16)}'.`,
        location: `line:${tagStartLine}`,
      });
      const fallbackGt = text.indexOf('>', i + 1);
      if (fallbackGt === -1) break;
      line += countNewlines(text, i, fallbackGt + 1);
      i = fallbackGt + 1;
      continue;
    }

    cursor = nameEnd;
    const attrs: Record<string, string> = {};
    let selfClosing = false;
    let closedTag = false;
    let attrLine = tagStartLine;

    while (cursor < n) {
      // Skip whitespace
      const wsStart = cursor;
      while (cursor < n && /\s/.test(text[cursor])) {
        cursor += 1;
      }
      const hadWhitespace = cursor > wsStart;
      attrLine += countNewlines(text, wsStart, cursor);
      if (cursor >= n) break;

      if (text[cursor] === '>') {
        cursor += 1;
        closedTag = true;
        break;
      }
      if (text[cursor] === '/' && text[cursor + 1] === '>') {
        selfClosing = true;
        cursor += 2;
        closedTag = true;
        break;
      }

      if (!hadWhitespace && Object.keys(attrs).length > 0) {
        pushIssue({
          severity: 'error',
          code: 'XML_INVALID_ATTRIBUTE',
          message: `Missing whitespace between attributes in <${tagName}>.`,
          location: `line:${attrLine}`,
        });
      }

      // Parse attribute name
      const aNameStart = cursor;
      while (cursor < n && !/[\s=/>]/.test(text[cursor])) {
        cursor += 1;
      }
      const attrName = text.slice(aNameStart, cursor);
      if (!attrName || !XML_NAME_RE.test(attrName)) {
        pushIssue({
          severity: 'error',
          code: 'XML_INVALID_ATTRIBUTE',
          message: `Invalid attribute name '${attrName || text[cursor]}' in <${tagName}>.`,
          location: `line:${attrLine}`,
        });
        const recovery = text.indexOf('>', cursor);
        if (recovery === -1) {
          cursor = n;
          break;
        }
        attrLine += countNewlines(text, cursor, recovery + 1);
        cursor = recovery + 1;
        closedTag = true;
        break;
      }

      // Skip whitespace before '='
      const eqWsStart = cursor;
      while (cursor < n && /\s/.test(text[cursor])) cursor += 1;
      attrLine += countNewlines(text, eqWsStart, cursor);

      if (text[cursor] !== '=') {
        pushIssue({
          severity: 'error',
          code: 'XML_INVALID_ATTRIBUTE',
          message: `Attribute '${attrName}' in <${tagName}> must have a quoted value.`,
          location: `line:${attrLine}`,
        });
        continue;
      }
      cursor += 1; // skip '='

      const valWsStart = cursor;
      while (cursor < n && /\s/.test(text[cursor])) cursor += 1;
      attrLine += countNewlines(text, valWsStart, cursor);

      const quote = text[cursor];
      if (quote !== '"' && quote !== "'") {
        pushIssue({
          severity: 'error',
          code: 'XML_INVALID_ATTRIBUTE',
          message: `Attribute '${attrName}' in <${tagName}> must be enclosed in single or double quotes.`,
          location: `line:${attrLine}`,
        });
        // Skip unquoted token
        while (cursor < n && !/[\s/>]/.test(text[cursor])) cursor += 1;
        continue;
      }

      const valStart = cursor + 1;
      const valEnd = text.indexOf(quote, valStart);
      if (valEnd === -1) {
        pushIssue({
          severity: 'error',
          code: 'XML_UNCLOSED_ATTRIBUTE_QUOTE',
          message: `Unclosed attribute value for '${attrName}' in <${tagName}>.`,
          location: `line:${attrLine}`,
        });
        cursor = n;
        break;
      }
      const attrVal = text.slice(valStart, valEnd);
      if (attrVal.includes('<')) {
        pushIssue({
          severity: 'error',
          code: 'XML_UNESCAPED_LT_IN_ATTR',
          message: `Unescaped '<' in attribute '${attrName}' of <${tagName}>.`,
          location: `line:${attrLine}`,
        });
      }
      checkEntitiesInSegment(attrVal, attrLine, pushIssue, 'attribute');
      if (Object.prototype.hasOwnProperty.call(attrs, attrName)) {
        pushIssue({
          severity: 'error',
          code: 'XML_DUPLICATE_ATTRIBUTE',
          message: `Duplicate attribute '${attrName}' on <${tagName}>.`,
          location: `line:${attrLine}`,
        });
      } else {
        attrs[attrName] = attrVal;
      }
      attrLine += countNewlines(text, valStart, valEnd);
      cursor = valEnd + 1;
    }

    if (!closedTag) {
      pushIssue({
        severity: 'error',
        code: 'XML_UNCLOSED_TAG',
        message: `Unclosed opening tag '<${tagName}'.`,
        location: `line:${tagStartLine}`,
      });
      break;
    }

    const colonIdx = tagName.indexOf(':');
    const localName = colonIdx === -1 ? tagName : tagName.slice(colonIdx + 1);

    if (stack.length === 0) {
      seenRootCount += 1;
      if (seenRootCount === 1) {
        rootTag = tagName;
        rootLocalName = localName;
      } else {
        pushIssue({
          severity: 'error',
          code: 'XML_MULTIPLE_ROOTS',
          message: `Multiple root elements detected: extra root '<${tagName}>'.`,
          location: `line:${tagStartLine}`,
        });
      }
    }

    const parentIndex = stack.length > 0 ? stack[stack.length - 1].elementIndex : null;
    let elementIndex: number | null = null;
    elementCount += 1;
    if (elements.length < MAX_STORED_ELEMENTS) {
      elementIndex = elements.length;
      elements.push({
        index: elementIndex,
        tag: tagName,
        localName,
        line: tagStartLine,
        attrs,
        selfClosing,
        parentIndex,
        depth: stack.length,
        textContent: '',
      });
    }

    if (!selfClosing) {
      stack.push({ tag: tagName, line: tagStartLine, elementIndex });
    }

    line = attrLine;
    i = cursor;
  }

  for (let s = stack.length - 1; s >= 0; s--) {
    pushIssue({
      severity: 'error',
      code: 'XML_UNCLOSED_TAG',
      message: `Unclosed XML element '<${stack[s].tag}>' opened at line ${stack[s].line}.`,
      location: `line:${stack[s].line}`,
    });
  }

  if (seenRootCount === 0 && !issues.some((iss) => iss.code === 'XML_EMPTY')) {
    pushIssue({
      severity: 'error',
      code: 'XML_MISSING_ROOT',
      message: 'XML document has no root element.',
      location: 'line:1',
    });
  }

  return {
    ok: !issues.some((iss) => iss.severity === 'error'),
    rootTag,
    rootLocalName,
    elementCount,
    elements,
    issues,
  };
}
