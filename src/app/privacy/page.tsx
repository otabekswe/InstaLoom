import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, PrivacyContact } from "@/components/legal/legal-page";
import { getPrivacyContact } from "@/lib/privacy";

export const metadata: Metadata = { title: "Privacy policy · InstaLoom", description: "How this InstaLoom workspace uses Instagram data and how to request deletion." };

export default function PrivacyPage() {
  const { name } = getPrivacyContact();
  return <LegalPage title="Privacy policy">
    <p>InstaLoom is an open-source, self-hosted workspace for Instagram messages, comments, story replies, and reply automations. This policy describes this installation, operated by {name}. Other installations are managed by their own operators.</p>
    <section><h2>Information we process</h2><ul>
      <li>Connected Instagram account IDs, usernames, display names, and profile picture URLs.</li>
      <li>Instagram access tokens and their expiration dates, used to access the features you authorize.</li>
      <li>Messages, comments, story replies, sender identifiers and available profile details, timestamps, read status, and attachment URLs received through Instagram.</li>
      <li>Post and story IDs, captions, media URLs, and publication dates used to select content for automations.</li>
      <li>Reply rules, keywords, reply text, and delivery results; workspace sign-in sessions and connection records.</li>
    </ul><p>Instagram handles authorization. InstaLoom does not ask for or store your Instagram password.</p></section>
    <section><h2>How information is used</h2><p>Information is used to sign you in, connect your professional account, display conversations and media, send replies you request, run automations you enable, and prevent duplicate replies. People who message or comment on a connected account may have their interaction stored for these purposes.</p></section>
    <section><h2>Storage and retention</h2><p>Workspace data is stored in the operator’s local database or configured managed Postgres service. Access tokens are used on the server and are not included in dashboard API responses. The operator controls hosting, database access, and backups.</p><p>This version does not automatically delete conversation history after a fixed period. Stored history and automation records remain until the operator deletes them. Disconnecting an account removes its stored access token and stops new processing for that account, but keeps existing records.</p></section>
    <section><h2>Sharing and external services</h2><p>Instagram data and outgoing replies are exchanged with Meta’s Instagram APIs. Authorized workspace users and the server operator can access workspace data. Hosting and network providers may process connection information, such as IP addresses and request logs, to deliver this service. Loading Instagram media also makes requests to Meta’s media servers.</p><p>The InstaLoom application does not include advertising trackers or a feature for selling personal data. Meta and infrastructure providers process information under their own policies.</p></section>
    <section><h2>Cookies</h2><p>Essential cookies maintain your sign-in session and secure the Instagram authorization flow. Sign-in sessions expire after seven days; authorization-flow cookies expire after ten minutes. Signing out revokes the current workspace session.</p></section>
    <section><h2>Your choices and deletion</h2><p>You can pause automations, disconnect an account in Settings, or revoke InstaLoom’s authorization through Instagram’s Apps and Websites settings. Revoking access does not automatically erase the copy already stored in this workspace.</p><p>To request access, correction, or deletion of your stored data, use the contact below. See the <Link href="/data-deletion">data deletion instructions</Link> for the information needed to locate your records. The operator may ask for verification of account ownership. Deleting data here does not delete content from Instagram or a recipient’s account.</p></section>
    <PrivacyContact />
    <section><h2>Policy changes</h2><p>Changes to this installation’s data practices should be reflected on this page with an updated date.</p></section>
  </LegalPage>;
}
