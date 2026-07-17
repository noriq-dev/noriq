// Sanitized markdown renderer. Two modes:
//   - default (breaks:false): CommonMark, for hand-authored plan/doc bodies where a
//     single newline is a soft wrap (PLNR-151).
//   - breaks:true: GitHub-comment semantics, one newline = one <br>, for streamed
//     conversational output (run transcript) where agents separate thoughts with a
//     single newline and never leave a blank line (PLNR-172).
import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function Markdown({ source, compact, breaks }: { source: string; compact?: boolean; breaks?: boolean }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true, breaks: breaks ?? false })),
    [source, breaks],
  );
  return (
    <div
      className={compact ? 'md md-compact' : 'md'}
      // eslint-disable-next-line react/no-danger — sanitized above
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
