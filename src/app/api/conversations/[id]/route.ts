import { after, NextRequest, NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { ApiError, apiResponse, readJson, requireSameOrigin, requireSession } from "@/lib/auth";
import { getAccountById, getConversationById, getMessages, markConversationRead, updateConversation } from "@/lib/instagram";
import { enrichCustomerProfile, needsCustomerProfile } from "@/lib/customer-profile";

const querySchema = z.object({
  before: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const updateSchema = z.object({
  folder: z.enum(["primary", "general", "requests"]).optional(),
  status: z.enum(["open", "closed", "archived"]).optional(),
  assignedTo: z.string().max(200).nullable().optional(),
  isRead: z.literal(true).optional(),
}).strict().refine((body) => Object.keys(body).length > 0);

async function ownedConversation(id: string, userId: string) {
  const conversation = await getConversationById(id);
  const account = conversation && await getAccountById(conversation.instagramAccountId);
  if (!conversation || !account?.isActive || account.userId !== userId) throw new ApiError(404, "Conversation not found.");
  return conversation;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return apiResponse(async () => {
    const { user } = await requireSession(request);
    const { id } = await params;
    const conversation = await ownedConversation(id, user.id);
    const result = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!result.success) throw new ApiError(400, "Invalid message pagination.");
    const { limit, before } = result.data;
    const messages = await getMessages(id, { before, limit: limit + 1 });
    if (needsCustomerProfile(conversation)) {
      try {
        after(() => enrichCustomerProfile(id, user.id));
      } catch (error) {
        unstable_rethrow(error);
        // Optional enrichment must not prevent reading messages if scheduling is unavailable.
      }
    }
    return NextResponse.json({ conversation, messages: messages.slice(0, limit), hasMore: messages.length > limit });
  });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return apiResponse(async () => {
    const { user } = await requireSession(request);
    requireSameOrigin(request);
    const { id } = await params;
    await ownedConversation(id, user.id);
    const { isRead, ...updates } = await readJson(request, updateSchema);
    if (updates.assignedTo !== undefined && updates.assignedTo !== null && updates.assignedTo !== user.id) {
      throw new ApiError(400, "Assign this conversation to the workspace owner or leave it unassigned.");
    }
    if (Object.keys(updates).length > 0) await updateConversation(id, updates);
    if (isRead) await markConversationRead(id);
    return NextResponse.json({ conversation: await getConversationById(id) });
  });
}
