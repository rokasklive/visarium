import { useQuery } from '@tanstack/react-query';

/**
 * The end-to-end wiring check: browser → Vite proxy → server → back.
 *
 * It deliberately uses plain `fetch` rather than the generated client, because
 * the health probe is not part of the product API surface. Product endpoints go through
 * `@visarium/api-client`.
 */
export interface HealthStatus {
  status: 'UP' | 'DOWN' | string;
}

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: async (): Promise<HealthStatus> => {
      const response = await fetch('/health', { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Health check failed: ${response.status}`);
      return (await response.json()) as HealthStatus;
    },
    refetchInterval: 30_000,
    retry: false,
  });
}
