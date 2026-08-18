const MAX_TRACKED_REQUESTS = 200;
const _EVENTS = new Map<string, AbortController>();

export function register(requestId: string): AbortSignal {
  const controller = new AbortController();
  if (_EVENTS.size >= MAX_TRACKED_REQUESTS) {
    const oldestId = _EVENTS.keys().next().value!;
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

export function release(requestId: string): void {
  if (!requestId) return;
  _EVENTS.delete(requestId);
}

export function clear(): void {
  _EVENTS.clear();
}
