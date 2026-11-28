import DOMPurify from 'dompurify';
import { docxHtmlCache } from './viewerCache';

export async function loadDocxPreview(response: Response, versionKey: string): Promise<string> {
  const [arrayBuffer, mammoth] = await Promise.all([response.arrayBuffer(), import('mammoth')]);
  const result = await mammoth.convertToHtml({ arrayBuffer });
  const html = DOMPurify.sanitize(result.value);
  docxHtmlCache.set(versionKey, html);
  return html;
}
