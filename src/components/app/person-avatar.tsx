"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { safeMediaUrl } from "@/lib/client";
import { cn } from "@/lib/utils";

export function PersonAvatar({ name, src, className }: { name: string; src?: string | null; className?: string }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "IG";
  return (
    <Avatar className={cn("size-10 shrink-0", className)}>
      <AvatarImage src={safeMediaUrl(src ?? null)} alt="" />
      <AvatarFallback className="bg-secondary text-xs font-medium text-muted-foreground">{initials}</AvatarFallback>
    </Avatar>
  );
}
