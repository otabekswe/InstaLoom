import { NextRequest, NextResponse } from "next/server";
import { ApiError, apiResponse, requireSameOrigin, requireSession } from "@/lib/auth";
import { disconnectAccount } from "@/lib/instagram";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return apiResponse(async () => {
    const { user } = await requireSession(request);
    requireSameOrigin(request);
    const { id } = await params;
    if (!(await disconnectAccount(id, user.id))) throw new ApiError(404, "Account not found.");
    return NextResponse.json({ success: true });
  });
}
