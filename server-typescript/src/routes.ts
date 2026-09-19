    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    cancelSignal?.removeEventListener("abort", onParentAbort);
  }
}

app.post("/confirm", async (c) => {
  let data: Record<string, unknown> = {};
  try {
    data = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400 as any);
  }

  const actionId = String(data.action_id || "").trim();
  const confirmed = data.confirmed === true;
  const requestId = String(data.request_id || crypto.randomUUID());

  if (!actionId) {
    return c.json({ error: "action_id is required." }, 400 as any);
  }

  // Register cancellation before consuming the pending action. Otherwise a
  // duplicate request ID can make register() throw after popPending() has
  // already removed a valid confirmation, losing the action permanently.
  let cancelSignal: AbortSignal;
  try {
    cancelSignal = register(requestId);
  } catch (error) {
    return c.json({ error: String(error) }, 409 as any);
  }
  const onRequestAbort = () => cancel(requestId);
  c.req.raw.signal.addEventListener("abort", onRequestAbort, { once: true });

  const action = popPending(actionId);
  if (!action) {
    c.req.raw.signal.removeEventListener("abort", onRequestAbort);
    release(requestId, cancelSignal);
    return c.json({ error: "Pending action not found or already resolved." }, 404 as any);
  }

  if (!CONFIRMABLE_TOOL_NAMES.has(action.tool_name)) {
    c.req.raw.signal.removeEventListener("abort", onRequestAbort);
    release(requestId, cancelSignal);
    return c.json({ error: "Only pending write actions can be confirmed." }, 400 as any);
  }

  const provider = getActiveProvider();

  const canResume =
    action.resume !== undefined &&
    action.resume.provider_fingerprint === providerFingerprint(provider);

  if (!canResume) {
    try {
      const { status, body } = await confirmLegacy(action, actionId, confirmed, cancelSignal);
      return c.json(body, status as any);
    } finally {
      c.req.raw.signal.removeEventListener("abort", onRequestAbort);
      release(requestId, cancelSignal);
    }
  }

  const baseResponse: Record<string, unknown> = {
    confirmed,
    action_id: actionId,
    tool: action.tool_name,
  };
  if (action.tool_name === "read_file_permission") {
    baseResponse.permission_granted = confirmed;
    baseResponse.path = action.args.path;
  }

  const toolActivity: AgentEvent[] = [];
  let finalText = "";
  let errorMessage: string | null = null;
  let cancelled = false;
  let nextPending: PendingConfirmationEvent | null = null;
  let resultCaptured = false;
  let allowedPaths = extractAllowedPaths(data);
  if (
    action.tool_name === "read_file_permission" &&
    confirmed &&
    typeof action.args.path === "string"
  ) {