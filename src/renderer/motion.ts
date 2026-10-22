import { useSyncExternalStore } from 'react';

type MotionMode = 'dynamic' | 'static' | 'off';

let reducedMotionQuery: MediaQueryList | null | undefined;
const reducedMotionListeners = new Set<() => void>();
let performanceProtected = false;
const performanceProtectionListeners = new Set<() => void>();

function getReducedMotionQuery() {
  if (reducedMotionQuery !== undefined) return reducedMotionQuery;
  reducedMotionQuery = typeof window === 'undefined' ? null : window.matchMedia('(prefers-reduced-motion: reduce)');
  return reducedMotionQuery;
}

function notifyReducedMotion() {
  reducedMotionListeners.forEach((listener) => listener());
}

function subscribeReducedMotion(listener: () => void) {
  const query = getReducedMotionQuery();
  reducedMotionListeners.add(listener);
  if (reducedMotionListeners.size === 1) query?.addEventListener('change', notifyReducedMotion);
  return () => {
    reducedMotionListeners.delete(listener);
    if (!reducedMotionListeners.size) query?.removeEventListener('change', notifyReducedMotion);
  };
}

function getReducedMotionSnapshot() {
  return getReducedMotionQuery()?.matches ?? false;
}

function subscribePerformanceProtection(listener: () => void) {
  performanceProtectionListeners.add(listener);
  return () => performanceProtectionListeners.delete(listener);
}

function getPerformanceProtectionSnapshot() {
  return performanceProtected;
}

export function useSystemReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion, getReducedMotionSnapshot, () => false);
}

export function usePerformanceProtected() {
  return useSyncExternalStore(subscribePerformanceProtection, getPerformanceProtectionSnapshot, () => false);
}

export function isPerformanceProtected() {
  return performanceProtected;
}

export function setPerformanceProtected(next: boolean) {
  if (performanceProtected === next) return;
  performanceProtected = next;
  performanceProtectionListeners.forEach((listener) => listener());
}

export function motionEnabled(mode: MotionMode, userReducedMotion: boolean, systemReducedMotion: boolean, protectedSession = false) {
  return mode === 'dynamic' && !userReducedMotion && !systemReducedMotion && !protectedSession;
}

export function visibleElapsedDelta(deltaMs: number) {
  return deltaMs < 0 || deltaMs > 1_000 ? 0 : deltaMs;
}
