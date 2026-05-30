/**
 * The MCP resource handlers, wired to a Grimoire. Extracted from the process
 * entry (index.ts) so the glue between the protocol layer and the verifying
 * client is testable in isolation — the entry point only constructs and runs.
 *
 * `notify` is injected (rather than the whole server) so a test can observe
 * the list_changed nudge without a live stdio loop; index.ts passes a thunk
 * that forwards to the real server's sendNotification.
 */

import type { Grimoire } from "./grimoire.js";
import type { McpHandlers, ServerInfo } from "./mcp.js";

export function createGrimoireHandlers(
  grimoire: Grimoire,
  serverInfo: ServerInfo,
  notify: (method: string) => void,
  log: (...args: unknown[]) => void,
): McpHandlers {
  return {
    serverInfo,

    listResources: async () => {
      const resources = await grimoire.list();
      return {
        resources: resources.map((r) => ({
          uri: r.uri,
          name: r.name,
          mimeType: r.mimeType,
          description:
            r.description ??
            `Datamancy spell: ${r.name} (SHA-256 verified at fetch time).`,
        })),
      };
    },

    readResource: async ({ uri }) => {
      const { fetched, setChange } = await grimoire.read(uri);
      // If this cast revealed a spell-SET change since the client last listed,
      // nudge it to re-source the grimoire — the notice lands at point of use.
      // (Only ever non-null in live mode; a frozen pin never changes its set.)
      if (setChange) {
        log(
          `update @ ${setChange.version}: spells added ` +
            `[${setChange.added.join(", ") || "—"}], removed ` +
            `[${setChange.removed.join(", ") || "—"}] — re-source the grimoire.`,
        );
        notify("notifications/resources/list_changed");
      }
      // Echo the uri the client REQUESTED — grimoire.read only accepts a uri
      // that exactly resolves to a manifest resource, so this is provably that
      // resource, and it keeps list() and read() agreeing on the identifier
      // (both the resolved/absolute form) rather than leaking the manifest's
      // raw relative path here.
      return {
        contents: [
          {
            uri,
            mimeType: fetched.resource.mimeType,
            text: fetched.text,
          },
        ],
      };
    },
  };
}
