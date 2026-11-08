// The row primitives both Agents thread renderers draw with: a labelled row, an
// indented block of content, and the plain note. They live here, once, because the
// log view and the cards view must agree on them exactly -- the note in particular
// is the one item the cards view deliberately leaves to the log renderer, so a
// second copy of its rows would let the two drift apart.

import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** What these rows ask of a theme: one role per row, no attributes. */
export interface AgentsThreadRowsTheme {
	fg(color: string, text: string): string;
}

/** One labelled or bare row, painted in `role` and cut to the width it has. */
export function line(theme: AgentsThreadRowsTheme, role: string, text: string, width: number): string {
	return theme.fg(role, truncateToWidth(text, Math.max(1, width), "…"));
}

/**
 * Text as its own indented block: every source row wrapped to the cells left below
 * the indent, each drawn row painted in `role`. A blank source row stays a blank
 * indented row, so the shape of what the child wrote survives. The indent is capped
 * at one column less than the width, so a narrow pane still has a cell for content.
 */
export function contentLines(theme: AgentsThreadRowsTheme, role: string, text: string, width: number, requestedIndent: number): string[] {
	const indent = Math.min(requestedIndent, Math.max(0, width - 1));
	const prefix = " ".repeat(indent);
	const contentWidth = Math.max(1, width - indent);
	return text.split("\n").flatMap((source) => {
		if (source.length === 0) return [theme.fg(role, prefix)];
		const wrapped = wrapTextWithAnsi(source, contentWidth);
		return (wrapped.length > 0 ? wrapped : [source]).map((part) => theme.fg(role, `${prefix}${part}`));
	});
}

/**
 * A plain note: its own label, then its text at a two-column indent. It stays a
 * labelled meta row in both renderers -- unlike prose it is not Markdown, and
 * unlike a tool call it is not a card.
 */
export function noteRows(theme: AgentsThreadRowsTheme, role: string, text: string, width: number): string[] {
	return [line(theme, role, "Note", width), ...contentLines(theme, role, text, width, 2)];
}
