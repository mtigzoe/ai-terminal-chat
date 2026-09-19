const MAX_TRACKED_REQUESTS = 200;
const _EVENTS = new Map<string, AbortController>();

export function register(requestId: string): AbortSignal {
  if (_EVENTS.has(requestId)) {
    throw new Error(`Request ID is already in use: ${requestId}`);
  }

  const controller = new AbortController();
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
  if (!controller) return false;
  controller.abort();
  return true;
}

/**
 * Connect an HTTP request's lifetime to the registered cancellation signal.
 * Returns a cleanup function that removes the listener.
 */
export function bindRequestCancellation(
  requestSignal: AbortSignal,
  requestId: string,
): () => void {
  const onAbort = () => {
    cancel(requestId);
  };

  if (requestSignal.aborted) {
    onAbort();
  } else {
    requestSignal.addEventListener("abort", onAbort, { once: true });
  }

  return () => {
    requestSignal.removeEventListener("abort", onAbort);
  };
}

export function release(requestId: string, signal?: AbortSignal): void {
  if (!requestId) return;
  const controller = _EVENTS.get(requestId);
  if (!controller) return;
  // A request can outlive the registry entry when the 200-request cap evicts
  // it. If the same request ID is subsequently reused, an unconditional
  // delete from the old request's finally block would remove the newer
  // request's cancellation controller.
  if (signal && controller.signal !== signal) return;
  _EVENTS.delete(requestId);
}

export function clear(): void {
  for (const controller of _EVENTS.values()) {
    controller.abort();
  }
  _EVENTS.clear();
}
