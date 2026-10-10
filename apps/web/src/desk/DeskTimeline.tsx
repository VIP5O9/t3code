import type { DeskMessage, DeskSeat } from "@t3tools/contracts";
import { ArrowDownIcon } from "lucide-react";
import {
  Fragment,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { DESK_RENDER_LIMIT, type DeskPendingPost } from "./deskRoomState";
import {
  deskMentionNames,
  formatDeskTime,
  seatAvatarClass,
  wireBadgeVariant,
} from "./deskPresentation";

/** Within this distance of the bottom, new messages keep the view pinned. */
const STICK_THRESHOLD_PX = 80;
/** Consecutive messages from one author within this gap share a header. */
const GROUP_GAP_MS = 5 * 60 * 1000;

type TimelineItem =
  | { readonly kind: "message"; readonly key: string; readonly message: DeskMessage }
  | { readonly kind: "pending"; readonly key: string; readonly post: DeskPendingPost };

interface Group {
  readonly profile: string;
  readonly ts: string;
  readonly items: TimelineItem[];
}

const timeOf = (ts: string) => {
  const time = Date.parse(ts);
  return Number.isNaN(time) ? 0 : time;
};

function groupItems(items: readonly TimelineItem[]): Group[] {
  const groups: Group[] = [];
  for (const item of items) {
    const profile = item.kind === "message" ? item.message.profile : "user";
    const ts = item.kind === "message" ? item.message.ts : item.post.ts;
    const last = groups.at(-1);
    const sameAuthor =
      last !== undefined &&
      last.profile === profile &&
      timeOf(ts) - timeOf(last.ts) <= GROUP_GAP_MS;
    if (sameAuthor) {
      last.items.push(item);
    } else {
      groups.push({ profile, ts, items: [item] });
    }
  }
  return groups;
}

export function DeskTimeline({
  messages,
  pending,
  seats,
  forceScrollToken,
}: {
  readonly messages: readonly DeskMessage[];
  readonly pending: readonly DeskPendingPost[];
  readonly seats: readonly DeskSeat[];
  /** Changing this value pins the view to the bottom (used after the owner sends). */
  readonly forceScrollToken: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const heightBeforeEarlierRef = useRef<number | null>(null);
  // Pinned and the last message seen are only written from scroll events, so the
  // view state follows what the reader actually sees instead of effect chains.
  const [view, setView] = useState<{ readonly pinned: boolean; readonly seenId: string | null }>({
    pinned: true,
    seenId: null,
  });
  const [showAll, setShowAll] = useState(false);

  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const visible = showAll ? messages : messages.slice(-DESK_RENDER_LIMIT);
  const hiddenCount = messages.length - visible.length;
  const lastId = messages.at(-1)?.id ?? null;
  const groups = useMemo(
    () =>
      groupItems([
        ...visible.map((message): TimelineItem => ({ kind: "message", key: message.id, message })),
        ...pending.map((post): TimelineItem => ({ kind: "pending", key: post.localId, post })),
      ]),
    [visible, pending],
  );
  const names = useMemo(() => deskMentionNames(seats), [seats]);

  const seenIndex = view.seenId === null ? -1 : messages.findIndex((m) => m.id === view.seenId);
  const unseen = view.pinned ? 0 : Math.max(0, messages.length - 1 - seenIndex);

  const scrollToBottom = () => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  };

  // Runs after every commit: while pinned, arriving messages and pending posts
  // keep the newest row in view.
  useLayoutEffect(() => {
    if (pinnedRef.current) scrollToBottom();
  });

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (forceScrollToken > 0 && element) element.scrollTop = element.scrollHeight;
  }, [forceScrollToken]);

  // Revealing earlier messages must not move the rows the owner is reading.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (showAll && element && heightBeforeEarlierRef.current !== null) {
      element.scrollTop += element.scrollHeight - heightBeforeEarlierRef.current;
    }
    heightBeforeEarlierRef.current = null;
  }, [showAll]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < STICK_THRESHOLD_PX;
    pinnedRef.current = atBottom;
    setView((current) =>
      current.pinned === atBottom && !atBottom
        ? current
        : { pinned: atBottom, seenId: atBottom ? lastId : current.seenId },
    );
  };

  const showEarlier = () => {
    heightBeforeEarlierRef.current = scrollRef.current?.scrollHeight ?? null;
    setShowAll(true);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="scrollbar-gutter-stable min-h-0 flex-1 overflow-y-auto overscroll-y-contain"
      >
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4 px-4 py-4">
          {hiddenCount > 0 ? (
            <div className="flex justify-center">
              <Button size="sm" variant="ghost" onClick={showEarlier}>
                Show earlier ({hiddenCount})
              </Button>
            </div>
          ) : null}
          {groups.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              The room is quiet. The seats post here when they have something to say.
            </p>
          ) : null}
          {groups.map((group) => (
            <DeskGroup
              key={group.items[0]?.key ?? group.ts}
              group={group}
              seats={seats}
              names={names}
              byId={byId}
            />
          ))}
        </div>
      </div>
      {unseen > 0 ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              pinnedRef.current = true;
              scrollToBottom();
            }}
          >
            <ArrowDownIcon />
            New messages
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function DeskGroup({
  group,
  seats,
  names,
  byId,
}: {
  readonly group: Group;
  readonly seats: readonly DeskSeat[];
  readonly names: ReadonlySet<string>;
  readonly byId: ReadonlyMap<string, DeskMessage>;
}) {
  const isOwner = group.profile === "user";
  const seat = seats.find((candidate) => candidate.id === group.profile);
  const displayName = isOwner ? "You" : (seat?.name ?? group.profile);
  const role = !isOwner && seat && seat.role !== seat.name ? seat.role : null;

  return (
    <section className={cn("flex gap-2.5", isOwner && "flex-row-reverse")} aria-label={displayName}>
      {isOwner ? null : (
        <span
          aria-hidden
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold uppercase",
            seatAvatarClass(group.profile),
          )}
        >
          {displayName.charAt(0)}
        </span>
      )}
      <div className={cn("flex min-w-0 flex-col gap-1", isOwner ? "items-end" : "items-start")}>
        <header className="flex items-baseline gap-1.5 px-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{displayName}</span>
          {role ? <span>{role}</span> : null}
          <time>{formatDeskTime(group.ts)}</time>
        </header>
        {group.items.map((item) =>
          item.kind === "message" ? (
            <DeskBubble
              key={item.key}
              message={item.message}
              owner={isOwner}
              names={names}
              replyTo={item.message.replyTo ? (byId.get(item.message.replyTo) ?? null) : null}
              seats={seats}
            />
          ) : (
            <div
              key={item.key}
              className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground opacity-60"
            >
              <p className="break-words whitespace-pre-wrap">{item.post.text}</p>
              <span className="text-xs">Sending…</span>
            </div>
          ),
        )}
      </div>
    </section>
  );
}

function DeskBubble({
  message,
  owner,
  names,
  replyTo,
  seats,
}: {
  readonly message: DeskMessage;
  readonly owner: boolean;
  readonly names: ReadonlySet<string>;
  readonly replyTo: DeskMessage | null;
  readonly seats: readonly DeskSeat[];
}) {
  const text = message.human?.trim() ? message.human : message.message;
  const wireType = message.wire?.type?.trim() ?? "";
  const replyName = replyTo
    ? replyTo.profile === "user"
      ? "You"
      : (seats.find((seat) => seat.id === replyTo.profile)?.name ?? replyTo.profile)
    : null;
  const mentionNames = new Set([...names, ...message.mentions.map((name) => name.toLowerCase())]);

  return (
    <div
      className={cn(
        "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
        owner
          ? "rounded-br-sm bg-primary text-primary-foreground"
          : "rounded-bl-sm border border-border bg-card text-card-foreground",
      )}
    >
      {replyTo ? (
        <blockquote className="mb-1.5 border-l-2 border-current/40 pl-2 text-xs opacity-80">
          <span className="font-medium">{replyName}</span>
          <span className="line-clamp-2 break-words">
            {" "}
            {(replyTo.human?.trim() ? replyTo.human : replyTo.message).slice(0, 160)}
          </span>
        </blockquote>
      ) : null}
      <p className="break-words whitespace-pre-wrap">{highlightMentions(text, mentionNames)}</p>
      <div className="mt-1 flex items-center gap-1.5 text-xs opacity-70">
        {wireType ? (
          <Badge size="sm" variant={wireBadgeVariant(wireType)}>
            {wireType}
          </Badge>
        ) : null}
        <time className="ml-auto">{formatDeskTime(message.ts)}</time>
      </div>
    </div>
  );
}

const MENTION = /@[A-Za-z][\w-]*/gu;

/** Renders `@name` tokens for known names as highlighted chips. Keys are character offsets. */
function highlightMentions(text: string, names: ReadonlySet<string>) {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(MENTION)) {
    const start = match.index;
    if (start > cursor) nodes.push(<Fragment key={cursor}>{text.slice(cursor, start)}</Fragment>);
    const token = match[0];
    nodes.push(
      names.has(token.slice(1).toLowerCase()) ? (
        <span key={start} className="rounded-sm bg-accent px-1 font-medium text-accent-foreground">
          {token}
        </span>
      ) : (
        <Fragment key={start}>{token}</Fragment>
      ),
    );
    cursor = start + token.length;
  }
  if (cursor < text.length) nodes.push(<Fragment key={cursor}>{text.slice(cursor)}</Fragment>);
  return nodes;
}
