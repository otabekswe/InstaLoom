import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, PrivacyContact } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Data deletion · InstaLoom", description: "How to disconnect Instagram and request deletion of your data from this InstaLoom workspace." };

export default function DataDeletionPage() {
  return <LegalPage title="Data deletion">
    <p>You can request deletion of data associated with your Instagram account, including if you sent a message or comment to an account connected to this workspace. You do not need an InstaLoom login to make a request.</p>
    <section><h2>Request deletion</h2><ol>
      <li>Use the contact below and say that you want your data deleted from InstaLoom.</li>
      <li>Include your Instagram username and this workspace’s web address. If you contacted a business, include its Instagram username so the operator can locate the right conversation.</li>
      <li>The operator may ask you to confirm account ownership before removing the relevant records. Do not send your password or access token.</li>
    </ol><p>Relevant records can include account/profile information, stored messages and comments, attachment links, cached media, automation settings and delivery records, and sign-in information. The operator handles the request and can explain its completion status and any backup retention that applies.</p></section>
    <section><h2>Stop future access</h2><p>If you connected an account, open InstaLoom’s <Link href="/settings">Settings</Link> and choose Disconnect. You can also remove the app in Instagram’s Apps and Websites settings. Disconnecting clears the stored access token and stops new processing for the account; it does not delete existing history.</p></section>
    <section><h2>What this affects</h2><p>Requests cover data held by this workspace. They do not remove your Instagram account, original posts or comments, or messages held by Meta or other recipients. Backups and infrastructure logs are managed by the workspace operator and its service providers.</p></section>
    <PrivacyContact />
    <p>Read the <Link href="/privacy">privacy policy</Link> for details about how this workspace uses data.</p>
  </LegalPage>;
}
