import type { ProviderConnection } from "@/shared/schema";

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

export function providerEndpoint(settings: ProviderConnection, path: string): string {
  const base = new URL(settings.baseUrl);
  const allowedPlaintext =
    base.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(base.hostname);
  if (base.protocol !== "https:" && !allowedPlaintext) {
    throw new Error("Provider URL must use HTTPS or loopback HTTP");
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new Error("Provider base URL must not contain credentials, query parameters, or fragments");
  }
  const normalized = base.toString().replace(/\/$/u, "");
  return `${normalized}/${path.replace(/^\//u, "")}`;
}

export function providerHeaders(settings: ProviderConnection): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (settings.apiKey) headers.set("Authorization", `Bearer ${settings.apiKey}`);
  return headers;
}

export function providerOriginPattern(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Provider URL must use HTTP or HTTPS");
  }
  return `${url.protocol}//${url.hostname}/*`;
}

export async function listProviderModels(
  settings: ProviderConnection,
  signal?: AbortSignal,
): Promise<string[]> {
  const response = await checkedFetch(providerEndpoint(settings, "models"), {
    method: "GET",
    headers: providerHeaders(settings),
    signal,
  });
  const body = (await response.json()) as unknown;
  if (!body || typeof body !== "object") throw new Error("Provider returned an invalid model list");
  const record = body as Record<string, unknown>;
  const candidates = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];
  const models = candidates.flatMap((candidate): string[] => {
    const value =
      typeof candidate === "string"
        ? candidate
        : candidate && typeof candidate === "object"
          ? typeof (candidate as Record<string, unknown>).id === "string"
            ? ((candidate as Record<string, unknown>).id as string)
            : typeof (candidate as Record<string, unknown>).name === "string"
              ? ((candidate as Record<string, unknown>).name as string)
              : ""
          : "";
    const normalized = value.trim();
    return normalized && normalized.length <= 200 ? [normalized] : [];
  });
  return [...new Set(models)].sort((left, right) => left.localeCompare(right)).slice(0, 1_000);
}

export async function checkedFetch(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: "error", credentials: "omit", cache: "no-store" });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ProviderHttpError(
      response.status,
      body.slice(0, 500) || `Provider returned HTTP ${response.status}`,
    );
  }
  return response;
}

/**
 * Gateways sometimes ignore `stream: true` and answer with a complete JSON body
 * (content-type application/json) instead of an SSE stream. Adapters detect this
 * via isEventStream and parse the full response instead.
 */
export function isEventStream(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("event-stream");
}

export async function parseSse(
  response: Response,
  onData: (data: string, eventName?: string) => void,
): Promise<void> {
  if (!response.body) throw new Error("Provider returned an empty stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length > 0) onData(dataLines.join("\n"), eventName);
    eventName = undefined;
    dataLines = [];
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "") {
        flush();
      } else if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (done) break;
  }
  if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).trimStart());
  flush();
}

export function safeJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
