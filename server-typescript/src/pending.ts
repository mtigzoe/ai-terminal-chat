export interface PendingAction {
  action_id: string;
  tool_name: string;
  args: Record<string, unknown>;
  preview: Record<string, unknown>;
}

const MAX_PENDING_ACTIONS = 100;
const _PENDING = new Map<string, PendingAction>();

export function createPending(
  toolName: string,
  args: Record<string, unknown>,
  preview: Record<string, unknown>
): PendingAction {
  const action: PendingAction = {
    action_id: crypto.randomUUID(),
    tool_name: toolName,
    args: { ...args },
    preview: { ...preview },
  };

  if (_PENDING.size >= MAX_PENDING_ACTIONS) {
    const oldestId = _PENDING.keys().next().value!;
    _PENDING.delete(oldestId);
  }

  _PENDING.set(action.action_id, action);
  return action;
}

export function getPending(actionId: string): PendingAction | undefined {
  return _PENDING.get(actionId);
}

export function popPending(actionId: string): PendingAction | undefined {
  const action = _PENDING.get(actionId);
  if (action) {
    _PENDING.delete(actionId);
  }
  return action;
}

export function clear(): void {
  _PENDING.clear();
}
