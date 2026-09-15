'use client';

/**
 * True below the phone breakpoint (767px). Structural layout switches (the assistant becoming a
 * full-screen sheet, the header compacting) read this; purely visual stacking is done in CSS with
 * the `m-*` utility classes in globals.css so inline grids can be overridden without JS.
 * Server render and the first client paint report false, so desktop markup hydrates unchanged.
 */
import { useSyncExternalStore } from 'react';

const QUERY = '(max-width: 767px)';

function subscribe(cb: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false);
}
