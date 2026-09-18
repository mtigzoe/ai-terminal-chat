import { describe, it, expect, beforeEach } from "vitest";
import { clear, createPending, getPending, popPending } from "../src/pending.ts";

describe("pending", () => {
  beforeEach(() => {
    clear();
  });

  it("round-trips a pending action", () => {
    const action = createPending("write_file", { path: "app.py" }, { requires_confirmation: true, diff: "+change" });

    const stored = getPending(action.action_id);
    expect(stored).not.toBeNull();
    expect(stored!.tool_name).toBe("write_file");
    expect(stored!.args).toEqual({ path: "app.py" });
    expect(stored!.preview.requires_confirmation).toBe(true);

    const consumed = popPending(action.action_id);
    expect(consumed!.action_id).toBe(action.action_id);
    expect(getPending(action.action_id)).toBeUndefined();
    expect(popPending(action.action_id)).toBeUndefined();
  });

  it("getPending returns undefined for unknown id", () => {
    expect(getPending("missing")).toBeUndefined();
  });

  it("popPending returns undefined for unknown id", () => {
    expect(popPending("missing")).toBeUndefined();
  });

  it("clear removes all pending actions", () => {
    createPending("tool-a", { x: 1 }, {});
    createPending("tool-b", { y: 2 }, {});
    clear();
    expect(getPending("tool-a")).toBeUndefined();
    expect(getPending("tool-b")).toBeUndefined();
  });
  it("invalidates create_file confirmation when the target appears", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { getProjectRoot } = await import("../src/security.ts");
    const rel = "__pending_create_file_test__.txt";
    const abs = path.join(getProjectRoot(), rel);
    try {
      fs.rmSync(abs, { force: true });
      const action = createPending("create_file", { path: rel }, { requires_confirmation: true });
      fs.writeFileSync(abs, "created elsewhere", "utf8");
      expect(popPending(action.action_id)).toBeUndefined();
    } finally {
      fs.rmSync(abs, { force: true });
    }
  });

});
