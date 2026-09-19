const MAX_TRACKED_REQUESTS = 200;
const _EVENTS = new Map<string, AbortController>();
// A cancel request can arrive before the request handler has registered its
// request ID. Keep a bounded cancellation intent so that race is still
// observed when register() runs.
const _PENDING_CANCELLATIONS = new Set<string>();

export function register(requestId: string): AbortSignal {
  if (_EVENTS.has(requestId)) {
    throw new Error(`Request ID is already in use: ${requestId}`);
  }

  const controller = new AbortController();
  if (_PENDING_CANCELLATIONS.delete(requestId)) controller.abort();
  if (_EVENTS.size >= MAX_TRACKED_REQUESTS) {
    const oldestId = _EVENTS.keys().next().value!;
    const oldestController = _EVENTS.get(oldestId);
    oldestController?.abort();
    _EVENTS.delete(oldestId);
  }
  _EVENTS.set(requestId, controller);
  return controller.signal;
}

export function cancel(requestId: string): boolean {
  const controller = _EVENTS.get(requestId);
  if (!controller) {
    if (_PENDING_CANCELLATIONS.size >= MAX_TRACKED_REQUESTS) {
      const oldest = _PENDING_CANCELLATIONS.values().next().value;
      if (oldest) _PENDING_CANCELLATIONS.delete(oldest);
    }
    _PENDING_CANCELLATIONS.add(requestId);
    return true;
  }
  controller.abort();
  return true;
}

export function bindRequestCancellation(
  requestSignal: AbortSignal,
  requestId: string,
  registeredSignal?: AbortSignal,
): () => void {
  const onAbort = () => {
    // An evicted request can outlive its registry entry. If its HTTP
    // connection aborts later, it must not cancel a newer request reusing
    // the same request ID.
    if (registeredSignal) {
      const current = _EVENTS.get(requestId);
      if (!current || current.signal !== registeredSignal) return;
    }
    cancel(requestId);
  };

  if (requestSignal.aborted) onAbort();
  else requestSignal.addEventListener("abort", onAbort, { once: true });

  return () => requestSignal.removeEventListener("abort", onAbort);
}

export function release(requestId: string, signal?: AbortSignal): void {
  if (!requestId) return;
  const controller = _EVENTS.get(requestId);
  if (!controller) return;
  // Never let an evicted request release a newer request that reused its ID.
  if (signal && controller.signal !== signal) return;
  _EVENTS.delete(requestId);
}

export function clear(): void {
  for (const controller of _EVENTS.values()) controller.abort();
  _EVENTS.clear();
  _PENDING_CANCELLATIONS.clear();
}
