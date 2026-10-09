"use client";

import { useId, useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { CircleHelp } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Hover help that also opens on keyboard focus or tap. */
export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const triggerId = useId();
  const descriptionId = useId();
  return <Popover.Root open={open} onOpenChange={setOpen} triggerId={triggerId}>
    <Popover.Trigger id={triggerId} aria-haspopup={false} openOnHover delay={150} closeDelay={100}
      onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) setOpen(true); }}
      render={<Button type="button" variant="ghost" size="icon-sm" aria-label={`About ${label}`} aria-describedby={open ? descriptionId : undefined} className="text-muted-foreground hover:text-foreground" />}>
      <CircleHelp className="size-3.5" />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="top" align="start" sideOffset={6} className="z-50">
        <Popover.Popup id={descriptionId} role="tooltip" initialFocus={false} finalFocus={false}
          className="w-72 max-w-[calc(100vw-2rem)] rounded-lg border bg-popover p-3 text-xs leading-5 text-popover-foreground shadow-sm outline-none transition-opacity duration-100 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 data-instant:duration-0">
          {children}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}
