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
