import assert from "node:assert/strict";
import test from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_PREVIEW_BINARY_NOTICE, FILE_PREVIEW_LIMITS, listRepositoryFiles, readFilePreview } from "../lib/file-index.ts";

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
