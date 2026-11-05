import { lookup } from "node:dns/promises";
import { isIPv6 } from "node:net";
import { networkInterfaces } from "node:os";

/**
 * Names of the Compose peers and of the controller itself: service names plus the
 * container names that Docker DNS also serves on the shared network.
 */
export const CLAUDE_PEER_HOSTS = ["postgres", "controller", "gateway",
  "super-leader-postgres-1", "super-leader-controller-1", "super-leader-gateway"] as const;
/**
 * Loopback and cloud metadata spellings. The sandbox proxy matches hosts and IP
 * literals, not ranges, and "*" also allows IP literals, so each spelling is listed.
 */
const LOCAL_AND_METADATA_HOSTS = ["localhost", "*.localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]",
  "169.254.169.254", "169.254.170.2", "100.100.100.200", "[fd00:ec2::254]", "metadata", "metadata.google.internal"] as const;
export const CLAUDE_DENIED_DOMAINS = [...CLAUDE_PEER_HOSTS, ...LOCAL_AND_METADATA_HOSTS] as const;
// Names that do not exist on this network (no gateway profile, local runs) have nothing to deny.
const UNRESOLVED_CODES = new Set(["ENOTFOUND", "ENODATA"]);

async function resolveAll(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map(item => item.address);
}

/** Formats an address the way deniedDomains matches IP literals: IPv6 in brackets, without a zone ID. */
function hostEntry(address: string): string {
  const bare = address.split("%")[0];
  return isIPv6(bare) ? `[${bare}]` : bare;
}

/**
 * Hosts sandboxed Bash must not reach through the sandbox proxy: the fixed names
 * above, the addresses those peer names resolve to now, and every address of this
 * container, whose listeners share the proxy's network namespace.
 */
export async function claudeDeniedHosts(resolve: (host: string) => Promise<string[]> = resolveAll): Promise<string[]> {
  const own = Object.values(networkInterfaces()).flatMap(items => items ?? []).map(item => item.address);
  const peers = await Promise.all(CLAUDE_PEER_HOSTS.map(async host => {
    try { return await resolve(host); }
    catch (error) {
      if (UNRESOLVED_CODES.has((error as NodeJS.ErrnoException).code ?? "")) return [];
      throw error;
    }
  }));
  return [...new Set([...CLAUDE_DENIED_DOMAINS, ...[...own, ...peers.flat()].map(hostEntry)])];
}
