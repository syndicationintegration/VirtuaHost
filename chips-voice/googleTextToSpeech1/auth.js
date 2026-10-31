// Login and session tokens for the web UI, plus the shared API key for scripts.
//
//   ADMIN_USER           login name (default "admin")
//   ADMIN_PASSWORD_HASH  scrypt hash made by `npm run hash-password`
//   SESSION_SECRET       random string used to sign session tokens
//   SESSION_HOURS        token lifetime (default 12)
//   API_KEY              optional static key for scripts (x-api-key / Bearer)
//   NEON_AUTH_URL        optional Neon Auth base URL; also accepts its RS256 session JWTs (JWKS)
//   NEON_AUTH_ISSUER     optional: require this iss claim on Neon tokens
//   internalKey          (not an env var) a random per-process key the server uses to call itself on loopback,
//                        for the built-in chat and MCP features; it never leaves the process
//
// Tokens are "v1.<base64url payload>.<base64url HMAC-SHA256>"; nothing is stored on the server.
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return crypto.timingSafeEqual(actual, expected);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function createAuth(options = {}) {
  const user = options.user || 'admin';
  const passwordHash = options.passwordHash || '';
  const secret = options.secret || '';
  const apiKey = options.apiKey || '';
  const internalKey = options.internalKey || '';
  const ttlMs = (options.sessionHours || 12) * 3600 * 1000;
  const now = options.now || Date.now;

  const loginEnabled = !!(passwordHash && secret);
  const enabled = loginEnabled || !!apiKey;

  const sign = (data) => crypto.createHmac('sha256', secret).update(data).digest();

  function issueToken(username) {
    const payload = b64(JSON.stringify({ sub: username, exp: now() + ttlMs }));
    return `v1.${payload}.${b64(sign(`v1.${payload}`))}`;
  }

  function verifyToken(token) {
    if (!loginEnabled) return null;
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return null;
    const given = Buffer.from(parts[2], 'base64url');
    const wanted = sign(`v1.${parts[1]}`);
    if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return null;
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      return payload.exp > now() ? payload : null;
    } catch (err) {
      return null;
    }
  }

  // Failed logins per client are counted so guessing is slow.
  const attempts = new Map();
  const MAX_FAILURES = options.maxFailures || 5;
  const WINDOW_MS = options.windowMs || 15 * 60 * 1000;

  function blockedFor(client) {
    const entry = attempts.get(client);
    if (!entry) return 0;
    if (now() - entry.first > WINDOW_MS) { attempts.delete(client); return 0; }
    return entry.count >= MAX_FAILURES ? WINDOW_MS - (now() - entry.first) : 0;
  }

  function recordFailure(client) {
    const entry = attempts.get(client);
    if (!entry || now() - entry.first > WINDOW_MS) attempts.set(client, { first: now(), count: 1 });
    else entry.count += 1;
  }

  // Express handler for POST /auth/login
  function login(req, res) {
    if (!loginEnabled) return res.status(404).json({ error: 'login is not configured' });
    const client = req.ip;
    const wait = blockedFor(client);
    if (wait) {
      res.set('Retry-After', String(Math.ceil(wait / 1000)));
      return res.status(429).json({ error: 'too many attempts; try again later' });
    }
    const { username, password } = req.body || {};
    // Always run the hash so timing does not reveal whether the username was right.
    const passwordOk = verifyPassword(password || '', passwordHash);
    const userOk = safeEqual(username || '', user);
    if (!(passwordOk && userOk)) {
      recordFailure(client);
      return res.status(401).json({ error: 'wrong username or password' });
    }
    attempts.delete(client);
    res.json({ token: issueToken(user), user, expiresInHours: ttlMs / 3600000 });
  }

  // Neon Auth (optional): RS256 JWTs signed by the Neon Auth JWKS. Returns the same {sub, exp} payload
  // as verifyToken (exp in ms), or null. `fetchJwks` can be injected for tests.
  const neonUrl = (options.neonAuthUrl || '').replace(/\/+$/, '');
  const neonEnabled = !!neonUrl;
  const fetchJwks = options.fetchJwks || (async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`JWKS ${res.status}`);
    return res.json();
  });
  let jwks = null;

  async function jwkFor(kid, refresh) {
    if (!jwks || refresh) jwks = await fetchJwks(`${neonUrl}/.well-known/jwks.json`);
    return (jwks.keys || []).find((k) => k.kid === kid && (k.kty === 'RSA' || k.alg === 'RS256'));
  }

  async function verifyNeonToken(token) {
    if (!neonEnabled) return null;
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    try {
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (header.alg !== 'RS256' || !header.kid) return null;
      let jwk = await jwkFor(header.kid, false);
      if (!jwk) jwk = await jwkFor(header.kid, true); // key rotation: refresh once
      if (!jwk) return null;
      const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key,
        Buffer.from(parts[2], 'base64url'));
      if (!ok) return null;
      if (!claims.exp || claims.exp * 1000 <= now()) return null;
      if (options.neonIssuer && claims.iss !== options.neonIssuer) return null;
      return { sub: String(claims.sub || ''), exp: claims.exp * 1000 };
    } catch (err) {
      return null;
    }
  }

  // Express 4 middleware: a valid session token or the API key. Neon Auth is checked last, and only
  // for tokens that are not HMAC tokens, so local installs never reach the network. The HMAC and
  // API-key paths stay synchronous; only the Neon check returns a promise.
  function requireAuth(req, res, next) {
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const key = req.get('x-api-key') || bearer;
    const deny = () => res.status(401).json({ error: 'login required' });
    const pass = () => {
      try { next(); } catch (err) { next(err); }
    };
    if (!enabled && !neonEnabled) return next();
    if (verifyToken(bearer)) return next();
    if (apiKey && key && safeEqual(key, apiKey)) return next();
    if (internalKey && key && safeEqual(key, internalKey)) return next();
    if (neonEnabled && bearer && !bearer.startsWith('v1.')) {
      verifyNeonToken(bearer).then((payload) => (payload ? pass() : deny()), deny);
      return undefined;
    }
    return deny();
  }

  return {
    enabled: enabled || neonEnabled, loginEnabled, neonEnabled, login, requireAuth, issueToken, verifyToken,
    verifyNeonToken,
  };
}

module.exports = { createAuth, hashPassword, verifyPassword };
