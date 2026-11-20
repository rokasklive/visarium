import { useState } from 'react';
import { copyText } from '~/api/desktop';

/**
 * The parts Settings and Instance Settings are made of. A document page: 24px
 * spacing, three type sizes, one radius, ghost buttons and no filled control,
 * because nothing on a settings page is urgent.
 */

export function SectionHeading({ children }: { children: string }) {
  return <h2 className="mb-3 text-[11px] uppercase tracking-wide text-ink-dim">{children}</h2>;
}

export function TextField({
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password';
  autoComplete: string;
}) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-ink-dim">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        className="w-full max-w-[320px] rounded-sm border border-line bg-surface-raised px-2 py-1 text-ink placeholder:text-ink-disabled"
      />
    </label>
  );
}

export function GhostButton({
  children,
  disabled,
  onClick,
  type = 'button',
  label,
}: {
  children: string;
  disabled?: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit';
  label?: string;
}) {
  return (
    <button
      type={type === 'submit' ? 'submit' : 'button'}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="rounded-sm border border-line px-2 py-0.5 text-ink-dim hover:bg-surface-raised hover:text-ink disabled:text-ink-disabled"
    >
      {children}
    </button>
  );
}

export function CopyField({
  label,
  value,
  testId,
  lines,
}: {
  label: string;
  value: string;
  testId: string;
  /** A multi-line value gets a text area this many lines tall. */
  lines?: number;
}) {
  const [copied, setCopied] = useState(false);
  const field =
    'w-full min-w-0 rounded-sm border border-line bg-surface-raised px-2 py-1 font-mono text-[11px] text-ink';
  return (
    <div className="mb-3">
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-ink-dim">{label}</span>
      <div className="flex items-start gap-2">
        {lines ? (
          <textarea
            readOnly
            value={value}
            rows={lines}
            aria-label={label}
            data-testid={testId}
            onFocus={(e) => e.target.select()}
            className={`${field} resize-none`}
          />
        ) : (
          <input
            readOnly
            value={value}
            aria-label={label}
            data-testid={testId}
            onFocus={(e) => e.target.select()}
            className={field}
          />
        )}
        <GhostButton
          label={`Copy ${label}`}
          onClick={() => void copyText(value).then((ok) => setCopied(ok))}
        >
          {copied ? 'copied' : 'copy'}
        </GhostButton>
      </div>
    </div>
  );
}
