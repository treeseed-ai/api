export function splitPostgresSqlStatements(sql: string): string[] {
	const statements: string[] = [];
	let start = 0;
	let index = 0;
	let singleQuoted = false;
	let doubleQuoted = false;
	let lineComment = false;
	let blockComment = false;
	let dollarTag: string | null = null;
	while (index < sql.length) {
		const current = sql[index]!;
		const next = sql[index + 1];
		if (lineComment) {
			if (current === '\n') lineComment = false;
			index += 1;
			continue;
		}
		if (blockComment) {
			if (current === '*' && next === '/') {
				blockComment = false;
				index += 2;
			} else {
				index += 1;
			}
			continue;
		}
		if (dollarTag) {
			if (sql.startsWith(dollarTag, index)) {
				index += dollarTag.length;
				dollarTag = null;
			} else {
				index += 1;
			}
			continue;
		}
		if (singleQuoted) {
			if (current === "'" && next === "'") {
				index += 2;
			} else {
				if (current === "'") singleQuoted = false;
				index += 1;
			}
			continue;
		}
		if (doubleQuoted) {
			if (current === '"' && next === '"') {
				index += 2;
			} else {
				if (current === '"') doubleQuoted = false;
				index += 1;
			}
			continue;
		}
		if (current === '-' && next === '-') {
			lineComment = true;
			index += 2;
			continue;
		}
		if (current === '/' && next === '*') {
			blockComment = true;
			index += 2;
			continue;
		}
		if (current === "'") {
			singleQuoted = true;
			index += 1;
			continue;
		}
		if (current === '"') {
			doubleQuoted = true;
			index += 1;
			continue;
		}
		if (current === '$') {
			const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u);
			if (match) {
				dollarTag = match[0];
				index += dollarTag.length;
				continue;
			}
		}
		if (current === ';') {
			const statement = sql.slice(start, index).trim();
			if (statement) statements.push(statement);
			start = index + 1;
		}
		index += 1;
	}
	const trailing = sql.slice(start).trim();
	if (trailing) statements.push(trailing);
	return statements;
}
