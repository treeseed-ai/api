import { FEEDBACK_EXPORT_SCHEMA, type FeedbackPrivacyManifest } from '@treeseed/sdk/feedback';

const crcTable = Array.from({ length: 256 }, (_, value) => {
	let crc = value;
	for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	return crc >>> 0;
});

function crc32(bytes: Uint8Array) {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function zipTimestamp(date: Date) {
	const year = Math.max(1980, date.getUTCFullYear());
	return {
		time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
		date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
	};
}

export function createStoredZip(files: Array<{ name: string; bytes: Uint8Array }>) {
	const locals: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	const stamp = zipTimestamp(new Date());
	for (const file of files) {
		const name = Buffer.from(file.name, 'utf8');
		const bytes = Buffer.from(file.bytes);
		const crc = crc32(bytes);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
		local.writeUInt16LE(0, 8); local.writeUInt16LE(stamp.time, 10); local.writeUInt16LE(stamp.date, 12);
		local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22);
		local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
		locals.push(local, name, bytes);
		const header = Buffer.alloc(46);
		header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x0800, 8);
		header.writeUInt16LE(0, 10); header.writeUInt16LE(stamp.time, 12); header.writeUInt16LE(stamp.date, 14);
		header.writeUInt32LE(crc, 16); header.writeUInt32LE(bytes.length, 20); header.writeUInt32LE(bytes.length, 24);
		header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42);
		central.push(header, name);
		offset += local.length + name.length + bytes.length;
	}
	const centralBytes = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, centralBytes, end]);
}

export function createFeedbackExportFiles(rows: any[], manifestInput: Omit<FeedbackPrivacyManifest, 'schema' | 'count' | 'omittedFields' | 'redactionPolicy'>) {
	const records = rows.map((row) => ({
		id: row.id,
		type: row.type,
		status: row.status,
		message: row.message,
		submitterId: row.submitter_user_id,
		teamId: row.team_id,
		projectId: row.project_id,
		path: row.canonical_path,
		buildId: row.build_id,
		revision: row.revision,
		client: JSON.parse(row.client_json || '{}'),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		resolvedAt: row.resolved_at,
		history: Array.isArray(row.feedback_history) ? row.feedback_history.map((event: any) => ({ fromStatus: event.from_status, toStatus: event.to_status, note: event.note, createdAt: event.created_at })) : [],
	}));
	const manifest: FeedbackPrivacyManifest = {
		...manifestInput,
		schema: FEEDBACK_EXPORT_SCHEMA,
		count: records.length,
		omittedFields: ['contactEmail', 'displayName', 'username', 'profileImage', 'rawStorageKey'],
		redactionPolicy: 'Direct personal identifiers are omitted; only opaque principal and scope identifiers remain.',
	};
	const markdown = records.map((record) => `## ${record.id}\n\n**${record.type} · ${record.status} · ${record.path}**\n\n${record.message}\n`).join('\n');
	const encode = (value: string) => new TextEncoder().encode(value);
	return [
		{ name: 'manifest.json', bytes: encode(`${JSON.stringify(manifest, null, 2)}\n`) },
		{ name: 'feedback.jsonl', bytes: encode(records.map((record) => JSON.stringify(record)).join('\n') + '\n') },
		{ name: 'feedback.md', bytes: encode(`# Feedback export\n\n${markdown}`) },
	];
}
