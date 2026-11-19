/**
 * `@plantuml/core` ships JavaScript only. Its documented surface is two
 * functions (README, "API"); this declares exactly those.
 */
declare module '@plantuml/core' {
  /** Renders into the element with this id, asynchronously. Renders must not overlap. */
  export function render(lines: string[], targetId: string, options?: { dark?: boolean }): void;
  export function renderToString(
    lines: string[],
    onSuccess: (svg: string) => void,
    onError: (message: string) => void,
  ): void;
}
