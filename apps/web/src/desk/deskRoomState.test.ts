import type { DeskMessage, DeskSeat } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DESK_KEEP_LIMIT,
  applyDeskSnapshot,
  confirmDeskPendingPost,
  createDeskPendingPost,
  INITIAL_DESK_ROOM_DATA,
  lastDeskMessageId,
  mergeDeskMessages,
  orderDeskMessages,
  type DeskRoomData,
} from "./deskRoomState";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 10, 12, minute)).toISOString();

const message = (
  id: string,
  minute: number,
  overrides: Partial<DeskMessage> = {},
): DeskMessage => ({
  id,
  ts: at(minute),
  profile: "strategy",
  message: `text ${id}`,
  mentions: [],
  ...overrides,
});

const ids = (data: DeskRoomData) => orderDeskMessages(data.messages).map((item) => item.id);

const seat: DeskSeat = {
  id: "strategy",
  name: "Vector",
  role: "strategy",
  active: true,
  lastSeenAt: null,
};

describe("deskRoomState", () => {
  it("merges a delta after the messages already held", () => {
    const start = mergeDeskMessages(INITIAL_DESK_ROOM_DATA, [message("a", 1), message("b", 2)]);
    const next = applyDeskSnapshot(start, {
      messages: [message("c", 3)],
      seats: [seat],
      reset: false,
    });
    expect(ids(next)).toEqual(["a", "b", "c"]);
    expect(next.seats).toEqual([seat]);
    expect(lastDeskMessageId(next.messages)).toBe("c");
  });

  it("reset replaces the window the tail covers and keeps older messages", () => {
    const start = mergeDeskMessages(INITIAL_DESK_ROOM_DATA, [
      message("old", 0),
      message("stale", 5),
      message("kept-newer", 9),
    ]);
    const next = applyDeskSnapshot(start, {
      messages: [message("t1", 4), message("t2", 6)],
      seats: [],
      reset: true,
    });
    expect(ids(next)).toEqual(["old", "t1", "t2", "kept-newer"]);
  });

  it("reset with an empty tail clears the room", () => {
    const start = mergeDeskMessages(INITIAL_DESK_ROOM_DATA, [message("a", 1)]);
    const next = applyDeskSnapshot(start, { messages: [], seats: [], reset: true });
    expect(ids(next)).toEqual([]);
  });

  it("dedupes repeated ids and keeps the latest copy", () => {
    const first = mergeDeskMessages(INITIAL_DESK_ROOM_DATA, [message("a", 1)]);
    const second = mergeDeskMessages(first, [message("a", 1, { message: "edited" })]);
    expect(second.messages.size).toBe(1);
    expect(second.messages.get("a")?.message).toBe("edited");
  });

  it("orders by timestamp regardless of arrival order", () => {
    const data = mergeDeskMessages(INITIAL_DESK_ROOM_DATA, [
      message("late", 9),
      message("early", 1),
      message("mid", 5),
    ]);
    expect(ids(data)).toEqual(["early", "mid", "late"]);
  });

  it("keeps only the newest messages past the cap", () => {
    const batch = Array.from({ length: DESK_KEEP_LIMIT + 20 }, (_, index) =>
      message(`m${String(index).padStart(4, "0")}`, index),
    );
    const data = mergeDeskMessages(INITIAL_DESK_ROOM_DATA, batch);
    expect(data.messages.size).toBe(DESK_KEEP_LIMIT);
    expect(ids(data)[0]).toBe("m0020");
  });

  it("replaces a pending post with the real message when the POST response arrives", () => {
    const pending = createDeskPendingPost("buy the dip?", new Date(Date.UTC(2026, 9, 10)));
    const withPending = { ...INITIAL_DESK_ROOM_DATA, pending: [pending] };
    const real = message("u1", 3, { profile: "user", message: "buy the dip?" });
    const next = confirmDeskPendingPost(withPending, pending.localId, real);
    expect(next.pending).toEqual([]);
    expect(ids(next)).toEqual(["u1"]);
  });

  it("drops a pending post when its real message arrives over the stream first", () => {
    const pending = createDeskPendingPost("hold", new Date(Date.UTC(2026, 9, 10)));
    const withPending = { ...INITIAL_DESK_ROOM_DATA, pending: [pending] };
    const next = mergeDeskMessages(withPending, [
      message("u2", 4, { profile: "user", message: "hold" }),
    ]);
    expect(next.pending).toEqual([]);
    expect(ids(next)).toEqual(["u2"]);
  });

  it("does not drop a pending post for an old duplicate already in the room", () => {
    const old = message("u0", 1, { profile: "user", message: "hold" });
    const start = {
      ...mergeDeskMessages(INITIAL_DESK_ROOM_DATA, [old]),
      pending: [createDeskPendingPost("hold")],
    };
    const next = mergeDeskMessages(start, [old]);
    expect(next.pending).toHaveLength(1);
  });
});
