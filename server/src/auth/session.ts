import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import type { WebUser } from '../types.js';
import { generateOpaqueToken, hashSessionToken } from './password.js';

export const SESSION_COOKIE_NAME = 'agy_chat_sid';
export const CSRF_COOKIE_NAME = 'agy_chat_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

export interface AuthenticatedSession {
  user: WebUser;
  sessionIdHash: string;
  expiresAt: number;
}

export function shouldUseSecureCookies(req: FastifyRequest, config: AppConfig): boolean {
  if (config.secureCookies === 'always') return true;
  if (config.secureCookies === 'never') return false;
  if (req.protocol === 'https') return true;
  const xfProto = req.headers['x-forwarded-proto'];
  if (typeof xfProto === 'string' && xfProto.toLowerCase().includes('https')) return true;
  return false;
}

export function issueSessionCookies(params: {
  req: FastifyRequest;
  reply: FastifyReply;
  config: AppConfig;
  db: AppDatabase;
  userId: string;
}): { sessionIdHash: string; csrfToken: string } {
  const rawToken = generateOpaqueToken(32);
  const csrfToken = generateOpaqueToken(24);
  const sessionIdHash = hashSessionToken(rawToken);
  const expiresAt = Date.now() + params.config.sessionTtlMs;

  params.db.createWebSession({
    sessionIdHash,
    userId: params.userId,
    userAgent: String(params.req.headers['user-agent'] ?? '').slice(0, 250),
    expiresAt,
  });

  const secure = shouldUseSecureCookies(params.req, params.config);
  const maxAgeSec = Math.floor(params.config.sessionTtlMs / 1000);

  params.reply.setCookie(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: maxAgeSec,
  });

  params.reply.setCookie(CSRF_COOKIE_NAME, csrfToken, {
    httpOnly: false,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: maxAgeSec,
  });

  return { sessionIdHash, csrfToken };
}

export function clearSessionCookies(req: FastifyRequest, reply: FastifyReply, config: AppConfig): void {
  const secure = shouldUseSecureCookies(req, config);
  reply.clearCookie(SESSION_COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'lax', secure });
  reply.clearCookie(CSRF_COOKIE_NAME, { path: '/', httpOnly: false, sameSite: 'lax', secure });
}

export function authenticateRequest(
  req: FastifyRequest,
  db: AppDatabase
): AuthenticatedSession | null {
  const rawToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (!rawToken || typeof rawToken !== 'string') return null;
  const sessionIdHash = hashSessionToken(rawToken);
  const resolved = db.getSessionUser(sessionIdHash);
  if (!resolved) return null;
  return {
    user: resolved.user,
    sessionIdHash,
    expiresAt: resolved.expiresAt,
  };
}

export function verifyCsrfIfMutating(req: FastifyRequest): boolean {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
  const headerToken = req.headers[CSRF_HEADER_NAME];
  if (!cookieToken || typeof headerToken !== 'string') return false;
  return cookieToken === headerToken;
}
