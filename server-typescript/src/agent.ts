  cancelSignal?: AbortSignal
): Promise<unknown> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (cancelSignal?.aborted) controller.abort();
  else cancelSignal?.addEventListener("abort", onParentAbort, { once: true });
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(
        new Error(
          `Tool ${name} exceeded its ${timeoutSeconds}s execution limit and was abandoned.`
        )
      );
    }, timeoutSeconds * 1000);
  });
  try {
    return await Promise.race([
      Promise.resolve(fn(args, controller.signal)),
      timeoutPromise,
    ]);
  } catch (exc) {
    if (cancelSignal?.aborted) {
      return { error: `Tool ${name} cancelled.` };
    }
    if (
      exc instanceof Error &&
      exc.message.includes("exceeded its") &&
      exc.message.includes("execution limit")
    ) {
      return { error: exc.message };
    }
    if (exc instanceof TypeError) {
      return { error: `Malformed arguments for ${name}: ${exc}` };
    }
    return { error: `Tool ${name} failed: ${exc}` };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    cancelSignal?.removeEventListener("abort", onParentAbort);
  }
}

function describeToolProgress(
  functionName: string,
  functionArgs: Record<string, unknown>