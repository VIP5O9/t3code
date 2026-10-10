/**
 * HTTP routes for the desk room. Each route authenticates, calls one DeskRoom
 * method, and maps its typed errors to the JSON the web client expects.
 *
 * @module DeskRoomHttp
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  DESK_EVENTS_PATH,
  DESK_POST_PATH,
  DESK_STATE_PATH,
  DeskPostRequest,
  type DeskEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/http";

import { authenticateMediaRequest } from "../auth/http.ts";
import * as DeskRoom from "./DeskRoom.ts";

/** Keeps idle proxies and clients from timing out the event stream. */
const KEEPALIVE_INTERVAL = "20 seconds";

const formatEvent = (event: DeskEvent) =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

const deskDisabled = () =>
  HttpServerResponse.jsonUnsafe({ error: "desk_disabled" }, { status: 404 });

const stateRoute = Effect.gen(function* () {
  yield* authenticateMediaRequest(AuthOrchestrationReadScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const room = yield* DeskRoom.DeskRoom;
  const url = HttpServerRequest.toURL(request);
  const after = Option.isSome(url) ? (url.value.searchParams.get("after") ?? undefined) : undefined;
  return HttpServerResponse.jsonUnsafe(yield* room.state(after));
}).pipe(
  Effect.catchTags({
    DeskDisabledError: () => Effect.succeed(deskDisabled()),
    EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
    EnvironmentInternalError: HttpServerRespondable.toResponse,
    EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
  }),
);

// EventSource cannot set headers, so this route authenticates like the media
// routes do (cookie, or a wsTicket query). The compression middleware would
// hold back frames, so `no-transform` opts the stream out, as the device hub does.
const eventsRoute = Effect.gen(function* () {
  yield* authenticateMediaRequest(AuthOrchestrationReadScope);
  const room = yield* DeskRoom.DeskRoom;
  if (!room.enabled) return deskDisabled();
  const frames = room.events.pipe(Stream.map(formatEvent));
  const keepalive = Stream.tick(KEEPALIVE_INTERVAL).pipe(Stream.map(() => ": ping\n\n"));
  const body = Stream.make(": connected\n\n").pipe(
    Stream.concat(Stream.merge(frames, keepalive)),
    Stream.encodeText,
  );
  return HttpServerResponse.stream(body, {
    contentType: "text/event-stream",
    headers: {
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}).pipe(
  Effect.catchTags({
    EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
    EnvironmentInternalError: HttpServerRespondable.toResponse,
    EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
  }),
);

const postRoute = Effect.gen(function* () {
  yield* authenticateMediaRequest(AuthOrchestrationOperateScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const input = yield* request.json.pipe(
    Effect.flatMap((json) => Schema.decodeUnknownEffect(DeskPostRequest)(json)),
    Effect.option,
  );
  if (Option.isNone(input)) {
    return HttpServerResponse.jsonUnsafe({ error: "invalid_body" }, { status: 400 });
  }
  const room = yield* DeskRoom.DeskRoom;
  return HttpServerResponse.jsonUnsafe(yield* room.post(input.value.text));
}).pipe(
  Effect.catchTags({
    DeskDisabledError: () => Effect.succeed(deskDisabled()),
    DeskInvalidTextError: () =>
      Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid_text" }, { status: 400 })),
    DeskPostFailedError: (error) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { error: "desk_post_failed", detail: error.detail },
          { status: 502 },
        ),
      ),
    EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
    EnvironmentInternalError: HttpServerRespondable.toResponse,
    EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
  }),
);

// DeskRoom is provided with the server's runtime services (server.ts), so one instance
// serves every route and runs the single poller.
export const layerDeskRoomRoutes = Layer.mergeAll(
  HttpRouter.add("GET", DESK_STATE_PATH, stateRoute),
  HttpRouter.add("GET", DESK_EVENTS_PATH, eventsRoute),
  HttpRouter.add("POST", DESK_POST_PATH, postRoute),
);
