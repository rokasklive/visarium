/**
 * The inspector, loaded on first open. Dev builds resolve this module;
 * a production build resolves `none.ts` in its place (vite.config.ts), so
 * the inspector is not in its module graph at all.
 */
import { type ComponentType, lazy } from 'react';
import type { InspectorProps } from './inspector';

export const Inspector: ComponentType<InspectorProps> | null = lazy(() => import('./inspector'));
