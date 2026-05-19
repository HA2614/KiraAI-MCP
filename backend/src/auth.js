import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import express from "express";
import { config } from "./config.js";
import { ExternalServiceError, ForbiddenError, UnauthorizedError, ValidationError } from "./errors.js";
import { fail, ok } from "./response.js";
import {
  countUsers,
  ensureFirstAdmin,
  getUserByEmail,
  getUserById,
  publicUser,
  setupFirstUser,
  touchUserLogin
} from "./accessControl.js";

const scryptAsync = promisify(scrypt);
const HASH_PREFIX = "scrypt";
const SCRYPT_PARAMS = {
  N: 16384,
  r: 8,
  p: 1,
  keylen: 64
};
const AUTH_BOOT_ID = b64url(randomBytes(24));

function b64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function fromB64url(value) {
  return Buffer.from(String(value || ""), "base64url");
}

function parseCookies(header = "") {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    const value = part.slice(index + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function signJwt(headerPart, payloadPart) {
  return b64url(createHmac("sha256", config.sessionSecret).update(`${headerPart}.${payloadPart}`).digest());
}

function encodeJwt(payload) {
  const headerPart = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payloadPart = b64url(JSON.stringify(payload));
  return `${headerPart}.${payloadPart}.${signJwt(headerPart, payloadPart)}`;
}

function decodeJwt(value) {
  const [headerPart, payloadPart, signature] = String(value || "").split(".");
  if (!headerPart || !payloadPart || !signature || !config.sessionSecret) return null;
  const expected = signJwt(headerPart, payloadPart);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  let header = null;
  let payload = null;
  try {
    header = JSON.parse(fromB64url(headerPart).toString("utf8"));
    payload = JSON.parse(fromB64url(payloadPart).toString("utf8"));
  } catch {
    return null;
  }
  if (header?.alg !== "HS256" || header?.typ !== "JWT") return null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!payload?.sub || !payload?.exp || Number(payload.exp) <= nowSeconds) return null;
  if (payload.boot !== AUTH_BOOT_ID) return null;
  return payload;
}

function cookieSecure(req) {
  if (config.authCookieSecure) return true;
  return req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}

function serializeSessionCookie(req, value, { maxAgeMs = config.authSessionTtlMs } = {}) {
  const parts = [
    `${config.authCookieName}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`
  ];
  if (cookieSecure(req)) parts.push("Secure");
  return parts.join("; ");
}

function clearSessionCookie(req) {
  return serializeSessionCookie(req, "", { maxAgeMs: 0 });
}

function assertAuthConfigured() {
  if (!config.authEnabled) return;
  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    throw new ExternalServiceError("SESSION_SECRET must be at least 32 characters when AUTH_ENABLED=true", null, "AUTH_CONFIG_MISSING");
  }
}

export async function hashPassword(password) {
  const raw = String(password || "");
  if (raw.length < 10) throw new ValidationError("Password must be at least 10 characters");
  const salt = randomBytes(16);
  const derived = await scryptAsync(raw, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p
  });
  return [
    HASH_PREFIX,
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    b64url(salt),
    b64url(derived)
  ].join("$");
}

export async function verifyPassword(password, encodedHash) {
  const parts = String(encodedHash || "").split("$");
  if (parts.length !== 6 || parts[0] !== HASH_PREFIX) return false;
  const [, rawN, rawR, rawP, rawSalt, rawHash] = parts;
  const salt = fromB64url(rawSalt);
  const expected = fromB64url(rawHash);
  if (!salt.length || !expected.length) return false;
  const derived = await scryptAsync(String(password || ""), salt, expected.length, {
    N: Number(rawN),
    r: Number(rawR),
    p: Number(rawP)
  });
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

export async function optionalAuth(req, _res, next) {
  try {
    req.auth = { enabled: config.authEnabled, authenticated: !config.authEnabled };
    if (!config.authEnabled) return next();
    assertAuthConfigured();
    const cookies = parseCookies(req.headers.cookie || "");
    const token = decodeJwt(cookies[config.authCookieName]);
    if (!token) return next();
    const user = await getUserById(token.sub);
    if (!user || user.status !== "active") {
      return next();
    }
    req.auth = {
      enabled: true,
      authenticated: true,
      token,
      user
    };
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireAuth(req, res, next) {
  if (!config.authEnabled) return next();
  if (req.path === "/health" || req.path.startsWith("/auth/")) return next();
  if (req.method === "GET" && /^\/invites\/[^/]+$/.test(req.path)) return next();
  if (req.method === "POST" && /^\/invites\/[^/]+\/accept$/.test(req.path)) return next();
  if (req.auth?.authenticated) return next();
  return fail(res, "Authentication required", 401, "AUTH_REQUIRED");
}

function requestOrigin(req) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return "";
  try {
    return new URL(origin).origin;
  } catch {
    return "";
  }
}

function ownOrigin(req) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (!host) return "";
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || req.protocol || "http";
  return `${proto}://${host}`;
}

export function isAllowedOrigin(req, originValue) {
  if (!originValue) return true;
  const origin = String(originValue || "").replace(/\/+$/, "");
  if (config.corsAllowedOrigins.map((value) => value.replace(/\/+$/, "")).includes(origin)) return true;
  return origin === ownOrigin(req);
}

export function originGuard(req, res, next) {
  if (!config.authEnabled) return next();
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = requestOrigin(req);
  if (!origin || isAllowedOrigin(req, origin)) return next();
  const error = new ForbiddenError("Request origin is not allowed", "BAD_ORIGIN", { origin });
  return fail(res, error.message, error.statusCode, error.code, error.details);
}

export async function createSessionForUser(req, res, user) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    sub: String(user.id),
    email: user.email,
    role: user.role || "user",
    boot: AUTH_BOOT_ID,
    jti: b64url(randomBytes(18)),
    iat: nowSeconds,
    exp: nowSeconds + Math.floor(config.authSessionTtlMs / 1000),
    requestId: req.requestId || null
  };
  res.setHeader("Set-Cookie", serializeSessionCookie(req, encodeJwt(payload)));
  await touchUserLogin(user.id);
  return payload;
}

export async function destroySession(req, res) {
  res.setHeader("Set-Cookie", clearSessionCookie(req));
}

export async function bootstrapAuth() {
  if (!config.authEnabled) return null;
  assertAuthConfigured();
  return ensureFirstAdmin({
    email: config.authBootstrapEmail,
    passwordHash: config.authBootstrapPasswordHash || config.authAdminPasswordHash
  });
}

export const authRouter = express.Router();

authRouter.get("/status", async (req, res, next) => {
  try {
    const userCount = config.authEnabled ? await countUsers() : 0;
    return ok(res, {
      enabled: config.authEnabled,
      authenticated: Boolean(req.auth?.authenticated),
      setupRequired: Boolean(config.authEnabled && userCount === 0),
      sessionMode: config.authEnabled ? "jwt_restart_expiring" : "disabled",
      user: req.auth?.authenticated ? publicUser(req.auth.user) : null
    });
  } catch (error) {
    return next(error);
  }
});

authRouter.post("/setup", async (req, res, next) => {
  try {
    if (!config.authEnabled) {
      return ok(res, { enabled: false, authenticated: true, setupRequired: false });
    }
    assertAuthConfigured();
    const email = String(req.body?.email || "");
    const password = String(req.body?.password || "");
    const displayName = String(req.body?.displayName || "");
    const passwordHash = await hashPassword(password);
    const user = await setupFirstUser({ email, passwordHash, displayName });
    await createSessionForUser(req, res, user);
    return ok(res, {
      enabled: true,
      authenticated: true,
      setupRequired: false,
      user: publicUser(user)
    }, null, 201);
  } catch (error) {
    return next(error);
  }
});

authRouter.get("/legacy-status", (req, res) => {
  ok(res, {
    enabled: config.authEnabled,
    authenticated: Boolean(req.auth?.authenticated),
    user: req.auth?.authenticated ? publicUser(req.auth.user) : null
  });
});

authRouter.post("/login", async (req, res, next) => {
  try {
    if (!config.authEnabled) {
      return ok(res, { enabled: false, authenticated: true });
    }
    assertAuthConfigured();
    if ((await countUsers()) === 0) {
      throw new ForbiddenError("Setup required before login", "SETUP_REQUIRED");
    }
    const email = String(req.body?.email || "");
    const password = String(req.body?.password || "");
    if (!email || !password) throw new UnauthorizedError("Invalid email or password", "INVALID_CREDENTIALS");
    const user = await getUserByEmail(email);
    if (!user || user.status !== "active") throw new UnauthorizedError("Invalid email or password", "INVALID_CREDENTIALS");
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) throw new UnauthorizedError("Invalid email or password", "INVALID_CREDENTIALS");
    await createSessionForUser(req, res, user);
    return ok(res, { enabled: true, authenticated: true, user: publicUser(user), setupRequired: false });
  } catch (error) {
    return next(error);
  }
});

authRouter.post("/logout", async (req, res, next) => {
  try {
    await destroySession(req, res);
    return ok(res, { authenticated: false });
  } catch (error) {
    return next(error);
  }
});
