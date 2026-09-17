import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  __setProjectRootForTests,
  __resetProjectRootForTests,
} from "./security.ts";
import { clear, createPending, getPending, popPending } from "./pending.ts";

const projects: string[] = [];

afterEach(() => {
  clear();
  __resetProjectRootForTests();
  for (const project of projects.splice(0)) {
    rmSync(project, { recursive: true, force: true });
  }
});

function makeProject(): string {
  const project = mkdtempSync(join(tmpdir(), "pending-file-state-"));
  projects.push(project);
  __setProjectRootForTests(project);
  return project;
}

test("write_file pending action is invalidated when the target changes", () => {
  const project = makeProject();
  const target = join(project, "example.txt");
  writeFileSync(target, "original\n", "utf8");

  const action = createPending(
    "write_file",
    { path: "example.txt", contents: "replacement\n" },
    { requires_confirmation: true },
  );
  writeFileSync(target, "changed by another process\n", "utf8");

  assert.equal(popPending(action.action_id), undefined);
  assert.equal(getPending(action.action_id), undefined);
});

test("write_file pending action remains confirmable when the target is unchanged", () => {
  makeProject();
  const target = join(projects[0]!, "example.txt");
  writeFileSync(target, "original\n", "utf8");

  const action = createPending(
    "write_file",
    { path: "example.txt", contents: "replacement\n" },
    { requires_confirmation: true },
  );

  assert.equal(popPending(action.action_id)?.action_id, action.action_id);
});

test("delete_file pending action is invalidated when the target disappears", () => {
  const project = makeProject();
  const target = join(project, "delete-me.txt");
  writeFileSync(target, "original\n", "utf8");

  const action = createPending(
    "delete_file",
    { path: "delete-me.txt" },
    { requires_confirmation: true },
  );
  rmSync(target);

  assert.equal(popPending(action.action_id), undefined);
});

test("delete_file can bind a binary target without decoding it as UTF-8", () => {
  const project = makeProject();
  const target = join(project, "binary.bin");
  writeFileSync(target, Buffer.from([0x00, 0xff, 0x80, 0x01]));

  const action = createPending(
    "delete_file",
    { path: "binary.bin" },
    { requires_confirmation: true },
  );

  assert.equal(popPending(action.action_id)?.action_id, action.action_id);
});

test("apply_patch pending action checks every target before confirmation", () => {
  const project = makeProject();
  writeFileSync(join(project, "a.txt"), "a\n", "utf8");
  writeFileSync(join(project, "b.txt"), "b\n", "utf8");

  const patch = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-a",
    "+A",
    "diff --git a/b.txt b/b.txt",
    "--- a/b.txt",
    "+++ b/b.txt",
    "@@ -1 +1 @@",
    "-b",
    "+B",
    "",
  ].join("\n");

  const action = createPending(
    "apply_patch",
    { patch },
    { requires_confirmation: true },
  );
  writeFileSync(join(project, "b.txt"), "changed by another process\n", "utf8");

  assert.equal(popPending(action.action_id), undefined);
});

test("apply_patch without diff --git headers is also bound to target state", () => {
  const project = makeProject();
  const target = join(project, "plain.txt");
  writeFileSync(target, "original\n", "utf8");

  const patch = [
    "--- a/plain.txt",
    "+++ b/plain.txt",
    "@@ -1 +1 @@",
    "-original",
    "+replacement",
    "",
  ].join("\n");

  const action = createPending(
    "apply_patch",
    { patch },
    { requires_confirmation: true },
  );
  writeFileSync(target, "changed after preview\n", "utf8");

  assert.equal(popPending(action.action_id), undefined);
  assert.equal(getPending(action.action_id), undefined);
});

test("git_add pending action is invalidated when the target changes", () => {
  const project = makeProject();
  const target = join(project, "stage-me.txt");
  writeFileSync(target, "original\n", "utf8");

  const action = createPending(
    "git_add",
    { path: "stage-me.txt" },
    { requires_confirmation: true },
  );
  writeFileSync(target, "changed after preview\n", "utf8");

  assert.equal(popPending(action.action_id), undefined);
  assert.equal(getPending(action.action_id), undefined);
});
