import assert from "node:assert/strict";
import test from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_PREVIEW_BINARY_NOTICE, FILE_PREVIEW_LIMITS, formatAge, listRepositoryEntries, listRepositoryFiles, readFilePreview } from "../lib/file-index.ts";

// The file picker's data source: Git lists the repository's files (S10) and
// one bounded read previews a file (S3). Git is injected, like
// ShellDeps.gitRunner, so both halves are testable without a Pi agent.

function scratch(t: { after(fn: () => void): void }, name = "gentle-file-index-"): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), name)));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

// An inherited GIT_DIR would point `git init` away from the fixture.
const FIXTURE_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));

function gitIn(root: string) {
	return (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: FIXTURE_ENV });
}

/** The production seam: a GitRunner bound to a root. */
function gitRunner(root: string) {
	return (args: string[]) => new Promise<{ stdout: string; code: number }>((resolve) => {
		execFile("git", ["-C", root, ...args], { encoding: "utf8", env: FIXTURE_ENV }, (error, stdout) => {
			resolve({ stdout, code: error ? (typeof error.code === "number" ? error.code : 1) : 0 });
		});
	});
}

function textLines(preview: ReturnType<typeof readFilePreview>): string[] {
	if (preview.kind !== "text") throw new Error(`expected a text preview, got ${preview.kind}`);
	return preview.lines;
}

test("the listing includes tracked and untracked files and never an ignored one", async (t) => {
	const root = scratch(t);
	const git = gitIn(root);
	git("init", "-q", "--initial-branch=main");
	writeFileSync(join(root, ".gitignore"), "ignored.txt\nbuild/\n");
	writeFileSync(join(root, "README.md"), "readme\n");
	writeFileSync(join(root, "src.ts"), "export {};\n");
	git("add", ".gitignore", "README.md", "src.ts");
	git("commit", "-q", "-m", "base");
	writeFileSync(join(root, "ignored.txt"), "git ignores this\n");
	writeFileSync(join(root, "untracked.ts"), "one\n");
	assert.deepEqual(await listRepositoryFiles(gitRunner(root)), {
		ok: true,
		files: [".gitignore", "README.md", "src.ts", "untracked.ts"],
	});
});

test("NUL splitting keeps a path that contains a space, and the list is sorted and de-duplicated", async () => {
	const calls: string[][] = [];
	const listing = await listRepositoryFiles(async (args) => {
		calls.push(args);
		return { stdout: "z last.ts\0a dir/first.ts\0z last.ts\0", code: 0 };
	});
	assert.deepEqual(listing, { ok: true, files: ["a dir/first.ts", "z last.ts"] });
	assert.deepEqual(calls, [["ls-files", "-z", "--cached", "--others", "--exclude-standard"]]);
});

test("an empty repository listing is an empty success, not a failure", async () => {
	assert.deepEqual(await listRepositoryFiles(async () => ({ stdout: "", code: 0 })), { ok: true, files: [] });
});

test("outside a Git repository the listing reports the failure instead of an empty success", async (t) => {
	const root = scratch(t);
	const listing = await listRepositoryFiles(gitRunner(root));
	assert.equal(listing.ok, false);
	if (listing.ok) return;
	assert.match(listing.message, /^Cannot list repository files: /);
	assert.match(listing.message, /128/);
});

test("a Git runner that rejects is reported, not thrown", async () => {
	assert.deepEqual(await listRepositoryFiles(async () => { throw new Error("spawn git ENOENT"); }), {
		ok: false,
		message: "Cannot list repository files: spawn git ENOENT",
	});
});

test("a listing Git cut short is a failure, never a silent partial list", async () => {
	const listing = await listRepositoryFiles(async () => ({ stdout: "a.ts\0", code: 1, truncated: true }));
	assert.equal(listing.ok, false);
	if (listing.ok) return;
	assert.match(listing.message, /truncated/);
});

test("a text file previews its lines with CRLF normalised", (t) => {
	const root = scratch(t);
	writeFileSync(join(root, "notes.txt"), "alpha\r\nbeta\r\ngamma\r\n");
	assert.deepEqual(readFilePreview(root, "notes.txt"), { kind: "text", lines: ["alpha", "beta", "gamma"], truncated: false });
});

test("a file over the byte budget stops at the budget and marks the preview truncated", (t) => {
	const root = scratch(t);
	const lineBytes = 391;
	writeFileSync(join(root, "big.txt"), `${"a".repeat(lineBytes - 1)}\n`.repeat(200));
	const preview = readFilePreview(root, "big.txt");
	const lines = textLines(preview);
	const budget = FILE_PREVIEW_LIMITS.maxBytes;
	assert.equal(preview.kind, "text");
	assert.equal(preview.truncated, true);
	assert.equal(lines.length, Math.ceil(budget / lineBytes));
	assert.deepEqual(new Set(lines.slice(0, -1)), new Set([`${"a".repeat(lineBytes - 1)}`]), "every complete line is whole");
	const consumed = lines.reduce((total, line, index) => total + line.length + (index === lines.length - 1 ? 0 : 1), 0);
	assert.equal(consumed, budget, "nothing past the budget is read");
});

test("a file exactly at the byte budget is not marked truncated", (t) => {
	const root = scratch(t);
	const budget = FILE_PREVIEW_LIMITS.maxBytes;
	const width = FILE_PREVIEW_LIMITS.maxLineWidth - 1;
	let text = `${"x".repeat(width)}\n`.repeat(Math.floor(budget / (width + 1)));
	text += "y".repeat(budget - text.length);
	writeFileSync(join(root, "exact.txt"), text);
	assert.equal(Buffer.byteLength(text), budget);
	assert.deepEqual(readFilePreview(root, "exact.txt"), { kind: "text", lines: text.split("\n"), truncated: false });
});

test("the line count is capped so a huge file cannot stall the render", (t) => {
	const root = scratch(t);
	const total = FILE_PREVIEW_LIMITS.maxLines + 50;
	writeFileSync(join(root, "many.txt"), Array.from({ length: total }, (_, index) => `line ${index}`).join("\n"));
	const preview = readFilePreview(root, "many.txt");
	assert.equal(preview.kind, "text");
	assert.equal(preview.truncated, true);
	const lines = textLines(preview);
	assert.equal(lines.length, FILE_PREVIEW_LIMITS.maxLines);
	assert.equal(lines[FILE_PREVIEW_LIMITS.maxLines - 1], `line ${FILE_PREVIEW_LIMITS.maxLines - 1}`);
});

test("one very long line is capped in width", (t) => {
	const root = scratch(t);
	writeFileSync(join(root, "min.js"), `${"a".repeat(FILE_PREVIEW_LIMITS.maxLineWidth * 4)}\n`);
	const preview = readFilePreview(root, "min.js");
	assert.equal(preview.kind, "text");
	assert.equal(preview.truncated, true);
	const lines = textLines(preview);
	assert.equal(lines.length, 1);
	assert.equal(lines[0].length, FILE_PREVIEW_LIMITS.maxLineWidth);
	assert.ok(lines[0].endsWith("…"), "the cap is marked instead of silently dropping text");
});

test("a file with a NUL byte previews as a binary notice instead of bytes", (t) => {
	const root = scratch(t);
	writeFileSync(join(root, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
	assert.deepEqual(readFilePreview(root, "image.png"), { kind: "binary", message: FILE_PREVIEW_BINARY_NOTICE });
});

test("a missing file previews as an error instead of throwing", (t) => {
	const root = scratch(t);
	assert.deepEqual(readFilePreview(root, "gone.txt"), { kind: "error", message: "Cannot read gone.txt (ENOENT)." });
});

// --- entry-level listing (S12): change state, mtime and a coarse age label ---

const LIST_ARGS = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
const ROOT_ARGS = ["rev-parse", "--show-toplevel"];

// Second-based on purpose: utimes takes seconds, and the gap makes the order real.
const BASE_MTIME = 1_700_000_000;

function setMtime(root: string, relative: string, seconds: number): void {
	utimesSync(join(root, relative), seconds, seconds);
}

/** One modified tracked file, one new untracked file, one ignored file and two untouched files. */
function changedRepository(t: { after(fn: () => void): void }) {
	const root = scratch(t);
	const git = gitIn(root);
	git("init", "-q", "--initial-branch=main");
	writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
	writeFileSync(join(root, "README.md"), "readme\n");
	writeFileSync(join(root, "src.ts"), "export {};\n");
	git("add", ".gitignore", "README.md", "src.ts");
	git("commit", "-q", "-m", "base");
	writeFileSync(join(root, "src.ts"), "export const changed = true;\n");
	writeFileSync(join(root, "new.ts"), "brand new\n");
	writeFileSync(join(root, "ignored.txt"), "git ignores this\n");
	setMtime(root, "new.ts", BASE_MTIME);
	setMtime(root, "src.ts", BASE_MTIME + 10);
	return { root, run: gitRunner(root) };
}

test("a new file is new, a modified tracked file is updated, an untouched one is clean, and changed sorts first", async (t) => {
	const { run } = changedRepository(t);
	const result = await listRepositoryEntries(run);
	if (result.ok === false) throw new Error(result.message);
	assert.deepEqual(result.entries.map((entry) => [entry.path, entry.state]), [
		["src.ts", "updated"],
		["new.ts", "new"],
		[".gitignore", "clean"],
		["README.md", "clean"],
	]);
});

test("mtimeMs is filled for changed entries only, and the most recently modified changed entry leads", async (t) => {
	const { root, run } = changedRepository(t);
	const result = await listRepositoryEntries(run);
	if (result.ok === false) throw new Error(result.message);
	const byPath = new Map(result.entries.map((entry) => [entry.path, entry]));
	const modified = statSync(join(root, "src.ts")).mtimeMs;
	const created = statSync(join(root, "new.ts")).mtimeMs;
	assert.ok(modified > created, "the fixture's mtimes really differ");
	assert.equal(byPath.get("src.ts")?.mtimeMs, modified);
	assert.equal(byPath.get("new.ts")?.mtimeMs, created);
	assert.equal(result.entries[0]?.path, "src.ts", "the newer change leads");
	assert.equal(byPath.get(".gitignore")?.mtimeMs, undefined);
	assert.ok(!("mtimeMs" in (byPath.get(".gitignore") as object)), "a clean entry carries no mtime key");
	assert.ok(!("mtimeMs" in (byPath.get("README.md") as object)), "a clean entry carries no mtime key");
});

test("the entries are the same file set the flat listing produces", async (t) => {
	const { run } = changedRepository(t);
	const listing = await listRepositoryFiles(run);
	const result = await listRepositoryEntries(run);
	if (listing.ok === false) throw new Error(listing.message);
	if (result.ok === false) throw new Error(result.message);
	assert.deepEqual(result.entries.map((entry) => entry.path).sort(), listing.files);
	assert.ok(!result.entries.some((entry) => entry.path === "ignored.txt"), "an ignored file is never an entry");
});

test("a changed file that is gone from disk keeps no mtime and does not throw", async (t) => {
	const root = scratch(t);
	const git = gitIn(root);
	git("init", "-q", "--initial-branch=main");
	writeFileSync(join(root, "gone.ts"), "export {};\n");
	git("add", "gone.ts");
	git("commit", "-q", "-m", "base");
	rmSync(join(root, "gone.ts"));
	assert.deepEqual(await listRepositoryEntries(gitRunner(root)), { ok: true, entries: [{ path: "gone.ts", state: "updated" }] });
});

test("a filename listing that fails is an explicit failure, never an empty success", async () => {
	const calls: string[][] = [];
	const result = await listRepositoryEntries(async (args) => {
		calls.push(args);
		return { stdout: "", code: 128 };
	});
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.match(result.message, /^Cannot list repository files: /);
	assert.match(result.message, /128/);
	assert.deepEqual(calls, [LIST_ARGS]);
});

test("a status that fails is an explicit failure, never an empty success", async () => {
	const result = await listRepositoryEntries(async (args) => (args[0] === "status" ? { stdout: "", code: 2 } : { stdout: "a.ts\0", code: 0 }));
	assert.deepEqual(result, { ok: false, message: "Cannot read repository changes: git status exited with code 2." });
});

test("a status runner that rejects is reported, not thrown", async () => {
	const result = await listRepositoryEntries(async (args) => {
		if (args[0] === "status") throw new Error("spawn git ENOENT");
		return { stdout: "a.ts\0", code: 0 };
	});
	assert.deepEqual(result, { ok: false, message: "Cannot read repository changes: spawn git ENOENT" });
});

test("a status Git cut short is a failure, never a silent partial state", async () => {
	const result = await listRepositoryEntries(async (args) => (args[0] === "status" ? { stdout: "?? a.ts\0", code: 0, truncated: true } : { stdout: "a.ts\0", code: 0 }));
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.match(result.message, /truncated/);
});

test("one status call decides every state, and a rename's original path never becomes an entry", async () => {
	const calls: string[][] = [];
	const result = await listRepositoryEntries(async (args) => {
		calls.push(args);
		if (args[0] === "ls-files") return { stdout: "clean.ts\0mod.ts\0new.ts\0renamed.ts\0", code: 0 };
		if (args[0] === "status") return { stdout: "?? new.ts\0 M mod.ts\0R  renamed.ts\0old.ts\0", code: 0 };
		return { stdout: "", code: 128 };
	});
	assert.deepEqual(result, {
		ok: true,
		entries: [
			{ path: "mod.ts", state: "updated" },
			{ path: "new.ts", state: "new" },
			{ path: "renamed.ts", state: "updated" },
			{ path: "clean.ts", state: "clean" },
		],
	});
	assert.deepEqual(calls, [LIST_ARGS, STATUS_ARGS, ROOT_ARGS]);
});

test("the age label uses s, m, h and d, and a future timestamp clamps to 0s", () => {
	const now = BASE_MTIME * 1000;
	const label = (elapsedMs: number) => formatAge(now - elapsedMs, now);
	assert.equal(label(0), "0s");
	assert.equal(label(45_000), "45s");
	assert.equal(label(59_000), "59s");
	assert.equal(label(59_999), "59s");
	assert.equal(label(60_000), "1m");
	assert.equal(label(5 * 60_000), "5m");
	assert.equal(label(12 * 60_000), "12m");
	assert.equal(label(3_599_000), "59m");
	assert.equal(label(3_600_000), "1h");
	assert.equal(label(5 * 3_600_000), "5h");
	assert.equal(label(86_399_000), "23h");
	assert.equal(label(86_400_000), "1d");
	assert.equal(label(3 * 86_400_000), "3d");
	assert.equal(label(-1), "0s");
	assert.equal(label(-10 * 86_400_000), "0s");
});
