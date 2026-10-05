/**
 * Markdown → sanitized HTML for chat messages.
 *
 * Model output is untrusted, so everything goes through DOMPurify before it
 * ever touches `innerHTML`. Sanitizing strips event handlers, scripts, and
 * dangerous URLs even if the markdown contains raw HTML.
 */
import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button', 'link', 'meta'],
  });
}
