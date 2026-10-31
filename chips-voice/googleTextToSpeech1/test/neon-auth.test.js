const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createAuth } = require('../auth');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const NEON = 'https://auth.example.neon.tech/project';

function jwt(claims, { key = privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b({ alg, kid, typ: 'JWT' });
  const body = b(claims);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

function mockJwks(keys = [jwk]) {
  const calls = [];
  const fetchJwks = async (url) => { calls.push(url); return { keys }; };
  return { fetchJwks, calls };
}

test('a valid Neon Auth JWT maps to {sub, exp} in milliseconds', async () => {
  const { fetchJwks, calls } = mockJwks();
  const auth = createAuth({ neonAuthUrl: NEON + '/', fetchJwks, now: () => 1000 });
  const exp = 2000;
  const payload = await auth.verifyNeonToken(jwt({ sub: 'user-1', exp }));
  assert.deepStrictEqual(payload, { sub: 'user-1', exp: exp * 1000 });
  assert.deepStrictEqual(calls, [NEON + '/.well-known/jwks.json']);
});

test('expired, wrong-signature, wrong-alg and unknown-kid tokens are rejected', async () => {
  const { fetchJwks } = mockJwks();
  const auth = createAuth({ neonAuthUrl: NEON, fetchJwks, now: () => 5000 * 1000 }); // clock in ms; exp in seconds
  assert.strictEqual(await auth.verifyNeonToken(jwt({ sub: 'a', exp: 4000 })), null, 'expired');
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.strictEqual(await auth.verifyNeonToken(jwt({ sub: 'a', exp: 9000 }, { key: other })), null, 'bad signature');
  assert.strictEqual(await auth.verifyNeonToken(jwt({ sub: 'a', exp: 9000 }, { alg: 'HS256' })), null, 'alg');
  assert.strictEqual(await auth.verifyNeonToken(jwt({ sub: 'a', exp: 9000 }, { kid: 'nope' })), null, 'kid');
  assert.strictEqual(await auth.verifyNeonToken('not.a.jwt.here'), null, 'malformed');
});

test('the issuer is checked when NEON_AUTH_ISSUER is set', async () => {
  const { fetchJwks } = mockJwks();
  const auth = createAuth({ neonAuthUrl: NEON, neonIssuer: 'https://good', fetchJwks, now: () => 0 });
  assert.strictEqual(await auth.verifyNeonToken(jwt({ sub: 'a', exp: 9999999999, iss: 'https://bad' })), null);
  assert.ok(await auth.verifyNeonToken(jwt({ sub: 'a', exp: 9999999999, iss: 'https://good' })));
});

test('the HMAC login path still verifies tokens with Neon Auth enabled', async () => {
  const { fetchJwks, calls } = mockJwks();
  const auth = createAuth({
    neonAuthUrl: NEON, fetchJwks, now: () => Date.now(),
    adminUser: 'admin', passwordHash: 'unused', secret: 'test-secret', sessionHours: 1,
  });
  const token = auth.issueToken('admin');
  assert.ok(auth.verifyToken(token), 'HMAC token verifies');
  let passed = false;
  await new Promise((resolve) => auth.requireAuth(
    { get: (n) => (n.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined) },
    { status: () => ({ json: () => resolve() }) },
    () => { passed = true; resolve(); },
  ));
  assert.strictEqual(passed, true);
  assert.deepStrictEqual(calls, [], 'HMAC tokens never reach the JWKS endpoint');
});

test('requireAuth accepts a Neon JWT and rejects a bad one', async () => {
  const { fetchJwks } = mockJwks();
  const auth = createAuth({ neonAuthUrl: NEON, fetchJwks, now: () => 5000 * 1000 });
  const good = jwt({ sub: 'u', exp: 9999999999 });
  const ok = await new Promise((resolve) => {
    auth.requireAuth({ get: (n) => (n.toLowerCase() === 'authorization' ? `Bearer ${good}` : undefined) },
      { status: () => ({ json: () => resolve(false) }) }, () => resolve(true));
  });
  assert.strictEqual(ok, true);
  const denied = await new Promise((resolve) => {
    auth.requireAuth({ get: (n) => (n.toLowerCase() === 'authorization' ? `Bearer ${jwt({ sub: 'u', exp: 1 })}` : undefined) },
      { status: (c) => ({ json: () => resolve(c) }) }, () => resolve('passed'));
  });
  assert.strictEqual(denied, 401);
});

test('without NEON_AUTH_URL the verifier is off and no JWKS is fetched', async () => {
  const { fetchJwks, calls } = mockJwks();
  const auth = createAuth({ fetchJwks });
  assert.strictEqual(auth.neonEnabled, false);
  assert.strictEqual(auth.enabled, false);
  assert.strictEqual(await auth.verifyNeonToken(jwt({ sub: 'a', exp: 9999999999 })), null);
  assert.deepStrictEqual(calls, []);
});
