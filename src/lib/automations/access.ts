import { ApiError } from "@/lib/auth";
import { getOwnerInstagramId } from "@/lib/config";
import { getAccountById } from "@/lib/instagram";

export async function requireAutomationAccount(accountId: string, userId: string) {
  const account = await getAccountById(accountId);
  if (!account?.isActive || account.userId !== userId || account.instagramAccountId !== getOwnerInstagramId()) {
    throw new ApiError(404, "Instagram account not found.");
  }
  return account;
}
