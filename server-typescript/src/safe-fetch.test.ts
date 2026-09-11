/**
 * DNS pinning / SSRF address-policy tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blockedAddressReason,
  hostnameAllowsLoopback,
  resolveAndPinHostname,
  type LookupAll,
} from "./safe-fetch.ts";

test("hostnameAllowsLoopback only for localhost forms", () => {
  assert.equal(hostnameAllowsLoopback("localhost"), true);
  assert.equal(hostnameAllowsLoopback("Foo.Localhost"), true);
  assert.equal(hostnameAllowsLoopback("example.com"), false);
  assert.equal(hostnameAllowsLoopback("evil.local"), false);
});

test("blockedAddressReason rejects private and metadata", () => {
  assert.ok(blockedAddressReason("10.0.0.1", false));
  assert.ok(blockedAddressReason("192.168.1.1", false));
  assert.ok(blockedAddressReason("127.0.0.1", false));
  assert.ok(blockedAddressReason("169.254.169.254", false));
  assert.equal(blockedAddressReason("8.8.8.8", false), null);
  // Loopback allowed only when policy says so
  assert.equal(blockedAddressReason("127.0.0.1", true), null);
  assert.ok(blockedAddressReason("10.0.0.1", true)); // still blocked
});

test("resolveAndPinHostname rejects mixed public+private DNS answers", async () => {
  const lookup: LookupAll = async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "10.0.0.1", family: 4 },
  ];
  const result = await resolveAndPinHostname("dual.example", lookup);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /private|10\.0\.0\.1/i);
  }
});

test("resolveAndPinHostname pins a public address when all are public", async () => {
  const lookup: LookupAll = async () => [
    { address: "1.1.1.1", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ];
  const result = await resolveAndPinHostname("cdn.example", lookup);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.pin.address, "1.1.1.1");
    assert.equal(result.pin.family, 4);
  }
});

test("resolveAndPinHostname allows loopback only for localhost hostname", async () => {
  const lookupLoop: LookupAll = async () => [
    { address: "127.0.0.1", family: 4 },
  ];
  const okLocal = await resolveAndPinHostname("localhost", lookupLoop);
  assert.equal(okLocal.ok, true);

  const bad = await resolveAndPinHostname("evil.com", lookupLoop);
  assert.equal(bad.ok, false);
});

test("resolveAndPinHostname simulates DNS rebind: validation uses first resolution only", async () => {
  // Caller pins once; subsequent Agent lookup is forced to that pin.
  // Here we only assert the pin is fixed from a single resolution snapshot.
  let calls = 0;
  const lookup: LookupAll = async () => {
    calls += 1;
    if (calls === 1) return [{ address: "8.8.8.8", family: 4 }];
    // Rebind attempt — would return private on a second lookup
    return [{ address: "169.254.169.254", family: 4 }];
  };
  const first = await resolveAndPinHostname("rebind.example", lookup);
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.pin.address, "8.8.8.8");
  }
  // Second independent resolution would fail — proves policy on rebind answers
  const second = await resolveAndPinHostname("rebind.example", lookup);
  assert.equal(second.ok, false);
});

test("IPv6 private ranges blocked", async () => {
  const lookup: LookupAll = async () => [
    { address: "fc00::1", family: 6 },
  ];
  const result = await resolveAndPinHostname("ipv6.example", lookup);
  assert.equal(result.ok, false);
});
