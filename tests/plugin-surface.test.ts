import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	allKeymapActions, checkKeymap, effectiveKey, keymapAction, writeKeymaps, type PiKeybindings,
} from "../lib/keymaps.ts";
import { buildKeymapRows } from "../lib/keymaps-customize.ts";
import { buildCommandPaletteGroups } from "../lib/command-palette-catalog.ts";
import { bridgeCommandContributions, bridgeKeymapActions } from "../lib/plugin-surface.ts";

// The bridge publishes what its plugins registered; this shell reads it. Each
// rule below is one promise the reader makes: absent is empty, malformed costs
// only the bad entry, reads are live, a contributed action obeys the same
// key rules as a built-in one, and a contributed palette item joins the
// section it names — or opens one of its own after the catalog.

const SURFACE = Symbol.for("gentle-shell-bridge/plugin-surface/v1");

function setSurface(surface: unknown): void {
	(globalThis as Record<symbol, unknown>)[SURFACE] = surface;
}

function clearSurface(): void {
	delete (globalThis as Record<symbol, unknown>)[SURFACE];
}

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "gentle-plugin-surface-"));
}

const PANEL_ACTION = { id: "panel:open", label: "Open panel", defaultKey: "alt+p" };

function surfaceWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema: 1,
		keymaps: () => [PANEL_ACTION],
		commands: () => [],
		...overrides,
	};
}

test.afterEach(clearSurface);

test("no bridge at all: both getters are empty and nothing throws", () => {
	clearSurface();
	assert.deepEqual(bridgeKeymapActions(), []);
	assert.deepEqual(bridgeCommandContributions(), []);
});

test("a foreign schema is ignored whole", () => {
	setSurface({ ...surfaceWith(), schema: 2 });
	assert.deepEqual(bridgeKeymapActions(), []);
	assert.deepEqual(bridgeCommandContributions(), []);
});

test("a throwing getter never escapes: that channel is empty, the other still reads", () => {
	setSurface(surfaceWith({ keymaps: () => { throw new Error("boom"); } }));
	assert.deepEqual(bridgeKeymapActions(), []);
});

test("a malformed entry is skipped and its siblings survive", () => {
	setSurface(surfaceWith({ keymaps: () => [PANEL_ACTION, { id: "", label: "broken" }, { id: "ok:two", label: "Second" }] }));
	assert.deepEqual(bridgeKeymapActions().map((action) => action.id), ["panel:open", "ok:two"]);
});

test("reads are live: a registration made after the first read is seen by the next one", () => {
	const actions: Record<string, unknown>[] = [];
	setSurface(surfaceWith({ keymaps: () => actions }));
	assert.deepEqual(bridgeKeymapActions(), []);
	actions.push(PANEL_ACTION);
	assert.deepEqual(bridgeKeymapActions().map((action) => action.id), ["panel:open"]);
});

test("a contributed action behaves like a built-in one: lookup, listing, env then saved then default", () => {
	setSurface(surfaceWith({ keymaps: () => [{ ...PANEL_ACTION, env: "GENTLE_PANEL_KEY" }] }));
	assert.equal(keymapAction("panel:open")?.label, "Open panel");
	assert.ok(allKeymapActions().some((action) => action.id === "panel:open"));
	assert.ok(allKeymapActions().some((action) => action.id === "changes"));
	assert.equal(effectiveKey("panel:open", {}, {}), "alt+p");
	assert.equal(effectiveKey("panel:open", {}, { "panel:open": "ctrl+p" }), "ctrl+p");
	assert.equal(effectiveKey("panel:open", { GENTLE_PANEL_KEY: "alt+o" }, { "panel:open": "ctrl+p" }), "alt+o");
});

test("a contributed id can never shadow a built-in id", () => {
	setSurface(surfaceWith({ keymaps: () => [{ id: "changes", label: "Fake changes", defaultKey: "alt+z" }] }));
	assert.equal(keymapAction("changes")?.label, "Browse changes");
	assert.equal(effectiveKey("changes", {}, {}), "alt+g");
});

test("a contributed key collides with a built-in: the user is asked, and the built-in can be moved onto it", () => {
	setSurface(surfaceWith());
	const keybindings: PiKeybindings = { getKeys: () => [] };
	const ontoBuiltin = checkKeymap("panel:open", "alt+g", {}, {}, keybindings);
	assert.equal(ontoBuiltin.kind, "confirm");
	const ontoPlugin = checkKeymap("changes", "alt+p", {}, {}, keybindings);
	assert.equal(ontoPlugin.kind, "confirm");
	assert.match(ontoPlugin.kind === "confirm" ? ontoPlugin.message : "", /Open panel/);
});

test("the Keymaps page lists a contributed action as a row with its key", () => {
	setSurface(surfaceWith());
	const configHome = scratch();
	writeKeymaps(configHome, { "panel:open": "ctrl+p" });
	const rows = buildKeymapRows({
		env: {}, configHome, keybindings: () => undefined, commands: [],
		notify: () => {}, reload: () => {},
	});
	const row = rows.find((candidate) => candidate.category === "Keymaps" && typeof candidate.label === "function" && candidate.label().startsWith("Open panel"));
	assert.ok(row, "the contributed action has a row");
	assert.equal(typeof row.label === "function" ? row.label() : row.label, "Open panel: ctrl+p");
});

test("a contributed item joins the section it names", () => {
	setSurface(surfaceWith({ commands: () => [{ id: "panel:open", section: "Session", label: "Open panel", command: "panel:open" }] }));
	const groups = buildCommandPaletteGroups([{ name: "panel:open", description: "Open the panel" }], { "panel:open": "alt+p" });
	const session = groups.find((group) => group.title === "Session");
	assert.ok(session, "Session still exists");
	assert.deepEqual(session.items.at(-1), { command: "panel:open", label: "Open panel", description: "Open the panel", shortcut: "alt+p" });
});

test("an unknown section opens a group of its own, after the catalog", () => {
	setSurface(surfaceWith({ commands: () => [{ id: "panel:open", section: "Panel", label: "Open panel", command: "panel:open" }] }));
	const groups = buildCommandPaletteGroups([{ name: "gentle:status" }, { name: "panel:open" }], {});
	assert.deepEqual(groups.map((group) => group.title), ["Diagnostics", "Panel"]);
	assert.deepEqual(groups.at(-1)?.items.map((item) => item.command), ["panel:open"]);
});

test("a contributed item whose command is not registered is not listed, and an empty new section does not appear", () => {
	setSurface(surfaceWith({ commands: () => [{ id: "panel:open", section: "Panel", label: "Open panel", command: "panel:open" }] }));
	const groups = buildCommandPaletteGroups([{ name: "gentle:status" }], {});
	assert.equal(groups.some((group) => group.title === "Panel"), false);
});
