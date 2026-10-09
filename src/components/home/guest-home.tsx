import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getSessionFromToken, SESSION_COOKIE } from "@/lib/auth";
import { HomePage } from "./home-page";

export function GuestHome() {
  return <Suspense fallback={null}><GuestHomeContent /></Suspense>;
}

async function GuestHomeContent() {
  // Validate expiry at navigation time, even when the page was prefetched.
  await connection();
  const cookieStore = await cookies();
  if (await getSessionFromToken(cookieStore.get(SESSION_COOKIE)?.value)) redirect("/inbox");
  return <HomePage />;
}
