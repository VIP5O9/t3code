/**
 * HTTP and SSE client for the desk room, plus the sync policy that keeps the
 * room current: reconnect with backoff, gap-fill after every stream open, and
 * polling when the stream keeps failing.
 */
import {
  DESK_EVENTS_PATH,
  DESK_POST_PATH,
  DESK_STATE_PATH,
  DeskMessage,
  DeskPostResponse,
  DeskSeat,
  DeskState,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import type { DeskConnectionStatus } from "./deskRoomState";

export type DeskApiErrorReason = "disabled" | "invalid_text" | "post_failed" | "http" | "network";

export class DeskApiError extends Error {
  readonly reason: DeskApiErrorReason;
  readonly status: number | null;

  constructor(reason: DeskApiErrorReason, message: string, status: number | null = null) {
    super(message);
    this.name = "DeskApiError";
    this.reason = reason;
    this.status = status;
  }
}

const isDeskDisabled = (error: unknown) =>
  error instanceof DeskApiError && error.reason === "disabled";

/**
 * Same credential rules as the primary HTTP layer: a desktop shell sends its
 * bearer token, a same-origin browser sends its session cookie, and anything
 * else sends nothing.
 */
async function primaryRequestInit(): Promise<RequestInit> {
  const bearerToken = await readDesktopPrimaryBearerToken();
  if (bearerToken) {
    return { credentials: "omit", headers: { authorization: `Bearer ${bearerToken}` } };
  }
  return { credentials: isSameOriginPrimary() ? "include" : "omit" };
}

function isSameOriginPrimary(): boolean {
  return new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin === window.location.origin;
}

async function responseError(response: Response): Promise<DeskApiError> {
  const body: unknown = await response.json().catch(() => null);
  const error = typeof body === "object" && body !== null && "error" in body ? body.error : null;
  if (response.status === 404 && error === "desk_disabled") {
    return new DeskApiError("disabled", "The desk is not configured on this environment.", 404);
  }
  if (response.status === 400 && error === "invalid_text") {
    return new DeskApiError(
      "invalid_text",
      "Messages must be non-empty and under the length limit.",
      400,
    );
  }
  if (response.status === 502) {
    return new DeskApiError("post_failed", "The desk could not deliver that message.", 502);
  }
  return new DeskApiError("http", `Desk request failed (${response.status}).`, response.status);
}

async function send(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...(await primaryRequestInit()), ...init });
  } catch (cause) {
    if (init.signal?.aborted) throw cause;
    throw new DeskApiError("network", "Could not reach this environment.");
  }
  if (!response.ok) throw await responseError(response);
  return response.json();
}

const decodeOrThrow = <A, I>(schema: Schema.Codec<A, I>, value: unknown): A => {
  const decoded = Schema.decodeUnknownOption(schema)(value);
  if (Option.isNone(decoded)) throw new DeskApiError("http", "Unexpected desk response.");
  return decoded.value;
};

/** `after` is the newest message id the room holds; omit it for the latest tail. */
export async function fetchDeskState(
  after: string | null,
  signal?: AbortSignal,
): Promise<DeskState> {
  const url = resolvePrimaryEnvironmentHttpUrl(DESK_STATE_PATH, after ? { after } : undefined);
  const body = await send(url, { cache: "no-store", ...(signal ? { signal } : {}) });
  return decodeOrThrow(DeskState, body);
}

export async function postDeskMessage(text: string): Promise<DeskMessage> {
  const url = resolvePrimaryEnvironmentHttpUrl(DESK_POST_PATH);
  const body = await send(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return decodeOrThrow(DeskPostResponse, body).message;
}

export interface DeskEventHandlers {
  readonly onOpen: () => void;
  readonly onMessage: (message: DeskMessage) => void;
  readonly onSeats: (seats: readonly DeskSeat[]) => void;
  readonly onError: () => void;
}

/**
 * One EventSource. Returns a close function. Reconnecting is the caller's job,
 * because the browser's own retry cannot be given the backoff the room needs.
 */
const decodeMessage = Schema.decodeUnknownOption(DeskMessage);
const decodeSeats = Schema.decodeUnknownOption(Schema.Array(DeskSeat));

export function openDeskEvents(handlers: DeskEventHandlers): () => void {
  const url = resolvePrimaryEnvironmentHttpUrl(DESK_EVENTS_PATH);
  const source = new EventSource(url, { withCredentials: isSameOriginPrimary() });
  const payload = (event: Event): unknown => {
    try {
      return JSON.parse(String((event as MessageEvent).data));
    } catch {
      return undefined;
    }
  };
  source.addEventListener("open", () => handlers.onOpen());
  source.addEventListener("message", (event) => {
    const message = decodeMessage(payload(event));
    if (Option.isSome(message)) handlers.onMessage(message.value);
  });
  source.addEventListener("seats", (event) => {
    const seats = decodeSeats(payload(event));
    if (Option.isSome(seats)) handlers.onSeats(seats.value);
  });
  source.addEventListener("error", () => handlers.onError());
  return () => source.close();
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;
/** Failed stream attempts before the room falls back to polling (retries wait 1s, 2s, 4s). */
const STREAM_FAILURES_BEFORE_POLLING = 4;
const POLL_INTERVAL_MS = 3_000;
const STREAM_RETRY_INTERVAL_MS = 30_000;

export interface DeskSyncHandlers {
  readonly getLastId: () => string | null;
  readonly onState: (state: DeskState) => void;
  readonly onMessage: (message: DeskMessage) => void;
  readonly onSeats: (seats: readonly DeskSeat[]) => void;
  readonly onConnection: (status: DeskConnectionStatus) => void;
}

/**
 * Keeps the room synced until the returned function is called.
 * Stream failures back off 1s, 2s, 4s; after the fourth failure the room polls
 * every 3s and retries the stream every 30s. Every stream open fills the gap
 * from the last message the room holds.
 */
export function startDeskSync(handlers: DeskSyncHandlers): () => void {
  const controller = new AbortController();
  let stopped = false;
  let failures = 0;
  let closeStream: (() => void) | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollActive = false;

  const clearRetry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };
  const clearPoll = () => {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
  };
  const dropStream = () => {
    closeStream?.();
    closeStream = null;
  };
  const stop = () => {
    stopped = true;
    pollActive = false;
    clearRetry();
    clearPoll();
    dropStream();
    controller.abort();
  };

  /** Fetches what came after the last message the room holds. Returns false on failure. */
  const catchUp = async (): Promise<boolean> => {
    try {
      const state = await fetchDeskState(handlers.getLastId(), controller.signal);
      if (stopped) return false;
      handlers.onState(state);
      return true;
    } catch (error) {
      if (stopped) return false;
      if (isDeskDisabled(error)) {
        stop();
        handlers.onConnection("disabled");
      } else {
        handlers.onConnection("offline");
      }
      return false;
    }
  };

  const poll = async () => {
    pollTimer = null;
    if (stopped || !pollActive) return;
    if (await catchUp()) handlers.onConnection("polling");
    if (!stopped && pollActive) pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
  };

  const openStream = () => {
    if (stopped) return;
    dropStream();
    closeStream = openDeskEvents({
      onOpen: () => {
        failures = 0;
        pollActive = false;
        clearRetry();
        clearPoll();
        handlers.onConnection("live");
        void catchUp();
      },
      onMessage: (message) => {
        if (!stopped) handlers.onMessage(message);
      },
      onSeats: (seats) => {
        if (!stopped) handlers.onSeats(seats);
      },
      onError: () => {
        if (stopped) return;
        dropStream();
        failures += 1;
        if (failures >= STREAM_FAILURES_BEFORE_POLLING) {
          handlers.onConnection("polling");
          if (!pollActive) {
            pollActive = true;
            void poll();
          }
          clearRetry();
          retryTimer = setTimeout(() => {
            retryTimer = null;
            openStream();
          }, STREAM_RETRY_INTERVAL_MS);
          return;
        }
        handlers.onConnection("connecting");
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** (failures - 1), RECONNECT_MAX_MS);
        clearRetry();
        retryTimer = setTimeout(() => {
          retryTimer = null;
          openStream();
        }, delay);
      },
    });
  };

  handlers.onConnection("connecting");
  // The fetch detects a disabled desk at once; the stream carries live updates.
  void catchUp();
  openStream();
  return stop;
}
