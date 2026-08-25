type ZipEntry = { path: string; bytes: Uint8Array };

const encoder = new TextEncoder();
const crcTable = Array.from({ length: 256 }, (_unused, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	return value >>> 0;
});

function crc32(bytes: Uint8Array) {
	let value = 0xffffffff;
	for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
	return (value ^ 0xffffffff) >>> 0;
}

function integerBytes(value: number, size: 2 | 4) {
	const bytes = new Uint8Array(size);
	const view = new DataView(bytes.buffer);
	if (size === 2) view.setUint16(0, value, true);
	else view.setUint32(0, value, true);
	return bytes;
}

function join(parts: Uint8Array[]) {
	const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}

function safePath(path: string) {
	const normalized = path.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '');
	if (!normalized || normalized.split('/').includes('..')) throw new Error(`Unsafe knowledge-pack path: ${path}`);
	return normalized;
}

export function createDeterministicZip(entries: ZipEntry[]) {
	const local: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
		const name = encoder.encode(safePath(entry.path));
		const checksum = crc32(entry.bytes);
		const u16 = (value: number) => integerBytes(value, 2);
		const u32 = (value: number) => integerBytes(value, 4);
		const localHeader = join([
			u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
			u32(checksum), u32(entry.bytes.length), u32(entry.bytes.length), u16(name.length), u16(0), name,
		]);
		local.push(localHeader, entry.bytes);
		central.push(join([
			u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
			u32(checksum), u32(entry.bytes.length), u32(entry.bytes.length), u16(name.length), u16(0),
			u16(0), u16(0), u16(0), u32(0), u32(offset), name,
		]));
		offset += localHeader.length + entry.bytes.length;
	}
	const u16 = (value: number) => integerBytes(value, 2);
	const u32 = (value: number) => integerBytes(value, 4);
	const centralBytes = join(central);
	return join([...local, centralBytes, u32(0x06054b50), u16(0), u16(0), u16(entries.length),
		u16(entries.length), u32(centralBytes.length), u32(offset), u16(0)]);
}
