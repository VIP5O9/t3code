import type { DeskSeat } from "@t3tools/contracts";

import { formatRelativeTimeLabel } from "../timestampFormat";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { seatAvatarClass } from "./deskPresentation";

/** One chip per seat. Tapping a chip addresses that seat in the composer. */
export function DeskRoster({
  seats,
  onPick,
}: {
  readonly seats: readonly DeskSeat[];
  readonly onPick: (seatId: string) => void;
}) {
  if (seats.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 border-b border-border/60 px-4 py-2.5">
      {seats.map((seat) => (
        <Tooltip key={seat.id}>
          <TooltipTrigger
            render={
              <Button
                size="sm"
                variant="outline"
                aria-label={`Address ${seat.name}`}
                onClick={() => onPick(seat.id)}
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-5 items-center justify-center rounded-full text-3xs font-semibold uppercase",
                    seatAvatarClass(seat.id),
                  )}
                >
                  {seat.name.charAt(0)}
                </span>
                <span className="text-foreground">{seat.name}</span>
                <span className="text-muted-foreground">{seat.role}</span>
                <span
                  aria-label={seat.active ? "Active" : "Inactive"}
                  className={cn(
                    "size-1.5 rounded-full",
                    seat.active ? "bg-success" : "bg-muted-foreground/40",
                  )}
                />
              </Button>
            }
          />
          <TooltipPopup side="top">
            {seat.lastSeenAt
              ? `${seat.active ? "Active" : "Inactive"}, last seen ${formatRelativeTimeLabel(seat.lastSeenAt)}`
              : `${seat.active ? "Active" : "Inactive"}, not seen in the room yet`}
          </TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
}
