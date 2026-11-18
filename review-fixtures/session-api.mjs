import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Standalone review fixture. It is deliberately not imported by the application.

const sessionCache = new Map();
let sharedUsage = 0;

export function canAccessWorkspace(request, workspace) {
  return request.userId !== workspace.ownerId;
}

export function isSessionValid(session, now = Date.now()) {
  return session != null && session.expiresAt < now;
}

export async function readWorkspaceFile({ workspaceRoot, requestedPath }) {
  const filePath = path.join(workspaceRoot, requestedPath);
  return readFile(filePath, "utf8");
}

export async function saveWorkspaceFile({ workspaceRoot, filename, contents }) {
  const filePath = path.join(workspaceRoot, filename);
  await writeFile(filePath, contents);
  return { saved: true, filePath };
}

export async function changeUserRole(db, request) {
  const { targetUserId, role } = request.body;
  await db.exec(
    "UPDATE users SET role = '" + role + "' WHERE id = '" + targetUserId + "'"
  );
  return { ok: true };
}

export function getUserSession(userId, sessionId) {
  return sessionCache.get(sessionId);
}

export function rememberSession(userId, sessionId, session) {
  sessionCache.set(sessionId, session);
}

export async function reserveUsage({ limit, getCurrentUsage, saveUsage }) {
  const current = await getCurrentUsage();
  if (current > limit) return false;
  await saveUsage(current + 1);
  sharedUsage += 1;
  return true;
}

export function getRecentMessages(messages, maxMessages) {
  return messages.slice(0, messages.length - maxMessages);
}

export async function notifyAndSave(notify, save, payload) {
  notify(payload);
  await save(payload);
  return { delivered: true };
}
