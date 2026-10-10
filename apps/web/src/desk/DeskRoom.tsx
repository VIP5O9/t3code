import { useMemo, useState } from "react";
import { MessagesSquareIcon } from "lucide-react";

import { isElectron } from "../env";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset, useSidebar } from "../components/ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { cn } from "../lib/utils";
import { DeskComposer } from "./DeskComposer";
import { DeskRoster } from "./DeskRoster";
import { DeskTimeline } from "./DeskTimeline";
import { sendDeskText, useDeskRoomSync } from "./useDeskRoom";
import { DeskApiError } from "./deskApi";
import { orderDeskMessages, useDeskRoomStore, type DeskConnectionStatus } from "./deskRoomState";

const MAX_MESSAGE_LENGTH = 4000;

const CONNECTION_LABEL: Record<DeskConnectionStatus, { label: string; dot: string }> = {
  connecting: { label: "Connecting", dot: "bg-warning" },
  live: { label: "Live", dot: "bg-success" },
  polling: { label: "Polling", dot: "bg-info" },
  offline: { label: "Offline", dot: "bg-destructive" },
  disabled: { label: "Not set up", dot: "bg-muted-foreground/50" },
};

/** The desk room: the seats and the owner in one live chat. */
export function DeskRoom() {
  useDeskRoomSync();
  const messages = useDeskRoomStore((state) => state.messages);
  const seats = useDeskRoomStore((state) => state.seats);
  const connection = useDeskRoomStore((state) => state.connection);
  const pending = useDeskRoomStore((state) => state.pending);
  const ordered = useMemo(() => orderDeskMessages(messages), [messages]);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [scrollToken, setScrollToken] = useState(0);

  const pickSeat = (seatId: string) => {
    setDraft((current) => {
      const separator = current === "" || /\s$/u.test(current) ? "" : " ";
      return `${current}${separator}@${seatId} `;
    });
    setFocusToken((token) => token + 1);
  };

  const send = async () => {
    const text = draft.trim();
    if (text === "" || sending) return;
    if (text.length > MAX_MESSAGE_LENGTH) {
      setError(`Messages can be at most ${MAX_MESSAGE_LENGTH} characters.`);
      return;
    }
    setError(null);
    setSending(true);
    setDraft("");
    setScrollToken((token) => token + 1);
    try {
      await sendDeskText(text);
    } catch (cause) {
      setDraft((current) => (current === "" ? text : current));
      setError(cause instanceof DeskApiError ? cause.message : "Could not send the message.");
    } finally {
      setSending(false);
    }
  };

  const status = CONNECTION_LABEL[connection];
  const disabledReason =
    connection === "offline"
      ? "Offline. Messages can't be sent until the connection returns."
      : null;

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Desk breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Desk</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="min-w-0 flex-1" />
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden className={cn("size-2 rounded-full", status.dot)} />
            {status.label}
          </span>
        </WorkspacePageHeader>

        {connection === "disabled" ? (
          <DeskDisabledState />
        ) : (
          <>
            <div className="mx-auto flex w-full max-w-[860px] flex-col">
              <DeskRoster seats={seats} onPick={pickSeat} />
            </div>
            <DeskTimeline
              messages={ordered}
              pending={pending}
              seats={seats}
              forceScrollToken={scrollToken}
            />
            <DeskComposer
              draft={draft}
              onDraftChange={setDraft}
              seats={seats}
              disabledReason={disabledReason}
              error={error}
              focusToken={focusToken}
              onSend={() => void send()}
            />
          </>
        )}
      </div>
    </SidebarInset>
  );
}

function DeskDisabledState() {
  const { toggleSidebar } = useSidebar();
  return (
    <div className="flex min-h-0 flex-1 px-4">
      <Empty>
        <EmptyHeader className="max-w-md">
          <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground">
            <MessagesSquareIcon className="size-5" />
          </div>
          <EmptyTitle>The desk is not set up here</EmptyTitle>
          <EmptyDescription>
            This environment has no trading desk configured. Set T3CODE_DESK_DIR on the server to
            the desk directory and restart it. Your threads are unaffected.
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button size="sm" variant="outline" onClick={toggleSidebar}>
              Show threads
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
