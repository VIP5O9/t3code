import { createFileRoute } from "@tanstack/react-router";

import { DeskRoom } from "../desk/DeskRoom";

export const Route = createFileRoute("/desk")({
  component: DeskRoom,
});
