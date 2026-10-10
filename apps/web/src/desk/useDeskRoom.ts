import { useEffect } from "react";

import { DeskApiError, postDeskMessage, startDeskSync } from "./deskApi";
import { createDeskPendingPost, lastDeskMessageId, useDeskRoomStore } from "./deskRoomState";

/** Keeps the room store synced with the desk while the room is mounted. */
export function useDeskRoomSync(): void {
  useEffect(
    () =>
      startDeskSync({
        getLastId: () => lastDeskMessageId(useDeskRoomStore.getState().messages),
        onState: (state) => useDeskRoomStore.getState().applySnapshot(state),
        onMessage: (message) => useDeskRoomStore.getState().mergeMessages([message]),
        onSeats: (seats) => useDeskRoomStore.getState().setSeats(seats),
        onConnection: (status) => useDeskRoomStore.getState().setConnection(status),
      }),
    [],
  );
}

/**
 * Posts an owner message. It shows at once as pending and is replaced by the
 * real message on success. On failure the pending copy is removed and the error
 * is thrown so the composer can restore the text.
 */
export async function sendDeskText(text: string): Promise<void> {
  const store = useDeskRoomStore.getState();
  const pending = createDeskPendingPost(text);
  store.addPending(pending);
  try {
    const message = await postDeskMessage(text);
    useDeskRoomStore.getState().confirmPending(pending.localId, message);
  } catch (error) {
    useDeskRoomStore.getState().removePending(pending.localId);
    if (error instanceof DeskApiError) throw error;
    throw new DeskApiError("network", "Could not send the message.");
  }
}
