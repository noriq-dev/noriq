import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AttachmentPreview,
  attachmentPreviewDecision,
  type AttachmentPreviewItem,
} from './AttachmentPreview';

let container: HTMLDivElement;
let root: Root | null = null;

const image: AttachmentPreviewItem = {
  id: 'att_image', filename: 'field report.png', contentType: 'image/png', size: 1536, createdAt: '2026-08-10T00:00:00Z',
};

function Harness({ attachment }: { attachment: AttachmentPreviewItem }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={opener} onClick={() => setOpen(true)}>Preview attachment</button>
      {open && <AttachmentPreview attachment={attachment} onClose={() => setOpen(false)} returnFocus={opener.current} />}
    </>
  );
}

function mount(attachment: AttachmentPreviewItem) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Harness attachment={attachment} />));
  const opener = container.querySelector<HTMLButtonElement>('button')!;
  act(() => opener.click());
  return opener;
}

const tick = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const button = (label: string) => [...document.querySelectorAll('button')].find((el) => el.textContent === label)!;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.style.overflow = '';
});

describe('attachment preview decisions', () => {
  it('covers browser-supported media and refuses scriptable markup', () => {
    const item = (filename: string, contentType: string, size = 20): AttachmentPreviewItem => ({ id: filename, filename, contentType, size, createdAt: '' });
    expect(attachmentPreviewDecision(item('shot.webp', 'image/webp')).kind).toBe('image');
    expect(attachmentPreviewDecision(item('brief.pdf', 'application/pdf')).kind).toBe('pdf');
    expect(attachmentPreviewDecision(item('note.json', 'application/json')).kind).toBe('text');
    expect(attachmentPreviewDecision(item('voice.ogg', 'audio/ogg')).kind).toBe('audio');
    expect(attachmentPreviewDecision(item('demo.mp4', 'video/mp4')).kind).toBe('video');
    expect(attachmentPreviewDecision(item('attack.html', 'text/html')).kind).toBe('unsupported');
    expect(attachmentPreviewDecision(item('attack.svg', 'image/svg+xml')).kind).toBe('unsupported');
    expect(attachmentPreviewDecision(item('huge.log', 'text/plain', 3 * 1024 * 1024)).kind).toBe('unsupported');
  });
});

describe('AttachmentPreview', () => {
  it('shows an image and file context in a viewport-bounded dialog with all base actions', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mount(image);

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).toBeTruthy();
    expect(dialog.style.width).toContain('100vw - 24px');
    expect(dialog.style.height).toContain('100dvh - 24px');
    expect(dialog.style.maxHeight).toContain('100dvh - 24px');
    expect(dialog.textContent).toContain('field report.png');
    expect(dialog.textContent).toContain('image/png');
    expect(dialog.textContent).toContain('1.5 KB');
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('/api/attachments/att_image');
    expect(dialog.querySelector<HTMLAnchorElement>('a[target="_blank"]')?.textContent).toContain('Open full view');
    expect(dialog.querySelector<HTMLAnchorElement>('a[download]')?.download).toBe('field report.png');
    expect(button('Copy link')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close attachment preview');
  });

  it('fetches text through the authorized route, formats JSON, and copies the link or visible content', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '{"answer":42}' }));
    mount({ ...image, id: 'att_json', filename: 'result.json', contentType: 'application/json' });
    await tick();

    const visible = '{\n  "answer": 42\n}';
    expect(document.querySelector('pre')?.textContent).toBe(visible);
    act(() => button('Copy content').click());
    await tick();
    expect(writeText).toHaveBeenCalledWith(visible);
    expect(document.body.textContent).toContain('Content copied');

    act(() => button('Copy link').click());
    await tick();
    expect(writeText).toHaveBeenLastCalledWith('http://localhost:3000/api/attachments/att_json');
    expect(document.body.textContent).toContain('Link copied');
  });

  it('shows a safe fallback without fetching or embedding an unsafe type', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mount({ ...image, id: 'att_html', filename: 'attack.html', contentType: 'text/html' });

    expect(document.body.textContent).toContain('No inline preview');
    expect(document.body.textContent).toContain('download-only for safety');
    expect(document.querySelector('[role="dialog"] iframe')).toBeFalsy();
    expect(document.querySelector('[role="dialog"] pre')).toBeFalsy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('closes on Escape and backdrop interaction, then restores focus to the opener', () => {
    vi.stubGlobal('fetch', vi.fn());
    const opener = mount(image);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeFalsy();
    expect(document.activeElement).toBe(opener);

    act(() => opener.click());
    act(() => document.querySelector<HTMLElement>('[data-attachment-preview-backdrop]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeFalsy();
    expect(document.activeElement).toBe(opener);
  });
});
