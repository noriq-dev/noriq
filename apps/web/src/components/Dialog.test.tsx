// PLNR-175: the dialog singleton must resolve its promise on the user's choice (and never
// hang), since call sites gate real mutations on `await confirm(...)`.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { alert, confirm, DialogHost, prompt } from './Dialog';

let container: HTMLDivElement;
function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => createRoot(container).render(<DialogHost />));
}
afterEach(() => container?.remove());

const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label);

describe('Dialog singleton (PLNR-175)', () => {
  it('confirm resolves true on the confirm button, false on cancel', async () => {
    mount();
    let a: boolean | undefined;
    act(() => void confirm('Delete it?').then((v) => (a = v)));
    await act(async () => button('Confirm')!.click());
    expect(a).toBe(true);

    let b: boolean | undefined;
    act(() => void confirm('Delete it?').then((v) => (b = v)));
    await act(async () => button('Cancel')!.click());
    expect(b).toBe(false);
  });

  it('prompt returns its value on OK (seeded default, then edited) and null on cancel', async () => {
    mount();
    // OK with the seeded default returns it unchanged.
    let seeded: string | null | undefined;
    act(() => void prompt('Board name?', 'seed').then((v) => (seeded = v)));
    await act(async () => button('OK')!.click());
    expect(seeded).toBe('seed');

    // Editing the controlled input (via React's tracked value setter) is reflected on OK.
    let edited: string | null | undefined;
    act(() => void prompt('Board name?', 'seed').then((v) => (edited = v)));
    const input = container.querySelector('input')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, 'ship it');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('OK')!.click());
    expect(edited).toBe('ship it');

    let cancelled: string | null | undefined = 'unset';
    act(() => void prompt('Board name?').then((v) => (cancelled = v)));
    await act(async () => button('Cancel')!.click());
    expect(cancelled).toBeNull();
  });

  it('a destructive-sounding confirm gets the danger (red-bordered) button', async () => {
    mount();
    act(() => void confirm('Delete the board?'));
    expect(button('Confirm')!.style.border).toContain('255, 92, 92');
    await act(async () => button('Cancel')!.click());
  });
});
