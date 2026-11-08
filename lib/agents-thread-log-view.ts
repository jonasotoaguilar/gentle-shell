import { THREAD_ITEM, type ThreadItem, type ToolItem } from "./agents-protocol.ts";
import { contentLines, line, noteRows } from "./agents-thread-rows.ts";

// The log view: the Agents pane's original renderer, kept whole and free of the
// chat's cards. It prints each retained item as a labelled run -- "Text",
// "Thinking", "Note", "Tool · name · status", "Output" -- with two columns of
// indent inside an item and four inside a tool's output. It infers nothing: a
// shell command gets no ODD phase, a file call no file card, and a note that the
// chat draws as an input card stays a plain labelled note. The selection lives
// in lib/agents-view-style-policy.ts; the pane picks this renderer for the log
// style and lib/agents-thread-view.ts for the cards style.

export interface AgentsThreadLogTheme {
	fg(color: string, text: string): string;
}

const ROLE = {
	TEXT: "text",
	THINKING: "dim",
	TOOL: "accent",
	TOOL_ERROR: "error",
	OUTPUT: "muted",
	NOTE: "muted",
	LABEL: "customMessageLabel",
} as const;

function toolStatus(item: ToolItem): "Running" | "Error" | "Complete" {
	if (item.isError) return "Error";
	return item.running ? "Running" : "Complete";
}

/** Render an already-sanitized, bounded protocol item as the registry view's labelled rows. */
export function renderThreadLogItem(item: ThreadItem, theme: AgentsThreadLogTheme, width: number): string[] {
	if (width <= 0) return [];
	switch (item.kind) {
		case THREAD_ITEM.TEXT:
			return [line(theme, ROLE.LABEL, "Text", width), ...contentLines(theme, ROLE.TEXT, item.text, width, 2)];
		case THREAD_ITEM.THINKING:
			return [line(theme, ROLE.LABEL, "Thinking", width), ...contentLines(theme, ROLE.THINKING, item.text, width, 2)];
		case THREAD_ITEM.NOTE:
			return noteRows(theme, ROLE.NOTE, item.text, width);
		case THREAD_ITEM.TOOL: {
			const role = item.isError ? ROLE.TOOL_ERROR : ROLE.TOOL;
			const header = line(theme, role, `Tool · ${item.name} · ${toolStatus(item)}`, width);
			if (item.output.length === 0) return [header];
			return [header, line(theme, ROLE.OUTPUT, "  Output", width), ...contentLines(theme, ROLE.OUTPUT, item.output, width, 4)];
		}
		default:
			return [];
	}
}
