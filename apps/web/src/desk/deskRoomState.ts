/**
 * State for the desk room: the messages the seats and the owner exchanged, the
 * roster, and the connection status. The functions are pure so the merge rules
 * (delta, reset window, dedupe, pending posts) are tested without React or
 * network. The zustand store at the bottom only wraps them.
 */
import type { DeskMessage, DeskSeat } from "@t3tools/contracts";
import { create } from "zustand";

/** Messages kept in memory; the oldest are dropped past this. */
export const DESK_KEEP_LIMIT = 500;
/** Messages rendered before the owner asks for earlier ones. */
export const DESK_RENDER_LIMIT = 300;

export type DeskConnectionStatus = "connecting" | "live" | "polling" | "offline" | "disabled";

/** An owner message sent but not yet confirmed by the server. */
export interface DeskPendingPost {
  readonly localId: string;
  readonly text: string;
  readonly ts: string;
}

export interface DeskRoomData {
  /** Keyed by message id. Iteration order is not meaningful; use orderDeskMessages. */
  readonly messages: ReadonlyMap<string, DeskMessage>;
  readonly seats: readonly DeskSeat[];
  readonly connection: DeskConnectionStatus;
  readonly pending: readonly DeskPendingPost[];
}

export const INITIAL_DESK_ROOM_DATA: DeskRoomData = {
  messages: new Map(),
  seats: [],
  connection: "connecting",
  pending: [],
};

const timeOf = (message: Pick<DeskMessage, "ts">): number => {
  const time = Date.parse(message.ts);
  return Number.isNaN(time) ? 0 : time;
};

/** Oldest first; equal timestamps fall back to id so the order is stable. */
export function compareDeskMessages(a: DeskMessage, b: DeskMessage): number {
  const byTime = timeOf(a) - timeOf(b);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function orderDeskMessages(messages: ReadonlyMap<string, DeskMessage>): DeskMessage[] {
  return [...messages.values()].sort(compareDeskMessages);
}

/** The id to pass as `after` when catching up: the newest message in the room. */
export function lastDeskMessageId(messages: ReadonlyMap<string, DeskMessage>): string | null {
  let newest: DeskMessage | null = null;
  for (const message of messages.values()) {
    if (newest === null || compareDeskMessages(message, newest) > 0) newest = message;
  }
  return newest?.id ?? null;
}

/** Keeps the newest `limit` messages. */
function capMessages(
  messages: Map<string, DeskMessage>,
  limit: number = DESK_KEEP_LIMIT,
): Map<string, DeskMessage> {
  if (messages.size <= limit) return messages;
  const kept = orderDeskMessages(messages).slice(-limit);
  return new Map(kept.map((message) => [message.id, message]));
}

/**
 * Upserts incoming messages by id. An owner message whose text matches a
 * pending post and that is new to the room confirms that post, so the pending
 * copy disappears when the real one arrives over the stream.
 */
export function mergeDeskMessages(
  data: DeskRoomData,
  incoming: readonly DeskMessage[],
): DeskRoomData {
  if (incoming.length === 0) return data;
  const messages = new Map(data.messages);
  let pending = data.pending;
  for (const message of incoming) {
    const isNew = !messages.has(message.id);
    messages.set(message.id, message);
    if (isNew && message.profile === "user") {
      const text = message.message.trim();
      const index = pending.findIndex((post) => post.text.trim() === text);
      if (index !== -1) pending = pending.filter((_, position) => position !== index);
    }
  }
  return { ...data, messages: capMessages(messages), pending };
}

/**
 * Applies a `/api/desk/state` response. A delta merges into the room. A reset
 * replaces the window the tail covers and keeps older messages we already hold.
 * An empty reset means the desk has nothing, so the room is cleared.
 */
export function applyDeskSnapshot(
  data: DeskRoomData,
  snapshot: {
    readonly messages: readonly DeskMessage[];
    readonly seats: readonly DeskSeat[];
    readonly reset: boolean;
  },
): DeskRoomData {
  let next = data;
  if (snapshot.reset) {
    if (snapshot.messages.length === 0) {
      next = { ...data, messages: new Map() };
    } else {
      const times = snapshot.messages.map(timeOf);
      const start = Math.min(...times);
      const end = Math.max(...times);
      const messages = new Map(
        [...data.messages].filter(([, message]) => {
          const time = timeOf(message);
          return time < start || time > end;
        }),
      );
      next = { ...data, messages };
    }
  }
  next = mergeDeskMessages(next, snapshot.messages);
  return { ...next, seats: snapshot.seats };
}

export function setDeskSeats(data: DeskRoomData, seats: readonly DeskSeat[]): DeskRoomData {
  return { ...data, seats };
}

export function setDeskConnection(
  data: DeskRoomData,
  connection: DeskConnectionStatus,
): DeskRoomData {
  return data.connection === connection ? data : { ...data, connection };
}

export function addDeskPendingPost(data: DeskRoomData, post: DeskPendingPost): DeskRoomData {
  return { ...data, pending: [...data.pending, post] };
}

export function removeDeskPendingPost(data: DeskRoomData, localId: string): DeskRoomData {
  return { ...data, pending: data.pending.filter((post) => post.localId !== localId) };
}

/** The POST response confirmed a pending post: drop it and store the real message. */
export function confirmDeskPendingPost(
  data: DeskRoomData,
  localId: string,
  message: DeskMessage,
): DeskRoomData {
  const withoutPending = removeDeskPendingPost(data, localId);
  return mergeDeskMessages(withoutPending, [message]);
}

let pendingCounter = 0;

export function createDeskPendingPost(text: string, now: Date = new Date()): DeskPendingPost {
  pendingCounter += 1;
  return { localId: `pending-${now.getTime()}-${pendingCounter}`, text, ts: now.toISOString() };
}

interface DeskRoomStore extends DeskRoomData {
  readonly applySnapshot: (snapshot: Parameters<typeof applyDeskSnapshot>[1]) => void;
  readonly mergeMessages: (messages: readonly DeskMessage[]) => void;
  readonly setSeats: (seats: readonly DeskSeat[]) => void;
  readonly setConnection: (connection: DeskConnectionStatus) => void;
  readonly addPending: (post: DeskPendingPost) => void;
  readonly removePending: (localId: string) => void;
  readonly confirmPending: (localId: string, message: DeskMessage) => void;
  readonly reset: () => void;
}

export const useDeskRoomStore = create<DeskRoomStore>()((set) => ({
  ...INITIAL_DESK_ROOM_DATA,
  applySnapshot: (snapshot) => set((state) => applyDeskSnapshot(state, snapshot)),
  mergeMessages: (messages) => set((state) => mergeDeskMessages(state, messages)),
  setSeats: (seats) => set((state) => setDeskSeats(state, seats)),
  setConnection: (connection) => set((state) => setDeskConnection(state, connection)),
  addPending: (post) => set((state) => addDeskPendingPost(state, post)),
  removePending: (localId) => set((state) => removeDeskPendingPost(state, localId)),
  confirmPending: (localId, message) =>
    set((state) => confirmDeskPendingPost(state, localId, message)),
  reset: () => set({ ...INITIAL_DESK_ROOM_DATA, messages: new Map(), pending: [] }),
}));
