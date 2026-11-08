import assert from "node:assert/strict";
import test from "node:test";
import { colorToHex } from "@earendil-works/pi-tui";
import {
	FILE_CARD_IDENTITY,
	ODD_FILE_CARD,
	SKILL_FILE_CARD,
	fileCardIdentity,
	fileCardLineRange,
	fileCardMarkdownRows,
	fileCardName,
	isMarkdownFile,
} from "../lib/skill-odd-card.ts";
import { SHELL_ACTIVITY_IDENTITY } from "../lib/odd-phase-inference.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

/** HSL hue of a `#rrggbb` color, so a role can be asserted purple rather than merely different. */
function hueOf(hex: string): number {
	const match = /^#([0-9a-f]{6})$/i.exec(hex);
	if (!match) throw new Error(`not a hex color: ${hex}`);
	const [r, g, b] = [0, 2, 4].map((at) => parseInt(match[1].slice(at, at + 2), 16) / 255);
	const max = Math.max(r, g, b);
	const delta = max - Math.min(r, g, b);
	if (delta === 0) return 0;
	const hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
	return (hue * 60 + 360) % 360;
}

/**
 * The xterm-256 index a `#rrggbb` collapses to on a 256-color terminal.
 *
 * Two palette entries far apart in hex can land on the same index, and then the two
 * cards wearing them look identical on a real terminal — so the identity is asserted at
 * that depth, not only in RGB.
 */
function ansi256Of(hex: string): number {
	const match = /^#([0-9a-f]{6})$/i.exec(hex);
	if (!match) throw new Error(`not a hex color: ${hex}`);
	const [r, g, b] = [0, 2, 4].map((at) => parseInt(match[1].slice(at, at + 2), 16));
	const levels = [0, 95, 135, 175, 215, 255];
	const nearest = (value: number) =>
		levels.reduce((best, level, at) => (Math.abs(level - value) < Math.abs(levels[best]! - value) ? at : best), 0);
	return 16 + 36 * nearest(r) + 6 * nearest(g) + nearest(b);
}

// A file card is chosen from the path the call names, so every boundary case is
// pinned here: a folder called `skills` or `odd` is a path component, never a
// substring, and a Windows path classifies exactly like a POSIX one.
test("a skill and an ODD artifact are recognized by a whole path component", () => {
	assert.equal(fileCardIdentity("skills/gentle-ai/SKILL.md")?.identity, FILE_CARD_IDENTITY.SKILL);
	assert.equal(fileCardIdentity("skills/gentle-ai/references/notes.md")?.identity, FILE_CARD_IDENTITY.SKILL);
	assert.equal(fileCardIdentity("packages/gentle/skills/tdd/SKILL.md")?.identity, FILE_CARD_IDENTITY.SKILL);
	// A document named SKILL.md is a skill wherever it sits: the name is the
	// file's own identity, not its folder's.
	assert.equal(fileCardIdentity("SKILL.md")?.identity, FILE_CARD_IDENTITY.SKILL);
	assert.equal(fileCardIdentity("/home/dev/repo/SKILL.md")?.identity, FILE_CARD_IDENTITY.SKILL);

	assert.equal(fileCardIdentity("odd/work/feature/design.md")?.identity, FILE_CARD_IDENTITY.ODD);
	assert.equal(fileCardIdentity("odd/work")?.identity, FILE_CARD_IDENTITY.ODD, "the folder itself is an ODD path");

	// Windows separators are the same components, not a different path.
	assert.equal(fileCardIdentity("C:\\repo\\skills\\tdd\\SKILL.md")?.identity, FILE_CARD_IDENTITY.SKILL);
	assert.equal(fileCardIdentity("C:\\repo\\odd\\work\\design.md")?.identity, FILE_CARD_IDENTITY.ODD);
	assert.equal(fileCardIdentity("\\\\server\\share\\odd\\work\\design.md")?.identity, FILE_CARD_IDENTITY.ODD);
});

test("a path that merely contains the word is not a skill or an ODD artifact", () => {
	for (const path of [
		"lib/skillset/index.ts",
		"lib/my-skills/notes.md",
		"docs/oddity.md",
		"lib/odd-work/notes.md",
		"odd-work/notes.md",
		"docs/readme.md",
		"lib/x.ts",
		// A file whose own name is `odd` is not inside an ODD folder.
		"docs/odd",
	]) {
		assert.equal(fileCardIdentity(path), undefined, path);
	}
	// Nothing to classify is not an error.
	for (const path of [undefined, null, 42, "", "/", "C:\\"]) {
		assert.equal(fileCardIdentity(path), undefined, String(path));
	}
});

test("the innermost named folder decides which card a nested path wears", () => {
	assert.equal(fileCardIdentity("skills/pack/odd/notes.md")?.identity, FILE_CARD_IDENTITY.ODD);
	assert.equal(fileCardIdentity("odd/work/skills/notes.md")?.identity, FILE_CARD_IDENTITY.SKILL);
	// A SKILL.md keeps its own identity inside an ODD folder.
	assert.equal(fileCardIdentity("odd/work/skills/SKILL.md")?.identity, FILE_CARD_IDENTITY.SKILL);
});

test("a skill keeps the read card's colors and an ODD artifact wears the theme's heading role", () => {
	// A skill is the read card's own color, with only its name and mark changed, while an
	// ODD artifact wears the theme's `mdHeading` role on its heading and on the rail that
	// leads its rows — so the line reads as part of the label it belongs to, and the card
	// owns no color that could disagree with the theme drawing it.
	assert.deepEqual(SKILL_FILE_CARD, { identity: "skill", title: "skill", glyph: "▤", titleRole: "toolTitle" });
	assert.equal(ODD_FILE_CARD.identity, "odd");
	assert.equal(ODD_FILE_CARD.title, "odd");
	assert.equal(ODD_FILE_CARD.glyph, "📑", "the artifact mark the user picked");
	assert.equal(ODD_FILE_CARD.titleRole, "mdHeading", "the ODD artifact wears the theme's own heading role");
	assert.equal(ODD_FILE_CARD.railRole, ODD_FILE_CARD.titleRole, "the line under the label is the label's own");
	assert.deepEqual(Object.keys(ODD_FILE_CARD).sort(), ["glyph", "identity", "railRole", "title", "titleRole"], "the card names roles, never a color of its own");
	assert.equal(SKILL_FILE_CARD.railRole, undefined, "a skill keeps the read card's rail, so nothing new is claimed");
	// Not a status and not the code palette: the identity can neither read as a failure
	// nor recolor the code drawn beside it.
	assert.doesNotMatch(ODD_FILE_CARD.titleRole, /^syntax/u, "not a code-palette role");
	for (const role of ["warning", "error", "success", "toolTitle"]) assert.notEqual(ODD_FILE_CARD.titleRole, role, role);
	assert.equal(fileCardIdentity("skills/a/SKILL.md")?.title, "skill");
	assert.equal(fileCardIdentity("odd/work/a.md")?.title, "odd");
});

test("every shipped theme defines the ODD card's role, so the identity needs no color of its own", async () => {
	// The card names a theme role, so the theme at hand decides what it looks like — the
	// same card is the same color in the transcript, in the Agents pane and in every
	// shipped theme, and no card-local hex can disagree with the theme that paints it.
	const { readFile } = await import("node:fs/promises");
	const { fileURLToPath } = await import("node:url");
	for (const name of ["Gentle", "Gentleman-Cute", "Gentleman-Sexy"]) {
		const theme = JSON.parse(await readFile(fileURLToPath(new URL(`../themes/${name}.json`, import.meta.url)), "utf8"));
		assert.ok(Object.hasOwn(theme.colors, ODD_FILE_CARD.titleRole), `${name} defines ${ODD_FILE_CARD.titleRole}`);
		const resolve = (role: string) => (theme.vars?.[theme.colors[role]] ?? theme.colors[role]).toLowerCase();
		assert.match(resolve(ODD_FILE_CARD.titleRole), /^#[0-9a-f]{6}$/u, `${name}: the role resolves to a color`);
		// No role in a shipped theme is the fixed violet the card used to own.
		for (const role of Object.keys(theme.colors)) {
			assert.notEqual(resolve(role), "#c36ff2", `${name}: no role is the removed card color (${role})`);
		}
	}
});

test("a collapsed card can name the file itself, on either separator", () => {
	// The last path component and nothing else: a name with spaces stays whole, a
	// trailing separator names no empty file, and a Windows path reads like a POSIX one.
	assert.equal(fileCardName("odd/work/design.md"), "design.md");
	assert.equal(fileCardName("C:\\repo\\odd\\work\\design.md"), "design.md");
	assert.equal(fileCardName("odd/my design doc.md"), "my design doc.md");
	assert.equal(fileCardName("odd/work/"), "work", "a trailing separator names no empty file");
	assert.equal(fileCardName("design.md"), "design.md");
	assert.equal(fileCardName("odd/work/a-very-long-artifact-name-for-a-card.md"), "a-very-long-artifact-name-for-a-card.md");
	// Nothing to name is nothing, never an invented file.
	for (const value of ["", "/", undefined, null, 7]) assert.equal(fileCardName(value), "", String(value));
	// A drive root names a drive and not a file: the caller decides what to show for it.
	assert.equal(fileCardName("C:\\"), "C:");
});

test("only a Markdown file is rendered as Markdown", () => {
	for (const path of ["skills/a/SKILL.md", "odd/work/a.md", "odd/work/a.MD", "C:\\repo\\odd\\a.Md"]) {
		assert.equal(isMarkdownFile(path), true, path);
	}
	for (const path of ["skills/a/notes.markdown", "odd/work/a.md.bak", "lib/x.ts", "", undefined, 7]) {
		assert.equal(isMarkdownFile(path), false, String(path));
	}
});

test("a read names the file line range it asked for, and no other tool claims one", () => {
	// The range is the call's own: the lines it asked the read to return.
	assert.equal(fileCardLineRange("read", { path: "a.md", offset: 142, limit: 4 }), ":142-145");
	assert.equal(fileCardLineRange("read", { path: "a.md", offset: 2, limit: 3 }), ":2-4");
	assert.equal(fileCardLineRange("read", { path: "a.md", limit: 4 }), ":1-4");
	assert.equal(fileCardLineRange("read", { path: "a.md", offset: 5 }), ":5");
	assert.equal(fileCardLineRange("read", { path: "a.md" }), undefined);
	// A malformed range states nothing rather than inventing one.
	assert.equal(fileCardLineRange("read", { offset: "2", limit: 3 }), undefined);
	assert.equal(fileCardLineRange("read", { offset: 2, limit: 0 }), undefined);

	// A write and an edit know how many lines they write, never where in the file
	// those lines land. A count must never be drawn as a file line number, so the
	// card names no range at all: `:3` would claim a position the call never
	// stated, and the real range lives in the diff the result carries.
	assert.equal(fileCardLineRange("write", { path: "a.md", content: "one\ntwo\nthree" }), undefined);
	assert.equal(fileCardLineRange("write", { path: "a.md", content: "one\ntwo\n" }), undefined);
	assert.equal(fileCardLineRange("write", { path: "a.md", content: "" }), undefined);
	assert.equal(fileCardLineRange("write", { path: "a.md" }), undefined);
	assert.equal(fileCardLineRange("edit", { path: "a.md", oldText: "a", newText: "one\ntwo" }), undefined);
	assert.equal(fileCardLineRange("edit", { path: "a.md", edits: [{ oldText: "a", newText: "x" }, { oldText: "b", newText: "y\nz" }] }), undefined);
	assert.equal(fileCardLineRange("edit", { path: "a.md" }), undefined);

	// Every other tool names no range, and neither does a missing argument set.
	assert.equal(fileCardLineRange("grep", { path: "a.md", limit: 2 }), undefined);
	assert.equal(fileCardLineRange("read", undefined), undefined);
});

const taggedTheme = {
	fg: (color: string, text: string) => `[${color}]${text}`,
	bold: (text: string) => `<b>${text}</b>`,
};

test("a Markdown file renders through Pi's own Markdown, in the theme's roles", () => {
	const source = "## Handoff\n\nSome **bold** text with `code`.\n";
	const rows = fileCardMarkdownRows(source, taggedTheme, 40);
	const shown = rows.join("\n");
	assert.match(shown, /\[mdHeading\](?:<b>)?Handoff/);
	assert.match(shown, /\[mdCode\]code/);
	assert.equal(shown.includes("## "), false, "the heading renders instead of showing its source");
	assert.equal(shown.includes("**"), false, "inline emphasis renders instead of its source");
});

test("a file is never swallowed: a theme that cannot paint Markdown still shows its rows", () => {
	const unreadable = {
		fg() {
			throw new Error("no roles here");
		},
	};
	const rows = fileCardMarkdownRows("first line\nsecond line", unreadable, 40);
	assert.deepEqual(rows.map((row) => stripAnsi(row).trimEnd()), ["first line", "second line"]);
	// The fallback fits the width it was given, and keeps every row.
	const narrow = fileCardMarkdownRows("first line\nsecond line", unreadable, 6);
	assert.ok(narrow.length >= 2, "every source row reaches the card");
	for (const row of narrow) assert.ok(stripAnsi(row).length <= 6, `"${row}" fits`);
	// An empty file draws nothing at all rather than a blank card row.
	assert.deepEqual(fileCardMarkdownRows("", taggedTheme, 40), []);
	assert.deepEqual(fileCardMarkdownRows("   \n\n", taggedTheme, 40), []);
	assert.deepEqual(fileCardMarkdownRows("first line", taggedTheme, 0), []);
});
