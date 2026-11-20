import { createRootRoute, Outlet, useLocation } from '@tanstack/react-router';
import { useLayoutEffect } from 'react';
import { markLibraryOpened } from '~/api/desktop';
import { Shell } from '~/components/shell';

export const Route = createRootRoute({
  component: Root,
  notFoundComponent: () => (
    <div className="p-6 text-ink-dim">Nothing here. Try the boards list.</div>
  ),
});

function Root() {
  const pathname = useLocation({ select: (location) => location.pathname });
  useLayoutEffect(() => {
    if (pathname !== '/settings') markLibraryOpened();
  }, [pathname]);

  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}
