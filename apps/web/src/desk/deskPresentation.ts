/** Presentation helpers for the desk room. Colours come from theme tokens only. */
import type { DeskSeat } from "@t3tools/contracts";

const SEAT_AVATAR_CLASS: Record<string, string> = {
  strategy: "bg-info text-info-foreground",
  research: "bg-success text-success-foreground",
  risk: "bg-warning text-warning-foreground",
  dev: "bg-update text-update-foreground",
  astra: "bg-secondary text-secondary-foreground",
  executor: "bg-destructive text-destructive-foreground",
};

export const seatAvatarClass = (profile: string) =>
  SEAT_AVATAR_CLASS[profile] ?? "bg-muted text-muted-foreground";

/** Badge tone per desk-wire family: signals and strategy blue, decisions and fills green, risk red. */
export function wireBadgeVariant(type: string) {
  switch (type) {
    case "SIG":
    case "STG":
      return "info";
    case "DEC":
    case "FIL":
      return "success";
    case "RSK":
      return "error";
    case "Q":
    case "A":
    case "REQ":
      return "secondary";
    default:
      return "outline";
  }
}

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/** HH:MM in the viewer's locale; empty when the timestamp does not parse. */
export function formatDeskTime(ts: string): string {
  const time = Date.parse(ts);
  return Number.isNaN(time) ? "" : TIME_FORMAT.format(time);
}

/** Names that a `@word` in a message should highlight: seat ids and persona names. */
export function deskMentionNames(seats: readonly DeskSeat[]): Set<string> {
  const names = new Set<string>();
  for (const seat of seats) {
    names.add(seat.id.toLowerCase());
    names.add(seat.name.toLowerCase());
  }
  return names;
}

export const DESK_SEAT_IDS = ["strategy", "research", "risk", "dev", "astra", "executor"] as const;
