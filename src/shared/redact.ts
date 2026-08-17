/**
 * Secret redaction for dev tools and logs. API keys and Authorization
 * headers must never leave the extension or appear in debug views.
 */

const SECRET_KEYS = new Set(["apikey", "api_key", "authorization", "x-api-key", "token", "secret", "key", "password"]);

const REDACTED = "••••••••[redacted]";

/** Deep-clones `value` replacing any value whose key looks like a secret. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.has(k.toLowerCase()) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 0 && /(?:sk-|Bearer\s+)[A-Za-z0-9._-]{8,}/.test(value)) {
    return value.replace(/(sk-|Bearer\s+)([A-Za-z0-9._-]{4})[A-Za-z0-9._-]+/g, `$1$2••••[redacted]`);
  }
  return value;
}

/** Redacts a URL's credentials, e.g. https://user:pass@host -> https://•••@host */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@]+)@/i, "$1•••@");
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase());
}
