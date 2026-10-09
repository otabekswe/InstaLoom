import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiResponse, readJson, requireSameOrigin, requireSession } from "@/lib/auth";
import { getAccountById, getConversationById } from "@/lib/instagram";
import { getDb } from "@/lib/db";
import { ReplyEligibilityError, sendAgentReply } from "@/lib/webhook";

const sendSchema = z.object({
  accountId: z.string().min(1).max(200),
  text: z.string().trim().min(1).max(1000).refine((value) => Buffer.byteLength(value, "utf8") <= 1000).optional(),
  attachmentUrl: z.url().max(2048).refine((url) => new URL(url).protocol === "https:").optional(),
  attachmentType: z.enum(["image", "video", "audio", "file"]).optional(),
  replyToMid: z.string().min(1).max(500).optional(),
  commentId: z.string().min(1).max(500).optional(),
}).strict().refine((body) => Boolean(body.text) !== Boolean(body.attachmentUrl))
  .refine((body) => Boolean(body.attachmentUrl) === Boolean(body.attachmentType));

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return apiResponse(async () => {
    const { user } = await requireSession(request);
    requireSameOrigin(request);
    const { id: conversationId } = await params;
    const body = await readJson(request, sendSchema);
    const conversation = await getConversationById(conversationId);
    const account = await getAccountById(body.accountId);
    if (!conversation || !account?.isActive || account.userId !== user.id || conversation.instagramAccountId !== account.id) {
      throw new ApiError(404, "Conversation not found for this account.");
    }
    if (body.replyToMid && !(await getDb().prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND mid = ?").get(conversationId, body.replyToMid))) {
      throw new ApiError(400, "The message being replied to must belong to this conversation.");
    }
    try {
      return NextResponse.json(await sendAgentReply({ ...body, conversationId }));
    } catch (error) {
      if (error instanceof ReplyEligibilityError) throw new ApiError(error.status, error.message);
      throw new ApiError(502, "Instagram could not send this reply. Check the account connection and messaging window, then try again.");
    }
  });
}
