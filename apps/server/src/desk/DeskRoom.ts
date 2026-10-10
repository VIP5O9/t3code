/**
 * Desk room: the trading desk's shared chat, as authenticated clients see it.
 *
 * The chat file under `T3CODE_DESK_DIR` is the source of truth. The seats write
 * it through their broker, and the owner posts through the desk's own Python
 * helper so locking and @mention parsing match the seats'. Reads re-check the
 * file, and a poller pushes new messages and seat changes to subscribers.
 *
 * @module DeskRoom
 */
import {
  DESK_POST_MAX_LENGTH,
  DeskMessage,
  DeskSeatId,
  type DeskEvent,
  type DeskPostResponse,
  type DeskSeat,
  type DeskState,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const DESK_SEATS = DeskSeatId.literals;

/** Persona names where the desk has them; the other seats show their role, capitalized. */
const SEAT_NAMES: Record<DeskSeatId, string> = {
  strategy: "Vector",
  research: "Vantage",
  risk: "Ballast",
  dev: "Dev",
  astra: "Astra",
  executor: "Executor",
};

const CHAT_DIR = "desk-chat";
const CHAT_FILE = "messages.json";
/** Messages served when the client has no known cursor. */
const TAIL_LENGTH = 300;
const POLL_INTERVAL = Duration.seconds(1);
/** A subscriber that stops reading drops its oldest events instead of growing without bound. */
const PUBSUB_CAPACITY = 256;
const PRESENCE_TTL_MS = 10_000;
const PRESENCE_TIMEOUT = Duration.seconds(5);
const SEATS_HEARTBEAT_MS = 30_000;
const POST_TIMEOUT = Duration.seconds(10);
const POST_DETAIL_MAX_LENGTH = 300;
/** The helper's own entry point; the chat directory is its import root. */
const POST_SCRIPT =
  "import sys, json; sys.path.insert(0, sys.argv[1]); import desk_post; print(json.dumps(desk_post.post('user', sys.argv[2], kind='talk', quiet=True)))";

const ChatFile = Schema.fromJsonString(Schema.Array(Schema.Unknown));
const parseChatFile = Schema.decodeUnknownOption(ChatFile);
const parseJsonValue = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export class DeskDisabledError extends Schema.TaggedError<DeskDisabledError>()(
  "DeskDisabledError",
  {},
) {
  override get message(): string {
    return "The desk room is disabled on this server.";
  }
}

export class DeskInvalidTextError extends Schema.TaggedError<DeskInvalidTextError>()(
  "DeskInvalidTextError",
  {},
) {
  override get message(): string {
    return `Desk messages must be 1 to ${DESK_POST_MAX_LENGTH} characters.`;
  }
}

export class DeskPostFailedError extends Schema.TaggedError<DeskPostFailedError>()(
  "DeskPostFailedError",
  {
    /** Bounded tail of the helper's stderr; the message itself stays fixed. */
    detail: Schema.String,
  },
) {
  override get message(): string {
    return "The desk helper could not post the message.";
  }
}

export class DeskRoom extends Context.Service<
  DeskRoom,
  {
    /** False when T3CODE_DESK_DIR is unset or empty; every method then fails with DeskDisabledError. */
    readonly enabled: boolean;
    /** Messages after `after`, or the last TAIL_LENGTH with `reset` when `after` is absent or unknown. */
    readonly state: (after?: string) => Effect.Effect<DeskState, DeskDisabledError>;
    readonly events: Stream.Stream<DeskEvent, DeskDisabledError>;
    readonly post: (
      text: string,
    ) => Effect.Effect<
      DeskPostResponse,
      DeskDisabledError | DeskInvalidTextError | DeskPostFailedError
    >;
  }
>()("t3/desk/DeskRoom") {}

interface MakeOptions {
  /** Absolute desk directory. Undefined or blank disables the room. */
  readonly deskDir: string | undefined;
  /** Seat activity keyed by seat id. Defaults to `systemctl is-active` on the seat units. */
  readonly presence?: Effect.Effect<Readonly<Record<string, boolean>>>;
  readonly pollInterval?: Duration.Input;
}

interface Snapshot {
  /** mtime and size at the last successful parse; undefined until the first one. */
  readonly signature: string | undefined;
  readonly messages: ReadonlyArray<DeskMessage>;
}

interface PresenceCache {
  readonly at: number;
  readonly active: Readonly<Record<string, boolean>>;
}

interface SeatsCache {
  readonly at: number;
  readonly key: string;
}

/**
 * Maps one file entry to the contract shape: `reply_to` becomes `replyTo`, a
 * missing `mentions` becomes [], and an entry the contract cannot decode is
 * dropped rather than failing the whole room.
 */
const toDeskMessage = (entry: unknown): Option.Option<DeskMessage> => {
  if (typeof entry !== "object" || entry === null) return Option.none();
  const { reply_to: replyTo, ...rest } = entry as Record<string, unknown>;
  return Schema.decodeUnknownOption(DeskMessage)({
    ...rest,
    ...(replyTo === undefined ? {} : { replyTo }),
    mentions: Array.isArray(rest.mentions) ? rest.mentions : [],
  });
};

const seatsOf = (
  active: Readonly<Record<string, boolean>>,
  messages: ReadonlyArray<DeskMessage>,
): ReadonlyArray<DeskSeat> => {
  const lastSeen = new Map<string, string>();
  for (const message of messages) lastSeen.set(message.profile, message.ts);
  return DESK_SEATS.map((id) => ({
    id,
    name: SEAT_NAMES[id],
    role: id,
    active: active[id] === true,
    lastSeenAt: lastSeen.get(id) ?? null,
  }));
};

/** Runs a command to completion and returns its stdout, stderr, and exit code. */
const runCommand = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: ChildProcess.Command,
) =>
  Effect.scoped(
    spawner
      .spawn(command)
      .pipe(
        Effect.flatMap((handle) =>
          Effect.all(
            [
              handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
              handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          ),
        ),
      ),
  );

const INACTIVE = Object.fromEntries(DESK_SEATS.map((seat): [string, boolean] => [seat, false]));

/**
 * One `systemctl is-active` for all six seats. Its exit code is non-zero when
 * any seat is down, so only stdout counts; a failed or slow call reads as down.
 */
const systemctlPresence = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  runCommand(
    spawner,
    ChildProcess.make(
      "systemctl",
      ["is-active", ...DESK_SEATS.map((seat) => `desk-agent@${seat}.service`)],
      { stdin: "ignore" },
    ),
  ).pipe(
    Effect.timeout(PRESENCE_TIMEOUT),
    Effect.map(([stdout]) => {
      const states = stdout.split("\n").map((line) => line.trim());
      return Object.fromEntries(
        DESK_SEATS.map((seat, index): [string, boolean] => [seat, states[index] === "active"]),
      );
    }),
    Effect.orElseSucceed(() => INACTIVE),
  );

export const make = (options: MakeOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const deskDir = options.deskDir?.trim() ?? "";
    const enabled = deskDir.length > 0;
    const chatDir = path.join(deskDir, CHAT_DIR);
    const chatFile = path.join(chatDir, CHAT_FILE);
    const readPresence = options.presence ?? systemctlPresence(spawner);

    const pubsub = yield* PubSub.sliding<DeskEvent>(PUBSUB_CAPACITY);
    const snapshot = yield* Ref.make<Snapshot>({ signature: undefined, messages: [] });
    const syncLock = yield* Semaphore.make(1);
    const presenceCache = yield* Ref.make<PresenceCache | undefined>(undefined);
    const seatsCache = yield* Ref.make<SeatsCache | undefined>(undefined);

    // Re-reads the chat file when its mtime or size moved, and publishes the
    // messages whose ids the previous copy lacked. A missing, unreadable, or
    // unparsable file keeps the last good copy and leaves the signature alone,
    // so the next call tries again.
    const readChat = syncLock.withPermits(1)(
      Effect.gen(function* () {
        const info = yield* fs.stat(chatFile).pipe(Effect.option);
        if (Option.isNone(info)) return;
        const mtime = Option.match(info.value.mtime, {
          onNone: () => 0,
          onSome: (date) => date.getTime(),
        });
        const signature = `${mtime}:${info.value.size}`;
        const previous = yield* Ref.get(snapshot);
        if (previous.signature === signature) return;
        const text = yield* fs.readFileString(chatFile).pipe(Effect.option);
        if (Option.isNone(text)) return;
        const entries = parseChatFile(text.value);
        if (Option.isNone(entries)) return;
        const messages = entries.value.flatMap((entry) => Option.toArray(toDeskMessage(entry)));
        yield* Ref.set(snapshot, { signature, messages });
        // The first successful read seeds the room silently: subscribers hear only later arrivals.
        if (previous.signature === undefined) return;
        const known = new Set(previous.messages.map((message) => message.id));
        yield* Effect.forEach(
          messages.filter((message) => !known.has(message.id)),
          (message) => PubSub.publish(pubsub, { type: "message", message }),
          { discard: true },
        );
      }),
    );

    const currentPresence = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = yield* Ref.get(presenceCache);
      if (cached !== undefined && now - cached.at < PRESENCE_TTL_MS) return cached.active;
      const active = yield* readPresence;
      yield* Ref.set(presenceCache, { at: now, active });
      return active;
    });

    // Seats go out when presence or a seat's last message changes, and at least every SEATS_HEARTBEAT_MS.
    const publishSeats = Effect.gen(function* () {
      const active = yield* currentPresence;
      const { messages } = yield* Ref.get(snapshot);
      const seats = seatsOf(active, messages);
      const key = seats
        .map((seat) => `${seat.id}:${seat.active}:${seat.lastSeenAt ?? ""}`)
        .join("|");
      const now = yield* Clock.currentTimeMillis;
      const last = yield* Ref.get(seatsCache);
      if (last !== undefined && last.key === key && now - last.at < SEATS_HEARTBEAT_MS) return;
      yield* Ref.set(seatsCache, { at: now, key });
      yield* PubSub.publish(pubsub, { type: "seats", seats });
    });

    const whenEnabled = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      enabled ? effect : Effect.fail(new DeskDisabledError({}));

    const state = (after?: string) =>
      whenEnabled(
        Effect.gen(function* () {
          yield* readChat;
          const { messages } = yield* Ref.get(snapshot);
          const active = yield* currentPresence;
          const index =
            after === undefined ? -1 : messages.findIndex((message) => message.id === after);
          const reset = index === -1;
          const now = yield* Clock.currentTimeMillis;
          return {
            messages: reset ? messages.slice(-TAIL_LENGTH) : messages.slice(index + 1),
            seats: seatsOf(active, messages),
            total: messages.length,
            reset,
            serverTime: DateTime.formatIso(DateTime.makeUnsafe(now)),
          };
        }),
      );

    const post = (text: string) =>
      whenEnabled(
        Effect.gen(function* () {
          const trimmed = text.trim();
          if (
            trimmed.length === 0 ||
            trimmed.length > DESK_POST_MAX_LENGTH ||
            trimmed.includes("\0")
          ) {
            return yield* new DeskInvalidTextError({});
          }
          // The helper runs without DESK_CHAT_BROKER_SOCKET, as the owner's post requires.
          const env = Object.fromEntries(
            Object.entries(process.env).filter(([name]) => name !== "DESK_CHAT_BROKER_SOCKET"),
          );
          const [stdout, stderr, exitCode] = yield* runCommand(
            spawner,
            ChildProcess.make("python3", ["-I", "-c", POST_SCRIPT, chatDir, trimmed], {
              cwd: chatDir,
              env,
              stdin: "ignore",
            }),
          ).pipe(
            Effect.catchTags({
              PlatformError: () =>
                Effect.fail(
                  new DeskPostFailedError({ detail: "The desk helper could not start." }),
                ),
            }),
            Effect.timeoutOrElse({
              duration: POST_TIMEOUT,
              orElse: () =>
                Effect.fail(new DeskPostFailedError({ detail: "The desk helper timed out." })),
            }),
          );
          const stored =
            exitCode === 0
              ? Option.flatMap(parseJsonValue(stdout.trim()), toDeskMessage)
              : Option.none<DeskMessage>();
          if (Option.isNone(stored)) {
            return yield* new DeskPostFailedError({
              detail: stderr.slice(-POST_DETAIL_MAX_LENGTH),
            });
          }
          // Re-read now so subscribers get the message without waiting for the poller.
          yield* readChat;
          return { message: stored.value };
        }),
      );

    if (enabled) {
      yield* readChat.pipe(
        Effect.andThen(publishSeats),
        Effect.ignoreCause({ log: true }),
        Effect.repeat(Schedule.spaced(options.pollInterval ?? POLL_INTERVAL)),
        Effect.forkScoped,
      );
    }

    return DeskRoom.of({
      enabled,
      state,
      events: enabled ? Stream.fromPubSub(pubsub) : Stream.fail(new DeskDisabledError({})),
      post,
    });
  });

export const layer = Layer.effect(
  DeskRoom,
  Effect.gen(function* () {
    const deskDir = yield* Config.String("T3CODE_DESK_DIR").pipe(
      Config.option,
      Config.map(Option.getOrUndefined),
    );
    return yield* make({ deskDir });
  }),
);
