import { vi } from "vitest";

const { originalGlobalFetch } = vi.hoisted(() => ({
  originalGlobalFetch: globalThis.fetch,
}));

vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");

  return {
    ...actual,
    fetch: (...args: Parameters<typeof actual.fetch>) => {
      const currentGlobalFetch = globalThis.fetch;
      if (currentGlobalFetch !== originalGlobalFetch) {
        return currentGlobalFetch(...args);
      }
      return actual.fetch(...args);
    },
  };
});
