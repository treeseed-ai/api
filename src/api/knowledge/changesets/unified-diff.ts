export interface TextFileChange {
	path: string;
	before: string | null;
	after: string | null;
}

function sharedStart(left: string[], right: string[]) {
	let count = 0;
	while (count < left.length && count < right.length && left[count] === right[count]) count += 1;
	return count;
}

function sharedEnd(left: string[], right: string[], start: number) {
	let count = 0;
	while (count < left.length - start && count < right.length - start
		&& left[left.length - count - 1] === right[right.length - count - 1]) count += 1;
	return count;
}

function textFileDiff(change: TextFileChange) {
	if (change.before === null && change.after === null) throw new Error(`Changeset path ${change.path} has no content.`);
	if (change.before === change.after) return '';
	const before = change.before === null ? [] : change.before.split('\n');
	const after = change.after === null ? [] : change.after.split('\n');
	const prefix = sharedStart(before, after);
	const suffix = sharedEnd(before, after, prefix);
	const start = Math.max(0, prefix - 3);
	const beforeEnd = before.length - Math.max(0, suffix - 3);
	const afterEnd = after.length - Math.max(0, suffix - 3);
	const oldSlice = before.slice(start, beforeEnd);
	const newSlice = after.slice(start, afterEnd);
	const leading = prefix - start;
	const trailing = Math.min(3, suffix);
	const body = [...oldSlice.slice(0, leading).map((line) => ` ${line}`),
		...oldSlice.slice(leading, oldSlice.length - trailing).map((line) => `-${line}`),
		...newSlice.slice(leading, newSlice.length - trailing).map((line) => `+${line}`),
		...newSlice.slice(newSlice.length - trailing).map((line) => ` ${line}`)].join('\n');
	return [`diff --git a/${change.path} b/${change.path}`,
		...(change.before === null ? ['new file mode 100644'] : change.after === null ? ['deleted file mode 100644'] : []),
		`--- ${change.before === null ? '/dev/null' : `a/${change.path}`}`,
		`+++ ${change.after === null ? '/dev/null' : `b/${change.path}`}`,
		`@@ -${change.before === null ? 0 : start + 1},${oldSlice.length} +${change.after === null ? 0 : start + 1},${newSlice.length} @@`, body].join('\n');
}

export function createUnifiedChangeset(changes: TextFileChange[]) {
	const paths = new Set<string>();
	for (const change of changes) {
		if (paths.has(change.path)) throw new Error(`Duplicate changeset path: ${change.path}`);
		paths.add(change.path);
	}
	return changes.map(textFileDiff).filter(Boolean).join('\n');
}
