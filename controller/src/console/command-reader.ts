import type { IStore } from "../store/interface.js";

/** Public status validates persisted receipt identity without fetching or fabricating result bodies. */
export function consoleCommandReader(store: IStore): Pick<IStore, "findCommandByRequestId"> {
  return { findCommandByRequestId: requestId => store.findCommandMetadataByRequestId(requestId) };
}
