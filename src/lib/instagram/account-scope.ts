import { getOwnerInstagramId } from "@/lib/config";

/** Only identities verified by this Meta app may access or process account data. */
export function instagramAccountScope(alias: "a" | "i" | "instagram_accounts") {
  const ownerId = getOwnerInstagramId();
  const sql = `EXISTS (SELECT 1 FROM instagram_identities verified
    WHERE verified.app_id = ? AND verified.subject = ${alias}.instagram_account_id
      AND verified.user_id = ${alias}.user_id)`;
  const params: string[] = [process.env.INSTAGRAM_APP_ID || ""];
  if (ownerId !== null) {
    params.push(ownerId);
    return { sql: `${sql} AND ${alias}.instagram_account_id = ?`, params };
  }
  return { sql, params };
}
