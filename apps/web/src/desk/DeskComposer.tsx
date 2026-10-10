import type { DeskSeat } from "@t3tools/contracts";
import { SendHorizontalIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import { DESK_SEAT_IDS, seatAvatarClass } from "./deskPresentation";

const TRAILING_MENTION = /(?:^|\s)@([A-Za-z]*)$/u;

/** Seat ids matching the `@` being typed at the end of the draft; null when no mention is open. */
export function deskMentionQuery(draft: string): string | null {
  const match = TRAILING_MENTION.exec(draft);
  return match ? (match[1] ?? "").toLowerCase() : null;
}

/** Replaces the trailing `@partial` with `@seat `. */
export function completeDeskMention(draft: string, seatId: string): string {
  return draft.replace(/@[A-Za-z]*$/u, `@${seatId} `);
}

export function DeskComposer({
  draft,
  onDraftChange,
  seats,
  disabledReason,
  error,
  focusToken,
  onSend,
}: {
  readonly draft: string;
  readonly onDraftChange: (draft: string) => void;
  readonly seats: readonly DeskSeat[];
  readonly disabledReason: string | null;
  readonly error: string | null;
  /** Changing this value focuses the textarea (used after a seat chip is tapped). */
  readonly focusToken: number;
  readonly onSend: () => void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const seatIds = seats.length > 0 ? seats.map((seat) => seat.id) : [...DESK_SEAT_IDS];
  const query = dismissed ? null : deskMentionQuery(draft);
  const options = query === null ? [] : seatIds.filter((id) => id.startsWith(query));
  const activeIndex = options.length === 0 ? 0 : Math.min(highlight, options.length - 1);

  useEffect(() => {
    if (focusToken === 0) return;
    const textarea = wrapperRef.current?.querySelector("textarea");
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [focusToken]);

  const choose = (seatId: string) => {
    onDraftChange(completeDeskMention(draft, seatId));
    setHighlight(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (options.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((activeIndex + step + options.length) % options.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const pick = options[activeIndex];
        if (pick) choose(pick);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSend();
    }
  };

  return (
    <div className="border-t border-border/60 bg-background pb-safe">
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-2 px-4 py-3" ref={wrapperRef}>
        {options.length > 0 ? (
          <div
            role="listbox"
            aria-label="Seats"
            className="flex flex-wrap gap-1.5 rounded-xl border border-border bg-popover p-1.5"
          >
            {options.map((id, index) => (
              <button
                key={id}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-foreground",
                  index === activeIndex ? "bg-accent" : "hover:bg-accent/60",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-4 items-center justify-center rounded-full text-3xs font-semibold uppercase",
                    seatAvatarClass(id),
                  )}
                >
                  {id.charAt(0)}
                </span>
                @{id}
              </button>
            ))}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive-foreground">
            {error}
          </p>
        ) : null}
        {disabledReason ? <p className="text-sm text-muted-foreground">{disabledReason}</p> : null}
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Textarea
              aria-label="Message the desk"
              placeholder="Message the desk. Use @ to address a seat."
              value={draft}
              disabled={disabledReason !== null}
              rows={1}
              onChange={(event) => {
                setDismissed(false);
                setHighlight(0);
                onDraftChange(event.target.value);
              }}
              onKeyDown={onKeyDown}
            />
          </div>
          <Button
            aria-label="Send"
            size="icon-lg"
            variant="default"
            disabled={disabledReason !== null || draft.trim() === ""}
            onClick={onSend}
          >
            <SendHorizontalIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}
