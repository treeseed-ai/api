import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse, type ParseError } from 'jsonc-parser';
import { PlatformSchemas } from '@treeseed-cordis/sdk';
import { PackageArchiveInspector } from '@treeseed-cordis/deployment';
import { ApiJson } from '../src/json.js';
import { ApiRuntimeClosure } from '../src/runtime-audit.js';
export interface PreparedApiPackage { name: string; version: string; path: string; sha256: string; }
/** Test-only producer: public exact archives, no package imports or lifecycle execution. */
export class PreparedApiPackages {
    private readonly metadata = new Map<string, Readonly<Record<string, unknown>>>(); private readonly selected = new Map<string, PreparedApiPackage>();
    private readonly lock: Record<string, unknown[]>;
    private readonly cache = '/tmp/cordis-task3c-api-fixture-cache';
    constructor(private readonly destination: string) {
        const errors: ParseError[] = [], lock = parse(readFileSync('bun.lock', 'utf8'), errors, { allowTrailingComma: true }) as { lockfileVersion: number; packages: Record<string, unknown[]> };
        this.require(errors.length === 0 && lock.lockfileVersion === 2); this.lock = lock.packages; mkdirSync(this.cache, { recursive: true, mode: 0o700 }); const stat = lstatSync(this.cache); this.require(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700);
    }
    private require(value: unknown): asserts value { if (!value) throw new Error('API_FIXTURE_PACKAGE_UNAVAILABLE'); }
    private sha(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }
    private async inspect(path: string): Promise<PreparedApiPackage> { const sha256 = this.sha(readFileSync(path)), index = await PackageArchiveInspector.inspect(path, sha256), name = PlatformSchemas.packageName.parse(index.metadata.name), version = PlatformSchemas.version.parse(index.metadata.version); this.require(!this.selected.has(name)); const item = { name, version, path, sha256 }; this.selected.set(name, item); this.metadata.set(name, index.metadata); return item; }
    async prepare(): Promise<PreparedApiPackage[]> {
        const packed = spawnSync('bun', ['pm', 'pack', '--destination', this.destination], { encoding: 'utf8', timeout: 30000 }); this.require(packed.status === 0);
        const own = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }, api = join(this.destination, 'treeseed-cordis-api-' + own.version + '.tgz'); await this.inspect(api);
        for (const owner of ['sdk', 'deployment', 'identity', 'admin', 'ui']) { const target = join(this.destination, owner + '.tgz'); copyFileSync(resolve('vendor', owner + '.tgz'), target); await this.inspect(target); }
        const pending = ['@treeseed-cordis/api'], visited = new Set<string>();
        while (pending.length) {
            const name = pending.pop()!; if (visited.has(name)) continue; visited.add(name); if (!this.metadata.has(name)) await this.registry(name); const metadata = this.metadata.get(name)!;
            for (const field of ['dependencies', 'peerDependencies']) { const dependencies = metadata[field] as Record<string, unknown> | undefined; if (!dependencies) continue; for (const dependency of Object.keys(dependencies)) { PlatformSchemas.packageName.parse(dependency); const optional = field === 'peerDependencies' && (metadata.peerDependenciesMeta as Record<string, { optional?: boolean }> | undefined)?.[dependency]?.optional; if (optional && !this.metadata.has(dependency)) continue; pending.push(dependency); } }
        }
        ApiRuntimeClosure.validate(this.metadata); this.require(visited.size === this.metadata.size); return [...this.selected.values()].sort(PreparedApiPackages.order);
    }
    private static order(a: PreparedApiPackage, b: PreparedApiPackage): number { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; }
    private async body(response: Response, maximum: number): Promise<Buffer> { this.require(response.ok && response.body); const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0; try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; this.require(size <= maximum); chunks.push(next.value); } return Buffer.concat(chunks); } finally { await reader.cancel(); reader.releaseLock(); } }
    private async registry(name: string): Promise<void> {
        const record = this.lock[name]; this.require(record && typeof record[0] === 'string' && record[0].startsWith(name + '@')); const version = record[0].slice(name.length + 1), sri = record.at(-1); PlatformSchemas.version.parse(version); this.require(typeof sri === 'string' && /^sha512-[A-Za-z0-9+/]+=*$/.test(sri)); const path = join(this.cache, this.sha(name + '@' + version) + '.tgz');
        if (!existsSync(path)) { const metadataResponse = await fetch('https://registry.npmjs.org/' + encodeURIComponent(name) + '/' + encodeURIComponent(version), { redirect: 'error', signal: AbortSignal.timeout(30000) }), metadata = ApiJson.parse(await this.body(metadataResponse, 1024 * 1024)) as { name: string; version: string; dist: { integrity: string; tarball: string } }; this.require(metadata.name === name && metadata.version === version && metadata.dist.integrity === sri); const url = new URL(metadata.dist.tarball); this.require(url.protocol === 'https:' && url.hostname === 'registry.npmjs.org' && !url.port && !url.username && !url.password); const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) }), bytes = await this.body(response, 64 * 1024 * 1024); this.require('sha512-' + createHash('sha512').update(bytes).digest('base64') === sri); writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); }
        const bytes = readFileSync(path); this.require('sha512-' + createHash('sha512').update(bytes).digest('base64') === sri); const target = join(this.destination, this.sha(name + '@' + version) + '.tgz'); copyFileSync(path, target); let selected:PreparedApiPackage;try{selected=await this.inspect(target);}catch{throw new Error('API_FIXTURE_ARCHIVE_INVALID '+name+'@'+version);}this.require(selected.name === name && selected.version === version);
    }
}
