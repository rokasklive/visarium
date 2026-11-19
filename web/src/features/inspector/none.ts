/**
 * What a production build gets for `./load`: no inspector. Aliased in by
 * vite.config.ts because a dynamic import in dead code is still emitted as a
 * chunk by the bundler; only taking it out of the graph keeps it out of dist.
 */
import type { ComponentType } from 'react';
import type { InspectorProps } from './inspector';

export const Inspector: ComponentType<InspectorProps> | null = null;
