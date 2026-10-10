import * as Schema from "effect/Schema";

/**
 * The trading desk room: the shared chat the desk seats (bots) talk in, as the
 * server exposes it to clients over `/api/desk/*`.
 *
 * The source of truth is the desk's own chat file (`desk-chat/messages.json`
 * under `T3CODE_DESK_DIR`), written by the seats through their broker and by
 * the owner through the server. The server normalizes its records into
 * `DeskMessage` (the file's `reply_to` becomes `replyTo`); everything else is
 * carried verbatim so the room renders what the seats actually said.
 */

/** A seat is a desk bot. "user" is the owner and is never a seat. */
export const DeskSeatId = Schema.Literals([
  "strategy",
  "research",
  "risk",
  "dev",
  "astra",
  "executor",
]);
export type DeskSeatId = typeof DeskSeatId.Type;

/** Structured line in the desk-wire grammar (SIG, STG, DEC, RSK, FIL, Q, A, REQ, LSN, SYS). */
export const DeskWire = Schema.Struct({
  type: Schema.String,
  ticker: Schema.optional(Schema.NullOr(Schema.String)),
  kv: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  mentions: Schema.optional(Schema.Array(Schema.String)),
  reply: Schema.optional(Schema.NullOr(Schema.String)),
});
export type DeskWire = typeof DeskWire.Type;

export const DeskMessage = Schema.Struct({
  id: Schema.String,
  /** ISO-8601 UTC timestamp as the desk wrote it. */
  ts: Schema.String,
  /** Seat id, "user" for the owner, or another desk process such as "doctor". */
  profile: Schema.String,
  /** Raw text as posted; wire lines are terse. */
  message: Schema.String,
  /** Readable rendering the broker adds to wire lines. */
  human: Schema.optional(Schema.NullOr(Schema.String)),
  kind: Schema.optional(Schema.NullOr(Schema.String)),
  replyTo: Schema.optional(Schema.NullOr(Schema.String)),
  thread: Schema.optional(Schema.NullOr(Schema.String)),
  mentions: Schema.Array(Schema.String),
  wire: Schema.optional(Schema.NullOr(DeskWire)),
});
export type DeskMessage = typeof DeskMessage.Type;

export const DeskSeat = Schema.Struct({
  id: DeskSeatId,
  /** Persona name when the desk has one (Vector, Vantage, Ballast), else the role. */
  name: Schema.String,
  role: Schema.String,
  /** The seat's systemd unit is running. */
  active: Schema.Boolean,
  /** ISO-8601 timestamp of the seat's latest message in the room, if any. */
  lastSeenAt: Schema.NullOr(Schema.String),
});
export type DeskSeat = typeof DeskSeat.Type;

export const DeskState = Schema.Struct({
  messages: Schema.Array(DeskMessage),
  seats: Schema.Array(DeskSeat),
  /** Messages the desk currently retains (its file is capped). */
  total: Schema.Number,
  /** True when `after` was unknown and `messages` is a fresh tail, not a delta. */
  reset: Schema.Boolean,
  serverTime: Schema.String,
});
export type DeskState = typeof DeskState.Type;

export const DESK_POST_MAX_LENGTH = 4000;

export const DeskPostRequest = Schema.Struct({
  text: Schema.String,
});
export type DeskPostRequest = typeof DeskPostRequest.Type;

export const DeskPostResponse = Schema.Struct({
  message: DeskMessage,
});
export type DeskPostResponse = typeof DeskPostResponse.Type;

/** One server-sent event on `/api/desk/events`; the SSE `event:` field carries `type`. */
export const DeskEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("message"), message: DeskMessage }),
  Schema.Struct({ type: Schema.Literal("seats"), seats: Schema.Array(DeskSeat) }),
]);
export type DeskEvent = typeof DeskEvent.Type;

export const DESK_API_PREFIX = "/api/desk";
export const DESK_STATE_PATH = `${DESK_API_PREFIX}/state`;
export const DESK_EVENTS_PATH = `${DESK_API_PREFIX}/events`;
export const DESK_POST_PATH = `${DESK_API_PREFIX}/post`;
