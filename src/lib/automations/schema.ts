import { z } from "zod";

export const channelSchema = z.enum(["dm", "post", "story"]);
export type AutomationChannel = z.infer<typeof channelSchema>;
export const replyTextSchema = z.string().trim().max(1000).refine((value) => new TextEncoder().encode(value).length <= 1000);
export const automationSchema = z.object({
  name: z.string().trim().min(1).max(80),
  accountId: z.string().min(1).max(200),
  channel: channelSchema,
  mediaId: z.string().max(512).default(""),
  enabled: z.boolean().default(false),
  matchAll: z.boolean(),
  keywords: z.array(z.string().trim().min(1).max(80)).max(20),
  publicReply: replyTextSchema.default(""),
  dmReply: replyTextSchema.default(""),
}).strict().refine((rule) => rule.channel === "dm" ? !rule.mediaId : !!rule.mediaId)
  .refine((rule) => rule.matchAll || rule.keywords.length > 0)
  .refine((rule) => rule.channel === "post" ? !!(rule.publicReply || rule.dmReply) : !!rule.dmReply && !rule.publicReply);
export type AutomationInput = z.infer<typeof automationSchema>;
export const updateAutomationSchema = automationSchema.safeExtend({ id: z.string().uuid() });
export const automationIdentitySchema = z.object({
  accountId: z.string().min(1).max(200),
  id: z.string().uuid(),
}).strict();
export const automationActionSchema = automationIdentitySchema.extend({
  action: z.enum(["enable", "pause", "move-up", "move-down"]),
}).strict();
export type AutomationRule = AutomationInput & { id: string; position: number; revision: string; enabledAt: number };
export type AutomationRun = { id: string; ruleId: string; action: "public" | "dm"; status: string; error: string | null; replyText: string; createdAt: number };
export type InstagramMedia = { id: string; channel: "post" | "story"; caption: string; mediaType: string; imageUrl: string | null; permalink: string | null; timestamp: string };
