import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { emptyThread, TASK_EVENT, applyTaskEvent, normalizeRpcEvent, type ToolItem } from "../lib/agents-protocol.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The delegated route is pinned end to end through the child's real tool: the
// native edit executes, the protocol normalizes the event it produced, the store
// keeps the item, and the pane draws it — never a hand-built details payload.
import { createEditTool } from "@earendil-works/pi-coding-agent";
import { renderInputMessage, renderThreadItem } from "../lib/agents-thread-view.ts";
import { clearAgentToolRenderers, registerAgentToolRenderers } from "../lib/agents-tool-renderers.ts";
import { createCodeGraphCardRenderer, createQuietToolRenderer } from "../extensions/quiet-tools.ts";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// The chat's own renderers resolve their key hints through pi's theme singleton,
// exactly as they do in the transcript; a case that draws them initializes it.
initTheme("dark");

const plainTheme = { fg: (_color: string, text: string) => text };
const taggedTheme = { fg: (color: string, text: string) => `[${color}]${text}` };
const floatTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => `\u001b[48;5;236m${text}\u001b[49m`,
};
// The agent card's identity, as extensions/gentle-agents.ts paints it: an iris
// heading and rail over the iris tint, whatever the active accent is.
const IRIS_HEADING = "\u001b[38;2;185;167;242m";
const IRIS_RAIL = "\u001b[38;2;143;122;217m";
const IRIS_TINT = "\u001b[48;2;26;21;38m";
const tintTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => `\u001b[48;5;236m${text}\u001b[49m`,
};

function tool(overrides: Partial<ToolItem> = {}): ToolItem {
	return { kind: "tool", callId: "call", name: "bash", args: {}, output: "", running: false, isError: false, ...overrides };
}

test("renderThreadItem draws assistant prose the way the chat does, with no block label", () => {
	// The chat shows assistant text unlabeled at a one-column pad; the preview
	// must not invent a "Text" heading the transcript never draws. Below the
	// Markdown threshold the text is plain wrapped prose, still unlabeled.
	assert.deepEqual(renderThreadItem({ kind: "text", text: "one two three four" }, plainTheme, 9), [" one two", " three", " four"]);
	const prose = renderThreadItem({ kind: "text", text: "alpha\n\n  code" }, plainTheme, 30).map(stripAnsi).join("\n");
	assert.match(prose, /^ alpha/m, "the prose keeps the chat's one-column pad");
	assert.match(prose, /^\s+code\s*$/m, "the second paragraph reaches the pane");
	assert.equal(prose.includes("Text"), false, "no block label is invented");
	// Notes are meta rows with no chat counterpart, so they keep their label.
	assert.deepEqual(renderThreadItem({ kind: "note", text: "keep this" }, plainTheme, 30), ["Note", "  keep this"]);
	assert.deepEqual(renderThreadItem({ kind: "unknown" } as never, plainTheme, 30), []);
});

test("renderThreadItem renders assistant Markdown as the chat does, code fences included", () => {
	// The transcript renders assistant prose through Pi's Markdown component; a
	// preview that echoed the source showed a literal `## Handoff` and a raw fence.
	const source = "## Handoff\n\nSome **bold** text with `code`.\n\n```ts\nline one\nline two\n```";
	const lines = renderThreadItem({ kind: "text", text: source }, plainTheme, 40);
	const shown = lines.map(stripAnsi).join("\n");
	assert.equal(shown.includes("## "), false, "a heading renders instead of showing its Markdown source");
	assert.match(shown, /Handoff/);
	assert.equal(shown.includes("**"), false, "inline emphasis renders instead of its source");
	assert.match(shown, /line one[\s\S]*line two/, "a fenced block keeps every line, in order");
	assert.match(shown, /```ts/, "a real language keeps its code block");
	for (const row of lines) assert.ok(visibleWidth(row) <= 40, `"${stripAnsi(row)}" fits the pane`);
	// The Markdown roles are the chat's own, so the pane matches the transcript.
	const tagged = renderThreadItem({ kind: "text", text: "## Handoff\n\n`code`" }, taggedTheme, 40).join("\n");
	assert.match(tagged, /\[mdHeading\]Handoff/);
	assert.match(tagged, /\[mdCode\]code/);
	// A very narrow pane keeps plain prose: Markdown chrome would leave no room.
	const narrow = renderThreadItem({ kind: "text", text: "alpha beta gamma" }, plainTheme, 10);
	for (const row of narrow) assert.ok(visibleWidth(row) <= 10);
	assert.match(narrow.join("\n"), /alpha/);
	assert.equal(narrow.join("\n").includes("```"), false);
});

test("renderThreadItem unwraps a plain-text container fence into the prose the chat prints", () => {
	// A subagent's handoff arrives as assistant text wrapped in a ```text fence:
	// a plain-text container, not a code sample. The chat draws it as a code
	// block — the `text` label, the code palette and a two-column indent — which
	// inside the pane reads as the answer being boxed in. Plain text carries no
	// syntax, so the pane shows the prose itself and drops the container.
	const handoff = "status: completed\nsummary: wired the card\nfiles_changed:\n  - lib/agents-view.ts: renamed a helper";
	const fenced = ["```text", handoff, "```"].join("\n");
	assert.deepEqual(
		renderThreadItem({ kind: "text", text: fenced }, plainTheme, 60),
		renderThreadItem({ kind: "text", text: handoff }, plainTheme, 60),
		"the container fence adds no fence line, palette or indent of its own",
	);
	const shown = renderThreadItem({ kind: "text", text: fenced }, plainTheme, 60).map(stripAnsi).join("\n");
	assert.equal(shown.includes("```"), false, "no fence line survives");
	assert.equal(shown.includes("text\n"), false, "the fence's language label is gone");
	assert.match(shown, /^ status: completed/m, "the answer sits at the chat's own one-column pad");
	assert.match(shown, /wired the card/);
	// The handoff never wears the code-block roles; it is ordinary prose.
	const tagged = renderThreadItem({ kind: "text", text: fenced }, taggedTheme, 60).join("\n");
	assert.equal(tagged.includes("[mdCodeBlock]"), false, "the handoff does not take the code-block palette");
	assert.equal(tagged.includes("[mdCodeBlockBorder]"), false, "and draws no fence border");
	// The same container arrives inside a longer answer, and with the txt alias.
	const nested = renderThreadItem({ kind: "text", text: `Done.\n\n\`\`\`txt\n${handoff}\n\`\`\`` }, plainTheme, 60).map(stripAnsi).join("\n");
	assert.match(nested, /Done\./);
	assert.match(nested, /status: completed/);
	assert.equal(nested.includes("```"), false);
	// A genuine code block keeps its block: another language, or no language.
	const code = renderThreadItem({ kind: "text", text: "```ts\nconst x = 1;\n```" }, taggedTheme, 60).join("\n");
	assert.match(code, /\[mdCodeBlockBorder\]```ts/, "a real language keeps its code block");
	assert.match(code, /\[mdCodeBlock\]const x = 1;/, "and its code role");
	const bare = renderThreadItem({ kind: "text", text: "```\nplain\n```" }, taggedTheme, 60).join("\n");
	assert.match(bare, /\[mdCodeBlockBorder\]```/, "an untagged fence stays a code block");
	// A very narrow pane keeps the same rule: prose, never the container.
	const narrow = renderThreadItem({ kind: "text", text: fenced }, plainTheme, 11).map(stripAnsi).join("\n");
	assert.equal(narrow.includes("```"), false);
	assert.match(narrow, /status: completed|status:/);
});

test("renderThreadItem names the activity a bash command implies, as the chat's card does", () => {
	// extensions/quiet-tools.ts heads a bash card with the activity its own command
	// names (lib/odd-phase-inference.ts SHELL_ACTIVITY_IDENTITY: exploring ⌕ /
	// checking ✓ / versioning ⎇ / publishing ↑). The preview derives it from the
	// retained call itself, never from a stored or invented history.
	assert.match(renderThreadItem(tool({ args: { command: "pnpm test" }, output: "PASS" }), plainTheme, 40)[0], /^╭─ ✓ checking · pnpm test/);
	assert.match(renderThreadItem(tool({ args: { command: "cat lib/agents-view.ts" } }), plainTheme, 60)[0], /^╭─ ⌕ exploring · cat lib\/agents-view\.ts/);
	// An ambiguous command claims no phase, exactly as the chat leaves it generic.
	assert.match(renderThreadItem(tool({ args: { command: "node scripts/release.mjs" } }), plainTheme, 40)[0], /^╭─ \$ bash · node scripts\/release\.mjs/);
	// A remote presence thread publishes no arguments, so it can name no phase.
	assert.match(renderThreadItem(tool({ args: {} }), plainTheme, 40)[0], /^╭─ \$ bash/);
	// Only the shell card borrows a phase name; every other tool keeps its own.
	assert.match(renderThreadItem(tool({ name: "read", args: { path: "a.ts" } }), plainTheme, 40)[0], /≡ read · a\.ts/);
	// The phase paints the heading; the card's tone still states the call's state.
	assert.equal(renderThreadItem(tool({ args: { command: "pnpm test" } }), taggedTheme, 40)[0].includes("[mdHeading]✓ checking"), true);
});

test("a thread card's left rail carries the phase's own color while the tone keeps the call's state", () => {
	// The chat's bash card paints the rail that leads its rows in the phase's
	// color while the card is idle; the pane mirrors it, so one call reads the same
	// in both places. The rules still state the status, so a running or failed call
	// never reads as a quiet one.
	const finished = renderThreadItem(tool({ args: { command: "git status" }, output: "clean" }), taggedTheme, 40);
	assert.match(finished[0]!, /^\[mdLink\]╭\[success\]─ /, "the idle card's left corner carries the phase, the rule the status tone");
	assert.match(finished[0]!, /\[mdLink\]⌕ exploring/);
	assert.match(finished[1]!, /^\[mdLink\]│ clean .*\[success\]│$/, "the left rail matches the label, the right rail the status");
	assert.match(finished.at(-1)!, /^\[mdLink\]╰\[success\]─/, "the bottom corner carries the same phase, the rule the status tone");

	// A running call is a warning frame and a failed one an error frame; neither
	// changes what the call was, and both wear the status on the left edge too.
	const running = renderThreadItem(tool({ args: { command: "pnpm test" }, running: true }), taggedTheme, 40);
	assert.match(running[1]!, /^\[warning\]│ \[muted\]running…/, "a running call's left edge wears the status tone, not the phase");
	assert.match(running.at(-1)!, /^\[warning\]╰/);

	const failed = renderThreadItem(tool({ args: { command: "git status" }, output: "boom", isError: true }), taggedTheme, 40);
	assert.match(failed[0]!, /^\[error\]╭/);
	assert.match(failed[1]!, /^\[error\]│ boom/, "a failed call's left edge wears the status tone, not the phase");
	assert.match(failed.at(-1)!, /^\[error\]╰/);

	// A tool that names no phase keeps the rail it always had, so the pane never
	// borrows a phase color for work the classifier did not label.
	const read = renderThreadItem(tool({ name: "read", args: { path: "a.ts" }, output: "x" }), taggedTheme, 40);
	assert.match(read[1]!, /^\[success\]│ /);

	// Narrow panes keep the same rail and never exceed their width.
	for (const width of [12, 20, 40]) {
		const rows = renderThreadItem(tool({ args: { command: "git status" }, output: "clean" }), plainTheme, width);
		for (const row of rows) assert.ok(visibleWidth(row) <= width, `"${stripAnsi(row)}" fits ${width}`);
		assert.ok(rows.some((row) => /^│ /.test(row)), `width ${width} keeps a left rail`);
		assert.match(renderThreadItem(tool({ args: { command: "git status" }, output: "clean" }), taggedTheme, width).find((row) => row.startsWith("[mdLink]│")) ?? "", /^\[mdLink\]│/, `width ${width} keeps the phase rail`);
	}
});

test("a thread card names local history and remote writes as the chat's card does", () => {
	// The chat's bash card heads `git commit` as versioning and `git push` as
	// publishing; the pane reads the same retained command through the same
	// classifier, so one call never reads as two activities. Neither is an ODD
	// phase: the classifer names a card, not the session's phase.
	assert.match(renderThreadItem(tool({ args: { command: "git add -A && git commit -m x" }, output: "ok" }), plainTheme, 60)[0], /^╭─ ⎇ versioning · git add -A && git commit -m x/);
	assert.match(renderThreadItem(tool({ args: { command: "git push" }, output: "pushed" }), plainTheme, 60)[0], /^╭─ ↑ publishing · git push/);
	assert.match(renderThreadItem(tool({ args: { command: "gh stack submit" } }), plainTheme, 60)[0], /^╭─ ↑ publishing · gh stack submit/);
	// A stack's local half is versioning, and its view is inspection.
	assert.match(renderThreadItem(tool({ args: { command: "gh stack add feat/two" } }), plainTheme, 60)[0], /^╭─ ⎇ versioning · gh stack add feat\/two/);
	assert.match(renderThreadItem(tool({ args: { command: "gh stack view" } }), plainTheme, 60)[0], /^╭─ ⌕ exploring · gh stack view/);
	// An unlisted stack command and a compound with a segment nobody can name keep
	// the generic card rather than claiming an activity, while a deletion on the
	// same call outranks both the commit and the push beside it.
	assert.match(renderThreadItem(tool({ args: { command: "gh stack checkout" } }), plainTheme, 60)[0], /^╭─ \$ bash · gh stack checkout/);
	assert.match(renderThreadItem(tool({ args: { command: "node scripts/release.mjs" } }), plainTheme, 60)[0], /^╭─ \$ bash · node scripts\/release\.mjs/);
	assert.match(renderThreadItem(tool({ args: { command: "git push && rm -rf dist" } }), plainTheme, 60)[0], /^╭─ ⚠ destructive · git push && rm -rf dist/);

	// A help flag an option consumed is its value, not a query, in the pane too.
	assert.match(renderThreadItem(tool({ args: { command: "git commit -m --help" } }), plainTheme, 60)[0], /^╭─ ⎇ versioning · git commit -m --help/);
	assert.match(renderThreadItem(tool({ args: { command: "gh issue comment 7 --body --help" } }), plainTheme, 60)[0], /^╭─ ↑ publishing · gh issue comment 7 --body --help/);

	// The heading and the rail it leads share the activity's role while the card is
	// idle, and the rules keep the call's own state, so the label never hides a
	// finished or failed call. Versioning wears the theme's warm role and
	// publishing its green one.
	const versioning = renderThreadItem(tool({ args: { command: "git commit -m x" }, output: "done" }), taggedTheme, 40);
	assert.match(versioning[0]!, /\[warning\]⎇ versioning/);
	assert.match(versioning[1]!, /^\[warning\]│ done .*\[success\]│$/);
	assert.match(versioning.at(-1)!, /^\[warning\]╰\[success\]─/, "the idle card's bottom corner keeps the activity's role, the rule the status tone");
	const publishing = renderThreadItem(tool({ args: { command: "git push" }, output: "boom", isError: true }), taggedTheme, 40);
	assert.match(publishing[0]!, /\[success\]↑ publishing/);
	assert.match(publishing[1]!, /^\[error\]│ boom .*\[error\]│$/, "a failed call's left edge wears the status tone over the label's own role");
	assert.match(publishing.at(-1)!, /^\[error\]╰/, "and the frame still states the failure");
});

test("a thread card names preparation, reformatting and deletion as the chat's card does", () => {
	// The pane reads the same classifier, so these three identities reach it with
	// the marks and roles the transcript's bash card uses, and a deletion outranks
	// the check, commit or push printed beside it.
	for (const [command, heading] of [
		["pnpm install", /^╭─ ⚒ {2}preparing · pnpm install/],
		["mkdir -p tmp/scratch", /^╭─ ⚒ {2}preparing · mkdir -p tmp\/scratch/],
		["prettier --write .", /^╭─ ≋ formatting · prettier --write \./],
		["eslint . --fix", /^╭─ ≋ formatting · eslint \. --fix/],
		["rm -rf build", /^╭─ ⚠ destructive · rm -rf build/],
		["rm -f logo.png", /^╭─ ⚠ destructive · rm -f logo\.png/],
		["docker volume rm data", /^╭─ ⚠ destructive · docker volume rm data/],
		["kubectl delete pod web", /^╭─ ⚠ destructive · kubectl delete pod web/],
		["env FOO=bar rm -rf dist", /^╭─ ⚠ destructive · env FOO=bar rm -rf dist/],
		["git checkout .", /^╭─ ⚠ destructive · git checkout \./],
		["pnpm test && rm -rf dist", /^╭─ ⚠ destructive · pnpm test && rm -rf dist/],
	] as const) {
		assert.match(renderThreadItem(tool({ args: { command } }), plainTheme, 60)[0], heading, command);
	}
	// A check beside an unnamed segment keeps the generic heading in the pane too.
	assert.match(renderThreadItem(tool({ args: { command: "pnpm test && node scripts/release.mjs" } }), plainTheme, 60)[0], /^╭─ \$ bash · pnpm test && node scripts\/release\.mjs/);

	// The rail is the label's role while the card is idle, and the rules keep the
	// call's status — red on both edges for a finished deletion, the code palette
	// for the two maintenance cards.
	const destructive = renderThreadItem(tool({ args: { command: "rm -rf build" }, output: "gone" }), taggedTheme, 40);
	assert.match(destructive[0]!, /\[error\]⚠ destructive/);
	assert.match(destructive[1]!, /^\[error\]│ gone .*\[success\]│$/);
	assert.match(destructive.at(-1)!, /^\[error\]╰\[success\]─/, "the idle card's bottom corner keeps the deletion's role, the rule the status tone");
	const formatting = renderThreadItem(tool({ args: { command: "prettier --write ." }, output: "done" }), taggedTheme, 40);
	assert.match(formatting[0]!, /\[syntaxFunction\]≋ formatting/);
	assert.match(formatting[1]!, /^\[syntaxFunction\]│ done /);

	// An exemption keeps the call's real identity: a help page is a query, a dry run
	// or a staged-only restore changes nothing, and quoted prose is prose.
	assert.match(renderThreadItem(tool({ args: { command: "rm --help" } }), plainTheme, 60)[0], /^╭─ ⌕ exploring · rm --help/);
	assert.match(renderThreadItem(tool({ args: { command: "git clean -n" } }), plainTheme, 60)[0], /^╭─ \$ bash · git clean -n/);
	assert.match(renderThreadItem(tool({ args: { command: "git restore --staged lib/a.ts" } }), plainTheme, 60)[0], /^╭─ \$ bash · git restore --staged lib\/a\.ts/);
});

// The pane draws the chat's own preparing mark, so it carries the same gap: an
// emoji-fallback font paints U+2692 two cells wide while the terminal advances one,
// and a single space would be painted inside the glyph (`⚒preparing`).
test("a preparing thread card keeps the gap the chat's card carries", () => {
	const WIDE_INK = new Set(["⚒"]);
	// Blank columns that survive the mark's one-cell overhang, i.e. what the eye sees.
	const visibleGapAfter = (row: string): number => {
		const cells = [...row];
		const at = cells.indexOf("⚒");
		if (at < 0) return 0;
		let spaces = 0;
		for (let index = at + 1; index < cells.length && cells[index] === " "; index += 1) spaces += 1;
		return Math.max(0, spaces - (WIDE_INK.has("⚒") ? 1 : 0));
	};
	const item = tool({ args: { command: "pnpm install" } });
	const previous = cardStyle();
	try {
		for (const style of [CARD_STYLE.NEON, CARD_STYLE.FLOAT]) {
			setCardStyle(style);
			for (const width of [30, 40, 60]) {
				const rows = renderThreadItem(item, style === CARD_STYLE.FLOAT ? floatTheme : plainTheme, width).map(stripAnsi);
				// The heading row: the top rule outlined, the row below the padding row floated.
				const row = rows[style === CARD_STYLE.FLOAT ? 1 : 0] ?? "";
				assert.match(row, /⚒ {2}preparing/, `${style} at ${width}: ${JSON.stringify(row)}`);
				assert.doesNotMatch(row, /⚒\S/u, `${style} at ${width}: the mark never joins its word`);
				assert.equal(visibleGapAfter(row), 1, `${style} at ${width}: one column shows beside a two-cell mark`);
				for (const drawn of rows) assert.equal(visibleWidth(drawn), width, `${style} at ${width}: "${drawn}" keeps the pane width`);
			}
		}
	} finally {
		setCardStyle(previous);
	}
});

test("a versioning thread card previews its own family and keeps the rest behind the expansion", () => {
	// The pane reads the same shared preview the chat's bash card does, so one call
	// never reads as two: a commit shows its summary and diffstat rather than its
	// file list, and everything the preview leaves out is one expansion away.
	const output = [
		"[main 1a2b3c4] feat: add the thing",
		" 2 files changed, 5 insertions(+), 1 deletion(-)",
		" create mode 100644 src/a.ts",
	].join("\n");
	const item = tool({ args: { command: "git commit -m x" }, output });
	const collapsed = renderThreadItem(item, plainTheme, 60, { toolsExpanded: false }).map(stripAnsi).join("\n");
	assert.match(collapsed, /\[main 1a2b3c4\] feat: add the thing/);
	assert.match(collapsed, /2 files changed, 5 insertions\(\+\), 1 deletion\(-\)/);
	assert.doesNotMatch(collapsed, /create mode/, "the file list stays behind the expansion");
	assert.match(collapsed, /…/, "the pane says rows remain");

	const expanded = renderThreadItem(item, plainTheme, 60).map(stripAnsi).join("\n");
	for (const row of output.split("\n")) assert.ok(expanded.includes(row), `expanding keeps "${row}"`);
});

test("a failed versioning thread card keeps its cause visible when the rows wrap", () => {
	// The pane slices its own wrapped rows, so it can lose the cause the same way the
	// transcript can: the cause must lead at every width, and the pane still spends no
	// more than its three preview rows.
	const output = [
		"Auto-merging src/a.ts",
		"CONFLICT (content): Merge conflict in src/a.ts",
		"error: could not apply 1a2b3c4... feat: x",
		"hint: After resolving the conflicts, mark them with",
		'hint: "git add/rm <pathspec>", then run',
		'hint: run "git cherry-pick --abort".',
		"",
		"Command exited with code 1",
	].join("\n");
	const item = tool({ args: { command: "git cherry-pick 1a2b3c4" }, output, isError: true });
	const content = /error:|hint:|CONFLICT|Auto-merging|could not apply|resolving the conflicts|<pathspec>|cherry-pick --abort|Command exited/;
	// The expanded card wraps too, so a logical row is compared as the words it holds
	// once the card's rails are taken out of the way.
	const flatten = (rows: string[]) => rows.map((line) => line.replace(/^\s*\u2502?\s?/, "").replace(/\s*\u2502\s*$/, "")).join(" ").replace(/\s+/gu, " ");
	for (const width of [40, 44, 50, 120]) {
		const rows = renderThreadItem(item, plainTheme, width, { toolsExpanded: false }).map(stripAnsi);
		const collapsed = rows.join("\n");
		assert.match(collapsed, /could not apply 1a2b3c4/, `width ${width}: the cause stays visible`);
		assert.match(collapsed, /…/, `width ${width}: the rest stays one expansion away`);
		const previewRows = rows.filter((line) => content.test(line));
		assert.match(previewRows[0] ?? "", /could not apply 1a2b3c4/, `width ${width}: the cause leads, never a hint`);
		assert.ok(previewRows.length <= 4, `width ${width}: three preview rows and the marker, got ${JSON.stringify(previewRows)}`);

		const expanded = flatten(renderThreadItem(item, plainTheme, width).map(stripAnsi));
		for (const row of output.split("\n")) assert.ok(expanded.includes(row), `width ${width}: expanding keeps "${row}"`);
	}
});

test("a failed versioning thread card states its cause and exit status ahead of the advice", () => {
	// The pane reads the same shared preview, so a conflict looks the same here: the
	// cause and the exit status the host appended, never three rows of advice.
	const output = [
		"Auto-merging src/a.ts",
		"CONFLICT (content): Merge conflict in src/a.ts",
		"error: could not apply 1a2b3c4... feat: x",
		"hint: After resolving the conflicts, mark them with",
		'hint: "git add/rm <pathspec>", then run',
		'hint: run "git cherry-pick --abort".',
		"",
		"Command exited with code 1",
	].join("\n");
	const item = tool({ args: { command: "git cherry-pick 1a2b3c4" }, output, isError: true });
	const collapsed = renderThreadItem(item, plainTheme, 60, { toolsExpanded: false }).map(stripAnsi).join("\n");
	assert.match(collapsed, /could not apply 1a2b3c4/);
	assert.match(collapsed, /Command exited with code 1/);
	assert.match(collapsed, /…/, "the advice rows are one expansion away");

	const expanded = renderThreadItem(item, plainTheme, 60).map(stripAnsi).join("\n");
	for (const row of output.split("\n")) assert.ok(expanded.includes(row), `expanding keeps "${row}"`);
});

test("a versioning thread card with nothing left to show adds no truncation marker", () => {
	// A rebase prints one sentence, so expanding it would draw the same row again.
	const rebase = renderThreadItem(tool({ args: { command: "git rebase main" }, output: "Successfully rebased and updated refs/heads/main.\n" }), plainTheme, 60, { toolsExpanded: false }).map(stripAnsi).join("\n");
	assert.match(rebase, /Successfully rebased and updated refs\/heads\/main\./);
	assert.doesNotMatch(rebase, /…/, "one row of output has nothing left to reveal");

	// A silent add prints nothing, so the card draws nothing and claims nothing.
	for (const output of ["", "\n"]) {
		const add = renderThreadItem(tool({ args: { command: "git add -A" }, output }), plainTheme, 60, { toolsExpanded: false }).map(stripAnsi);
		assert.equal(add.length, 2, `${JSON.stringify(output)}: the heading and its closing rule only`);
		assert.doesNotMatch(add.join("\n"), /staged|added|created|files? changed/i);
	}
});

test("a versioning thread card says rows remain when wrapping alone hides them", () => {
	// The preview reads this output whole, so nothing is left behind textually. At a
	// narrow width those two rows wrap past the pane's three preview rows, and only
	// expanding draws the rest, so the marker must still say rows remain.
	const output = [
		"[main 1a2b3c4] feat: a subject long enough that the summary row wraps over more than the three preview rows at a narrow width",
		" 1 file changed, 1 insertion(+)",
	].join("\n");
	const item = tool({ args: { command: "git commit -m x" }, output });
	const collapsed = renderThreadItem(item, plainTheme, 44, { toolsExpanded: false }).map(stripAnsi).join("\n");
	assert.match(collapsed, /…/, "wrapping hides rows, so the pane says they remain");
	assert.doesNotMatch(collapsed, /1 file changed/, "the wrapped tail is what expanding reveals");

	const expanded = renderThreadItem(item, plainTheme, 44).map(stripAnsi).join("\n");
	assert.match(expanded, /1 file changed, 1 insertion\(\+\)/);
});

test("a gh thread card draws the rows the child printed, with no field layout", () => {
	// The pane reads a gh call the way it reads any shell call: its retained output,
	// bounded, with nothing invented over the payload.
	const output = [
		"{",
		'  "number": 123,',
		'  "state": "OPEN",',
		'  "title": "A helpful contribution"',
		"}",
	].join("\n");
	const item = tool({ args: { command: "gh pr view 123 --json title,state,number" }, output });
	const collapsed = renderThreadItem(item, plainTheme, 60, { toolsExpanded: false }).map(stripAnsi).join("\n");
	assert.match(collapsed, /⌕ exploring · gh pr view 123 --json title,state,number/);
	assert.match(collapsed, /"number": 123,/, "the rows are the ones the child printed");
	assert.doesNotMatch(collapsed, /^\s*title: /m, "no field layout is invented over the payload");
	assert.match(collapsed, /…/, "the rest of the output waits behind the marker");

	const expanded = renderThreadItem(item, plainTheme, 60).map(stripAnsi).join("\n");
	for (const row of output.split("\n")) assert.ok(expanded.includes(row), `expanding keeps "${row}"`);
	assert.doesNotMatch(expanded, /Raw output/, "the expansion is the result itself, not a decoded layout");
});

test("a gh thread card keeps a create's URL and the list's own rows", () => {
	const url = "https://github.com/o/r/pull/123";
	const created = renderThreadItem(tool({ args: { command: "gh pr create --fill" }, output: `${url}\n` }), plainTheme, 60, { toolsExpanded: false }).map(stripAnsi).join("\n");
	assert.match(created, /↑ publishing · gh pr create --fill/);
	assert.match(created, /https:\/\/github\.com\/o\/r\/pull\/123/);
	assert.doesNotMatch(created, /…/, "the URL is the whole result");

	const listed = JSON.stringify(
		Array.from({ length: 6 }, (_, index) => ({ number: 120 + index, title: `Pull request ${index}` })),
		null,
		2,
	);
	const item = tool({ args: { command: "gh pr list --json number,title" }, output: listed });
	const collapsed = renderThreadItem(item, plainTheme, 60, { toolsExpanded: false }).map(stripAnsi).join("\n");
	assert.match(collapsed, /"number": 120,/, "the list draws the payload's own rows");
	assert.doesNotMatch(collapsed, /number: 120 · title: Pull request 0/, "one item is not summarized onto a row");
	assert.match(collapsed, /…/, "the rest of the list stays one expansion away");
	assert.match(renderThreadItem(item, plainTheme, 60).map(stripAnsi).join("\n"), /Pull request 5/);
});

test("a failed gh thread card keeps the preview it always had", () => {
	const item = tool({
		args: { command: "gh pr view 999 --json title" },
		output: ["{", '  "title": "A helpful contribution"', "}", "GraphQL: Could not resolve to a PullRequest with the number of 999."].join("\n"),
		isError: true,
	});
	const collapsed = renderThreadItem(item, plainTheme, 60, { toolsExpanded: false }).map(stripAnsi).join("\n");
	// Nothing is styled out of a failure: the pane keeps its bounded first rows and
	// its marker for every call, however its output reads.
	assert.doesNotMatch(collapsed, /│ title: /, "a failure is never previewed as a payload");
	assert.match(collapsed, /…/, "the marker still says rows remain");
	const expanded = renderThreadItem(item, plainTheme, 60).map(stripAnsi);
	assert.match(expanded.join("\n"), /Could not resolve to a PullRequest/);
	assert.ok(expanded.every((row) => visibleWidth(row) <= 60));
});

// A retained thread's tool output is arbitrary text: the store sanitizes what it keeps,
// but a payload's JSON escape decodes into a real byte and JSON leaves C1 raw, so the
// pane sanitizes the copy it draws. Two properties have to hold together — the untrusted
// bytes are gone, and the theme's own escapes (painted after) are still there.
const C1_BYTES = /[\u007f-\u009f]/;
// C0 except the tab, the newline a row break uses, and the ESC the theme paints with.
const INJECTED_CONTROL = /[\u0000-\u0008\u000b-\u001a\u001c-\u001f]/;
const ALL_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const THEME_FG = "\u001b[36m";
const ansiTheme = { fg: (_color: string, text: string) => `${THEME_FG}${text}\u001b[39m` };
// A tool output holding a BEL, a complete C1 CSI and a lone C1 byte, with the text each
// one sat inside kept.
const POISONED_OUTPUT = ["alpha\u0007beta", "gamma\u009b31mdelta", "epsilon\u009fzeta"].join("\n");

test("the pane's own card sanitizes the retained output it draws", () => {
	// `subagent_run` has no chat renderer, so these rows are the pane's fallback card.
	const poisoned = tool({ name: "subagent_run", args: { agent: "worker" }, output: POISONED_OUTPUT });
	const expanded = renderThreadItem(poisoned, plainTheme, 60).join("\n");
	assert.doesNotMatch(expanded, ALL_CONTROL, "no control byte a tool's output carried reaches a row");
	assert.match(expanded, /alphabeta/, "the text the BEL sat in is kept");
	assert.match(expanded, /gammadelta/, "the CSI sequence goes and the text it wrapped stays");
	assert.match(expanded, /epsilonzeta/);

	// A collapsed card previews the same sanitized rows, so the short card is clean too.
	const short = renderThreadItem(tool({ name: "subagent_run", args: { agent: "worker" }, output: "alpha\u0007beta" }), plainTheme, 60, { toolsExpanded: false }).join("\n");
	assert.doesNotMatch(short, ALL_CONTROL);
	assert.match(short, /alphabeta/);

	// A long output spends the preview budget and the marker, and stays clean at both
	// levels: the bytes are removed before any row, wrapping or slicing happens.
	const long = Array.from({ length: 8 }, (_, index) => `row ${index}\u009b31m tail ${index}`).join("\n");
	const longItem = tool({ name: "subagent_run", args: { agent: "worker" }, output: long });
	const longCollapsed = renderThreadItem(longItem, plainTheme, 60, { toolsExpanded: false }).join("\n");
	assert.doesNotMatch(longCollapsed, ALL_CONTROL);
	assert.match(longCollapsed, /…/, "the marker still says rows remain");
	const longExpanded = renderThreadItem(longItem, plainTheme, 60).join("\n");
	assert.doesNotMatch(longExpanded, ALL_CONTROL);
	for (let index = 0; index < 8; index += 1) assert.ok(longExpanded.includes(`row ${index} tail ${index}`), `expanding keeps row ${index}`);

	// Legitimate text is untouched: accents, CJK and emoji are drawn as the call produced them.
	const unicode = tool({ name: "subagent_run", args: { agent: "worker" }, output: "línea 日本語 🐛 ñandú" });
	assert.match(renderThreadItem(unicode, plainTheme, 60).join("\n"), /línea 日本語 🐛 ñandú/);

	// The theme's own colour survives while the payload's bytes do not: the pane
	// sanitizes the untrusted text it was handed, never the row it painted.
	const painted = renderThreadItem(poisoned, ansiTheme, 60).join("\n");
	assert.ok(painted.includes(THEME_FG), "the theme's escape is still painted");
	assert.doesNotMatch(painted, C1_BYTES);
	assert.doesNotMatch(painted, INJECTED_CONTROL);
});

test("a retained call drawn by the chat's own renderer sanitizes the same way", (t) => {
	t.after(() => clearAgentToolRenderers());
	registerAgentToolRenderers({ bash: createQuietToolRenderer("bash") });
	// The chat's card sanitizes the result it is handed, so the reused renderer path is
	// clean without the pane sanitizing it a second time — and the theme's escapes the
	// chat paints with are still there.
	const item = tool({ args: { command: "printf poisoned" }, output: POISONED_OUTPUT });
	const expanded = renderThreadItem(item, plainTheme, 60).join("\n");
	assert.doesNotMatch(expanded, ALL_CONTROL);
	assert.match(expanded, /alphabeta/);
	assert.match(expanded, /gammadelta/);
	const painted = renderThreadItem(item, ansiTheme, 60).join("\n");
	assert.ok(painted.includes(THEME_FG), "the chat card's theme escapes survive");
	assert.doesNotMatch(painted, C1_BYTES);
	assert.doesNotMatch(painted, INJECTED_CONTROL);
});

test("a non-versioning thread card keeps the preview it always had", () => {
	// Only local history is restyled: inspection, checks and publishing keep the
	// bounded first rows and the marker that says more remain.
	const output = Array.from({ length: 6 }, (_, index) => `output ${index}`).join("\n");
	const collapsed = renderThreadItem(tool({ args: { command: "git status" }, output }), plainTheme, 40, { toolsExpanded: false });
	assert.equal(collapsed.length, 6, "head, three preview rows, one truncated marker, and the closing rule");
	assert.match(collapsed[1]!, /output 0/);
	assert.match(collapsed[4]!, /^│ … +│$/);
});

test("renderThreadItem follows the chat's thinking visibility", () => {
	// Visible: the chat draws thinking inline in the thinking role, unlabeled.
	assert.deepEqual(renderThreadItem({ kind: "thinking", text: "first\nsecond" }, taggedTheme, 30), ["[thinkingText] first", "[thinkingText] second"]);
	assert.deepEqual(renderThreadItem({ kind: "thinking", text: "one\n\ntwo" }, taggedTheme, 40), ["[thinkingText] one", "[thinkingText] ", "[thinkingText] two"]);
	// Hidden: the chat collapses the whole run to its one-row label.
	assert.deepEqual(renderThreadItem({ kind: "thinking", text: "secret reasoning" }, taggedTheme, 30, { thinkingVisible: false }), ["[thinkingText]Thinking..."]);
});

test("renderThreadItem previews a collapsed tool card and expands it with the chat's own state", () => {
	const output = Array.from({ length: 6 }, (_, index) => `output ${index}`).join("\n");
	const expanded = renderThreadItem(tool({ output }), plainTheme, 40);
	assert.equal(expanded.length, 8, "head, six retained rows, and the closing rule");
	const collapsed = renderThreadItem(tool({ output }), plainTheme, 40, { toolsExpanded: false });
	assert.equal(collapsed.length, 6, "head, three preview rows, one truncated marker, and the closing rule");
	assert.match(collapsed[1], /^│ output 0 +│$/);
	assert.match(collapsed[3], /^│ output 2 +│$/);
	assert.equal(collapsed.join("\n").includes("output 3"), false, "a collapsed card shows the chat's bounded preview");
	assert.match(collapsed[4], /^│ … +│$/, "a collapsed card never hides the remaining rows silently");
	assert.match(collapsed[5], /^╰─+╯$/);
	for (const row of collapsed) assert.equal(visibleWidth(row), 40);
	// A short card is already complete, so collapsing adds no marker.
	assert.equal(renderThreadItem(tool({ output: "one" }), plainTheme, 40, { toolsExpanded: false }).length, 3);
});

test("renderThreadItem draws a steering message as the received message, and keeps unrelated notes labeled", () => {
	// lib/agents-runner.ts records a message delivered to a running child as a
	// note marked `steered: `, because the protocol carries no user-item kind.
	const steered = renderThreadItem({ kind: "note", text: "steered: also check the lexer" }, plainTheme, 40).map(stripAnsi).join("\n");
	assert.match(steered, /✉  Messaging agent · note/, "the message the child received wears the chat's Messaging agent heading");
	assert.equal(steered.includes("steered:"), false, "the runner's transport marker never reaches the pane");
	assert.match(steered, /also check the lexer/);
	for (const text of ["error: boom", "asked: pick one", "retrying (1/3)", "extension error: x"]) {
		assert.deepEqual(renderThreadItem({ kind: "note", text }, plainTheme, 40), ["Note", `  ${text}`], `"${text}" is not an input message`);
	}
});

test("renderInputMessage draws the received message as the chat's Messaging agent card", () => {
	// The pane reuses the agent card's design for a message the child received:
	// the same iris heading, glyph, rail and tint the chat's Messaging agent
	// call wears (extensions/gentle-agents.ts agentTheme), with the message
	// itself below it. It is a message, not a call: it never collapses, so no
	// expansion hint and no preview budget of its own.
	const message = "please inspect the parser\nand report what you find";
	const rows = renderInputMessage(message, tintTheme, 60);
	const shown = rows.map(stripAnsi).join("\n");
	assert.match(shown, /✉  Messaging agent · note/, "the heading is the chat's own Messaging agent heading");
	assert.match(shown, /please inspect the parser/);
	assert.match(shown, /and report what you find/, "the whole message is below the heading");
	assert.ok(shown.indexOf("Messaging agent") < shown.indexOf("please inspect the parser"), "the heading opens the card");
	// Same identity as the transcript card: iris heading and rail on the iris tint.
	assert.ok(rows.some((row) => row.includes(IRIS_HEADING) && row.includes("✉  Messaging agent")), "the glyph and heading wear the agent card's iris");
	assert.ok(rows.filter((row) => row.includes(IRIS_RAIL)).length >= 3, "every card row keeps the agent card's iris rail");
	assert.equal(rows.every((row) => row.includes(IRIS_TINT)), true, "the card sits on the agent card's tint");
	for (const row of rows) assert.equal(visibleWidth(row), 60, `"${stripAnsi(row)}" keeps the pane width`);
	// A message is always shown whole: every retained line, no preview marker.
	const long = Array.from({ length: 24 }, (_, index) => `message line ${index}`).join("\n");
	const whole = renderInputMessage(long, tintTheme, 40).map(stripAnsi).join("\n");
	for (let index = 0; index < 24; index += 1) assert.match(whole, new RegExp(`message line ${index}\\b`), `message line ${index} reaches the card`);
	assert.equal(whole.includes("…"), false, "the message is never clipped to a preview");
	assert.equal(/ctrl\+o/i.test(whole), false, "a message carries no expansion hint");
	// A long message wraps inside the card instead of being cut off.
	const wrapped = renderInputMessage("alpha beta gamma delta", plainTheme, 24).map(stripAnsi);
	assert.equal(wrapped.length > 2, true, "a long message wraps onto more rows");
	assert.match(wrapped.join(" "), /alpha[\s\S]*delta/, "the tail of the message is never dropped");
	// A theme without a background keeps the outlined card, in the same roles.
	const outlined = renderInputMessage(message, plainTheme, 60).map(stripAnsi);
	assert.match(outlined[0], /^╭─ ✉  Messaging agent · note/);
	assert.match(outlined.at(-1) ?? "", /^╰─+╯$/);
	// A narrow pane still draws a bounded, closed card around the words.
	for (let narrow = 1; narrow <= 14; narrow += 1) {
		const lines = renderInputMessage("alpha beta", plainTheme, narrow);
		assert.ok(lines.length > 0, `a ${narrow}-column pane still draws the message`);
		for (const row of lines) assert.ok(visibleWidth(row) <= narrow, `"${stripAnsi(row)}" fits ${narrow} columns`);
		if (narrow >= 10) assert.match(lines.join("\n"), /alpha/, `a ${narrow}-column pane still shows the message`);
	}
	assert.deepEqual(renderInputMessage("", plainTheme, 30), [], "an absent message draws nothing");
	assert.deepEqual(renderInputMessage("   ", plainTheme, 30), [], "a blank message draws nothing");
});

test("the message card keeps a visible gap after its envelope at every width", () => {
	// An emoji-fallback font draws U+2709 two cells wide while pi-tui counts it as
	// one, so the single space a heading joins after its glyph would be painted
	// inside the glyph and read as `✉Messaging`. The card therefore carries the
	// envelope's own gap — the two-cell glyph gap the sidebar widgets use — so one
	// column always shows, whatever the font draws, and the heading's counted
	// width stays equal to what the terminal paints.
	for (const theme of [plainTheme, tintTheme]) {
		for (let width = 10; width <= 120; width += 1) {
			const shown = renderInputMessage("hello", theme, width).map(stripAnsi);
			const heading = shown.find((row) => row.includes("✉"));
			if (heading === undefined) continue;
			assert.match(heading, /✉ {2}/u, `a ${width}-column card keeps two columns after the envelope`);
			if (width >= 30) assert.match(heading, /✉ {2}Messaging agent/u, `a ${width}-column card shows the heading after the gap`);
			if (width >= 60) assert.match(heading, /✉ {2}Messaging agent · note/u, `a ${width}-column card shows the whole heading`);
			for (const row of shown) assert.doesNotMatch(row, /✉\S/u, `"${row}" never joins the envelope to its heading`);
		}
	}
});

test("renderThreadItem draws a tool call as one card headed by the tool and its own call detail", () => {
	const lines = renderThreadItem(tool({ args: { command: "echo hi" }, output: "one\ntwo" }), plainTheme, 40);
	assert.match(lines[0], /^╭─ \$ bash · echo hi ─+╮$/, "the top rule names the tool and the call it made");
	assert.match(lines[1], /^│ one +│$/, "the first retained output line is the card's first body row");
	assert.match(lines[2], /^│ two +│$/);
	assert.match(lines.at(-1) ?? "", /^╰─+╯$/, "the call and its output read as one closed card");
	for (const row of lines) assert.equal(visibleWidth(row), 40, `"${row}" fills the pane width`);
	// A finished call with no output stays a quiet two-row card.
	assert.equal(renderThreadItem(tool(), plainTheme, 40).length, 2);
	// Each tool keeps its own mark and name, so two calls never read alike.
	assert.match(renderThreadItem(tool({ name: "read", args: { path: "lib/x.ts" } }), plainTheme, 40)[0], /^╭─ ≡ read · lib\/x\.ts ─+╮$/);
	assert.match(renderThreadItem(tool({ name: "grep", args: { pattern: "TODO", path: "lib" } }), plainTheme, 40)[0], /^╭─ ⌕ grep · \/TODO\/ in lib ─+╮$/);
});

test("a CodeGraph preview heads with the operation and mark its card wears in the chat", () => {
	// extensions/quiet-tools.ts CODEGRAPH_IDENTITY is the one CodeGraph mark, and
	// its card names the operation beside it, so the preview mirrors both: one
	// tool never reads as two glyphs — or two headings — across surfaces. `init`
	// names no query, so without its operation the row would say only `codegraph`.
	const row = renderThreadItem(tool({ name: "codegraph", args: { operation: "query", query: "postEntry" } }), plainTheme, 60)[0];
	assert.match(row, /^╭─ 󰆼 codegraph · query postEntry ─+╮$/);
	const init = renderThreadItem(tool({ name: "codegraph", args: { operation: "init" }, output: "CodeGraph initialized a new .codegraph index at /repo (local)." }), plainTheme, 60)[0];
	assert.match(init, /^╭─ 󰆼 codegraph · init ─+╮$/);
});

test("the pane draws a CodeGraph init call exactly as the chat does, one collapsed action row", (t) => {
	t.after(() => clearAgentToolRenderers());
	// The retained call is drawn by the transcript's own CodeGraph card, so the
	// pane inherits its heading and its one-row init preview instead of keeping a
	// second card in step by hand.
	registerAgentToolRenderers({ codegraph: createCodeGraphCardRenderer() }, { owner: "quiet-tools" });
	const output = [
		'',
		'┌  Initializing CodeGraph',
		'│',
		'◆  Indexed 1 files',
		'│',
		'CodeGraph synced the existing .codegraph index at /repo (local).',
		'',
	].join("\n");
	const item = tool({ name: "codegraph", args: { operation: "init" }, output });
	const body = (rows: string[]) => rows.slice(1, -1).map((row) => stripAnsi(row).replace(/^│\s?/, "").replace(/\s+│$/, ""));

	const collapsed = renderThreadItem(item, plainTheme, 80, { toolsExpanded: false });
	assert.match(stripAnsi(collapsed[0]!), /^╭─ 󰆼 codegraph · init ─/, "the init call heads exactly as the chat's card heads it");
	assert.doesNotMatch(stripAnsi(collapsed[0]!), /to collapse/, "a collapsed row is not advertised as open");
	assert.deepEqual(body(collapsed), ["→ synced"], "collapsed says only the action the run stated");

	// Expanded, the pane shows the tool's own output, as the transcript does.
	const expanded = renderThreadItem(item, plainTheme, 80, { toolsExpanded: true }).map(stripAnsi).join("\n");
	assert.match(expanded, /CodeGraph synced the existing \.codegraph index at \/repo \(local\)\./);
	assert.match(expanded, /Indexed 1 files/);
});

test("renderThreadItem keeps every retained tool-output line inside the card across terminal widths", () => {
	const toolOutput = Array.from({ length: 11 }, (_, index) => `output line ${index}`).join("\n");
	for (const width of [20, 30, 40, 60, 80, 120]) {
		const lines = renderThreadItem(tool({ name: "long-running-command", output: toolOutput }), plainTheme, width);
		assert.equal(lines[0].includes("long-"), true, `the tool stays named at width ${width}`);
		for (let index = 0; index < 11; index += 1) {
			assert.equal(lines.some((row) => row.includes(`output line ${index}`)), true, `retained output line ${index} stays visible at width ${width}`);
		}
		assert.equal(lines.filter((row) => row.includes("output line")).length, 11, `no retained output line is capped at width ${width}`);
		for (const row of lines) assert.ok(visibleWidth(row) <= width, `"${row}" fits width ${width}`);
	}
});

test("renderThreadItem states a running, complete or failed call in the card's own tone", () => {
	const running = renderThreadItem(tool({ running: true }), taggedTheme, 40);
	assert.equal(running[0].startsWith("[warning]╭"), true, "a call still waiting wears the pending tone");
	assert.equal(running.some((row) => row.includes("[muted]running…")), true, "a call with nothing yet says it is running");
	const partial = renderThreadItem(tool({ running: true, output: "half" }), taggedTheme, 40);
	assert.equal(partial.some((row) => row.includes("half")), true, "live output replaces the placeholder");
	assert.equal(partial.some((row) => row.includes("running…")), false);
	const complete = renderThreadItem(tool({ output: "done" }), taggedTheme, 40);
	assert.equal(complete[0].startsWith("[success]╭"), true);
	const failed = renderThreadItem(tool({ output: "boom", isError: true }), taggedTheme, 40);
	assert.equal(failed[0].startsWith("[error]╭"), true, "a failed call never reads as a finished one");
	assert.equal(failed[0].includes("[error]$ bash"), true);
});

test("renderThreadItem shows the whole retained bash command on an expanded card and one line collapsed", () => {
	// The chat's bash card keeps a collapsed heading on one row and restores the
	// complete command across the rows below once it is expanded. A card that only
	// ever drew a one-row heading expanded its output but never its call, so the
	// command the subagent ran was unreadable past the first screenful of columns.
	const command = `cat ${Array.from({ length: 12 }, (_, index) => `lib/module-${index}/retained-command-surface.ts`).join(" ")}`;
	const headingOf = (rows: string[]) => rows.map((row) => stripAnsi(row).replace(/[╭╮╰╯│─]/gu, " ")).join(" ").replace(/\s+/gu, " ").trim();
	const expanded = renderThreadItem(tool({ args: { command } }), plainTheme, 60);
	assert.equal(headingOf(expanded.slice(0, -1)), `⌕ exploring · ${command}`, "every character of the retained command reaches the expanded card");
	assert.equal(expanded.length > 2, true, "an over-wide command continues on the rows below the rule");
	for (const row of expanded) assert.equal(visibleWidth(row), 60, `"${stripAnsi(row)}" keeps the pane width`);
	// Collapsed is still the chat's one-line preview, ending in an ellipsis.
	const collapsed = renderThreadItem(tool({ args: { command } }), plainTheme, 60, { toolsExpanded: false });
	assert.equal(collapsed.length, 2, "a collapsed card is its heading and its closing rule");
	assert.match(collapsed[0], /…\s*╮$/, "an over-wide command ends in an ellipsis instead of wrapping");
	assert.equal(collapsed[0].includes("module-1/"), false, "the collapsed heading never continues on a second row");
	assert.equal(collapsed.join("\n").includes(command), false, "the collapsed card shows only the preview it always did");
	for (const row of collapsed) assert.equal(visibleWidth(row), 60);
	// A multi-line call keeps its own lines, so a script is not folded into one
	// unreadable row; the command's whitespace still folds the way it always has.
	const script = renderThreadItem(tool({ args: { command: "git diff --stat\n-- lib/agents-thread-view.ts" } }), plainTheme, 80).map(stripAnsi);
	assert.equal(script.length, 3, "the second line of the call keeps a row of its own");
	assert.match(script[1], /─ lib\/agents-thread-view\.ts|^│ -- lib\/agents-thread-view\.ts/);
	assert.match(renderThreadItem(tool({ args: { command: "ls  -la" } }), plainTheme, 40)[0], /· ls -la /, "runs of spaces still fold as they did");
	// A retained escape never reaches the terminal through the heading either.
	const hostile = renderThreadItem(tool({ args: { command: "cat \u001b[31mlib/x.ts\u0007" } }), plainTheme, 40);
	assert.equal(hostile.join("").includes("\u001b"), false, "a retained escape is stripped from the command");
	assert.match(hostile.map(stripAnsi).join("\n"), /cat lib\/x\.ts/);
});

test("renderThreadItem keeps another tool's bounded one-line heading when it is expanded", () => {
	// Only the shell command is shown whole: a file path or query stays one row so
	// a card never turns into a wall of heading just because it is expanded.
	const path = `lib/${Array.from({ length: 20 }, (_, index) => `segment-${index}`).join("/")}/x.ts`;
	const lines = renderThreadItem(tool({ name: "read", args: { path } }), plainTheme, 40);
	assert.equal(lines.length, 2, "a non-shell card keeps its one-row heading and closing rule");
	assert.match(lines[0], /…\s*╮$/, "an over-wide detail still ends in an ellipsis");
	assert.equal(lines[0].includes("segment-19"), false, "a non-shell detail is not continued on the rows below");
	for (const row of lines) assert.equal(visibleWidth(row), 40);
});

test("renderThreadItem omits a call detail the thread never carried", () => {
	// Remote presence threads publish tool items with no invocation arguments.
	for (const args of [{}, { command: "  " }, { command: 7 } as unknown as Record<string, unknown>]) {
		const lines = renderThreadItem(tool({ args }), plainTheme, 40);
		assert.match(lines[0], /^╭─ \$ bash ─+╮$/, "an absent detail leaves the heading at the tool alone");
		assert.equal(lines.join("\n").includes("undefined"), false);
	}
});

test("renderThreadItem draws the tool card in the conversation card style", () => {
	setCardStyle(CARD_STYLE.FLOAT);
	const lines = renderThreadItem(tool({ args: { command: "echo hi" }, output: "one" }), floatTheme, 40);
	const stripped = lines.map(stripAnsi);
	assert.equal(stripped[0].includes("bash"), false, "the float card opens with its padding row");
	assert.equal(stripped[1].includes("$ bash · echo hi"), true, "the heading keeps the conversation card's float chrome");
	assert.equal(lines[1].includes("\u001b[48;5;236m"), true, "the card paints its tone background like the transcript card does");
	for (const row of lines) assert.equal(visibleWidth(row), 40, `"${stripAnsi(row)}" keeps the pane width`);
});

test("renderThreadItem fits every card row inside very narrow terminals", () => {
	for (let width = 1; width <= 12; width += 1) {
		const lines = renderThreadItem(tool({ args: { command: "echo hi" }, output: "one\ntwo", running: true }), plainTheme, width);
		assert.ok(lines.length > 0, `a ${width}-column pane still draws the call`);
		assert.match(lines.at(-1) ?? "", /^╰/, `the card still closes at width ${width}`);
		for (const row of lines) assert.ok(visibleWidth(row) <= width, `"${row}" fits width ${width}`);
	}
	assert.deepEqual(renderThreadItem(tool(), plainTheme, 0), []);
});

test("renderThreadItem renders actual sanitized retention markers and error status color", () => {
	let thread = emptyThread({ maxOutputChars: 24 });
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_START, callId: "call", name: "bash", args: {} });
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_END, callId: "call", output: "\u001b[31mfirst retained line\nlast retained line", isError: true });
	const item = thread.items[0];
	assert.equal(item?.kind, "tool");
	if (item?.kind !== "tool") throw new Error("expected the actual tool event to create a tool item");
	assert.equal(item.output.includes("\u001b"), false, "applyTaskEvent sanitizes terminal escapes before rendering");
	assert.equal(item.output.startsWith("…"), true, "the existing retention marker reaches the view unchanged");
	const lines = renderThreadItem(item, taggedTheme, 60);
	assert.equal(lines[0].startsWith("[error]╭"), true);
	assert.equal(lines[0].includes("[error]$ bash"), true);
	assert.equal(lines.some((row) => row.includes("…")), true, "the renderer retains the protocol marker rather than inventing one");
});

// A tool the chat already draws must read in the preview exactly as it reads in
// the transcript: the preview reuses the chat's own renderers instead of a
// second card kept in step by hand, so a heading can never drift again.
test("a tool the chat draws is the chat's own card in the preview, not a second one", (t) => {
	t.after(() => clearAgentToolRenderers());
	registerAgentToolRenderers({
		read: createQuietToolRenderer("read"),
		edit: createQuietToolRenderer("edit"),
		write: createQuietToolRenderer("write"),
	});
	const heading = (item: ToolItem, width = 60) => stripAnsi(renderThreadItem(item, plainTheme, width, { toolsExpanded: false })[0]!).trimEnd();

	// The chat heads a call with the tool name and its argument on one line; the
	// preview used to head it with the name, a separator and the argument.
	assert.match(heading(tool({ name: "read", args: { path: "lib/x.ts" } })), /^╭─ ≡ read lib\/x\.ts/);
	assert.doesNotMatch(heading(tool({ name: "read", args: { path: "lib/x.ts" } })), /≡ read · lib/);
	// The reported drift: write and edit headed `+ write · path` in the preview and
	// `+ write path (n lines)` in the chat, so one call read two ways.
	assert.match(heading(tool({ name: "write", args: { path: "a.ts", content: "one\ntwo" }, output: "wrote 8 bytes" })), /^╭─ \+ write a\.ts \(2 lines\)/);
	assert.doesNotMatch(heading(tool({ name: "write", args: { path: "a.ts", content: "one\ntwo" } })), /\+ write · a\.ts/);
	assert.match(heading(tool({ name: "edit", args: { path: "a.ts", oldText: "x", newText: "y" }, output: "ok" })), /^╭─ ✎ edit a\.ts/);
	assert.doesNotMatch(heading(tool({ name: "edit", args: { path: "a.ts" } })), /✎ edit · a\.ts/);
	// The rest of the row is the chat's too: the call, its retained result and the
	// closing rule of one card.
	const read = renderThreadItem(tool({ name: "read", args: { path: "lib/x.ts" }, output: "line one\nline two" }), plainTheme, 60, { toolsExpanded: true });
	assert.match(read.map(stripAnsi).join("\n"), /line one[\s\S]*line two/, "the retained result is drawn by the chat's result slot");
	assert.match(stripAnsi(read.at(-1)!), /^╰─+╯$/, "and one card still closes the row");
});

test("an edit's diff wears the theme's diff roles in the preview too", (t) => {
	t.after(() => clearAgentToolRenderers());
	// The chat's edit renderer is the pane's edit card, so a retained diff — the rows
	// an edit result carried, with no details payload to read — is colored by the same
	// code that colors the transcript: added rows in the added role, removed rows in
	// the removed role, and everything else left as the card already painted it.
	registerAgentToolRenderers({ edit: createQuietToolRenderer("edit") }, { owner: "quiet-tools" });
	const item = tool({ name: "edit", args: { path: "a.ts" }, output: "-1 old\n+2 new\n 3 kept" });
	const shown = renderThreadItem(item, taggedTheme, 60, { toolsExpanded: true }).join("\n");
	assert.match(shown, /\[toolDiffRemoved\]-1 old/);
	assert.match(shown, /\[toolDiffAdded\]\+2 new/);
	assert.equal(shown.includes("[toolDiffAdded] 3 kept"), false, "a context row is not a change");

	// The pane's own fallback card reads the same marks when the chat has no renderer
	// to hand over, so an edit's diff does not lose its colors with the chat's card.
	clearAgentToolRenderers();
	const fallback = renderThreadItem(item, taggedTheme, 60, { toolsExpanded: true }).join("\n");
	assert.match(fallback, /\[toolDiffRemoved\]-1 old/);
	assert.match(fallback, /\[toolDiffAdded\]\+2 new/);
	assert.match(fallback, / 3 kept/, "the context row is still drawn, in no diff role");
	assert.equal(fallback.includes("[toolDiffAdded] 3"), false);

	// A failed edit's output is its error, never a diff to color.
	const failed = renderThreadItem(tool({ name: "edit", args: { path: "a.ts" }, output: "-1 old\n+2 new", isError: true }), taggedTheme, 60, { toolsExpanded: true }).join("\n");
	assert.equal(failed.includes("[toolDiffAdded]"), false);
	assert.equal(failed.includes("[toolDiffRemoved]"), false);
});

// The reported drift, end to end through the real chat renderer: an edit's
// details now reach the pane, so neither expansion level falls back to `✓
// applied` for a change the child could count. Both levels are compared row for
// row against the transcript's own card, and a call without details keeps the
// truthful fallback rather than an invented diff.
test("an edit's own details draw the transcript's card at both expansion levels", (t) => {
	t.after(() => clearAgentToolRenderers());
	const renderer = createQuietToolRenderer("edit");
	registerAgentToolRenderers({ edit: renderer }, { owner: "quiet-tools" });
	const chatTheme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text, underline: (text: string) => text, strikethrough: (text: string) => text };
	const args = { path: "lib/x.ts", edits: [{ oldText: "old", newText: "new" }] };
	const output = "Successfully replaced 1 occurrence";
	const diff = "--- lib/x.ts\n+++ lib/x.ts\n@@ -1,3 +1,3 @@\n-1 old\n+1 new\n 2 kept\n 3 also";
	const transcript = (expanded: boolean, details: unknown): string[] => {
		const context = { args, toolCallId: "call", invalidate() {}, lastComponent: undefined, state: {}, cwd: "", executionStarted: true, argsComplete: true, isPartial: false, expanded, showImages: false, isError: false, durationMs: undefined, outputPad: 0 };
		const call = renderer.renderCall!(args, chatTheme as never, context as never);
		const result = renderer.renderResult!({ content: [{ type: "text", text: output }], details } as never, { expanded, isPartial: false }, chatTheme as never, context as never);
		return [...call.render(100), ...result.render(100)];
	};
	const item = tool({ name: "edit", args, output, details: { diff } });
	for (const expanded of [false, true]) {
		assert.deepEqual(renderThreadItem(item, plainTheme, 100, { toolsExpanded: expanded }), transcript(expanded, { diff }), `the ${expanded ? "expanded" : "collapsed"} pane card is the transcript card`);
	}
	const collapsed = renderThreadItem(item, plainTheme, 100, { toolsExpanded: false }).map(stripAnsi).join("\n");
	assert.match(collapsed, /✓ \+1 \/ -1/, "the collapsed card states the counts the child's diff produced, not `applied`");
	assert.equal(collapsed.includes("applied"), false);
	const opened = renderThreadItem(item, plainTheme, 100, { toolsExpanded: true }).map(stripAnsi).join("\n");
	assert.match(opened, /-1 old/, "the expanded card is the diff itself");
	assert.match(opened, /\+1 new/);
	assert.equal(opened.includes("Successfully replaced"), false, "the acknowledgement is not what an expanded diff shows");

	// A call that carries no details — an older child, a thread restored from a
	// history file, a remote presence row — keeps the card the transcript draws for
	// it, which states the acknowledgement it has and never a diff it does not.
	const plain = tool({ name: "edit", args, output });
	for (const expanded of [false, true]) {
		assert.deepEqual(renderThreadItem(plain, plainTheme, 100, { toolsExpanded: expanded }), transcript(expanded, undefined), `a details-free ${expanded ? "expanded" : "collapsed"} edit reads as the transcript draws it`);
	}
	assert.match(renderThreadItem(plain, plainTheme, 100, { toolsExpanded: false }).map(stripAnsi).join("\n"), /✓ applied/);
});

test("a tool the chat does not draw keeps the preview's own card", (t) => {
	t.after(() => clearAgentToolRenderers());
	// Registration is per tool: naming one renderer never claims another's row.
	registerAgentToolRenderers({ read: createQuietToolRenderer("read") });
	assert.match(stripAnsi(renderThreadItem(tool({ name: "edit", args: { path: "a.ts" } }), plainTheme, 40)[0]!), /^╭─ ✎ edit · a\.ts/);
	assert.match(stripAnsi(renderThreadItem(tool({ name: "subagent_run", args: { agent: "worker" } }), plainTheme, 40)[0]!), /^╭─ → subagent_run · worker/);
	assert.match(stripAnsi(renderThreadItem(tool({ args: { command: "pnpm test" } }), plainTheme, 40)[0]!), /^╭─ ✓ checking · pnpm test/, "the shell card stays the preview's own until the chat's renderer is registered");
});

test("a registered file renderer draws the ODD card's heading role in the preview's own tree", async (t) => {
	t.after(() => clearAgentToolRenderers());
	// The pane reuses the chat's card through an adapter, and the identity is a theme role,
	// so the left edge and the label read mdHeading in the pane exactly as in the chat.
	const { readFile } = await import("node:fs/promises");
	const { fileURLToPath } = await import("node:url");
	const { loadThemeFromPath } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
	const { foregroundAnsi, parseColor, getTerminalColorMode } = await import("@earendil-works/pi-tui");
	const mode = getTerminalColorMode();
	registerAgentToolRenderers({ read: createQuietToolRenderer("read") }, { owner: "quiet-tools" });
	for (const name of ["Gentle", "Gentleman-Cute", "Gentleman-Sexy"]) {
		const path = fileURLToPath(new URL(`../themes/${name}.json`, import.meta.url));
		const theme = loadThemeFromPath(path, mode);
		const shipped = JSON.parse(await readFile(path, "utf8"));
		const resolve = (role: string) => shipped.vars?.[shipped.colors[role]] ?? shipped.colors[role];
		const expected = foregroundAnsi(parseColor(resolve("mdHeading")), mode);
		const rows = renderThreadItem(tool({ name: "read", args: { path: "odd/work/design.md" }, output: "one" }), theme as never, 100);
		const plain = rows.map((row) => stripAnsi(row));
		const heading = rows[plain.findIndex((row) => row.includes("odd ·"))] ?? "";
		assert.ok(heading.includes(expected), `${name}: the registered card heads the ODD identity in mdHeading`);
		const rail = rows[plain.findIndex((row) => row.includes("one"))] ?? "";
		assert.ok(rail.includes(expected), `${name}: and so does the rail that leads its rows`);
	}
});

test("a registered shell renderer draws the chat's bash card in the preview", (t) => {
	t.after(() => clearAgentToolRenderers());
	registerAgentToolRenderers({ bash: createQuietToolRenderer("bash") });
	// One factory, so the activity theme, the rail and the tone are the chat's.
	// Tags are read off the row: this theme labels each role it is asked for.
	const untag = (row: string) => stripAnsi(row).replace(/\[[a-zA-Z]+\]/gu, "");
	const checked = renderThreadItem(tool({ args: { command: "pnpm test" }, output: "PASS" }), taggedTheme, 40);
	assert.match(checked[0]!, /^\[mdHeading\]╭\[success\]─ /, "the idle card's left corner carries the activity's role, the rule the call's status");
	assert.match(untag(checked[0]!), /^╭─ ✓ checking · pnpm test/, "the activity and its command are the chat's own heading");
	assert.match(checked[1]!, /^\[mdHeading\]│.*\[success\]│$/, "the left rail carries the activity's role, as the transcript's does, and the far rail the call's");
	const running = renderThreadItem(tool({ args: { command: "pnpm test" }, running: true, output: "" }), taggedTheme, 40);
	assert.equal(running.some((row) => row.includes("[muted]running…")), true, "a call with no result yet still says it is running");
});

// A skill or an ODD artifact heads as that file in the transcript, so the pane's
// own card (the one it draws when no chat renderer has been offered) names the
// same file kind from the same shared helpers: one call never reads two ways.
test("a thread card heads a skill and an ODD artifact as the chat does", () => {
	const skill = tool({ name: "read", args: { path: "skills/gentle-ai/SKILL.md", offset: 2, limit: 3 }, output: "one" });
	assert.match(renderThreadItem(skill, plainTheme, 60)[0]!, /^╭─ ▤ skill · read skills\/gentle-ai\/SKILL\.md:2-4/);
	// A SKILL.md is a skill wherever it sits, and a folder that only starts with
	// the word is an ordinary read.
	assert.match(renderThreadItem(tool({ name: "read", args: { path: "SKILL.md" } }), plainTheme, 60)[0]!, /^╭─ ▤ skill · read SKILL\.md/);
	assert.match(renderThreadItem(tool({ name: "read", args: { path: "lib/skillset/x.ts" } }), plainTheme, 60)[0]!, /^╭─ ≡ read · lib\/skillset\/x\.ts/);

	// An edit and a write state no line range: the lines they write are a count,
	// never a position in the file, so the pane names none either.
	const edit = tool({ name: "edit", args: { path: "odd/work/design.md", oldText: "a", newText: "one\ntwo" }, output: "ok" });
	const write = tool({ name: "write", args: { path: "odd/work/design.md", content: "one\ntwo\nthree" }, output: "wrote" });
	assert.match(renderThreadItem(edit, plainTheme, 60)[0]!, /^╭─ 📑 odd · edit odd\/work\/design\.md/);
	assert.match(renderThreadItem(write, plainTheme, 60)[0]!, /^╭─ 📑 odd · write odd\/work\/design\.md/);
	for (const item of [edit, write]) {
		assert.doesNotMatch(renderThreadItem(item, plainTheme, 60)[0]!, /:\d/, "a line count never reads as a file line number");
	}
	// A Windows path is the same path components here too.
	assert.match(renderThreadItem(tool({ name: "read", args: { path: "C:\\repo\\odd\\work\\x.md" } }), plainTheme, 60)[0]!, /^╭─ 📑 odd · read C:\\repo\\odd\\work\\x\.md/);

	// The ODD heading wears the theme's own `mdHeading` role, the one the transcript asks
	// for, so the theme decides the color; the frame keeps the call's own state and the
	// rail that leads the rows carries the same role. No status or code role is borrowed.
	const tagged = renderThreadItem(tool({ name: "read", args: { path: "odd/work/design.md" }, output: "x" }), taggedTheme, 60);
	assert.match(tagged[0]!, /\[mdHeading\]📑 odd/);
	assert.doesNotMatch(tagged[0]!, /\[warning\]📑 odd/);
	for (const role of ["syntaxFunction", "syntaxVariable", "mdHr", "toolTitle"]) {
		assert.doesNotMatch(tagged[0]!, new RegExp(`\\[${role}\\]📑 odd`), `the ODD identity is not the theme's ${role}`);
	}
	assert.match(tagged[1]!, /^\[mdHeading\]│/, "the rail carries the heading's own role");
	assert.match(tagged[1]!, /\[success\]│$/, "and the right rail keeps the call's tone");
	// A skill keeps the read card's colors.
	assert.match(renderThreadItem(tool({ name: "read", args: { path: "skills/a/SKILL.md" }, output: "x" }), taggedTheme, 60)[0]!, /\[toolTitle\]▤ skill/);
});

test("an ODD card in the preview names the file collapsed and the path expanded", () => {
	// The pane's own card follows the chat's rule for an ODD artifact: collapsed it names
	// the file the call touched, expanded it states the whole path, and a read keeps the
	// range it asked for in both. A skill is not this case and states its path at both.
	const drawnAt = (name: string, args: Record<string, unknown>, expanded: boolean) =>
		renderThreadItem(tool({ name, args, output: "one" }), plainTheme, 100, { toolsExpanded: expanded }).map(stripAnsi).join("\n");
	const read = { path: "odd/work/design.md", offset: 142, limit: 4 };
	assert.match(drawnAt("read", read, false), /📑 odd · read design\.md:142-145/);
	assert.doesNotMatch(drawnAt("read", read, false), /odd\/work\/design\.md/);
	assert.match(drawnAt("read", read, true), /📑 odd · read odd\/work\/design\.md:142-145/);
	for (const name of ["edit", "write"]) {
		const args = { path: "odd/work/design.md", oldText: "a", newText: "b", content: "one\n" };
		assert.match(drawnAt(name, args, false), new RegExp(`📑 odd · ${name} design\\.md`));
		assert.match(drawnAt(name, args, true), new RegExp(`📑 odd · ${name} odd/work/design\\.md`));
		// A count of written lines is never dressed as a position in the file.
		assert.doesNotMatch(drawnAt(name, args, false), /:\d/);
		assert.doesNotMatch(drawnAt(name, args, true), /:\d/);
	}
	// Both separators, a name with spaces, and a skill that keeps its path.
	assert.match(drawnAt("read", { path: "odd/my design doc.md" }, false), /📑 odd · read my design doc\.md/);
	assert.match(drawnAt("read", { path: "C:\\repo\\odd\\work\\x.md" }, false), /📑 odd · read x\.md/);
	assert.match(drawnAt("read", { path: "C:\\repo\\odd\\work\\x.md" }, true), /📑 odd · read C:\\repo\\odd\\work\\x\.md/);
	assert.match(drawnAt("read", { path: "skills/gentle-ai/SKILL.md" }, false), /▤ skill · read skills\/gentle-ai\/SKILL\.md/);
});

test("a thread card renders an expanded read of any Markdown file as Markdown and every other file plain", () => {
	const source = "## Handoff\n\nSome **bold** text with `code`.";
	// The file's Markdown name decides it, never the folder holding it.
	for (const path of ["skills/a/SKILL.md", "odd/work/design.md", "docs/design.md"]) {
		const item = tool({ name: "read", args: { path }, output: source });
		const expanded = renderThreadItem(item, plainTheme, 60).map(stripAnsi).join("\n");
		assert.doesNotMatch(expanded, /## Handoff/, `${path}: a heading renders instead of its source`);
		assert.match(expanded, /Handoff/);
		assert.doesNotMatch(expanded, /\*\*/, `${path}: emphasis renders instead of its source`);
		// Collapsed keeps the raw preview: the pane shows the file, not a render of it.
		assert.match(renderThreadItem(item, plainTheme, 60, { toolsExpanded: false }).map(stripAnsi).join("\n"), /## Handoff/, path);
	}
	// A file that is not Markdown keeps the plain retained rows.
	for (const path of ["skills/a/notes.txt", "lib/x.ts"]) {
		const item = tool({ name: "read", args: { path }, output: source });
		assert.match(renderThreadItem(item, plainTheme, 60).map(stripAnsi).join("\n"), /## Handoff/, path);
	}
});

// The key a card names is the one the host resolved for the chat's own tool
// toggle, and it is named only when there is something behind it: a card whose
// two levels draw the same rows would advertise a key that changes nothing.
test("the pane's own card names the configured expand key only when expanding reveals rows", () => {
	const output = Array.from({ length: 6 }, (_, index) => `output ${index}`).join("\n");
	const item = tool({ name: "subagent_run", args: { task: "review" }, output });
	const collapsed = renderThreadItem(item, plainTheme, 60, { toolsExpanded: false, expandLabel: "ctrl+o" }).map(stripAnsi);
	assert.match(collapsed[0]!, /ctrl\+o to expand$|ctrl\+o to expand /, "the collapsed card names the key that opens it");
	const expanded = renderThreadItem(item, plainTheme, 60, { toolsExpanded: true, expandLabel: "ctrl+o" }).map(stripAnsi);
	assert.match(expanded[0]!, /ctrl\+o to collapse/, "an open card names the key that closes it");
	assert.equal(collapsed[0]!.includes("to collapse"), false);
	assert.equal(expanded[0]!.includes("to expand"), false);

	// The host's own label is what shows: a remapped key reaches the card, and a
	// hardcoded one never does.
	assert.match(renderThreadItem(item, plainTheme, 60, { toolsExpanded: false, expandLabel: "ctrl+e" }).map(stripAnsi)[0]!, /ctrl\+e to expand/);
	assert.equal(renderThreadItem(item, plainTheme, 60, { toolsExpanded: false, expandLabel: "ctrl+e" }).map(stripAnsi)[0]!.includes("ctrl+o"), false);
	// A host that left the action unbound names no key at all.
	const unbound = renderThreadItem(item, plainTheme, 60, { toolsExpanded: false, expandLabel: "" }).map(stripAnsi).join("\n");
	assert.equal(unbound.includes("to expand"), false);

	// A card that already shows everything it has carries no hint: there is no
	// second level for the key to reveal.
	const complete = tool({ name: "subagent_run", args: { task: "review" }, output: "one row" });
	const closed = renderThreadItem(complete, plainTheme, 60, { toolsExpanded: false, expandLabel: "ctrl+o" }).map(stripAnsi);
	const open = renderThreadItem(complete, plainTheme, 60, { toolsExpanded: true, expandLabel: "ctrl+o" }).map(stripAnsi);
	assert.equal(closed.join("\n").includes("ctrl+o"), false);
	assert.deepEqual(closed, open, "nothing is hidden, so the two levels are the same card");

	// A multi-line shell command is revealed by expanding, so the card names the key
	// even though its preview rows already fit.
	const multi = tool({ args: { command: "pnpm test \\\n  --watch" }, output: "ok" });
	assert.match(renderThreadItem(multi, plainTheme, 60, { toolsExpanded: false, expandLabel: "ctrl+o" }).map(stripAnsi).join("\n"), /ctrl\+o to expand/);
});

test("a card that is still running names no key, because it has not decided what it reveals", () => {
	const running = renderThreadItem(tool({ name: "subagent_run", args: { task: "review" }, running: true, output: "" }), plainTheme, 60, { toolsExpanded: false, expandLabel: "ctrl+o" });
	assert.equal(running.map(stripAnsi).join("\n").includes("ctrl+o"), false);
});

test("the key hint yields its columns before the heading does, at every width", () => {
	const output = Array.from({ length: 8 }, (_, index) => `line ${index}`).join("\n");
	const item = tool({ name: "subagent_run", args: { task: "review the parser" }, output });
	for (let width = 1; width <= 80; width += 1) for (const toolsExpanded of [false, true]) {
		const rows = renderThreadItem(item, plainTheme, width, { toolsExpanded, expandLabel: "ctrl+o" });
		for (const row of rows) assert.ok(visibleWidth(row) <= width, `"${stripAnsi(row)}" fits width ${width}`);
	}
	// Too narrow for both: the heading keeps its room and the hint steps aside.
	const narrow = renderThreadItem(item, plainTheme, 24, { toolsExpanded: false, expandLabel: "ctrl+o" }).map(stripAnsi);
	assert.equal(narrow[0]!.includes("ctrl+o"), false);
	assert.match(narrow[0]!, /subagent_run/);
});

// The elapsed time on a card is the child's own measurement and nothing else:
// no measurement means no time, so a resumed or remote thread never shows one.
test("the pane's own card shows the measured elapsed time on its closing rule", () => {
	const output = Array.from({ length: 6 }, (_, index) => `output ${index}`).join("\n");
	const measured = tool({ name: "subagent_run", args: { task: "review" }, output, durationMs: 1234 });
	for (const toolsExpanded of [false, true]) {
		const rows = renderThreadItem(measured, plainTheme, 60, { toolsExpanded }).map(stripAnsi);
		assert.match(rows.at(-1)!, / 1\.2s ╯$/, "the closing rule carries the measured time");
		for (const row of rows.slice(0, -1)) assert.equal(row.includes("1.2s"), false, "the time rides the rule, not the heading");
		assert.match(rows.join("\n"), /review/, "the call itself still heads the card");
	}
	// Sub-second runs read in milliseconds, as the chat's cards do.
	assert.match(renderThreadItem(tool({ name: "subagent_run", args: { task: "review" }, output: "one", durationMs: 320 }), plainTheme, 60).map(stripAnsi).at(-1)!, /320ms/);
	// No measurement, no time: an older child and a remote presence row both land
	// here, and neither may be given a made-up duration.
	for (const unmeasured of [
		tool({ name: "subagent_run", args: { task: "review" }, output }),
		tool({ name: "subagent_run", args: { task: "review" }, output, durationMs: Number.NaN }),
		tool({ name: "subagent_run", args: { task: "review" }, output: "one", running: true, durationMs: 900 }),
	]) {
		const rows = renderThreadItem(unmeasured, plainTheme, 60).map(stripAnsi);
		assert.equal(/\d+ms|\d+\.\d+s/.test(rows.join("\n")), false, "nothing measured, nothing drawn");
	}
	// The rule yields the time rather than overflowing a narrow pane.
	for (let width = 1; width <= 20; width += 1) {
		const rows = renderThreadItem(measured, plainTheme, width).map(stripAnsi);
		for (const row of rows) assert.ok(visibleWidth(row) <= width, `"${row}" fits width ${width}`);
	}
});

// The elapsed time and the key hint on a chat-drawn card are the chat's own: the
// pane hands the chat's renderer the same measured duration and the same
// expansion the transcript does, so one call reads identically in both places.
test("a chat-drawn card reads the same in the pane and in the transcript, time included", (t) => {
	t.after(() => clearAgentToolRenderers());
	registerAgentToolRenderers({ bash: createQuietToolRenderer("bash") });
	const chatTheme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text, underline: (text: string) => text, strikethrough: (text: string) => text };
	const args = { command: "pnpm test --watch" };
	const output = Array.from({ length: 8 }, (_, index) => `line ${index}`).join("\n");
	const transcript = (expanded: boolean, durationMs: number | undefined): string[] => {
		const context = { args, toolCallId: "call", invalidate() {}, lastComponent: undefined, state: {}, cwd: "", executionStarted: true, argsComplete: true, isPartial: false, expanded, showImages: false, isError: false, durationMs, outputPad: 0 };
		const renderer = createQuietToolRenderer("bash");
		const call = renderer.renderCall!(args, chatTheme as never, context as never);
		const result = renderer.renderResult!({ content: [{ type: "text", text: output }], details: undefined } as never, { expanded, isPartial: false }, chatTheme as never, context as never);
		return [...call.render(60), ...result.render(60)];
	};
	for (const expanded of [false, true]) {
		const pane = renderThreadItem(tool({ args, output, durationMs: 1234 }), plainTheme, 60, { toolsExpanded: expanded });
		assert.deepEqual(pane, transcript(expanded, 1234), `the ${expanded ? "expanded" : "collapsed"} pane card is the transcript card`);
	}
	const collapsed = renderThreadItem(tool({ args, output, durationMs: 1234 }), plainTheme, 60, { toolsExpanded: false }).map(stripAnsi).join("\n");
	assert.match(collapsed, /1\.2s/, "the measured time reaches the pane");
	assert.match(collapsed, /to expand/, "and so does the chat's own key hint");
	// A call the child did not measure draws no time in either place.
	assert.deepEqual(renderThreadItem(tool({ args, output }), plainTheme, 60, { toolsExpanded: false }), transcript(false, undefined));
});

test("a gh thread card expands to the retained output the chat draws", () => {
	// gh prints `--json` compact, so the retained output of an issue read is one long
	// row. Neither the pane nor the chat lays it out: expanding draws the result the
	// child produced, wrapped only by the width it is drawn at.
	const output = JSON.stringify({
		number: 2726,
		title: "Expanded cards should be legible",
		state: "OPEN",
		body: "First line of the report.\n\nSecond paragraph.",
		comments: [{ author: { login: "octocat" }, body: "Confirmed on main." }],
	});
	const item = tool({ args: { command: "gh issue view 2726 --json number,title,state,body,comments" }, output });
	const collapsed = renderThreadItem(item, plainTheme, 60, { toolsExpanded: false }).map(stripAnsi).join("\n");
	assert.match(collapsed, /\{"number":2726,/, "the preview is the payload's own first row");

	const expanded = renderThreadItem(item, plainTheme, 80, { toolsExpanded: true }).map(stripAnsi).join("\n");
	assert.doesNotMatch(expanded, /Raw output/, "there is no decoded layout to name");
	const flat = (value: string) => stripAnsi(value).replace(/[│╰╯╭─]/gu, "").replace(/\s+/gu, "");
	assert.ok(flat(expanded).includes(flat(output)), "expanding keeps the whole compact result");
});

test("an expanded write of a Markdown file renders what it wrote in the pane too; a non-Markdown write stays plain", (t) => {
	t.after(() => clearAgentToolRenderers());
	// Production offers the chat's write card to the pane, so this is the card a
	// delegated write is actually drawn with.
	registerAgentToolRenderers({ write: createQuietToolRenderer("write") }, { owner: "quiet-tools" });
	const source = "## Handoff\n\nSome **bold** text with `code`.";
	const write = (path: string) => tool({ name: "write", args: { path, content: source }, output: "Successfully wrote 44 bytes" });
	// The rule is the file's Markdown name, not the folder holding it: an ODD artifact,
	// a skill's document and a project's own notes render the same way in the pane, as
	// they do in the transcript.
	for (const path of ["odd/work/design.md", "skills/a/SKILL.md", "docs/design.md"]) {
		const expanded = renderThreadItem(write(path), plainTheme, 80, { toolsExpanded: true }).map(stripAnsi).join("\n");
		assert.doesNotMatch(expanded, /## Handoff/, `${path}: the heading renders instead of its source`);
		assert.match(expanded, /Handoff/);
		assert.doesNotMatch(expanded, /\*\*/, `${path}: emphasis renders instead of its source`);
		assert.match(expanded, /code/);
	}
	// A file that is not Markdown keeps the content as it was written; collapsed keeps
	// the write's own summary.
	assert.match(renderThreadItem(write("odd/work/notes.txt"), plainTheme, 80, { toolsExpanded: true }).map(stripAnsi).join("\n"), /## Handoff/);
	const collapsed = renderThreadItem(write("odd/work/design.md"), plainTheme, 80, { toolsExpanded: false }).map(stripAnsi).join("\n");
	assert.match(collapsed, /wrote 44 bytes/);
	assert.doesNotMatch(collapsed, /Handoff/);
	// A failed write states its cause and never renders the body it did not write.
	const failed = renderThreadItem(tool({ name: "write", args: { path: "odd/work/design.md", content: source }, output: "EACCES: permission denied", isError: true }), plainTheme, 80, { toolsExpanded: true }).map(stripAnsi).join("\n");
	assert.match(failed, /EACCES/);
	assert.doesNotMatch(failed, /Handoff/);
});

test("a delegated edit's own diff reaches the pane through the child's real tool", async (t) => {
	t.after(() => clearAgentToolRenderers());
	const dir = await mkdtemp(join(tmpdir(), "gentle-thread-edit-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "note.md"), "# Title\n\nalpha\n\nbeta\n\ngamma\n\ndelta\n", "utf8");
	// The child's real tool, not a fixture: one call replacing four blocks.
	const result = await createEditTool(dir).execute("call-1", {
		path: "note.md",
		edits: [
			{ oldText: "alpha", newText: "ALPHA" },
			{ oldText: "beta", newText: "BETA" },
			{ oldText: "gamma", newText: "GAMMA" },
			{ oldText: "delta", newText: "DELTA" },
		],
	} as never, undefined, undefined);

	// The transport, the retention and the drawing, in the order the runner does them.
	const thread = [
		{ type: TASK_EVENT.TOOL_START, callId: "call-1", name: "edit", args: { path: "note.md", edits: [] } },
		...normalizeRpcEvent({ type: "tool_execution_end", toolCallId: "call-1", toolName: "edit", result, isError: false, durationMs: 4 }),
	].reduce((current, event) => applyTaskEvent(current, event as never), emptyThread());
	const item = thread.items[0] as ToolItem;
	assert.ok(typeof item.details?.diff === "string", "the child's own diff survived the transport");
	assert.equal(item.output.includes("Successfully replaced 4 block(s)"), true, "the retained output is the acknowledgement the child printed");

	// The pane draws the chat's own card from that route — no details were injected.
	registerAgentToolRenderers({ edit: createQuietToolRenderer("edit") }, { owner: "quiet-tools" });
	const collapsed = renderThreadItem(item, plainTheme, 100, { toolsExpanded: false }).map(stripAnsi).join("\n");
	assert.match(collapsed, /✓ \+4 \/ -4/, "the collapsed card counts the diff the child's edit produced");
	assert.doesNotMatch(collapsed, /applied/);
	const expanded = renderThreadItem(item, plainTheme, 100, { toolsExpanded: true }).map(stripAnsi).join("\n");
	assert.match(expanded, /- 3 alpha/, "the expanded card is the child's diff itself");
	assert.match(expanded, /\+ 3 ALPHA/);
	assert.doesNotMatch(expanded, /Successfully replaced/, "the acknowledgement is not what the expanded diff shows");
});
