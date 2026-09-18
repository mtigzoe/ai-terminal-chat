import { describe, expect, it } from 'vitest';
import {
  createHealthChallenge,
  createHealthProof,
  verifyHealthProof,
} from './health-check.cjs';

describe('Electron backend health authentication', () => {
  it('creates and verifies a proof for the current challenge', () => {
    const token = 'test-health-token';
    const challenge = createHealthChallenge();
    const proof = createHealthProof(token, challenge);

    expect(challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(proof).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyHealthProof(token, challenge, proof)).toBe(true);
  });

  it('rejects a proof for a different challenge', () => {
    const token = 'test-health-token';
    const challenge = createHealthChallenge();
    const proof = createHealthProof(token, challenge);

    expect(verifyHealthProof(token, createHealthChallenge(), proof)).toBe(false);
  });

  it('rejects a proof generated with a different token', () => {
    const challenge = createHealthChallenge();
    const proof = createHealthProof('real-token', challenge);

    expect(verifyHealthProof('attacker-token', challenge, proof)).toBe(false);
  });

  it('rejects malformed proofs', () => {
    const challenge = createHealthChallenge();

    expect(verifyHealthProof('test-health-token', challenge, '')).toBe(false);
    expect(verifyHealthProof('test-health-token', challenge, '00'.repeat(32) + '00')).toBe(false);
    expect(verifyHealthProof('test-health-token', challenge, 'not-a-proof')).toBe(false);
  });
});
