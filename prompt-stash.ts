/**
 * prompt-stash — stash the currently typed prompt with ctrl+s.
 *
 * Pressing ctrl+s hides the text in the editor. It comes back when:
 *   - you press ctrl+s again, or
 *   - right after the next prompt is sent.
 *
 * The shortcut exchanges the editor content with a single stash slot:
 *   - text in field, empty stash  -> text is hidden (stashed), field cleared
 *   - empty field, text stashed   -> text is restored into the field
 *   - text in field, text stashed -> the two swap (nothing is lost)
 *
 * Only one prompt can be hidden at a time; stashing again overwrites the slot.
 * A `stash: …` indicator in the footer shows the hidden text while stashed.
 * The stash is dropped when the session changes (/new, /resume, /fork, /reload).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "prompt-stash";
const PREVIEW_MAX = 42;

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
}

export default function (pi: ExtensionAPI) {
  let stash: string | null = null;

  const setStatus = (ctx: ExtensionContext, text?: string): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, text);
  };

  /** Move the stash back into the editor. Returns false when nothing is stashed. */
  const restore = (ctx: ExtensionContext): boolean => {
    if (stash === null) return false;
    const text = stash;
    stash = null;
    setStatus(ctx, undefined);
    ctx.ui.setEditorText(text);
    return true;
  };

  pi.registerShortcut("ctrl+s", {
    description:
      "Stash the typed prompt (restore with ctrl+s again, or automatically after the next send)",
    handler: async (ctx) => {
      const current = ctx.ui.getEditorText();

      if (current.trim()) {
        // Hide what is typed; if an older stash exists, swap it back in
        // (single slot — the newly hidden text overwrites it).
        const previous = stash;
        stash = current;
        ctx.ui.setEditorText(previous ?? "");
        setStatus(ctx, `stash: ${preview(current)}`);
        return;
      }

      if (!restore(ctx)) {
        ctx.ui.notify("Nothing to stash — the field is empty", "info");
      }
    },
  });

  // Re-insert the stashed prompt immediately after the next prompt is sent.
  // Built-in commands (/model, /compact, !ls, …) don't fire `input`, so they
  // never trigger a restore — only an actual prompt send does.
  pi.on("input", async (event, ctx) => {
    if (stash === null || event.source !== "interactive") return;
    // The editor was just cleared by the submit. If new text already appeared
    // (fast typing during the hand-off), leave the stash untouched so nothing
    // gets wiped — ctrl+s will restore it instead.
    if (ctx.ui.getEditorText().trim()) return;
    restore(ctx);
  });

  // A stash belongs to one conversation: drop it on /new, /resume, /fork, /reload.
  pi.on("session_start", async (_event, ctx) => {
    stash = null;
    setStatus(ctx, undefined);
  });
}