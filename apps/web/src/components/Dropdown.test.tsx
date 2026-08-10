import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dropdown, type DropdownOption } from './Dropdown';
import { Field, Select } from './ui';

let container: HTMLDivElement;
let root: Root | null = null;

function render(node: ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

function key(target: Element, value: string) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
});

describe('Dropdown', () => {
  it('exposes a labelled listbox, marks the selection, and commits pointer choices', () => {
    const onChange = vi.fn();
    render(<Dropdown
      label="Review gate"
      value="approved"
      options={[
        { value: 'approved', label: 'Approved', description: 'Wait for sign-off' },
        { value: 'landed', label: 'Landed', description: 'Continue after merge' },
      ]}
      onChange={onChange}
    />);

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Review gate"]')!;
    expect(trigger.textContent).toContain('Approved');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    act(() => trigger.click());
    const listbox = container.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(listbox.getAttribute('aria-label')).toBe('Review gate');
    expect(listbox.querySelector('[aria-selected="true"]')?.textContent).toContain('Approved');

    const landed = [...listbox.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent?.includes('Landed'))!;
    act(() => landed.click());
    expect(onChange).toHaveBeenCalledWith('landed');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('supports keyboard navigation and skips disabled options', () => {
    const onChange = vi.fn();
    render(<Dropdown
      label="Destination"
      value="alpha"
      options={[
        { value: 'alpha', label: 'Alpha' },
        { value: 'beta', label: 'Beta', disabled: true },
        { value: 'gamma', label: 'Gamma' },
      ]}
      onChange={onChange}
    />);

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Destination"]')!;
    act(() => key(trigger, 'ArrowDown'));
    const listbox = container.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(document.activeElement).toBe(listbox);

    act(() => key(listbox, 'ArrowDown'));
    expect(listbox.getAttribute('aria-activedescendant')).toMatch(/-2$/);
    act(() => key(listbox, 'Enter'));
    expect(onChange).toHaveBeenCalledWith('gamma');
  });

  it('filters long menus and clears the query after an outside dismissal', () => {
    const options: DropdownOption[] = Array.from({ length: 8 }, (_, index) => ({
      value: `item-${index}`,
      label: index === 6 ? 'Target option' : `Choice ${index}`,
      mono: index === 6 ? 'mdl_target' : undefined,
    }));
    render(<Dropdown label="Model" value={null} options={options} onChange={() => {}} />);

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Model"]')!;
    act(() => trigger.click());
    const filter = container.querySelector<HTMLInputElement>('[aria-label="Filter Model"]')!;
    expect(document.activeElement).toBe(filter);

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(filter, 'mdl_target');
      filter.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(container.querySelector('[role="option"]')?.textContent).toContain('Target option');

    act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    act(() => trigger.click());
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(8);
  });

  it('keeps empty and invalid states understandable', () => {
    render(<Dropdown label="Runner" value={null} options={[]} onChange={() => {}} invalid="Pick a runner" emptyNote="No runners online." />);

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Runner"]')!;
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(trigger.getAttribute('aria-describedby')!)?.textContent).toBe('Pick a runner');
    act(() => trigger.click());
    expect(container.textContent).toContain('No runners online.');
  });

  it('backs the existing Select API with the same Dropdown behavior', () => {
    const onChange = vi.fn();
    render(
      <Field label="Team">
        <Select value="design" onChange={onChange}>
          <optgroup label="Product">
            <option value="design">Design</option>
            <option value="research" disabled>Research</option>
          </optgroup>
          <option value="engineering">Engineering</option>
        </Select>
      </Field>,
    );

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Team"]')!;
    act(() => trigger.click());
    expect(container.querySelector('[role="listbox"]')?.textContent).toContain('Product');
    const engineering = [...container.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent?.includes('Engineering'))!;
    act(() => engineering.click());
    expect(onChange.mock.calls[0]?.[0].target.value).toBe('engineering');
  });
});
