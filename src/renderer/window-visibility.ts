import type { Result, WindowVisibility } from '../shared/contracts.js';

/**
 * A visibility query is only authoritative when no notification for the same
 * epoch arrived while the query was in flight.
 */
export function acceptsVisibilityQuery(
  result: Result<WindowVisibility>,
  epoch: number,
  requestedVersion: number,
  currentVersion: number,
) {
  return result.ok && result.value.windowEpoch === epoch && requestedVersion === currentVersion;
}
