// PLNR-175: in-app replacements for window.confirm / window.prompt / window.alert.
// The native dialogs are ugly, un-themable, and break the app's look. These mirror the
// native signatures (so call sites just add `await`) but render the app's own Modal.
//
// A module-level singleton — like the globals it replaces — so any component can call
// `confirm()` / `prompt()` / `alert()` without threading a hook or the store. <DialogHost/>
// is mounted once at the app root and registers itself here. One dialog at a time (a user
// can only answer one anyway), matching native modality.
import { useEffect, useRef, useState } from 'react';
import { Button, Modal, TextInput } from './ui';

type Request =
  | { kind: 'confirm'; message: string; title: string; danger: boolean; confirmLabel: string; resolve: (v: boolean) => void }
  | { kind: 'prompt'; message: string; title: string; defaultValue: string; placeholder?: string; resolve: (v: string | null) => void }
  | { kind: 'alert'; message: string; title: string; resolve: () => void };

let open: ((r: Request) => void) | null = null;

// Destructive-sounding confirms get the red button automatically, so call sites stay a
// bare `confirm(message)`; pass { danger: false } to opt out.
const DESTRUCTIVE = /\b(delete|remove|revoke|reject|kill|discard|stop|archive|reset|offboard|permanently)\b/i;

export function confirm(
  message: string,
  opts: { title?: string; danger?: boolean; confirmLabel?: string } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!open) return resolve(false);
    open({
      kind: 'confirm', message, resolve,
      title: opts.title ?? 'Confirm',
      danger: opts.danger ?? DESTRUCTIVE.test(message),
      confirmLabel: opts.confirmLabel ?? 'Confirm',
    });
  });
}

export function prompt(
  message: string,
  defaultValue = '',
  opts: { title?: string; placeholder?: string } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    if (!open) return resolve(null);
    open({ kind: 'prompt', message, defaultValue, resolve, title: opts.title ?? 'Enter a value', placeholder: opts.placeholder });
  });
}

export function alert(message: string, opts: { title?: string } = {}): Promise<void> {
  return new Promise((resolve) => {
    if (!open) return resolve();
    open({ kind: 'alert', message, resolve, title: opts.title ?? 'Heads up' });
  });
}

export function DialogHost() {
  const [req, setReq] = useState<Request | null>(null);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    open = (r) => {
      if (r.kind === 'prompt') setValue(r.defaultValue);
      setReq(r);
    };
    return () => { open = null; };
  }, []);

  useEffect(() => {
    if (req?.kind === 'prompt') {
      const el = inputRef.current;
      if (el) { el.focus(); el.select(); }
    }
  }, [req]);

  if (!req) return null;

  // Settle the promise, then close. Every path routes through here so a dialog never
  // resolves twice or leaves the promise dangling.
  const settle = (fn: () => void) => { fn(); setReq(null); };
  const cancel = () => settle(() => {
    if (req.kind === 'confirm') req.resolve(false);
    else if (req.kind === 'prompt') req.resolve(null);
    else req.resolve();
  });
  const accept = () => settle(() => {
    if (req.kind === 'confirm') req.resolve(true);
    else if (req.kind === 'prompt') req.resolve(value);
    else req.resolve();
  });

  return (
    <Modal title={req.title} onClose={cancel} width={420}>
      <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-soft)', whiteSpace: 'pre-wrap' }}>{req.message}</div>
      {req.kind === 'prompt' && (
        <div style={{ marginTop: 14 }}>
          <TextInput
            ref={inputRef}
            value={value}
            placeholder={req.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); accept(); }
            }}
          />
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
        {req.kind !== 'alert' && <Button variant="ghost" onClick={cancel}>Cancel</Button>}
        <Button
          variant={req.kind === 'confirm' && req.danger ? 'danger' : 'primary'}
          onClick={accept}
        >
          {req.kind === 'confirm' ? req.confirmLabel : req.kind === 'prompt' ? 'OK' : 'Got it'}
        </Button>
      </div>
    </Modal>
  );
}
