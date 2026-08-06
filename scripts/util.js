export function randomId(prefix = "") {
  const bytes = new Uint8Array(12);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  const value = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}${value}`;
}

export function deepClone(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return structuredClone(value);
}

export function clampInteger(value, min, max, fallback = min) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function parseStrictInteger(value, errorKey) {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return value;
    throw new Error(errorKey);
  }
  if (typeof value !== "string") throw new Error(errorKey);
  const text = value.trim();
  if (!/^[+-]?\d+$/u.test(text)) throw new Error(errorKey);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new Error(errorKey);
  return parsed;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function activeHost() {
  const users = game?.users?.contents
    ?? (typeof game?.users?.values === "function" ? [...game.users.values()] : []);
  const activeGMs = users
    .filter((user) => user.active && user.isGM)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return activeGMs[0] ?? null;
}

export function isHostClient() {
  return activeHost()?.id === game.user?.id;
}

export function notifyError(error) {
  console.error(`${game?.modules?.get?.("fbl-poker-table")?.title ?? "FBL Poker"} |`, error);
  const message = error instanceof Error ? error.message : String(error);
  const localized = message.startsWith("FBLPoker.") ? localize(message) : message;
  ui.notifications?.error(localized);
}

export function downloadTextFile(filename, content, mimeType = "application/json") {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function localize(key, data = null) {
  return data ? game.i18n.format(key, data) : game.i18n.localize(key);
}

export function getProperty(object, path) {
  if (globalThis.foundry?.utils?.getProperty) return foundry.utils.getProperty(object, path);
  return path.split(".").reduce((value, key) => value?.[key], object);
}
