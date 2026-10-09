import { z } from "zod";
import { getDb } from "@/lib/db";
import { instagramAccountScope } from "@/lib/instagram/account-scope";
import { getAccountById, getAccountAccessToken } from "@/lib/instagram";
import { graphRequest } from "@/lib/instagram/client";
import { sendAgentReply } from "@/lib/webhook";

type Job = { id: string; account_id: string; action: "dm" | "public"; conversation_id: string; comment_id: string | null; reply_text: string };
const STALE_SEND_MS = 120_000;
const QUEUE_EXPIRY_MS = 3600_000;

export async function hasQueuedAutomations(): Promise<boolean> {
  const scope = instagramAccountScope("i");
  return !!await getDb().prepare(`SELECT 1 FROM automation_runs r
    JOIN automation_rules a ON a.id = r.rule_id JOIN instagram_accounts i ON i.id = a.account_id
    WHERE r.status = 'queued' AND ${scope.sql} LIMIT 1`).get(...scope.params);
}

/** Database claims coordinate separate serverless invocations, including cron. */
export async function dispatchAutomations(): Promise<void> {
  const db = getDb();
  const scope = instagramAccountScope("i");
  const deadline = Date.now() + 45_000;
  await db.transaction(async () => {
    await db.prepare(`UPDATE automation_runs SET status='unknown',error='Delivery was interrupted. Check Instagram before sending again.',updated_at=?
      WHERE status='sending' AND updated_at < ? AND EXISTS (
        SELECT 1 FROM automation_rules a JOIN instagram_accounts i ON i.id=a.account_id
        WHERE a.id=automation_runs.rule_id AND ${scope.sql})`)
      .run(Date.now(), Date.now() - STALE_SEND_MS, ...scope.params);
  })();

  while (Date.now() < deadline) {
    const job = await db.transaction(async () => {
      await db.prepare(`UPDATE automation_runs SET status='skipped',error='Automation changed, paused, or delivery expired.',updated_at=?
        WHERE status='queued' AND EXISTS (
          SELECT 1 FROM automation_rules a JOIN instagram_accounts i ON i.id=a.account_id
          WHERE a.id=automation_runs.rule_id AND ${scope.sql})
        AND (created_at < ? OR NOT EXISTS (
          SELECT 1 FROM automation_rules a JOIN instagram_accounts i ON i.id=a.account_id
          WHERE a.id=automation_runs.rule_id AND a.enabled=1 AND a.revision=automation_runs.revision AND i.is_active=1))`)
        .run(Date.now(), ...scope.params, Date.now() - QUEUE_EXPIRY_MS);
      const next = await db.prepare(`SELECT r.*,a.account_id FROM automation_runs r
        JOIN automation_rules a ON a.id=r.rule_id JOIN instagram_accounts i ON i.id=a.account_id
        WHERE r.status='queued' AND ${scope.sql} AND NOT EXISTS (
          SELECT 1 FROM automation_runs active WHERE active.conversation_id=r.conversation_id AND active.status='sending')
        ORDER BY r.created_at,r.rowid LIMIT 1`).get(...scope.params) as Job | undefined;
      if (!next) return undefined;
      const claim = await db.prepare("UPDATE automation_runs SET status='sending',updated_at=? WHERE id=? AND status='queued'")
        .run(Date.now(), next.id);
      return claim.changes ? next : undefined;
    })();
    if (!job) return;

    // Never hold a database transaction while making an external request.
    try {
      const account = await getAccountById(job.account_id);
      if (!account?.isActive) throw new Error("Account disconnected");
      let resultId: string;
      if (job.action === "public") {
        if (!job.comment_id) throw new Error("Missing comment");
        const result = await graphRequest(`${encodeURIComponent(job.comment_id)}/replies`, await getAccountAccessToken(account.id),
          z.object({ id: z.string().min(1) }), { body: { message: job.reply_text } });
        resultId = result.id;
      } else {
        const result = await sendAgentReply({ accountId: account.id, conversationId: job.conversation_id,
          text: job.reply_text, ...(job.comment_id ? { commentId: job.comment_id } : {}) });
        resultId = result.messageId;
      }
      await db.prepare("UPDATE automation_runs SET status='sent',result_id=?,updated_at=? WHERE id=? AND status IN ('sending','unknown')")
        .run(resultId, Date.now(), job.id);
    } catch {
      // The provider may have accepted a request whose response was lost.
      // Failed/unknown rows are never changed back to queued automatically.
      await db.prepare("UPDATE automation_runs SET status='failed',error=?,updated_at=? WHERE id=? AND status IN ('sending','unknown')")
        .run("Could not confirm delivery. Check Instagram and the account connection; this reply will not retry automatically.", Date.now(), job.id);
    }
  }
}
