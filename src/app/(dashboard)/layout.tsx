"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Inbox, Camera, LogOut, Settings, Loader2, ImageIcon, CirclePlay } from "lucide-react";
import { BrandMark } from "@/components/brand/brand-mark";
import { toast } from "sonner";
import { AppProvider, useApp } from "@/components/app/app-context";
import { PersonAvatar } from "@/components/app/person-avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/client";
import { cn } from "@/lib/utils";

const navigation = [
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/post", label: "Post", icon: ImageIcon },
  { href: "/story", label: "Story", icon: CirclePlay },
  { href: "/settings", label: "Settings", icon: Settings },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <AppProvider><AppShell>{children}</AppShell></AppProvider>;
}

function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, accounts, loading } = useApp();
  const [signingOut, setSigningOut] = useState(false);
  async function signOut() {
    setSigningOut(true);
    try {
      await api("/api/auth/logout", { method: "POST" });
      router.replace("/login");
      router.refresh();
    } catch (error) { toast.error(errorMessage(error)); setSigningOut(false); }
  }
  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden lg:flex-row">
      <a href="#main-content" className="sr-only z-50 bg-card p-3 focus:not-sr-only focus:absolute">Skip to content</a>
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-background lg:flex" aria-label="Workspace navigation">
        <Link href="/inbox" className="flex h-20 items-center gap-2.5 px-6 font-semibold tracking-tight">
          <BrandMark className="size-6 text-primary" />
          <span className="text-lg">InstaLoom</span>
        </Link>
        <div className="mx-4 mb-7 flex items-center gap-3 rounded-lg border bg-card px-3 py-3">
          <Camera className="size-4 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-xs font-medium">Instagram workspace</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{loading ? "Loading accounts…" : `${accounts.length} connected ${accounts.length === 1 ? "account" : "accounts"}`}</p>
          </div>
        </div>
        <nav className="space-y-1 px-3">
          {navigation.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} aria-current={pathname.startsWith(href) ? "page" : undefined}
              className={cn("app-transition flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium", pathname.startsWith(href) ? "bg-accent text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground")}>
              <Icon className="size-[18px]" strokeWidth={1.8} />{label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto p-4">
          <div className="flex items-center gap-2.5 border-t pt-4">
            {loading ? <Skeleton className="size-8 rounded-full" /> : <PersonAvatar name={user?.name || "Instagram account"} className="size-8" />}
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{user?.name || "Instagram account"}</p>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">Connected with Instagram</p>
            </div>
            <Button variant="ghost" size="icon" aria-label="Sign out" title="Sign out" onClick={signOut} disabled={signingOut}>
              {signingOut ? <Loader2 className="animate-spin" /> : <LogOut />}
            </Button>
          </div>
        </div>
      </aside>
      <header className="shrink-0 border-b bg-card lg:hidden">
        <div className="flex h-14 items-center justify-between px-4"><Link href="/inbox" className="flex items-center gap-2 font-semibold tracking-tight"><BrandMark className="size-5 text-primary" />InstaLoom</Link><Button variant="ghost" size="icon-lg" aria-label="Sign out" onClick={signOut} disabled={signingOut}><LogOut /></Button></div>
        <nav className="grid grid-cols-4 px-2" aria-label="Workspace navigation">
          {navigation.map(({ href, label, icon: Icon }) => (
            <Link href={href} key={href} aria-current={pathname.startsWith(href) ? "page" : undefined} className={cn("flex items-center justify-center gap-1.5 border-b-2 px-1 py-3 text-xs font-medium", pathname.startsWith(href) ? "border-primary text-primary" : "border-transparent text-muted-foreground")}><Icon className="size-4" />{label}</Link>
          ))}
        </nav>
      </header>
      <main id="main-content" className="min-h-0 min-w-0 flex-1 overflow-hidden bg-card">{children}</main>
    </div>
  );
}
