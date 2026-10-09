import { after, NextRequest, NextResponse } from "next/server";
import { apiResponse, requireSession } from "@/lib/auth";
import { getAccountAccessToken, getAccountsByUser, toPublicAccount } from "@/lib/instagram";

export async function GET(request: NextRequest) {
  return apiResponse(async () => {
    const { user } = await requireSession(request);
    const activeAccounts = (await getAccountsByUser(user.id)).filter((account) => account.isActive);
    after(async () => { await Promise.allSettled(activeAccounts.map((account) => getAccountAccessToken(account.id))); });
    const accounts = activeAccounts.map(toPublicAccount);
    return NextResponse.json({ accounts });
  });
}
