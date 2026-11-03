// Deterministic ODD phase inference from observed tool activity. The Gentle
// Shell working label used to depend only on the model calling
// gentle_odd_phase, which models routinely skip; the tools the primary
// session actually runs are a reliable, observable signal instead.
//
// The mapping is deliberately conservative: an unknown tool, unknown subagent
// role, or an ambiguous shell command returns undefined so the caller leaves
// the current label unchanged. This module is pure (no Pi or registry
// imports); precedence against explicit reports lives in OddPhaseRegistry.

import { isDestructiveCommand, isDestructiveSegment } from "./destructive-card-activity.ts";
import type { OddPhase } from "./odd-phase.ts";

/**
 * The activity a shell call names on its own card. `exploring` and `checking` are
 * ODD phases; the rest are presentation only — installing, reformatting, deleting,
 * a commit or a push is not a step of the ODD protocol, so none of them reaches the
 * phase label, the global phase enum, or the exploration budget.
 */
export const SHELL_ACTIVITIES = ["destructive", "checking", "formatting", "preparing", "publishing", "versioning", "exploring"] as const;

export type ShellActivity = (typeof SHELL_ACTIVITIES)[number];

/**
 * The mark and theme role each activity wears, shared by the chat's bash card and
 * the Agents thread pane so one call never reads as two activities.
 *
 * The roles are the theme's own slots, never a fixed palette: `mdLink` and
 * `mdHeading` paint the two ODD phases, `error` is the theme's own red for a
 * deletion, `warning` is the warm role a local history change wears, and
 * `success` the green one a remote write wears, so a theme that changes its
 * palette changes the cards with it. `syntaxFunction` is the code palette, and it
 * is the one slot `preparing` and `formatting` share: the shipped themes define
 * six colours a heading can wear, and the two maintenance identities are told
 * apart by their mark and their word rather than by a colour no theme has. The
 * mark still tells an identity apart from a status tone, and the frame keeps
 * painting the call's own state.
 *
 * A mark carries its own gap where a font may paint it wider than pi-tui counts:
 * U+2692 is drawn two cells wide by an emoji-fallback font while pi-tui counts it
 * as one, so a single space after it is painted inside the glyph's own second cell
 * and the heading reads `⚒preparing`. Preparing's mark therefore ends in one
 * space — the minimum that still shows — so one column always appears and the
 * heading's counted width matches what the terminal paints.
 */
export const SHELL_ACTIVITY_IDENTITY: Record<ShellActivity, { glyph: string; titleRole: string }> = {
	destructive: { glyph: "⚠", titleRole: "error" },
	checking: { glyph: "✓", titleRole: "mdHeading" },
	formatting: { glyph: "≋", titleRole: "syntaxFunction" },
	preparing: { glyph: "⚒ ", titleRole: "syntaxFunction" },
	publishing: { glyph: "↑", titleRole: "success" },
	versioning: { glyph: "⎇", titleRole: "warning" },
	exploring: { glyph: "⌕", titleRole: "mdLink" },
};

const TOOL_PHASES: Readonly<Record<string, OddPhase>> = {
	read: "exploring",
	grep: "exploring",
	find: "exploring",
	ls: "exploring",
	ask_user_choice: "deciding",
	ask_user_question: "deciding",
	todo: "planning",
	gentle_review: "checking",
	gentle_review_scope: "checking",
	gentle_review_capture: "checking",
	gentle_review_capture_group: "checking",
};

// CodeGraph registers three operations and only two of them are exploration
// work: query and explore read the index, while init builds it — the tool's own
// setup step, not a phase of the agent's work. Naming init exploring would
// claim work the agent did not do, so it leaves the current label untouched.
const CODEGRAPH_TOOL = "codegraph";
const CODEGRAPH_OPERATION_PHASES: Readonly<Record<string, OddPhase>> = {
	query: "exploring",
	explore: "exploring",
};

const DELEGATED_PHASES: Readonly<Record<string, OddPhase>> = {
	"gentle-ai-worker": "implementing",
	"gentle-ai-verify": "checking",
	"gentle-ai-explore": "exploring",
};

const WRITE_TOOLS = new Set(["edit", "write"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

// Test, typecheck, lint, and build runners. Matched per shell segment.
const CHECKING_COMMANDS: readonly RegExp[] = [
	/^node\b.*\s--test\b/,
	/^node\s+\S*(test|check|lint|typecheck)[\w-]*\.m?[jt]s\b/,
	/^((npx|pnpx|bunx)\s+|(pnpm|yarn)\s+exec\s+)?(vitest|jest|mocha|tsc|pytest)\b/,
	/^python(3(\.\d+)?)?\s+-m\s+(pytest|unittest)\b/,
	/^go\s+(test|build|vet)\b/,
	/^cargo\s+(test|build|check|clippy|nextest)\b/,
	// `cargo fmt` rewrites code, so only the check form verifies anything.
	/^cargo\s+fmt\b.*\s--check\b/,
	/^ruff\s+format\s+--check\b/,
	/^deno\s+(test|check)\b/,
	/^deno\s+fmt\s+--check\b/,
	/^deno\s+task\s+(test|typecheck|lint|build|check)\b/,
	// A formatter asked to report instead of rewrite verifies like any other check.
	/^((npx|pnpx|bunx)\s+|(pnpm|yarn|npm)\s+(exec|run)\s+)?prettier\b.*\s(--check|-l|--list-different)\b/,
	/^((npx|pnpx|bunx)\s+)?(black|rustfmt|gofmt|gofumpt|shfmt|swiftformat|clang-format)\b.*\s(--check|--diff|-l|--list-different)(?=\s|=|$)/,
	// Waiting on or reading CI results verifies work; it is not exploration.
	/^gh\s+pr\s+checks\b/,
	/^gh\s+run\s+(view|watch|list)\b/,
];

// These runners verify only when they are not asked to rewrite files: `eslint
// --fix`, `ruff check --fix` and `deno lint --fix` repair code, so they are not
// checks. The flag has to be the whole flag: `eslint --fix-dry-run` writes
// nothing and stays a check.
const FIXABLE_CHECKING_COMMANDS: readonly RegExp[] = [
	/^((npx|pnpx|bunx)\s+|(pnpm|yarn)\s+exec\s+)?eslint\b/,
	/^ruff\s+check\b/,
	/^deno\s+lint\b/,
];
const FIX_FLAGS = /(^|\s)--(fix|fix-only|unsafe-fixes)(?=\s|=|$)/;
// `timeout` options that take the word after them; every other flag stands alone.
const TIMEOUT_VALUE_OPTIONS = new Set(["-s", "--signal", "-k", "--kill-after"]);

// Package managers that run a script by name, and the scripts that verify work.
// `install`, `deploy`, `publish`, `start` and a dev server are not checks, and an
// unlisted script leaves the label unchanged.
const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const CHECK_SCRIPTS = new Set(["test", "typecheck", "lint", "build", "check"]);
// Options that take the token after them, so `pnpm -C pkg test` names its script
// after the workspace directory instead of reading that directory as the script.
const PACKAGE_MANAGER_VALUE_OPTIONS = new Set(["-C", "--dir", "--prefix", "-F", "--filter", "--cwd"]);
// Options that take no value and change nothing about which script runs.
const PACKAGE_MANAGER_FLAGS = new Set(["-w", "--workspace-root", "-r", "--recursive", "-s", "--silent"]);

// `make` targets that verify work. Any other target — `install`, `deploy`,
// `clean`, `release`, an unknown recipe — changes the machine or does something
// this classifier cannot name, so it leaves the label unchanged.
const MAKE_CHECK_TARGETS = new Set(["test", "tests", "check", "checks", "build"]);
const MAKE_VALUE_OPTIONS = new Set(["-C", "--directory", "-f", "--file", "-I", "--include-dir"]);
const MAKE_FLAGS = new Set(["-s", "--silent", "-k", "--keep-going"]);

// `gh api` writes whenever it is given a method, a field, or an input body, so
// only the plain GET form is a query.
const GH_API_WRITE_FLAGS = new Set(["-X", "--method", "-f", "--raw-field", "-F", "--field", "--input"]);

// Formatters and lint fixers rewrite the files they read, so they are not checks.
// The read-only forms — `--check`, `--diff`, `-l`, `--list-different` — are handled
// by the check families above, and a segment carrying one is never formatting.
const FORMATTING_COMMANDS: readonly RegExp[] = [
	/^((npx|pnpx|bunx)\s+|(pnpm|yarn|npm)\s+(exec|run)\s+)?(prettier|biome|eslint|stylelint|oxlint|standard|markdownlint)\b.*\s(--write|--fix|-w)(?=\s|=|$)/,
	/^((npx|pnpx|bunx)\s+)?dprint\s+fmt\b/,
	// Formatters that rewrite in place by default; the read-only forms are excluded
	// above, so `black --check` and `rustfmt --check` stay the checks they are.
	/^((npx|pnpx|bunx)\s+)?(black|rustfmt|swiftformat)\b/,
	/^clang-format\b.*\s-i(?=\s|$)/,
	/^(cargo\s+fmt|go\s+fmt)\b/,
	// These print the formatted text unless told to write it.
	/^(gofmt|gofumpt|shfmt)\b.*\s-w(?=\s|$)/,
	/^ruff\s+(check|format)\b/,
	/^deno\s+(fmt|lint)\b/,
	/^(mix|dart|terraform)\s+(format|fmt)\b/,
];
// A formatter told to report instead of rewrite is a check, or nothing at all.
const FORMAT_READ_ONLY_FLAGS = /(^|\s)(--check|--diff|--list-different|--dry-run|-l)(?=\s|=|$)/;

// Preparing the environment: installing dependencies in any ecosystem, creating a
// directory, file or repository, and storing configuration in a tool's own file.
// Only the forms that name themselves count: an unknown script, an unlisted
// `make` recipe and a bare `git config --unset` stay unnamed.
const PREPARING_COMMANDS: readonly RegExp[] = [
	/^(pip|pip3)\s+install\b/,
	/^python(3(\.\d+)?)?\s+-m\s+pip\s+install\b/,
	/^uv\s+(pip\s+install|sync|add|init)\b/,
	/^poetry\s+(install|add)\b/,
	/^(bundle\s+install|gem\s+install|composer\s+install)\b/,
	/^(brew|port)\s+install\b/,
	/^(apt|apt-get|dnf|yum|zypper)\s+(install|add)\b/,
	/^apk\s+add\b/,
	/^pacman\s+-S\b/,
	/^go\s+(get|install|mod\s+download)\b/,
	/^cargo\s+(install|fetch|new|init)\b/,
	/^dotnet\s+(restore|add)\b/,
	// A repository, a directory or a file the call creates.
	/^git\s+(init|clone)\b/,
	/^(mkdir|touch|cp|ln)\b/,
	// Configuration the call stores on this machine. A read is inspection and is
	// matched before this family; a key deletion is not preparation either.
	/^git\s+config\s+[^-\s]+\s+\S/,
	/^(pip|pip3)\s+config\s+set\b/,
	/^go\s+env\s+-w\b/,
];
// The package managers install, scaffold and store configuration through the same
// subcommand position, so one reader serves every ecosystem.
const PREPARING_SCRIPTS = new Set(["install", "i", "ci", "add", "init"]);

// Local history. The index, a commit (`--amend` included), a rebase and a
// cherry-pick (each with its `--continue`/`--abort`) change this machine only.
const VERSIONING_COMMANDS: readonly RegExp[] = [
	/^git\s+(add|commit|rebase|cherry-pick)\b/,
	// A stack's local half creates and rebases branches; it publishes nothing.
	/^gh\s+stack\s+(init|add|rebase)\b/,
];

// Remote writes: they create or move something on GitHub, including the label,
// assignment and review mutations that ride on `edit` and its siblings.
const PUBLISHING_COMMANDS: readonly RegExp[] = [
	/^git\s+push\b/,
	/^gh\s+(pr|issue)\s+(create|edit|close|reopen|delete|merge|ready|review|comment|update-branch|pin|unpin|lock|unlock|transfer)\b/,
	/^gh\s+label\s+(create|edit|delete|clone)\b/,
	/^gh\s+release\s+(create|edit|delete|upload)\b/,
	/^gh\s+repo\s+(create|edit|delete|archive|rename|fork)\b/,
	// A stack's remote half pushes its branches and rewrites its PRs.
	/^gh\s+stack\s+(submit|push|merge|link|unstack|sync)\b/,
];

// `--help` prints a program's usage and stops, so it is a query on any command
// family. Only a program this classifier already names is asked: an unknown
// program's flag is a guess, and a runner that executes the rest of the segment
// can swallow the flag as an argument to the code it runs.
const HELP_AWARE_COMMANDS = new Set([
	"git", "gh",
	"node", "npx", "pnpx", "bunx", "pnpm", "npm", "yarn", "bun", "deno",
	"go", "cargo", "ruff", "python", "python3", "pytest", "vitest", "jest",
	"mocha", "tsc", "eslint", "make",
	// The families that delete or rewrite files print their usage the same way.
	"rm", "find", "shred", "truncate", "dd",
	"prettier", "biome", "dprint", "stylelint", "oxlint", "standard", "markdownlint",
	"black", "rustfmt", "swiftformat", "clang-format", "gofmt", "gofumpt", "shfmt",
	"mix", "dart", "terraform", "uv", "poetry", "pip", "pip3",
	// Containers and clusters print their usage the same way.
	"docker", "kubectl",
]);
// Programs that run the code they are handed. Only for these does a payload flag
// make the rest of the segment unreadable.
const SCRIPT_RUNNERS = new Set(["node", "deno", "bun", "python", "python3"]);
const PAYLOAD_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c"]);

// Git listing flags that may take one non-flag argument (`--contains <rev>`)
// without turning `git branch`/`git tag` into a create.
const GIT_LIST_FLAG = String.raw`(\s+(-a|-r|-l|-v|-vv|-n\d*|--all|--remotes|--list|--show-current|--contains|--merged|--no-merged|--points-at|--sort=\S+)(\s+[^-\s]\S*)?)*$`;

// Read-only inspection. Matched per shell segment.
const EXPLORING_COMMANDS: readonly RegExp[] = [
	/^git\s+(status|log|diff|show|blame|rev-parse|rev-list|merge-base|ls-files|ls-remote|ls-tree|cat-file|describe|shortlog|reflog|grep|check-ignore|for-each-ref|name-rev|count-objects)\b/,
	new RegExp(String.raw`^git\s+(branch|tag)${GIT_LIST_FLAG}`),
	/^git\s+remote(\s+(-v|--verbose|show|get-url)\b.*)?$/,
	/^git\s+(worktree|stash)\s+list\b/,
	/^git\s+config\s+(--get|--get-all|--get-regexp|-l|--list)\b/,
	// `git config <key>` without a value reports what is stored.
	/^git\s+config\s+[^-\s]+\s*$/,
	/^gh\s+(pr|issue|repo|release)\s+(view|list|diff|status)\b/,
	/^gh\s+(auth\s+status|search\s+\w+|label\s+list|workflow\s+(list|view))\b/,
	// Viewing a stack reads the local stack and its PRs.
	/^gh\s+stack\s+view\b/,
	// Metadata probes: what is installed, configured, or resolved here.
	/^locale\b/,
	/^cargo\s+tree\b/,
	/^go\s+version\b/,
	/^(ls|cat|head|tail|grep|egrep|rg|wc|pwd|tree|stat|file|which|type|readlink|realpath|dirname|basename|cut|uniq|tr|nl|column|strings|diff|cmp|od|xxd|hexdump|shasum|sha256sum|md5|md5sum|du|df|date|uname|whoami|ps|pgrep|lsof|jq|awk)\b/,
	/^command\s+-v\b/,
	/^(\[\[?|test)\s/,
	/^sort\b(?!.*\s(-o|--output)\b)/,
	/^sed\b(?!.*\s(-[a-zA-Z]*i|--in-place)\b)/,
	/^find\b(?!.*\s-(delete|exec|execdir|ok|okdir|fprint\w*)\b)/,
];

// Segments that neither inspect nor change anything worth labeling: shell
// control words, no-op builtins, and bare variable assignments (their
// command substitutions are classified as commands of their own).
const NEUTRAL_COMMANDS: readonly RegExp[] = [
	/^(cd|pushd|popd|echo|printf|sleep|true|false|export|set)\b/,
	/^(done|fi|esac|\}|\))$/,
	/^for\s+\w+(\s+in\b.*)?$/,
	// Each assignment must end at whitespace or the end: an optional separator
	// would let `a=a=a=…` split anywhere and backtrack exponentially.
	/^([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s"'])*(\s+|$))+$/,
];

// Shell keywords that prefix the command they introduce (`do grep x`).
const LEADING_KEYWORDS = /^(do|then|else|elif|if|while|until|time|!|\{|\()\s+/;

/**
 * Infers the ODD phase implied by a tool call, or undefined when the call
 * carries no reliable phase signal and the label must stay as it is.
 */
export function inferOddPhase(toolName: string, args: unknown): OddPhase | undefined {
	const name = normalizeToolName(toolName);
	if (name === "subagent_run") {
		const agent = stringArg(args, "agent");
		return agent && Object.hasOwn(DELEGATED_PHASES, agent) ? DELEGATED_PHASES[agent] : undefined;
	}
	if (WRITE_TOOLS.has(name)) return isOddTaskPath(stringArg(args, "path") ?? stringArg(args, "file_path")) ? "planning" : "implementing";
	if (SHELL_TOOLS.has(name)) return inferShellPhase(stringArg(args, "command"));
	if (name === CODEGRAPH_TOOL) {
		const operation = stringArg(args, "operation");
		return operation !== undefined && Object.hasOwn(CODEGRAPH_OPERATION_PHASES, operation)
			? CODEGRAPH_OPERATION_PHASES[operation]
			: undefined;
	}
	return Object.hasOwn(TOOL_PHASES, name) ? TOOL_PHASES[name] : undefined;
}

// Some runtimes expose tools through an MCP proxy as `mcp__<server>__<tool>`.
function normalizeToolName(toolName: string): string {
	return toolName.replace(/^mcp__.+?__/, "");
}

function stringArg(args: unknown, key: string): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

function isOddTaskPath(path: string | undefined): boolean {
	return path !== undefined && /(^|\/)odd\/tasks\//.test(path.replaceAll("\\", "/"));
}

/**
 * A command checks when any segment runs a checker; it explores only when
 * every segment is read-only inspection (or neutral like `cd`). Anything
 * else — a mutation, an install, an unknown program — is ambiguous.
 */
function inferShellPhase(command: string | undefined): OddPhase | undefined {
	const segments = shellSegments(command);
	if (segments.length === 0) return undefined;
	const activities = segments.map(segmentActivity);
	if (activities.includes("checking")) return "checking";
	return activities.every((activity) => activity === "exploring") ? "exploring" : undefined;
}

/**
 * The activity a shell command names for its own card, or undefined when some
 * segment carries no reliable signal. Preparing, formatting, destructive,
 * versioning and publishing are card identities, not ODD phases: the working
 * label and the exploration budget read inferOddPhase, which never returns them.
 *
 * The card keeps every segment honest: a segment nothing can name keeps the whole
 * call generic — a check printed beside an unknown script never claims the card —
 * and the strongest named activity wins, a deletion first, then a check, then a
 * remote write, a history change, a rewrite and a build-up. That is a display rule
 * only: the phase inference still lets any checking segment decide the label.
 */
export function inferShellActivity(command: string | undefined): ShellActivity | undefined {
	const segments = shellSegments(command);
	if (segments.length === 0) return undefined;
	const activities = segments.map(segmentActivity);
	// A deletion outranks everything, including a segment nothing can name: the card
	// never hides the one thing the call cannot undo.
	if (activities.includes("destructive") || (command !== undefined && isDestructiveCommand(command))) return "destructive";
	// Beside a segment nothing can name the card stays generic: the heading never
	// claims a check — or any other identity — for work the call also did silently.
	if (activities.includes(undefined)) return undefined;
	if (activities.includes("checking")) return "checking";
	if (activities.includes("publishing")) return "publishing";
	if (activities.includes("versioning")) return "versioning";
	if (activities.includes("formatting")) return "formatting";
	if (activities.includes("preparing")) return "preparing";
	return "exploring";
}

/** The command split into the simple commands the classifier reads, with the ones that do nothing dropped. */
function shellSegments(command: string | undefined): string[] {
	if (command === undefined) return [];
	return shellCommandSegments(command)
		.map(stripSegment)
		.filter((segment) => segment.length > 0 && !isNeutral(segment));
}

/**
 * What one simple command does. A help flag outranks the verb it qualifies —
 * `git push --help` prints usage — a help flag an option consumed leaves the verb
 * to name the segment, and a help flag this classifier cannot read as a query
 * leaves the segment unnamed rather than naming the verb beside it.
 */
function segmentActivity(segment: string): ShellActivity | undefined {
	const help = helpFlag(segment);
	if (help === "request") return "exploring";
	if (help === "unreadable") return undefined;
	if (isDestructiveSegment(segment)) return "destructive";
	if (isCheckingSegment(segment)) return "checking";
	if (isFormattingSegment(segment)) return "formatting";
	if (isReadOnlyInspection(segment)) return "exploring";
	// A segment whose payload this classifier cannot read, or that redirects its
	// output into a file, is a write it cannot name.
	if (HIDDEN_SUBSTITUTION.test(segment) || writesFile(segment)) return undefined;
	if (isPreparingSegment(segment)) return "preparing";
	if (matchesAny(VERSIONING_COMMANDS, segment)) return "versioning";
	if (matchesAny(PUBLISHING_COMMANDS, segment)) return "publishing";
	return undefined;
}

/**
 * Whether a segment asks a known program for its own usage page: a request, a
 * flag the segment's own text merely mentions or an option consumed, or an
 * unreadable one this classifier refuses to guess about.
 */
function helpFlag(segment: string): "request" | "unreadable" | "absent" {
	const words = shellWords(segment);
	const at = words.findIndex((word) => !word.quoted && word.text === "--help");
	if (at < 0) return "absent";
	// An option may take the help flag as its own value: `git commit -m --help`
	// commits a message spelled `--help` and `gh issue comment --body --help` posts
	// it, printing nothing. Escaped whitespace keeps the two in one word —
	// `git commit -m foo\ --help` commits `foo --help` — and a word that may expand
	// to an option (`$OPTS`) can consume it too. Which options take a value cannot be
	// known here, so a help flag directly after such a word is read as that word's
	// value and the segment keeps its own verb's activity. The reading only ever
	// removes a query, never adds one, so a genuine usage page beside an option stays
	// with the verb instead of turning a mutation into exploration.
	const previous = words[at - 1];
	if (previous !== undefined && (previous.text.startsWith("-") || previous.text.startsWith("$"))) return "absent";
	const program = (words[0]?.text ?? "").split("/").pop() ?? "";
	if (!HELP_AWARE_COMMANDS.has(program)) return "unreadable";
	// `node -e '…' --help` runs the payload with `--help` as its own argument.
	if (SCRIPT_RUNNERS.has(program) && words.slice(1).some((word) => PAYLOAD_FLAGS.has(word.text))) return "unreadable";
	if (writesFile(segment) || HIDDEN_SUBSTITUTION.test(segment)) return "unreadable";
	return "request";
}

/** One word of a segment, with the quotes the shell would have removed and whether it carried any. */
interface ShellWord {
	text: string;
	quoted: boolean;
}

/**
 * Splits a segment into the words the program receives, dropping the quoting
 * characters the shell would drop. A quoted `--help` is text handed to the
 * program, and a quoted `-m` is still an option, so both the text and whether the
 * word was quoted are kept.
 */
function shellWords(segment: string): ShellWord[] {
	const words: ShellWord[] = [];
	let text = "";
	let quoted = false;
	const push = () => {
		if (text.length > 0) words.push({ text, quoted });
		text = "";
		quoted = false;
	};
	for (let i = 0; i < segment.length; i++) {
		const char = segment[i] ?? "";
		if (char === "\\") {
			// `\X` is the literal X and `\<newline>` is a line continuation, so an
			// escaped space never ends a word: `foo\ --help` is one argument.
			const next = segment[i + 1];
			if (next === undefined) {
				text += char;
				continue;
			}
			i++;
			if (next !== "\n") text += next;
			continue;
		}
		if (char === "'") {
			// Nothing is escaped inside single quotes.
			const end = segment.indexOf("'", i + 1);
			text += segment.slice(i + 1, end < 0 ? segment.length : end);
			quoted = true;
			i = end < 0 ? segment.length : end;
			continue;
		}
		if (char === '"') {
			// A double-quoted span is one word whatever spaces it holds, and only `\X`
			// and a continuation escape; the quotes the shell would drop are dropped, so
			// a `--help` inside it stays text.
			let inner = "";
			let end = i + 1;
			while (end < segment.length && segment[end] !== '"') {
				const inner_char = segment[end] ?? "";
				if (inner_char !== "\\") {
					inner += inner_char;
					end++;
					continue;
				}
				const next = segment[end + 1];
				if (next === undefined) {
					inner += inner_char;
					end++;
					continue;
				}
				end += 2;
				if (next !== "\n") inner += next;
			}
			text += inner;
			quoted = true;
			i = end;
			continue;
		}
		if (/\s/.test(char)) {
			push();
			continue;
		}
		text += char;
	}
	push();
	return words;
}

/** The segment with its quoted spans removed, so a flag or a `>` mentioned in text is not read as one. */
function unquoted(segment: string): string {
	return segment.replace(/"[^"]*"|'[^']*'/g, " ");
}

/** A segment verifies work when it runs one of the check families below. */
function isCheckingSegment(segment: string): boolean {
	if (matchesAny(CHECKING_COMMANDS, segment)) return true;
	if (matchesAny(FIXABLE_CHECKING_COMMANDS, segment)) return !FIX_FLAGS.test(segment);
	if (isPackageManagerCheck(segment) || isMakeCheck(segment)) return true;
	// A watchdog bounds how long a check may run without changing what it does, so a
	// runner behind `timeout` still checks. Only the check families are unwrapped:
	// `timeout 5 git status` is not a check and is not inspection either.
	const bounded = timeoutCommand(segment);
	return bounded !== undefined && isCheckingSegment(bounded);
}

/**
 * The command a segment's `timeout` wrapper bounds, or undefined when the segment
 * is not a timeout call. The wrapper's flags, their values and the duration it
 * bounds all precede the command that runs.
 */
function timeoutCommand(segment: string): string | undefined {
	const words = segment.split(/\s+/);
	if (words[0] !== "timeout") return undefined;
	let index = 1;
	while (index < words.length && (words[index] ?? "").startsWith("-")) {
		const flag = words[index++];
		if (flag === "--") break;
		if (TIMEOUT_VALUE_OPTIONS.has(flag ?? "")) index++;
	}
	// The duration is required and is not part of the command it bounds.
	index++;
	return index < words.length ? words.slice(index).join(" ") : undefined;
}

/** A formatter or a lint fixer rewrites what it reads; its read-only form never does. */
function isFormattingSegment(segment: string): boolean {
	return !FORMAT_READ_ONLY_FLAGS.test(unquoted(segment)) && matchesAny(FORMATTING_COMMANDS, segment);
}

/**
 * Whether a segment prepares the environment. A package manager is read through
 * its own subcommand position, so `pnpm -C pkg install` installs like
 * `pnpm install` — the workspace flags a monorepo needs never hide it.
 */
function isPreparingSegment(segment: string): boolean {
	const script = packageManagerCommand(segment);
	if (script !== undefined) {
		if (PREPARING_SCRIPTS.has(script)) return true;
		// `pnpm config set fund false` stores configuration in the tool's own file.
		return script === "config" && /\sconfig\s+set\b/.test(segment);
	}
	return matchesAny(PREPARING_COMMANDS, segment);
}

/**
 * `pnpm -C pkg test` runs the same script as `pnpm test`, so the workspace flags
 * a monorepo needs must not hide it. Only a listed check script counts:
 * `pnpm install`, `pnpm deploy`, and an unlisted script stay ambiguous.
 */
function isPackageManagerCheck(segment: string): boolean {
	const script = packageManagerCommand(segment);
	return script !== undefined && isCheckScript(script);
}

/** The package-manager subcommand the segment runs, after its workspace flags. */
function packageManagerCommand(segment: string): string | undefined {
	const words = segment.split(/\s+/);
	if (!PACKAGE_MANAGERS.has(words[0] ?? "")) return undefined;
	for (let i = 1; i < words.length; i++) {
		const word = words[i] ?? "";
		if (PACKAGE_MANAGER_FLAGS.has(word) || word === "run") continue;
		if (PACKAGE_MANAGER_VALUE_OPTIONS.has(word)) {
			i++;
			continue;
		}
		const option = /^(--[a-z-]+)=/.exec(word);
		if (option && PACKAGE_MANAGER_VALUE_OPTIONS.has(option[1] ?? "")) continue;
		return word;
	}
	return undefined;
}

/**
 * `pnpm run test:unit` and `pnpm check:provider-contract` are the same check
 * families under a namespace, so a `:` suffix keeps its base script's meaning.
 */
function isCheckScript(word: string): boolean {
	return CHECK_SCRIPTS.has(word.split(":")[0] ?? "");
}

/**
 * Only a check target counts. A bare `make` builds its default target and stays
 * a check, while a recipe named on the command line must be one of them:
 * `make install`, `make deploy` and `make test install` leave the label alone.
 */
function isMakeCheck(segment: string): boolean {
	const words = segment.split(/\s+/);
	if (words[0] !== "make") return false;
	for (let i = 1; i < words.length; i++) {
		const word = words[i] ?? "";
		if (MAKE_FLAGS.has(word)) continue;
		// `-j` takes an optional job count, so it never swallows the recipe:
		// `make -j test` and `make -j4 test` still name `test`, while
		// `make -j install` names `install`.
		if (word === "-j" || word === "--jobs") {
			if (/^\d+$/.test(words[i + 1] ?? "")) i++;
			continue;
		}
		if (/^-j\d+$/.test(word) || /^--jobs=\d+$/.test(word)) continue;
		if (MAKE_VALUE_OPTIONS.has(word)) {
			i++;
			continue;
		}
		// `make VAR=1 test` passes a variable, not a target.
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
		if (!MAKE_CHECK_TARGETS.has(word)) return false;
	}
	return true;
}

/**
 * Splits a shell command into simple commands. Top-level `&&`, `||`, `;`,
 * `|`, `&`, and newlines separate them; quoted text never does; and every
 * `$(...)` substitution contributes its own commands, leaving a `$_`
 * placeholder behind. Not a full shell parser: whatever it cannot follow
 * lands in a segment that matches no pattern, so the label stays unchanged.
 *
 * This is the one segmenter: the activity and phase inference above read it, and
 * so does the versioning card's command family (lib/versioning-card-preview.ts),
 * which needs the same quote-aware split to find the step that reported last. A
 * second splitter that ignored quoting would read a separator inside a commit
 * message as a segment boundary and name the wrong family for the same call.
 */
export function shellCommandSegments(command: string): string[] {
	const commands: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (quote === "'") {
			current += char;
			if (char === "'") quote = undefined;
		} else if (char === "\\") {
			current += char + (command[i + 1] ?? "");
			i++;
		} else if (char === "$" && command[i + 1] === "(") {
			const end = findSubstitutionEnd(command, i + 2);
			if (end < 0) return [...commands, current + command.slice(i)];
			commands.push(...shellCommandSegments(command.slice(i + 2, end)));
			current += "$_";
			i = end;
		} else if (quote === '"') {
			current += char;
			if (char === '"') quote = undefined;
		} else if (char === "'" || char === '"') {
			quote = char;
			current += char;
		} else if (isSeparator(command, i)) {
			commands.push(current);
			current = "";
			if ((char === "|" || char === "&") && command[i + 1] === char) i++;
		} else {
			current += char;
		}
	}
	commands.push(current);
	return commands;
}

// `&` inside a redirection (`2>&1`, `&>/dev/null`) is not a separator.
function isSeparator(command: string, i: number): boolean {
	const char = command[i];
	if (char === "&") return command[i - 1] !== ">" && command[i + 1] !== ">";
	return char === ";" || char === "|" || char === "\n";
}

// Index of the `)` closing a `$(` whose body starts at `start`, or -1.
function findSubstitutionEnd(command: string, start: number): number {
	let depth = 1;
	let quote: "'" | '"' | undefined;
	for (let i = start; i < command.length; i++) {
		const char = command[i];
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === '"') i++;
		} else if (char === "\\") i++;
		else if (char === "'" || char === '"') quote = char;
		else if (char === "(") depth++;
		else if (char === ")" && --depth === 0) return i;
	}
	return -1;
}

// Drops harmless redirections (`2>&1`, `2>/dev/null`), leading shell
// keywords (`do grep x`), environment assignments (`CI=1 pnpm test`), git
// global options (`git -C dir status`), and whitespace. A bare assignment
// is left intact for NEUTRAL_COMMANDS.
function stripSegment(segment: string): string {
	let stripped = segment.replace(HARMLESS_REDIRECTS, "").trim();
	while (LEADING_KEYWORDS.test(stripped)) stripped = stripped.replace(LEADING_KEYWORDS, "");
	return stripped
		.replace(/^([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s"'])*\s+)+(?=\S)/, "")
		.replace(/^git\s+((-C|-c)\s+\S+\s+|--no-pager\s+)+/, "git ");
}

// A segment that writes a file (`echo x > out`) is never a no-op.
function isNeutral(segment: string): boolean {
	return !writesFile(segment) && matchesAny(NEUTRAL_COMMANDS, segment);
}

// The splitter follows `$(...)` but not backticks or `<(...)`, so a command
// hidden in one of those never reaches this classifier; `>(...)` is already a
// file write. A segment carrying one is ambiguous rather than inspection.
const HIDDEN_SUBSTITUTION = /`|<\(/;

function isReadOnlyInspection(segment: string): boolean {
	return !writesFile(segment)
		&& !HIDDEN_SUBSTITUTION.test(segment)
		&& (matchesAny(EXPLORING_COMMANDS, segment) || isGhApiRead(segment) || isGoEnvRead(segment));
}

/** `gh api` without a method, field, or input body reads; with one it writes. */
function isGhApiRead(segment: string): boolean {
	const words = segment.split(/\s+/);
	if (words[0] !== "gh" || words[1] !== "api") return false;
	return !words.slice(2).some((word) => GH_API_WRITE_FLAGS.has(word.split("=")[0] ?? "") || /^-[XfF]./.test(word));
}

/**
 * `go env` reports the Go configuration, but `-w` stores a value in the env
 * config file and `-u` unsets one: both write, so neither is inspection.
 */
function isGoEnvRead(segment: string): boolean {
	const words = segment.split(/\s+/);
	if (words[0] !== "go" || words[1] !== "env") return false;
	return !words.slice(2).some((word) => /^-[wu]$/.test(word));
}

// Stream merges and discarded output; neither writes a file.
const HARMLESS_REDIRECTS = /\s*(\d?>&\d|&?\d?>\s*\/dev\/null)/g;

// Output redirection to a file is a write. A `>` inside a quoted span is the
// program's own argument (`git commit -m "a > b"`, `git log --format="%h > %s"`),
// never a redirect, so only the text the shell would act on counts. Deliberately
// naive beyond that: an unbalanced quote keeps its `>`, which only ever leaves the
// label unchanged.
function writesFile(segment: string): boolean {
	return unquoted(segment).replace(HARMLESS_REDIRECTS, "").includes(">");
}

function matchesAny(patterns: readonly RegExp[], segment: string): boolean {
	return patterns.some((pattern) => pattern.test(segment));
}
