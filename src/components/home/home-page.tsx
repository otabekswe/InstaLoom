"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Camera, Loader2 } from "lucide-react";
import { BrandMark } from "@/components/brand/brand-mark";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/client";
import { oauthErrors } from "@/lib/oauth-errors";
import { InboxPreview } from "./inbox-preview";
import styles from "./home-page.module.css";

export function HomePage() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="InstaLoom home"><BrandMark /><span>InstaLoom</span></Link>
      </header>
      <main className={styles.hero}>
        <InboxPreview />
        <section className={styles.intro} aria-labelledby="home-title">
          <h1 id="home-title">Your inbox.<br />A little calmer.</h1>
          <p className={styles.description}>Instagram DMs and comments,<br className={styles.desktopBreak} /> together in one place.</p>
          <Suspense fallback={<Button disabled className={styles.connect}><Camera />Continue with Instagram<ArrowRight /></Button>}><ConnectButton /></Suspense>
          <p className={styles.note}>For Instagram professional accounts</p>
        </section>
      </main>
      <footer className="flex flex-wrap justify-center gap-x-5 gap-y-2 px-6 pb-6 text-xs text-muted-foreground"><Link href="/privacy" className="hover:text-foreground">Privacy policy</Link><Link href="/data-deletion" className="hover:text-foreground">Data deletion</Link></footer>
    </div>
  );
}

function ConnectButton() {
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const oauthError = searchParams.get("error");
  const message = error || (!attempted && oauthError ? oauthErrors[oauthError] || "The connection didn’t finish. Please try again." : null);

  async function connect() {
    if (loading) return;
    setLoading(true);
    setAttempted(true);
    setError(null);
    try {
      const data = await api<{ url: string }>("/api/auth/instagram");
      window.location.assign(data.url);
    } catch (cause) {
      setError(errorMessage(cause));
      setLoading(false);
    }
  }

  return <div className={styles.connectArea}>
    <Button onClick={connect} disabled={loading} className={styles.connect}>
      {loading ? <Loader2 className="animate-spin" /> : <Camera />}
      <span>{loading ? "Connecting…" : "Continue with Instagram"}</span>
      {!loading && <ArrowRight className={styles.connectArrow} />}
    </Button>
    {message && <p role="alert" className={styles.error}>{message}</p>}
  </div>;
}
