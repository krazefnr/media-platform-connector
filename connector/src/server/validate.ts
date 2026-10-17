const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!isUuid(value)) throw new ValidationError(`${field} must be a UUID`);
  return value.toLowerCase();
}

/** Trimmed, control characters removed, null when empty. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return text ? text.slice(0, max) : null;
}

export function requiredId(value: unknown, field: string): string {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string") throw new ValidationError(`${field} is required`);
  const id = text.trim();
  if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) throw new ValidationError(`${field} must be 1-200 printable characters`);
  return id;
}

export function optionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredId(value, field);
}

/** Money in major units (49.99), as a number or a decimal string. */
export function amount(value: unknown, field: string): number {
  const n = typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1e12) {
    throw new ValidationError(`${field} must be a non-negative amount in major currency units`);
  }
  return Math.round(n * 10000) / 10000;
}

export function currency(value: unknown): string {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(code)) throw new ValidationError("currency must be a 3-letter ISO 4217 code");
  return code;
}

export function optionalDate(value: unknown, field: string, fallback: Date): Date {
  if (value === undefined || value === null || value === "") return fallback;
  const date = value instanceof Date ? new Date(value.getTime()) : typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new ValidationError(`${field} must be a valid date`);
  return date;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Path only: no query string or fragment, which could carry personal data. */
export function cleanPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.split(/[?#]/, 1)[0] ?? "";
  if (!path.startsWith("/") || path.startsWith("//") || /[\u0000-\u001f\u007f\s]/.test(path)) return null;
  return path.slice(0, 300);
}

export function cleanHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase();
  return /^[a-z0-9.-]{1,253}$/.test(host) && !host.startsWith(".") ? host : null;
}
