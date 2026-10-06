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
	const lines = (source: string | null) => source === null || source === '' ? [] : (source.endsWith('\n') ? source.slice(0, -1) : source).split('\n');
	const before = lines(change.before);
	const after = lines(change.after);
	const identities = (values: string[], source: string | null) => values.map((line, index) => `${line}${index < values.length - 1 || source?.endsWith('\n') ? '\n' : ''}`);
	const beforeIdentity = identities(before, change.before);
	const afterIdentity = identities(after, change.after);
	const prefix = sharedStart(beforeIdentity, afterIdentity);
	const suffix = sharedEnd(beforeIdentity, afterIdentity, prefix);
	const start = Math.max(0, prefix - 3);
	const beforeEnd = before.length - Math.max(0, suffix - 3);
	const afterEnd = after.length - Math.max(0, suffix - 3);
	const oldSlice = before.slice(start, beforeEnd);
	const newSlice = after.slice(start, afterEnd);
	const leading = prefix - start;
	const trailing = Math.min(3, suffix);
	const marked = (line: string, marker: string, index: number, source: string | null, sourceLines: string[]) =>
		`${marker}${line}${index === sourceLines.length - 1 && !source?.endsWith('\n') ? '\n\\ No newline at end of file' : ''}`;
	const body = [...oldSlice.slice(0, leading).map((line, index) => marked(line, ' ', start + index, change.before, before)),
		...oldSlice.slice(leading, oldSlice.length - trailing).map((line, index) => marked(line, '-', start + leading + index, change.before, before)),
		...newSlice.slice(leading, newSlice.length - trailing).map((line, index) => marked(line, '+', start + leading + index, change.after, after)),
		...newSlice.slice(newSlice.length - trailing).map((line, index) => marked(line, ' ', afterEnd - trailing + index, change.after, after))].join('\n');
	return [`diff --git a/${change.path} b/${change.path}`,
		...(change.before === null ? ['new file mode 100644'] : change.after === null ? ['deleted file mode 100644'] : []),
		`--- ${change.before === null ? '/dev/null' : `a/${change.path}`}`,
		`+++ ${change.after === null ? '/dev/null' : `b/${change.path}`}`,
		...(oldSlice.length || newSlice.length ? [`@@ -${oldSlice.length ? start + 1 : start},${oldSlice.length} +${newSlice.length ? start + 1 : start},${newSlice.length} @@`, body] : [])].join('\n');
}

export function createUnifiedChangeset(changes: TextFileChange[]) {
	const paths = new Set<string>();
	for (const change of changes) {
		if (paths.has(change.path)) throw new Error(`Duplicate changeset path: ${change.path}`);
		paths.add(change.path);
	}
	const patches = changes.map(textFileDiff).filter(Boolean);
	return patches.length ? `${patches.join('\n')}\n` : '';
}
