import { ApiError } from "@/lib/auth";
import { getAccountById } from "@/lib/instagram";

export async function requireAutomationAccount(accountId: string, userId: string) {
  const account = await getAccountById(accountId);
  if (!account?.isActive || account.userId !== userId) {
    throw new ApiError(404, "Instagram account not found.");
  }
  return account;
}
