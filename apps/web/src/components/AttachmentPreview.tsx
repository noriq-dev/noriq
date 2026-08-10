import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';

export interface AttachmentPreviewItem {
  id: string;
  filename: string;
  size: number;
  contentType?: string;
  createdAt: string;
}

export type AttachmentPreviewKind = 'image' | 'text' | 'pdf' | 'audio' | 'video' | 'unsupported';

interface AttachmentPreviewDecision {
  kind: AttachmentPreviewKind;
  reason?: string;
}

const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
const SAFE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);
const SCRIPTABLE_MARKUP_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/xml',
  'text/xml',
]);
const CODE_APPLICATION_TYPES = new Set([
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/x-typescript',
  'application/sql',
  'application/x-sh',
  'application/yaml',
  'application/x-yaml',
]);
const TEXT_FILE_EXTENSION = /\.(?:txt|md|markdown|log|json|jsonl|csv|ya?ml|toml|ini|conf|config|ts|tsx|js|jsx|mjs|cjs|css|scss|less|py|rb|rs|go|java|c|cc|cpp|h|hpp|sh|bash|zsh|sql)$/i;

const normalizedType = (contentType?: string) => (contentType ?? '').split(';', 1)[0]!.trim().toLowerCase();

/** Keep attachment rendering on the same strict side of the server's stored-XSS boundary. */
export function attachmentPreviewDecision(attachment: AttachmentPreviewItem): AttachmentPreviewDecision {
  const contentType = normalizedType(attachment.contentType);
  if (SCRIPTABLE_MARKUP_TYPES.has(contentType) || contentType.endsWith('+xml')) {
    return { kind: 'unsupported', reason: 'This scriptable document type is download-only for safety.' };
  }
  if (SAFE_IMAGE_TYPES.has(contentType)) return { kind: 'image' };
  if (contentType === 'application/pdf') return { kind: 'pdf' };
  if (contentType.startsWith('audio/')) return { kind: 'audio' };
  if (contentType.startsWith('video/')) return { kind: 'video' };

  const textLike = contentType === 'application/json'
    || contentType.endsWith('+json')
    || contentType.startsWith('text/')
    || CODE_APPLICATION_TYPES.has(contentType)
    || ((contentType === '' || contentType === 'application/octet-stream') && TEXT_FILE_EXTENSION.test(attachment.filename));
  if (textLike && attachment.size > MAX_TEXT_PREVIEW_BYTES) {
    return { kind: 'unsupported', reason: 'This text file is too large for an inline preview.' };
  }
  if (textLike) return { kind: 'text' };
  return { kind: 'unsupported', reason: 'This file type does not have a safe inline preview.' };
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const actionStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
  minHeight: 32, padding: '6px 10px', borderRadius: 7,
  border: '1px solid var(--w-12)', background: 'var(--w-04)', color: 'var(--text-soft)',
  fontFamily: 'var(--mono)', fontSize: 10, textDecoration: 'none', cursor: 'pointer',
};

function displayText(raw: string, contentType?: string): string {
  const type = normalizedType(contentType);
  if (type === 'application/json' || type.endsWith('+json')) {
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { /* show malformed JSON as received */ }
  }
  return raw;
}

export function AttachmentPreview({ attachment, onClose, returnFocus }: {
  attachment: AttachmentPreviewItem;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const decision = attachmentPreviewDecision(attachment);
  const url = `/api/attachments/${attachment.id}`;
  const [text, setText] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = priorOverflow;
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [returnFocus]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (decision.kind !== 'text') return;
    const controller = new AbortController();
    setText(null);
    setLoadError(null);
    fetch(url, { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Preview request failed (${response.status})`);
        return response.text();
      })
      .then((body) => setText(displayText(body, attachment.contentType)))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : 'Preview unavailable');
      });
    return () => controller.abort();
  }, [attachment.contentType, decision.kind, url]);

  const copy = async (value: string, success: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(success);
    } catch {
      setCopyStatus('Copy failed');
    }
  };

  const absoluteUrl = new URL(url, window.location.href).href;

  return (
    <>
      <div
        data-attachment-preview-backdrop
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,.72)', backdropFilter: 'blur(3px)' }}
      />
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 61, display: 'grid', placeItems: 'center', padding: 12, pointerEvents: 'none' }}
      >
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          style={{
            width: 'min(960px, calc(100vw - 24px))', height: 'min(760px, calc(100dvh - 24px))', maxHeight: 'calc(100dvh - 24px)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden', pointerEvents: 'auto',
            background: 'var(--bg-raised)', border: '1px solid var(--w-15)', borderRadius: 14,
            boxShadow: '0 30px 90px rgba(0,0,0,.72)',
          }}
        >
          <header style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--line)', flex: 'none' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div id={titleId} style={{ fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {attachment.filename}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4, fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)' }}>
                <span>{attachment.contentType || 'unknown type'}</span>
                <span aria-hidden="true">·</span>
                <span>{formatAttachmentSize(attachment.size)}</span>
              </div>
            </div>
            <button
              ref={closeRef}
              type="button"
              aria-label="Close attachment preview"
              onClick={onClose}
              className="drawer-x"
              style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 17, width: 30, height: 30, borderRadius: 7, flex: 'none' }}
            >
              ✕
            </button>
          </header>

          <div
            data-attachment-preview-content
            style={{ minHeight: 0, flex: '1 1 auto', overflow: 'auto', padding: 16, overscrollBehavior: 'contain', background: 'rgba(0,0,0,.14)' }}
          >
            {decision.kind === 'image' && (
              <img src={url} alt={attachment.filename} style={{ display: 'block', width: '100%', height: 'auto', maxHeight: 'calc(100dvh - 190px)', objectFit: 'contain' }} />
            )}
            {decision.kind === 'pdf' && (
              <iframe title={`Preview of ${attachment.filename}`} src={url} sandbox="" style={{ display: 'block', width: '100%', height: 'min(70dvh, 720px)', border: 0, background: 'white' }} />
            )}
            {decision.kind === 'audio' && (
              <audio controls preload="metadata" src={url} style={{ display: 'block', width: '100%', margin: '54px auto' }} />
            )}
            {decision.kind === 'video' && (
              <video controls preload="metadata" src={url} style={{ display: 'block', width: '100%', maxHeight: 'calc(100dvh - 190px)', background: '#000' }} />
            )}
            {decision.kind === 'text' && text === null && !loadError && (
              <div role="status" style={{ padding: 30, textAlign: 'center', color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 11 }}>loading preview…</div>
            )}
            {decision.kind === 'text' && loadError && (
              <div role="alert" style={{ padding: 30, textAlign: 'center', color: 'var(--red-soft)', fontSize: 12 }}>{loadError}</div>
            )}
            {decision.kind === 'text' && text !== null && (
              <pre style={{ margin: 0, width: '100%', boxSizing: 'border-box', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--text-soft)', fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.55 }}>
                {text}
              </pre>
            )}
            {decision.kind === 'unsupported' && (
              <div style={{ minHeight: 150, display: 'grid', placeItems: 'center', textAlign: 'center', color: 'var(--text-dim)' }}>
                <div>
                  <div aria-hidden="true" style={{ fontSize: 30, marginBottom: 12 }}>📎</div>
                  <div style={{ fontSize: 13, color: 'var(--text-soft)', marginBottom: 5 }}>No inline preview</div>
                  <div style={{ fontSize: 11, maxWidth: 430, lineHeight: 1.5 }}>{decision.reason}</div>
                </div>
              </div>
            )}
          </div>

          <footer style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: '10px 16px', borderTop: '1px solid var(--line)', flex: 'none' }}>
            <a href={url} target="_blank" rel="noreferrer" style={actionStyle}>Open full view ↗</a>
            <a href={url} download={attachment.filename} style={actionStyle}>Download</a>
            <button type="button" onClick={() => void copy(absoluteUrl, 'Link copied')} style={actionStyle}>Copy link</button>
            {decision.kind === 'text' && text !== null && (
              <button type="button" onClick={() => void copy(text, 'Content copied')} style={actionStyle}>Copy content</button>
            )}
            {copyStatus && <span role="status" style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 9.5, color: copyStatus === 'Copy failed' ? 'var(--red-soft)' : 'var(--green)' }}>{copyStatus}</span>}
          </footer>
        </section>
      </div>
    </>
  );
}
