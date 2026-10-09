import { after, NextRequest } from "next/server";
import { verifySignature, handleVerification, processWebhook, webhookEventSchema } from "@/lib/webhook";

import { dispatchAutomations, hasQueuedAutomations } from "@/lib/automations/dispatch";

const MAX_BODY_BYTES = 1024 * 1024;
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const result = handleVerification(searchParams.get("hub.mode") ?? "", searchParams.get("hub.verify_token") ?? "",
    searchParams.get("hub.challenge") ?? "", process.env.WEBHOOK_VERIFY_TOKEN ?? "");
  return new Response(result.body, { status: result.status });
}

async function readBody(req: NextRequest): Promise<Buffer> {
  if (Number(req.headers.get("content-length")) > MAX_BODY_BYTES) throw new Error("too_large");
  const reader = req.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => undefined); }, 5000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new Error("timeout");
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error("too_large"); }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

export async function POST(req: NextRequest) {
  // Instagram Login webhooks use the Instagram app secret.
  const secret = process.env.INSTAGRAM_APP_SECRET ?? "";
  if (!secret) return new Response("Webhook is not configured", { status: 503 });
  const signature = req.headers.get("x-hub-signature-256") ?? "";
  if (!/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return new Response("Invalid signature", { status: 403 });
  let rawBody: Buffer;
  try { rawBody = await readBody(req); }
  catch (error) {
    const reason = error instanceof Error ? error.message : "";
    return new Response(reason === "too_large" ? "Payload too large" : "Could not read request", { status: reason === "too_large" ? 413 : reason === "timeout" ? 408 : 400 });
  }
  if (!verifySignature(rawBody, signature, secret)) return new Response("Invalid signature", { status: 403 });
  let body: unknown;
  try { body = JSON.parse(rawBody.toString("utf8")); }
  catch { return new Response("Invalid JSON", { status: 400 }); }
  const event = webhookEventSchema.safeParse(body);
  if (!event.success) return new Response("Invalid webhook payload", { status: 400 });
  try {
    await processWebhook(event.data);
    if (await hasQueuedAutomations()) after(dispatchAutomations);
    return new Response("EVENT_RECEIVED", { status: 200 });
  } catch {
    // No customer content, access tokens, or upstream error bodies in logs.
    console.error("Webhook processing failed; delivery will be retried.");
    return new Response("Please retry", { status: 503, headers: { "Retry-After": "5" } });
  }
}
