import Link from "next/link";
import { Camera, MessageSquare } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

export function EmptyState({ type }: { type: "no-accounts" | "no-conversation" }) {
  const connect = type === "no-accounts";
  const Icon = connect ? Camera : MessageSquare;
  return (
    <div className="max-w-[320px] px-5 text-center">
      <Icon className="mx-auto mb-5 size-9 text-muted-foreground/60" strokeWidth={1.2} />
      <h2 className="text-lg font-medium tracking-tight">{connect ? "Your inbox starts here" : "Space for a conversation"}</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{connect ? "Connect an Instagram professional account to bring your messages and comments together." : "Choose a conversation on the left to read messages and send a reply."}</p>
      {connect && <Link href="/settings" className={buttonVariants({ className: "mt-6 h-10 px-4" })}><Camera />Connect Instagram</Link>}
    </div>
  );
}
