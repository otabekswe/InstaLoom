import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { instagramAccountScope } from "@/lib/instagram/account-scope";
import type { AutomationInput, AutomationRule, AutomationChannel, AutomationRun } from "./schema";

type RuleRow = {
  id: string; account_id: string; channel: AutomationChannel; media_id: string; name: string;
  position: number; enabled: number; keywords: string; match_all: number; public_reply: string;
  dm_reply: string; revision: string; enabled_at: number;
};

function mapRule(row: RuleRow): AutomationRule {
  return {
    id: row.id, name: row.name, position: row.position, accountId: row.account_id,
    channel: row.channel, mediaId: row.media_id, enabled: !!row.enabled,
    keywords: JSON.parse(row.keywords), matchAll: !!row.match_all,
    publicReply: row.public_reply, dmReply: row.dm_reply,
    revision: row.revision, enabledAt: row.enabled_at,
  };
}

export async function getRules(accountId: string, channel: AutomationChannel): Promise<AutomationRule[]> {
  const rows = await getDb().prepare("SELECT * FROM automation_rules WHERE account_id = ? AND channel = ? ORDER BY position, id")
    .all(accountId, channel) as RuleRow[];
  return rows.map(mapRule);
}

export async function getRule(accountId: string, id: string): Promise<AutomationRule | undefined> {
  const row = await getDb().prepare("SELECT * FROM automation_rules WHERE account_id = ? AND id = ?")
    .get(accountId, id) as RuleRow | undefined;
  return row && mapRule(row);
}

export async function saveRule(input: AutomationInput): Promise<AutomationRule> {
  const db = getDb();
  return db.transaction(async () => {
    const id = randomUUID();
    const { position } = await db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM automation_rules WHERE account_id = ? AND channel = ? AND media_id = ?")
      .get(input.accountId, input.channel, input.mediaId) as { position: number };
    await db.prepare(`INSERT INTO automation_rules(id,account_id,channel,media_id,name,position,enabled,keywords,match_all,public_reply,dm_reply,revision,enabled_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.accountId, input.channel, input.mediaId, input.name, position, Number(input.enabled),
        JSON.stringify(input.keywords), Number(input.matchAll), input.publicReply, input.dmReply, randomUUID(), Date.now());
    return (await getRule(input.accountId, id))!;
  })();
}

export async function updateRule(id: string, input: AutomationInput): Promise<AutomationRule | undefined> {
  const db = getDb();
  return db.transaction(async () => {
    const result = await db.prepare(`UPDATE automation_rules SET name=?,enabled=?,keywords=?,match_all=?,public_reply=?,dm_reply=?,revision=?,enabled_at=?
      WHERE id=? AND account_id=? AND channel=? AND media_id=?`)
      .run(input.name, Number(input.enabled), JSON.stringify(input.keywords), Number(input.matchAll),
        input.publicReply, input.dmReply, randomUUID(), Date.now(), id, input.accountId, input.channel, input.mediaId);
    return result.changes ? getRule(input.accountId, id) : undefined;
  })();
}

export async function deleteRule(accountId: string, id: string): Promise<"deleted" | "missing" | "sending"> {
  const db = getDb();
  return db.transaction(async () => {
    if (!await getRule(accountId, id)) return "missing";
    // Claim and delete take the same database transaction lock. A claimed reply
    // may already be on its way to Instagram, so let that attempt finish first.
    if (await db.prepare("SELECT 1 FROM automation_runs WHERE rule_id = ? AND status = 'sending' AND updated_at > ? LIMIT 1")
      .get(id, Date.now() - 120_000)) return "sending";
    await db.prepare("DELETE FROM automation_rules WHERE account_id = ? AND id = ?").run(accountId, id);
    return "deleted";
  })();
}

export async function moveRule(accountId: string, id: string, direction: -1 | 1): Promise<AutomationRule[] | undefined> {
  const db = getDb();
  return db.transaction(async () => {
    const rule = await getRule(accountId, id);
    if (!rule) return undefined;
    const siblings = (await getRules(accountId, rule.channel)).filter((item) => item.mediaId === rule.mediaId);
    const index = siblings.findIndex((item) => item.id === id);
    const destination = index + direction;
    if (destination >= 0 && destination < siblings.length) {
      [siblings[index], siblings[destination]] = [siblings[destination], siblings[index]];
      const update = db.prepare("UPDATE automation_rules SET position = ? WHERE id = ? AND account_id = ?");
      for (const [position, item] of siblings.entries()) await update.run(position, item.id, accountId);
    }
    return getRules(accountId, rule.channel);
  })();
}

export async function getRuns(accountId: string, channel: AutomationChannel): Promise<AutomationRun[]> {
  // Keep eight recent results for each rule, with stable insertion ordering.
  return await getDb().prepare(`SELECT id,"ruleId",action,status,error,"replyText","createdAt" FROM (
    SELECT r.id,r.rule_id AS "ruleId",r.action,r.status,r.error,r.reply_text AS "replyText",r.created_at AS "createdAt",r.rowid AS "runOrder",
      ROW_NUMBER() OVER (PARTITION BY r.rule_id ORDER BY r.created_at DESC,r.rowid DESC) AS recent
    FROM automation_runs r JOIN automation_rules a ON a.id = r.rule_id WHERE a.account_id = ? AND a.channel = ?
    ) AS activity WHERE recent <= 8 ORDER BY "createdAt" DESC,"runOrder" DESC`)
    .all(accountId, channel) as AutomationRun[];
}

export function matchesRule(rule: Pick<AutomationRule, "matchAll" | "keywords">, text: string) {
  const normalized = text.normalize("NFKC").toLowerCase();
  return rule.matchAll || rule.keywords.some((keyword) => normalized.includes(keyword.normalize("NFKC").toLowerCase()));
}

type AutomationEvent = {
  accountId: string; channel: AutomationChannel; mediaId?: string; text: string;
  eventKey: string; customerId: string; conversationId: string; commentId?: string; timestamp: number;
};

/** Nested transaction shares the webhook receipt transaction, including its rollback. */
export async function enqueueAutomation(event: AutomationEvent): Promise<void> {
  const db = getDb();
  await db.transaction(async () => {
    const now = Date.now();
    if (event.timestamp < now - 3600_000 || event.timestamp > now + 300_000) return;
    const scope = instagramAccountScope("i");
    if (!await db.prepare(`SELECT 1 FROM instagram_accounts i WHERE i.id = ? AND i.is_active = 1 AND ${scope.sql}`)
      .get(event.accountId, ...scope.params)) return;
    // Choose a match before cooldown: never fall through to a second rule.
    const rule = (await getRules(event.accountId, event.channel)).find((item) => item.enabled
      && item.mediaId === (event.mediaId ?? "")
      && event.timestamp >= Math.floor(item.enabledAt / 1000) * 1000
      && matchesRule(item, event.text));
    if (!rule) return;
    if (await db.prepare("SELECT 1 FROM automation_runs WHERE rule_id = ? AND customer_id = ? AND created_at > ? LIMIT 1")
      .get(rule.id, event.customerId, now - 86400_000)) return;
    for (const [action, reply] of [["public", rule.publicReply], ["dm", rule.dmReply]]) {
      if (!reply) continue;
      await db.prepare(`INSERT OR IGNORE INTO automation_runs(id,rule_id,revision,event_key,customer_id,conversation_id,comment_id,action,reply_text,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), rule.id, rule.revision, event.eventKey,
        event.customerId, event.conversationId, event.commentId ?? null, action, reply, now, now);
    }
  })();
}
