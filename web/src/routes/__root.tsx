import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Shell } from '~/components/shell';

export const Route = createRootRoute({
  component: () => (
    <Shell>
      <Outlet />
    </Shell>
  ),
  notFoundComponent: () => (
    <div className="p-6 text-ink-dim">Nothing here. Try the boards list.</div>
  ),
});
