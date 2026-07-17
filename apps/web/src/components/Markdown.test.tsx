// PLNR-172: the run transcript must keep an agent's own line structure. Agents stream
// conversational output separated by single newlines (rarely a blank line before a list),
// so the transcript renders with breaks:true (one newline = one <br>) while plan/doc
// bodies keep the CommonMark default (soft newline = space).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

// The screenshotted reviewer report: an intro line, then three single-newline bullets
// with NO blank line before the list.
const REPORT = [
  'The build is refused. Findings below reference the passed check.',
  '- High — VCS detection misfires on detached HEAD',
  '- High — the changed wizard step is unguarded',
  '- Medium — copy nit in the banner',
].join('\n');

const count = (html: string, tag: string) => (html.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length;

describe('Markdown transcript rendering (PLNR-172)', () => {
  it('breaks: renders the three bullets as list items and keeps multi-line prose on separate lines', () => {
    const html = renderToStaticMarkup(<Markdown source={REPORT} breaks compact />);
    expect(count(html, 'li')).toBe(3);
    // The intro line and the first bullet no longer clump into one paragraph.
    expect(html).toContain('reference the passed check.');
    expect(html).not.toContain('passed check.- High');

    // Plain multi-line prose keeps its breaks as <br>, not collapsed to spaces.
    const prose = renderToStaticMarkup(<Markdown source={'line one\nline two\nline three'} breaks compact />);
    expect(count(prose, 'br')).toBe(2);
  });

  it('default (no breaks): CommonMark soft-wrap is preserved for plan/doc bodies', () => {
    const prose = renderToStaticMarkup(<Markdown source={'line one\nline two\nline three'} />);
    expect(prose).not.toContain('<br');
  });
});
