import assert from "node:assert/strict";
import test from "node:test";
import { createExplorationBudget } from "../lib/exploration-budget.ts";

const event = (id: string, toolName = "read", text = "x", isError = false, input: Record<string, unknown> = {}, details?: unknown) => ({
	toolCallId: id, toolName, isError, input, details, content: [{ type: "text" as const, text }],
});

test("cumulative successful lookups cross at four and notify only once", () => {
	const budget = createExplorationBudget();
	budget.start("s");
	for (let i = 1; i <= 3; i++) {
		budget.call("s", String(i));
		assert.equal(budget.result("s", event(String(i))), undefined);
	}
	budget.call("s", "4");
	const notice = budget.result("s", event("4"));
	assert.match(notice ?? "", /Exploration budget:.*4.*4.*bytes/);
	assert.match(notice ?? "", /one configured explorer/i);
	assert.match(notice ?? "", /read.only.*initially small/i);
	assert.match(notice ?? "", /preparation.*already.understood.*authorized inline write/i);
	assert.match(notice ?? "", /no.*mutation.*guard.*bypass/i);
	budget.call("s", "5");
	assert.equal(budget.result("s", event("5")), undefined);
});

test("UTF-8 text bytes cross strictly above 40000 and duplicate IDs do not count", () => {
	const budget = createExplorationBudget();
	budget.start("s");
	budget.call("s", "1");
	assert.equal(budget.result("s", event("1", "grep", "é".repeat(20000))), undefined);
	assert.equal(budget.result("s", event("1", "grep", "x")), undefined);
	budget.call("s", "2");
	assert.match(budget.result("s", event("2", "find", "x")) ?? "", /40,?001.*bytes/);
});

test("ignore child, aborted, non-discovery, error, stale and duplicate results across requests", () => {
	const budget = createExplorationBudget();
	budget.start("s");
	budget.call("s", "old");
	budget.start("s");
	assert.equal(budget.result("s", event("old")), undefined);
	for (const [id, name, error, primary, aborted] of [
		["child", "read", false, false, false], ["aborted", "read", false, true, true],
		["failed", "read", true, true, false], ["review", "gentle_review", false, true, false],
		["write", "write", false, true, false], ["bash", "bash", false, true, false],
	] as const) {
		budget.call("s", id);
		assert.equal(budget.result("s", event(id, name, "x".repeat(50000), error), primary, aborted), undefined);
	}
	for (const [i, name] of ["read", "grep", "find", "ls"].entries()) {
		budget.call("s", `new${i}`);
		const notice = budget.result("s", event(`new${i}`, name));
		if (i < 3) assert.equal(notice, undefined);
		else assert.match(notice ?? "", /Exploration budget:/);
	}
	budget.settle("s");
	budget.call("s", "late");
	assert.equal(budget.result("s", event("late")), undefined);
	budget.start("s");
	budget.call("s", "fresh");
	assert.equal(budget.result("s", event("fresh")), undefined);
});

test("known shell inspections reuse phase inference without counting checks, writes or unknown scripts", () => {
	const budget = createExplorationBudget();
	budget.start("s");
	for (const command of ["node --test example.test.ts", "pnpm build", "cat src/a > out", "unknown-script arg"]) {
		budget.call("s", command, "bash");
		assert.equal(budget.result("s", event(command, "bash", "x".repeat(50000), false, { command })), undefined);
	}
	for (const [i, [name, command]] of [["bash", "pwd"], ["bash", "cd src && rg needle ."], ["bash", "git status"], ["powershell", "git diff"]].entries()) {
		budget.call("s", String(i), name);
		const notice = budget.result("s", event(String(i), name, "x", false, { command }));
		if (i < 3) assert.equal(notice, undefined);
		else assert.match(notice ?? "", /Exploration budget:.*4 tracked lookups.*4 UTF-8/);
	}
});

test("newly inferred metadata probes count as discovery while checks and rewrites never do", () => {
	// Widening phase inference widens this budget: every command the detector
	// newly reads as exploring becomes a tracked lookup, so the checks and the
	// mutations that stay out of `exploring` must stay out of the count too.
	const budget = createExplorationBudget();
	budget.start("s");
	for (const command of [
		"make install", "make -j install", "cargo fmt", "ruff check --fix .", "deno lint --fix", "pnpm install",
		"go env -w GOPATH=/tmp/go", "go env -u GOPATH",
		"pnpm -C pkg test", "pnpm run test:unit", "cargo fmt --check", "python -m unittest",
		"git log --oneline `git rev-parse HEAD`", "cat <(touch marker)",
	]) {
		budget.call("s", command, "bash");
		assert.equal(budget.result("s", event(command, "bash", "x".repeat(50000), false, { command })), undefined, command);
	}
	for (const [i, command] of ["locale", "cargo tree", "go env", "gh api repos/o/n"].entries()) {
		budget.call("s", String(i), "bash");
		const notice = budget.result("s", event(String(i), "bash", "x", false, { command }));
		if (i < 3) assert.equal(notice, undefined, command);
		else assert.match(notice ?? "", /Exploration budget:.*4 tracked lookups/, command);
	}
});

test("versioning and publishing never count as discovery while a help page does", () => {
	// The budget counts exactly what the classifier names as exploring. Versioning
	// and publishing are card identities, not phases, so a commit, a push or a PR
	// edit is never a tracked lookup — while a help page is a read like any other.
	const budget = createExplorationBudget();
	budget.start("s");
	for (const command of [
		"git add -A",
		"git commit -m x",
		"git rebase main",
		"git cherry-pick abc1234",
		"git push",
		`git commit -m "--help"`,
		"gh pr create --title x",
		"gh issue edit 7 --add-label bug",
		"gh label create bug",
		"gh stack init",
		"gh stack submit",
		"git push && rm -rf dist",
		// A help flag an option consumed is not a query, a quoted `>` is not a write,
		// and an escaped space keeps the help flag inside the value.
		"git commit -m --help",
		"gh issue comment 7 --body --help",
		"git commit -m foo\\ --help",
		"gh issue comment 7 --body foo\\ --help",
		"git commit -m $OPTS --help",
		`git commit -m "fix: a > b"`,
		`gh issue comment 7 --body "before > after"`,
	]) {
		budget.call("s", command, "bash");
		assert.equal(budget.result("s", event(command, "bash", "x".repeat(50000), false, { command })), undefined, command);
	}
	// A usage page is a lookup, including one a command reaches after a value that
	// holds escaped whitespace.
	for (const [i, command] of [
		"git commit --help",
		"gh pr create --help",
		"gh stack submit --help",
		"git commit -m foo\\ bar --help",
	].entries()) {
		budget.call("s", String(i), "bash");
		const notice = budget.result("s", event(String(i), "bash", "x", false, { command }));
		if (i < 3) assert.equal(notice, undefined, command);
		else assert.match(notice ?? "", /Exploration budget:.*4 tracked lookups/, command);
	}
});

test("preparing, formatting and destructive never count as discovery", () => {
	// The budget counts exactly what the classifier names as exploring. Installing,
	// reformatting and deleting are card identities, not phases, so none of them is
	// a tracked lookup — and a check that reads the same files still is not either.
	const budget = createExplorationBudget();
	budget.start("s");
	for (const command of [
		"pnpm install",
		"npm ci",
		"pip install -r requirements.txt",
		"mkdir -p tmp/scratch",
		"git config user.name x",
		"prettier --write .",
		"eslint . --fix",
		"cargo fmt",
		"ruff check --fix .",
		"rm -rf dist",
		"env FOO=bar rm -rf dist",
		"git checkout .",
		"rm -f logo.png",
		"git reset --hard HEAD~1",
		"git push --delete origin feat/x",
		`psql -c 'DROP TABLE t'`,
		`echo 'DROP TABLE t' | psql`,
		"docker system prune -af",
		"kubectl delete pod web",
		"pnpm test && rm -rf dist",
		"pnpm test && node scripts/release.mjs",
		"timeout 900 pnpm typecheck 2>&1 | tail -20",
		"prettier --check .",
		"git clean -n",
	]) {
		budget.call("s", command, "bash");
		assert.equal(budget.result("s", event(command, "bash", "x".repeat(50000), false, { command })), undefined, command);
	}
});

test("read-only memory recall counts and memory mutation or diagnostics never count", () => {
	const budget = createExplorationBudget();
	budget.start("s");
	for (const name of ["mem_current_project", "mem_stats", "mem_save", "mem_update", "mem_review"]) {
		budget.call("s", name);
		assert.equal(budget.result("s", event(name, name, "x".repeat(50000))), undefined);
	}
	for (const [i, name] of ["mem_search", "mem_get_observation", "mem_context", "read"].entries()) {
		budget.call("s", name);
		const notice = budget.result("s", event(name, name));
		if (i < 3) assert.equal(notice, undefined);
		else assert.match(notice ?? "", /Exploration budget:.*4 tracked lookups/);
	}
});

test("nested reads inside review, mutation or verification are not discovery", () => {
	const budget = createExplorationBudget();
	budget.start("s");
	for (const [i, name] of ["gentle_review", "write", "verification"].entries()) {
		const parent = `p${i}`;
		budget.call("s", parent, name);
		budget.call("s", `${parent}/1`, "read", parent);
		assert.equal(budget.result("s", { ...event(`${parent}/1`, "read", "x".repeat(50000)), parentToolCallId: parent }), undefined);
	}
});

test("codegraph query and explore count but init and failed fallbacks do not", () => {
	const budget = createExplorationBudget();
	budget.start("s");
	for (const [id, input, details] of [
		["init", { operation: "init" }, undefined],
		["failed", { operation: "query" }, { status: "failed" }],
		["unavailable", { operation: "explore" }, { status: "unavailable" }],
	] as const) {
		budget.call("s", id);
		assert.equal(budget.result("s", event(id, "codegraph", "x".repeat(50000), false, input, details)), undefined);
	}
	const calls = [
		event("1", "codegraph", "x", false, { operation: "query" }),
		event("2", "codegraph", "x", false, { operation: "explore" }),
		event("3", "codegraph_query"), event("4", "codegraph_explore"),
	];
	for (const [i, item] of calls.entries()) {
		budget.call("s", item.toolCallId);
		const result = budget.result("s", item);
		if (i === 3) assert.match(result ?? "", /Exploration budget:/);
		else assert.equal(result, undefined);
	}
});
