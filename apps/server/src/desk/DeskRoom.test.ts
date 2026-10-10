import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as DeskRoom from "./DeskRoom.ts";

/** A chat entry shaped as the desk writes it; the index fixes its id and timestamp. */
const entry = (index: number, profile = "research", extra: Record<string, unknown> = {}) => ({
  id: `m${String(index).padStart(3, "0")}`,
  ts: `2026-10-10T14:00:00.${String(index).padStart(3, "0")}+00:00`,
  profile,
  message: `message ${index}`,
  ...extra,
});

const tempDeskDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3code-desk-room-" });
});

const writeChat = (deskDir: string, entries: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.join(deskDir, "desk-chat"), { recursive: true });
    yield* fs.writeFileString(
      path.join(deskDir, "desk-chat", "messages.json"),
      JSON.stringify(entries),
    );
  });

it.layer(NodeServices.layer)("DeskRoom", (it) => {
  it.effect("normalizes file entries and reports seat presence from the stub", () =>
    Effect.gen(function* () {
      const deskDir = yield* tempDeskDir;
      yield* writeChat(deskDir, [
        entry(0, "user"),
        { ...entry(1), reply_to: "m000", kind: "talk", channel: "desk" },
        { id: "broken" },
        "not an entry",
      ]);
      const room = yield* DeskRoom.make({
        deskDir,
        presence: Effect.succeed({ research: true }),
      });

      const state = yield* room.state();
      assert.deepEqual(
        state.messages.map((message) => message.id),
        ["m000", "m001"],
      );
      assert.deepEqual(state.messages[0]?.mentions, []);
      assert.equal(state.messages[1]?.replyTo, "m000");
      assert.equal(state.messages[1]?.kind, "talk");
      assert.equal(state.reset, true);
      assert.equal(state.total, 2);
      assert.deepEqual(
        state.seats.find((seat) => seat.id === "research"),
        {
          id: "research",
          name: "Vantage",
          role: "research",
          active: true,
          lastSeenAt: entry(1).ts,
        },
      );
      assert.deepEqual(
        state.seats.find((seat) => seat.id === "strategy"),
        { id: "strategy", name: "Vector", role: "strategy", active: false, lastSeenAt: null },
      );
    }).pipe(Effect.scoped),
  );

  it.effect("serves the tail on reset and only newer messages after a known cursor", () =>
    Effect.gen(function* () {
      const deskDir = yield* tempDeskDir;
      yield* writeChat(
        deskDir,
        Array.from({ length: 320 }, (_, index) => entry(index)),
      );
      const room = yield* DeskRoom.make({ deskDir, presence: Effect.succeed({}) });

      const tail = yield* room.state();
      assert.equal(tail.reset, true);
      assert.equal(tail.total, 320);
      assert.equal(tail.messages.length, 300);
      assert.equal(tail.messages[0]?.id, "m020");

      const delta = yield* room.state("m315");
      assert.equal(delta.reset, false);
      assert.deepEqual(
        delta.messages.map((message) => message.id),
        ["m316", "m317", "m318", "m319"],
      );

      const unknown = yield* room.state("gone");
      assert.equal(unknown.reset, true);
      assert.equal(unknown.messages.length, 300);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the last good copy while the chat file is torn or missing", () =>
    Effect.gen(function* () {
      const deskDir = yield* tempDeskDir;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const chatFile = path.join(deskDir, "desk-chat", "messages.json");
      yield* writeChat(deskDir, [entry(0), entry(1)]);
      const room = yield* DeskRoom.make({ deskDir, presence: Effect.succeed({}) });
      assert.equal((yield* room.state()).total, 2);

      yield* fs.writeFileString(chatFile, '[{"id": "m00');
      assert.deepEqual(
        (yield* room.state()).messages.map((message) => message.id),
        ["m000", "m001"],
      );

      yield* fs.remove(chatFile);
      assert.deepEqual(
        (yield* room.state()).messages.map((message) => message.id),
        ["m000", "m001"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("is disabled without a desk directory and fails every method", () =>
    Effect.gen(function* () {
      const room = yield* DeskRoom.make({ deskDir: "   " });
      assert.isFalse(room.enabled);
      assert.equal((yield* room.state().pipe(Effect.flip))._tag, "DeskDisabledError");
      assert.equal((yield* room.post("hello").pipe(Effect.flip))._tag, "DeskDisabledError");
      assert.equal(
        (yield* Stream.runCollect(room.events).pipe(Effect.flip))._tag,
        "DeskDisabledError",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("rejects blank text before running the helper and reports a failed helper", () =>
    Effect.gen(function* () {
      // No desk_post helper exists in this directory, so the post must fail, not write.
      const deskDir = yield* tempDeskDir;
      yield* writeChat(deskDir, []);
      const room = yield* DeskRoom.make({ deskDir, presence: Effect.succeed({}) });
      assert.equal((yield* room.post("   ").pipe(Effect.flip))._tag, "DeskInvalidTextError");
      assert.equal((yield* room.post("hello").pipe(Effect.flip))._tag, "DeskPostFailedError");
      assert.equal((yield* room.state()).total, 0);
    }).pipe(Effect.scoped),
  );
});

// The poller sleeps on the clock; the layer-scoped `it` has no live variant, so this
// test runs on the top-level live clock and provides the platform services itself.
it.live("DeskRoom emits each new entry on events in file order", () =>
  Effect.gen(function* () {
    const deskDir = yield* tempDeskDir;
    yield* writeChat(deskDir, [entry(0)]);
    const room = yield* DeskRoom.make({
      deskDir,
      presence: Effect.succeed({}),
      pollInterval: "5 millis",
    });
    // Seeds the snapshot before subscribing, so the seed itself is never an event.
    yield* room.state();
    const pull = yield* Stream.toPull(room.events);

    yield* writeChat(deskDir, [entry(0), entry(1), entry(2)]);
    const ids: string[] = [];
    while (ids.length < 2) {
      const chunk = yield* pull;
      for (const event of chunk) {
        if (event.type === "message") ids.push(event.message.id);
      }
    }
    assert.deepEqual(ids, ["m001", "m002"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
