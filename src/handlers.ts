/**
 * The MCP resource handlers, wired to a Grimoire. Extracted from the process
 * entry (index.ts) so the glue between the protocol layer and the verifying
 * client is testable in isolation — the entry point only constructs and runs.
 *
 * `notify` is injected (rather than the whole server) so a test can observe
 * the list_changed nudge without a live stdio loop; index.ts passes a thunk
 * that forwards to the real server's sendNotification.
 */

import type { Grimoire, SpellSetChange } from "./grimoire.js";
import type { McpHandlers, ServerInfo, ToolTextContent } from "./mcp.js";
import { STALE_NOTICE } from "./mcp.js";
import type { Provenance } from "./grimoire.js";

/**
 * Did these bytes come from the origin on this call, or from the memo after it
 * failed? The ONE place that question is asked.
 *
 * It used to be asked three times, once per surface, and the surfaces drifted:
 * `listResources` asked it only while building the *fallback* description, so
 * a row that carried its own description was never examined. Every row of a
 * real manifest carries one — so the resources catalog could not disclose
 * staleness against the live origin at all, while the two tool surfaces did.
 * The disclosure is now independent of the description; no row shape can
 * suppress it.
 */
const isStale = (provenance: Provenance): boolean => provenance !== "verified";

/** Content blocks for a tool result: the payload, preceded by the staleness
 *  notice when the bytes did not come fresh. One place, both tools. */
function blocks(provenance: Provenance, text: string): ToolTextContent[] {
  const notice: ToolTextContent[] = isStale(provenance)
    ? [{ type: "text", text: STALE_NOTICE }]
    : [];
  return [...notice, { type: "text", text }];
}

export function createGrimoireHandlers(
  grimoire: Grimoire,
  serverInfo: ServerInfo,
  notify: (method: string) => void,
  log: (...args: unknown[]) => void,
): McpHandlers {
  // Surface a spell-SET change: nudge the client to re-source the grimoire.
  // Both list() and read() can reveal it (resources/list is the MCP refresh
  // primitive), so the notice fires on whichever the client used — at point of
  // use. (Only ever non-null in live mode; a frozen pin never changes its set.)
  const surface = (setChange: SpellSetChange | null): void => {
    if (!setChange) return;
    log(
      `update @ ${setChange.version}: spells added ` +
        `[${setChange.added.join(", ") || "—"}], removed ` +
        `[${setChange.removed.join(", ") || "—"}] — re-source the grimoire.`,
    );
    notify("notifications/resources/list_changed");
  };

  return {
    serverInfo,

    listResources: async () => {
      const { resources, provenance, setChange } = await grimoire.list();
      surface(setChange);
      // `resources/list` has no sibling-block slot the way `contents[]` does,
      // so a row's description is the only channel available to disclose that
      // its catalog came from the memo. It is appended to EVERY row — an
      // author's description and the supplied fallback alike — because the
      // fact is about the fetch, not about the row.
      //
      // No affirmative "verified at fetch time" is claimed anywhere. It once
      // rode on the fallback, which asserted freshness on rows that had not
      // been fetched at all; an unearned affirmative is worse than silence,
      // and disclosing only the negative is the smaller, truer surface.
      const describe = (r: { name: string; description?: string }): string => {
        const base = r.description ?? `Datamancy spell: ${r.name}.`;
        return isStale(provenance) ? `${base} ${STALE_NOTICE}` : base;
      };
      return {
        resources: resources.map((r) => ({
          uri: r.uri,
          name: r.name,
          mimeType: r.mimeType,
          description: describe(r),
        })),
      };
    },

    readResource: async ({ uri }) => {
      const { fetched, provenance, setChange } = await grimoire.read(uri);
      surface(setChange);
      // Echo the uri the client REQUESTED — grimoire.read only accepts a uri
      // that exactly resolves to a manifest resource, so this is provably that
      // resource, and it keeps list() and read() agreeing on the identifier
      // (both the resolved/absolute form) rather than leaking the manifest's
      // raw relative path here.
      // The RESOURCE mouth discloses staleness too. It previously did not: the
      // tool mouth grew a notice block and this one kept returning the same
      // last-known-good bytes unmarked, so the two surfaces agreed on the bytes
      // and disagreed on the truth about them. `contents` is an array by spec,
      // so the notice is a sibling entry and the spell's own entry stays
      // byte-identical to what it always was.
      const notice = isStale(provenance)
        ? [{ uri, mimeType: "text/plain", text: STALE_NOTICE }]
        : [];
      return {
        contents: [
          ...notice,
          {
            uri,
            mimeType: fetched.resource.mimeType,
            text: fetched.text,
          },
        ],
      };
    },

    // The `list_spells` tool's body — the same verified manifest rows
    // listResources returns, rendered for a reader instead of for a protocol.
    // A tools-only host cannot browse resources, so this is how an agent
    // learns what exists; the rows are the catalog, never a baked-in list.
    listSpells: async () => {
      const { resources, provenance, setChange } = await grimoire.list();
      surface(setChange);
      return blocks(
        provenance,
        resources
          .map((r) => `${r.name} — ${r.description ?? "(no description)"}`)
          .join("\n"),
      );
    },

    // The `fetch_spell` tool's body. It is a NAME away from readResource and
    // nothing else: same grimoire, same verified pipeline, same
    // last-known-good memo, and the same list_changed nudge — so a tools-only
    // session learns the grimoire moved exactly when a resources session does.
    fetchSpell: async (spell) => {
      const { fetched, provenance, setChange } =
        await grimoire.readByName(spell);
      surface(setChange);
      return blocks(provenance, fetched.text);
    },
  };
}
