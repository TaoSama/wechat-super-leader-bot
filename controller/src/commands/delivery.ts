import type { DeliveryMode, SendRoute } from "../types.js";

const ROUTE_DELIVERY_MODES: Readonly<Record<SendRoute, readonly DeliveryMode[]>> = {
  "control-socket": ["next-turn", "steer"],
  "app-server-resume": ["next-turn", "steer"],
  "desktop-owner": ["next-turn"],
  "terminal-pane": ["next-turn"],
};

/** Route support is independent of live readiness and node protocol negotiation. */
export function routeSupportsDeliveryMode(route: SendRoute, mode: DeliveryMode = "next-turn"): boolean {
  return ROUTE_DELIVERY_MODES[route].includes(mode);
}
