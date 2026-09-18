const crypto = require('node:crypto');

// The challenge is fresh for every readiness probe so a captured proof cannot be replayed.
function createHealthChallenge() {
  return crypto.randomBytes(32).toString('hex');
}

function createHealthProof(token, challenge) {
  return crypto.createHmac('sha256', token).update(challenge, 'utf8').digest('hex');
}

function verifyHealthProof(token, challenge, proof) {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/i.test(proof)) {
    return false;
  }

  const expected = Buffer.from(createHealthProof(token, challenge), 'hex');
  const provided = Buffer.from(proof, 'hex');
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

module.exports = {
  createHealthChallenge,
  createHealthProof,
  verifyHealthProof,
};
