import { z } from "zod";

export function getGraphApiVersion(): string {
  const version = process.env.INSTAGRAM_API_VERSION;
  return version && /^v\d+\.0$/.test(version) ? version : "v25.0";
}

/** Never include upstream bodies or credential-bearing URLs in errors or logs. */
export async function instagramRequest<T>(url: URL, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(8_000), cache: "no-store" });
  } catch {
    throw new Error("Instagram could not be reached. Please try again.");
  }
  if (!response.ok) throw new Error(`Instagram request failed (${response.status}). Reconnect your account or try again.`);
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("Instagram returned an unexpected response. Please try again.");
  return parsed.data;
}

export function graphRequest<T>(path: string, token: string, schema: z.ZodType<T>, options: { body?: unknown; query?: Record<string, string>; method?: "GET" | "POST" | "DELETE" } = {}): Promise<T> {
  const url = new URL(`https://graph.instagram.com/${getGraphApiVersion()}/${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
  return instagramRequest(url, schema, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}
