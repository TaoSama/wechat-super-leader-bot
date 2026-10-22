import { ControllerServer } from "../../src/http/server.js";
import { MemoryStore } from "../../src/store/memory.js";

const nodeToken = "upgrade-test-node-token";
const server = new ControllerServer({
  host: "127.0.0.1", port: 0, controllerToken: "upgrade-test-controller-token",
  nodeTokens: { test: nodeToken }, tokenToNode: new Map([[nodeToken, "test"]]),
  allowedChatIds: new Set(), persistenceMode: "memory", commandTtlSeconds: 60,
}, new MemoryStore());
await server.start();
const address = server.getHttpServer().address();
if (!address || typeof address === "string") throw new Error("Missing isolated test server port");
process.send?.({ port: address.port });
