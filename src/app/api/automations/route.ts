import { after, NextRequest, NextResponse } from "next/server";
import { ApiError, apiResponse, readJson, requireSameOrigin, requireSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { requireAutomationAccount } from "@/lib/automations/access";
import { automationSchema, updateAutomationSchema, automationActionSchema, automationIdentitySchema, channelSchema, type AutomationInput } from "@/lib/automations/schema";
import { getRule, getRules, getRuns, saveRule, updateRule, moveRule, deleteRule } from "@/lib/automations/store";
import { dispatchAutomations } from "@/lib/automations/dispatch";
import { getSavedMedia } from "@/lib/instagram/media";

export const maxDuration = 120;

export async function GET(request: NextRequest) {
  return apiResponse(async () => {
    const { user } = await requireSession(request);
    const accountId = request.nextUrl.searchParams.get("account_id") ?? "";
    await requireAutomationAccount(accountId, user.id);
    const channel = channelSchema.safeParse(request.nextUrl.searchParams.get("channel"));
    if (!channel.success) throw new ApiError(400, "Choose an automation channel.");
    const rules = await getRules(accountId, channel.data);
    const media = await Promise.all([...new Set(rules.map((rule) => rule.mediaId))].map((id) => getSavedMedia(accountId, id)));
    const runs = await getRuns(accountId, channel.data);
    // Cron also recovers work while the workspace is closed.
    after(dispatchAutomations);
    return NextResponse.json({ rules, runs, media: media.filter((item) => item !== undefined) });
  });
}

export async function POST(request: NextRequest) {
  return apiResponse(async () => {
    const { user } = await requireSession(request);
    requireSameOrigin(request);
    const body = await readJson(request, automationSchema);
    const rule = await getDb().transaction(async () => {
      await validateRule(body, user.id);
      return saveRule(body);
    })();
    return NextResponse.json({ rule }, { status: 201 });
  });
}

export async function PUT(request: NextRequest) {
  return apiResponse(async () => {
    const { user } = await requireSession(request);
    requireSameOrigin(request);
    const body = await readJson(request, updateAutomationSchema);
    const rule = await getDb().transaction(async () => {
      await requireAutomationAccount(body.accountId, user.id);
      const existing = await getRule(body.accountId, body.id);
      if (!existing || existing.channel !== body.channel || existing.mediaId !== body.mediaId) {
        throw new ApiError(404, "Automation not found in this account and channel.");
      }
      await validateRule(body, user.id);
      const updated = await updateRule(body.id, body);
      if (!updated) throw new ApiError(404, "Automation not found.");
      return updated;
    })();
    return NextResponse.json({ rule });
  });
}

export async function PATCH(request: NextRequest) {
  return apiResponse(async () => {
    const { user } = await requireSession(request);
    requireSameOrigin(request);
    const body = await readJson(request, automationActionSchema);
    const rules = await getDb().transaction(async () => {
      await requireAutomationAccount(body.accountId, user.id);
      const rule = await getRule(body.accountId, body.id);
      if (!rule) throw new ApiError(404, "Automation not found.");
      if (body.action === "move-up" || body.action === "move-down") {
        return moveRule(body.accountId, body.id, body.action === "move-up" ? -1 : 1);
      }
      const input = { ...rule, enabled: body.action === "enable" };
      await validateRule(input, user.id);
      await updateRule(rule.id, input);
      return getRules(body.accountId, rule.channel);
    })();
    return NextResponse.json({ rules });
  });
}

export async function DELETE(request: NextRequest) {
  return apiResponse(async () => {
    const { user } = await requireSession(request);
    requireSameOrigin(request);
    const body = await readJson(request, automationIdentitySchema);
    const rules = await getDb().transaction(async () => {
      await requireAutomationAccount(body.accountId, user.id);
      const rule = await getRule(body.accountId, body.id);
      if (!rule) throw new ApiError(404, "Automation not found.");
      const result = await deleteRule(body.accountId, body.id);
      if (result === "sending") throw new ApiError(409, "A reply is being sent. Try deleting again in a moment.");
      if (result === "missing") throw new ApiError(404, "Automation not found.");
      return getRules(body.accountId, rule.channel);
    })();
    return NextResponse.json({ rules });
  });
}

async function validateRule(body: AutomationInput, userId: string) {
  const account = await requireAutomationAccount(body.accountId, userId);
  if (body.enabled && (!account.accessToken || !account.tokenExpiresAt || account.tokenExpiresAt <= Date.now())) {
    throw new ApiError(409, "Reconnect Instagram before enabling an automation.");
  }
  if (body.channel !== "dm") {
    const media = await getSavedMedia(body.accountId, body.mediaId);
    if (!media || media.channel !== body.channel) throw new ApiError(400, "Choose a post or story from this account first.");
    if (body.enabled && body.channel === "story" && (!Number.isFinite(Date.parse(media.timestamp)) || Date.parse(media.timestamp) < Date.now() - 86400_000)) {
      throw new ApiError(409, "This story has expired. Choose an active story.");
    }
  }
}
