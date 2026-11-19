import { type ReactNode, useState } from 'react';

/**
 * A button that asks first, in place.
 *
 * Not `window.confirm`: the desktop app's webview (wry on macOS) implements no
 * JavaScript dialogs, so there `confirm()` returns false without showing
 * anything and the act behind it silently never happens. The question is
 * asked here instead, the same in a browser and on the desktop: the button
 * becomes the question with "yes" and "cancel"; Escape cancels.
 */
export function ConfirmButton({
  question,
  onConfirm,
  children,
  className,
  label,
  disabled,
}: {
  question: string;
  onConfirm: () => void;
  children: ReactNode;
  className?: string;
  label?: string;
  disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={() => setAsking(true)}
        className={className}
      >
        {children}
      </button>
    );
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: an inline question, not a fieldset of form controls
    <span
      role="group"
      aria-label={question}
      className="inline-flex flex-wrap items-baseline gap-x-2 text-ink"
      onKeyDown={(e) => {
        if (e.key === 'Escape') setAsking(false);
      }}
    >
      <span>{question}</span>
      <button
        type="button"
        // biome-ignore lint/a11y/noAutofocus: the person just asked for this question; focus belongs on its answer
        autoFocus
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
        className="text-ink underline-offset-2 hover:underline"
      >
        yes
      </button>
      <button
        type="button"
        onClick={() => setAsking(false)}
        className="text-ink-dim hover:text-ink"
      >
        cancel
      </button>
    </span>
  );
}
