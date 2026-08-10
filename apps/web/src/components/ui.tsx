// Shared UI kit: modal + form primitives, in the design language.
import {
  Children, Fragment, createContext, forwardRef, isValidElement, useContext, useEffect, useMemo, useState,
  type ChangeEvent, type CSSProperties, type ReactNode, type SelectHTMLAttributes,
} from 'react';
import { Dropdown, type DropdownOption, type DropdownVariant } from './Dropdown';

export function Modal({ title, subtitle, onClose, children, width = 420 }: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 50, backdropFilter: 'blur(2px)' }} />
      <div
        style={{
          position: 'fixed', inset: 0, zIndex: 51,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
      <div
        style={{
          width,
          maxWidth: 'calc(100vw - 40px)',
          maxHeight: 'calc(100vh - 80px)',
          overflowY: 'auto',
          background: 'var(--bg-raised)',
          border: '1px solid var(--w-12)',
          borderRadius: 16,
          padding: 24,
          boxShadow: '0 30px 80px rgba(0,0,0,.6)',
          animation: 'pl-stream .25s ease both',
          pointerEvents: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-.01em' }}>{title}</div>
            {subtitle && <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)', marginTop: 3 }}>{subtitle}</div>}
          </div>
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            className="drawer-x"
            style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 17, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6 }}
          >
            ✕
          </button>
        </div>
        {children}
      </div>
      </div>
    </>
  );
}

const inputStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  background: 'var(--w-05)',
  border: '1px solid var(--w-1)',
  borderRadius: 9,
  padding: '9px 12px',
  color: 'var(--text)',
  fontSize: 13,
  outline: 'none',
  fontFamily: 'inherit',
};

const FieldLabelContext = createContext<string | null>(null);

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--text-dim)' }}>{label}</span>
        {hint && <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{hint}</span>}
      </div>
      <FieldLabelContext.Provider value={label}>{children}</FieldLabelContext.Provider>
    </label>
  );
}

export const TextInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  (props, ref) => <input ref={ref} {...props} style={{ ...inputStyle, ...props.style }} />,
);
TextInput.displayName = 'TextInput';

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} style={{ ...inputStyle, minHeight: 74, resize: 'vertical', ...props.style }} />;
}

interface SelectOptionElementProps {
  value?: string | number;
  disabled?: boolean;
  title?: string;
  label?: string;
  children?: ReactNode;
}

function optionText(node: ReactNode): string {
  return Children.toArray(node).map((child) => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    return isValidElement<SelectOptionElementProps>(child) ? optionText(child.props.children) : '';
  }).join('');
}

function dropdownOptions(children: ReactNode, section?: string): DropdownOption[] {
  const options: DropdownOption[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<SelectOptionElementProps>(child)) return;
    if (child.type === Fragment) {
      options.push(...dropdownOptions(child.props.children, section));
      return;
    }
    if (child.type === 'optgroup') {
      options.push(...dropdownOptions(child.props.children, child.props.label ?? section));
      return;
    }
    if (child.type !== 'option') return;
    const label = optionText(child.props.children) || child.props.label || String(child.props.value ?? '');
    options.push({
      value: String(child.props.value ?? label),
      label,
      description: child.props.title,
      disabled: child.props.disabled,
      section,
    });
  });
  return options;
}

function normalizedSelectValue(value: SelectHTMLAttributes<HTMLSelectElement>['value']): string {
  if (Array.isArray(value)) return String(value[0] ?? '');
  return value == null ? '' : String(value);
}

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'multiple' | 'size'> & {
  variant?: DropdownVariant;
  menuWidth?: CSSProperties['width'];
  placeholder?: string;
  invalid?: string;
};

/** Native-select-compatible adapter. Dropdown owns every visible selection surface. */
export function Select({
  children, value, defaultValue, onChange, disabled, style, title, autoFocus,
  variant: requestedVariant, menuWidth, placeholder, invalid, ...props
}: SelectProps) {
  const fieldLabel = useContext(FieldLabelContext);
  const controlled = value !== undefined;
  const [internalValue, setInternalValue] = useState(() => normalizedSelectValue(defaultValue));
  const options = useMemo(() => dropdownOptions(children), [children]);
  const selectedValue = controlled ? normalizedSelectValue(value) : internalValue;
  const variant = requestedVariant ?? (fieldLabel ? 'field' : 'micro');
  const label = props['aria-label'] ?? title ?? fieldLabel ?? 'Select an option';
  const {
    width, minWidth, maxWidth, flex, flexBasis, flexGrow, flexShrink, alignSelf,
    margin, marginBlock, marginBlockEnd, marginBlockStart, marginBottom, marginInline,
    marginInlineEnd, marginInlineStart, marginLeft, marginRight, marginTop,
    ...triggerStyle
  } = style ?? {};
  const containerStyle: CSSProperties = {
    width: width ?? (variant === 'field' ? '100%' : undefined),
    minWidth, maxWidth, flex, flexBasis, flexGrow, flexShrink, alignSelf,
    margin, marginBlock, marginBlockEnd, marginBlockStart, marginBottom, marginInline,
    marginInlineEnd, marginInlineStart, marginLeft, marginRight, marginTop,
  };

  const emitChange = (nextValue: string) => {
    if (!controlled) setInternalValue(nextValue);
    if (!onChange) return;
    const target = { value: nextValue } as HTMLSelectElement;
    onChange({ target, currentTarget: target } as ChangeEvent<HTMLSelectElement>);
  };

  return (
    <Dropdown
      value={selectedValue}
      options={options}
      onChange={emitChange}
      variant={variant}
      label={label}
      placeholder={placeholder}
      disabled={disabled}
      invalid={invalid}
      menuWidth={menuWidth}
      containerStyle={containerStyle}
      triggerStyle={{ ...triggerStyle, width: '100%' }}
      title={title}
      autoFocus={autoFocus}
    />
  );
}

export function Button({ variant = 'primary', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const styles: Record<string, CSSProperties> = {
    primary: { background: 'var(--accent)', color: 'var(--bg)', border: '1px solid transparent' },
    ghost: { background: 'var(--w-05)', color: 'var(--text)', border: '1px solid var(--w-12)' },
    danger: { background: 'transparent', color: 'var(--red-soft)', border: '1px solid rgba(255,92,92,.4)' },
  };
  return (
    <button
      {...props}
      className="hover-bright"
      style={{
        cursor: props.disabled ? 'default' : 'pointer',
        opacity: props.disabled ? 0.5 : 1,
        fontWeight: 600,
        fontSize: 12.5,
        padding: '9px 16px',
        borderRadius: 9,
        textAlign: 'center',
        ...styles[variant],
        ...props.style,
      }}
    />
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red-soft)', marginBottom: 10 }}>{String(children)}</div>;
}
