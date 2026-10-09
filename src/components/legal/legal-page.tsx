import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BrandMark } from "@/components/brand/brand-mark";
import { getPrivacyContact } from "@/lib/privacy";

export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="min-h-dvh bg-background">
    <header className="mx-auto flex max-w-3xl items-center justify-between px-6 py-7 sm:px-8"><Link href="/" className="flex items-center gap-2.5 text-lg font-semibold tracking-tight"><BrandMark className="size-6 text-primary" />InstaLoom</Link><Link href="/" className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />Home</Link></header>
    <main className="mx-auto max-w-3xl px-6 pt-8 pb-14 sm:px-8">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-3 text-sm text-muted-foreground">Last updated: October 10, 2026</p>
      <div className="mt-9 space-y-8 text-sm leading-7 text-muted-foreground [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-foreground [&_li]:pl-1 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-5 [&_p+p]:mt-3 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">{children}</div>
    </main>
    <footer className="mx-auto flex max-w-3xl flex-wrap gap-x-6 gap-y-2 border-t px-6 py-6 text-xs text-muted-foreground sm:px-8"><Link href="/privacy" className="hover:text-foreground">Privacy policy</Link><Link href="/data-deletion" className="hover:text-foreground">Data deletion</Link></footer>
  </div>;
}

export function PrivacyContact() {
  const { name, email, url } = getPrivacyContact();
  return <section id="contact"><h2>Contact</h2><p>For privacy questions, access or correction requests, or deletion requests, contact {name}.</p>
    {email ? <p>Email: <a href={`mailto:${email}`}>{email}</a></p> : null}
    {url ? <p><a href={url} target="_blank" rel="noopener noreferrer">Contact the workspace operator</a></p> : null}
    {!email && !url ? <p>The operator has not published a contact address here yet. Contact the person who provided this workspace address before connecting your Instagram account.</p> : null}
  </section>;
}
