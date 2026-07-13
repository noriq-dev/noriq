// Sanitized markdown renderer for agent-authored plan documents.
import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function Markdown({ source, compact }: { source: string; compact?: boolean }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true, breaks: false })),
    [source],
  );
  return (
    <div
      className={compact ? 'md md-compact' : 'md'}
      // eslint-disable-next-line react/no-danger — sanitized above
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
