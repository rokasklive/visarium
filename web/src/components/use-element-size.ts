import { useEffect, useRef, useState } from 'react';

/**
 * Element size via ResizeObserver.
 *
 * The canvas needs its pixel size to compute the visible world rect, and it must
 * not read layout during a pointer move. ResizeObserver pushes the size instead.
 */
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ width: Math.round(width), height: Math.round(height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, size };
}
