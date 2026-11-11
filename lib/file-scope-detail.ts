import { formatAge } from "./file-index.ts";
import type { GitResult, GitRunner } from "./shell-changes.ts";

// The focused scope's Git facts (S33): what the scope step paints on the line
// directly above its footer. The view renders this model and never runs Git;
// every lookup here degrades to an absent field, so a repository with no
// remote, no commits or failing Git paints less instead of a fabricated zero.

/** A registered worktree is compared with the session repository's local main. */
export const LOCAL_MAIN = "main";
/** The `main` row is compared with the remote main it tracks. */
export const REMOTE_MAIN = "origin/main";

export interface ScopeDetail {
	/** Uncommitted files in the working tree, as /changes already counted them. */
	changedFiles?: number;
	/** The working tree's newest change; painted as an age, never as a timestamp. */
	lastModifiedMs?: number;
	lastCommitSubject?: string;
	/** Commits the scope has that the comparison ref does not. */
	ahead?: number;
	/** Commits the comparison ref has that the scope does not. */
	behind?: number;
	/** The ref ahead/behind was measured against (LOCAL_MAIN or REMOTE_MAIN). */
	comparison?: string;
}

const COUNT = /^\d+$/;

/**
 * One `rev-list --left-right --count A...B` line: the left count belongs to A
 * alone and the right count to B alone, so `comparison...HEAD` reads as
 * `<behind> <ahead>`. Anything that is not exactly two counts is unparsable,
 * which the caller treats as absent.
 */
export function parseAheadBehind(stdout: string): { ahead: number; behind: number } | undefined {
	const fields = stdout.trim().split(/\s+/);
	if (fields.length !== 2) return undefined;
	const [behind, ahead] = fields;
	if (!COUNT.test(behind!) || !COUNT.test(ahead!)) return undefined;
	return { ahead: Number.parseInt(ahead!, 10), behind: Number.parseInt(behind!, 10) };
}

// A timed-out, truncated or non-zero answer is a failed lookup, never a
// partial count: only a complete, successful read reaches the detail line.
async function ask(git: GitRunner, args: string[]): Promise<GitResult | undefined> {
	try {
		const result = await git(args);
		return result.code === 0 && !result.truncated && !result.timedOut ? result : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The scope's last commit and its distance from `comparison`. A missing ref
 * (no remote, no local main, an unborn branch) and a failed Git call leave
 * both counts absent.
 */
export async function loadScopeDetail(git: GitRunner, comparison: string): Promise<ScopeDetail> {
	const [range, subject] = await Promise.all([
		ask(git, ["rev-list", "--left-right", "--count", `${comparison}...HEAD`]),
		ask(git, ["log", "-1", "--format=%s"]),
	]);
	const detail: ScopeDetail = { comparison };
	const distance = range === undefined ? undefined : parseAheadBehind(range.stdout);
	if (distance !== undefined) {
		detail.ahead = distance.ahead;
		detail.behind = distance.behind;
	}
	const line = subject?.stdout.split("\n")[0]?.trim();
	if (line) detail.lastCommitSubject = line;
	return detail;
}

const SEPARATOR = " · ";
// S34: the data paints with symbols, not words -- `±n files` for the uncommitted
// files, `↑n <ref>` ahead and `↓n <ref>` behind -- while the age and the commit
// subject keep their terse form. The count keeps the noun because `±3` alone
// reads as changed lines, the way `+1 -1` does in /changes. The ref stays last
// so the `main` row's `↓2 origin/main` still says what it is measured against.
const CHANGED_SYMBOL = "±";
const AHEAD_SYMBOL = "↑";
const BEHIND_SYMBOL = "↓";

/** The uncommitted count: the glyph plus the noun, singular at one. */
export function countCell(files: number): string {
	return `${CHANGED_SYMBOL}${files} ${files === 1 ? "file" : "files"}`;
}

/**
 * The detail line's text: the uncommitted files, the last modification's age,
 * the last commit subject, and the distance from the comparison ref. A field
 * that is zero or absent is not painted at all, and nothing here claims a
 * value Git did not answer.
 */
export function scopeDetailLine(detail: ScopeDetail, nowMs: number): string {
	const fields: string[] = [];
	const files = detail.changedFiles ?? 0;
	if (files > 0) fields.push(countCell(files));
	if (detail.lastModifiedMs !== undefined && detail.lastModifiedMs > 0) fields.push(formatAge(detail.lastModifiedMs, nowMs));
	if (detail.lastCommitSubject) fields.push(detail.lastCommitSubject);
	const comparison = detail.comparison;
	if (comparison !== undefined && (detail.ahead ?? 0) > 0) fields.push(`${AHEAD_SYMBOL}${detail.ahead} ${comparison}`);
	if (comparison !== undefined && (detail.behind ?? 0) > 0) fields.push(`${BEHIND_SYMBOL}${detail.behind} ${comparison}`);
	return fields.join(SEPARATOR);
}
