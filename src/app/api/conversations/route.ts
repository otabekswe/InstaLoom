import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiResponse, requireSession } from "@/lib/auth";
import { getAccountById, getConversations } from "@/lib/instagram";

const querySchema = z.object({
  account_id: z.string().min(1).max(200),
  folder: z.enum(["primary", "general", "requests"]).optional(),
  status: z.enum(["open", "closed", "archived"]).optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export async function GET(request: NextRequest) {
  return apiResponse(async () => {
    const { user } = await requireSession(request);
    const result = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!result.success) throw new ApiError(400, "Invalid conversation filters or pagination.");
    const { account_id: accountId, ...options } = result.data;
    const account = await getAccountById(accountId);
    if (!account?.isActive || account.userId !== user.id) throw new ApiError(404, "Account not found.");
    const conversations = await getConversations(accountId, { ...options, limit: options.limit + 1 });
    return NextResponse.json({ conversations: conversations.slice(0, options.limit), hasMore: conversations.length > options.limit });
  });
}
