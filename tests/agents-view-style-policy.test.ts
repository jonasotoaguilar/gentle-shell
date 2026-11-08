import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { AGENTS_VIEW_STYLE_SCHEMA, parseAgentsViewStyleFile, resolveAgentsViewStyle, writeAgentsViewStyle } from "../lib/agents-view-style-policy.ts";

const home = () => mkdtempSync(join(tmpdir(), "gentle-agents-view-style-"));

test("a missing preference means the log view", () => {
	const dir = home();
	try {
		assert.deepEqual(resolveAgentsViewStyle({ gentlePiConfigHome: dir }), { style: "log", source: "default", malformed: false, globalFile: join(dir, "agents-view-style.json") });
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the preference round-trips through the atomic writer", () => {
	const dir = home();
	try {
		const path = writeAgentsViewStyle("cards", { gentlePiConfigHome: dir });
		assert.equal(path, join(dir, "agents-view-style.json"));
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { schema: AGENTS_VIEW_STYLE_SCHEMA, style: "cards" });
		assert.deepEqual(resolveAgentsViewStyle({ gentlePiConfigHome: dir }), { style: "cards", source: "global_file", malformed: false, globalFile: path });
		writeAgentsViewStyle("log", { gentlePiConfigHome: dir });
		assert.equal(resolveAgentsViewStyle({ gentlePiConfigHome: dir }).style, "log");
		assert.deepEqual(readdirSync(dir), ["agents-view-style.json"], "no temporary file survives the rename");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the writer rejects values outside the style domain", () => {
	const dir = home();
	try {
		assert.throws(() => writeAgentsViewStyle("chat" as never, { gentlePiConfigHome: dir }), TypeError);
		assert.equal(existsSync(join(dir, "agents-view-style.json")), false);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a denied preference read preserves the stored bytes and refuses every write", (t) => {
	const dir = home();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = writeAgentsViewStyle("cards", { gentlePiConfigHome: dir });
	const before = readFileSync(path);
	const originalRead = fs.readFileSync;
	const originalWrite = fs.writeFileSync;
	let writes = 0;
	t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
		if (args[0] === path) throw Object.assign(new Error("fixture access denied"), { code: "EACCES" });
		return originalRead(...args);
	});
	t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
		writes++;
		return originalWrite(...args);
	});
	syncBuiltinESMExports();
	try {
		assert.deepEqual(resolveAgentsViewStyle({ gentlePiConfigHome: dir }), { style: "log", source: "global_file", malformed: true, globalFile: path });
		assert.throws(() => writeAgentsViewStyle("log", { gentlePiConfigHome: dir }), { message: `Cannot update malformed or unreadable agents view style preference: ${path}` });
		assert.equal(writes, 0);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
	assert.deepEqual(readFileSync(path), before);
	assert.deepEqual(readdirSync(dir), ["agents-view-style.json"]);
});

test("invalid or unreadable preference files read as log and are never overwritten", () => {
	for (const raw of ["", "{", "[]", "null", `{"schema":"${AGENTS_VIEW_STYLE_SCHEMA}","style":"registro"}`, `{"schema":"other/v1","style":"cards"}`, `{"schema":"${AGENTS_VIEW_STYLE_SCHEMA}","style":"cards","extra":1}`]) {
		assert.equal(parseAgentsViewStyleFile(raw), undefined, raw);
		const dir = home();
		const path = join(dir, "agents-view-style.json");
		writeFileSync(path, raw);
		assert.deepEqual(resolveAgentsViewStyle({ gentlePiConfigHome: dir }), { style: "log", source: "global_file", malformed: true, globalFile: path }, raw);
		assert.throws(() => writeAgentsViewStyle("log", { gentlePiConfigHome: dir }), /Cannot update malformed or unreadable agents view style preference/, raw);
		assert.equal(readFileSync(path, "utf8"), raw, "the malformed file is preserved");
		rmSync(dir, { recursive: true, force: true });
	}
});

test("both saved styles parse back exactly", () => {
	for (const style of ["log", "cards"]) {
		assert.equal(parseAgentsViewStyleFile(JSON.stringify({ schema: AGENTS_VIEW_STYLE_SCHEMA, style })), style);
	}
});

// The style names were `registry` and `chat` before this vocabulary existed, and
// a preference saved then must keep selecting the view it selected: it reads as
// the current name, the writer stores that name, and nothing is lost.
test("a preference saved under the old names resolves to the view it selected", () => {
	for (const [legacy, current] of [["registry", "log"], ["chat", "cards"]] as const) {
		const dir = home();
		try {
			const path = join(dir, "agents-view-style.json");
			writeFileSync(path, JSON.stringify({ schema: AGENTS_VIEW_STYLE_SCHEMA, style: legacy }));
			assert.equal(parseAgentsViewStyleFile(readFileSync(path, "utf8")), current, legacy);
			assert.deepEqual(resolveAgentsViewStyle({ gentlePiConfigHome: dir }), { style: current, source: "global_file", malformed: false, globalFile: path }, `${legacy} is not a malformed file`);
			assert.equal(writeAgentsViewStyle(current, { gentlePiConfigHome: dir }), path, "the old name is still writable over");
			assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { schema: AGENTS_VIEW_STYLE_SCHEMA, style: current });
		} finally { rmSync(dir, { recursive: true, force: true }); }
	}
});
