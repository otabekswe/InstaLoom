import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
if (existsSync(".env")) process.loadEnvFile(".env");
const base = new URL(process.argv[2] || "http://localhost:3000");
const secret = process.env.INSTAGRAM_APP_SECRET;
const token = process.env.WEBHOOK_VERIFY_TOKEN;
if (!secret || !token) {
  console.error("Set INSTAGRAM_APP_SECRET and WEBHOOK_VERIFY_TOKEN in .env.local first.");
  process.exit(1);
}

const body = JSON.stringify({ object: "instagram", entry: [] });
const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const verification = new URL("/api/webhook", base);
verification.search = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": token, "hub.challenge": "instaloom-local-check" }).toString();
let failures = 0;
async function check(name, url, options, status, expectedBody) {
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000), redirect: "manual" });
    const text = await response.text();
    const passed = response.status === status && (expectedBody === undefined || text === expectedBody);
    console.log(`${passed ? "PASS" : "FAIL"} ${name} (HTTP ${response.status})`);
    if (!passed) failures++;
  } catch {
    console.error(`FAIL ${name}: could not reach the app. Is it running?`);
    failures++;
  }
}
await check("verification challenge", verification, {}, 200, "instaloom-local-check");
const endpoint = new URL("/api/webhook", base);
await check("signed event", endpoint, { method: "POST", body, headers: { "x-hub-signature-256": signature, "Content-Type": "application/json" } }, 200, "EVENT_RECEIVED");
await check("unsigned event rejected", endpoint, { method: "POST", body }, 403);
await check("malformed signature rejected", endpoint, { method: "POST", body, headers: { "x-hub-signature-256": "sha256=bad" } }, 403);
console.log("These checks send empty events and do not create messages or contact Meta.");
process.exitCode = failures ? 1 : 0;
