import { openSync, closeSync, fstatSync, lstatSync, readSync, readdirSync, constants, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { validRange, satisfies } from 'semver';
import { CanonicalJson, PlatformSchemas, PluginManagementSchemas } from '@treeseed-cordis/sdk';
import { PackageArchiveInspector } from '@treeseed-cordis/deployment';
import { ApiJson } from './json.js';
interface RuntimeStamp { path: string; stat: Stats; file: boolean; }
interface RuntimePackage { kind: 'package'; name: string; version: string; sha256: string; }
export class ApiRuntimeClosure {
    static validate(metadata: ReadonlyMap<string, Readonly<Record<string, unknown>>>): void {
        const pending = ['@treeseed-cordis/api'], visited = new Set<string>();
        while (pending.length) {
            const name = pending.pop()!; if (visited.has(name)) continue; visited.add(name);
            const owner = metadata.get(name); RuntimeFiles.require(owner);
            RuntimeFiles.require(owner.optionalDependencies === undefined || (owner.optionalDependencies && typeof owner.optionalDependencies === 'object' && Object.keys(owner.optionalDependencies).length === 0));
            for (const field of ['dependencies', 'peerDependencies']) {
                const dependencies = owner[field]; if (dependencies === undefined) continue;
                RuntimeFiles.require(dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies));
                for (const [dependency, range] of Object.entries(dependencies)) {
                    RuntimeFiles.require(PlatformSchemas.packageName.safeParse(dependency).success && typeof range === 'string' && validRange(range));
                    const selected = metadata.get(dependency), optional = field === 'peerDependencies' && (owner.peerDependenciesMeta as Record<string, { optional?: unknown }> | undefined)?.[dependency]?.optional === true;
                    if (!selected && optional) continue;
                    RuntimeFiles.require(selected && typeof selected.version === 'string' && satisfies(selected.version, range)); pending.push(dependency);
                }
            }
        }
        RuntimeFiles.require(visited.size === metadata.size);
    }
}
/** Descriptor-anchored reads and a final identity check; never imports installed package code. */
class RuntimeFiles {
    private readonly stamps: RuntimeStamp[] = [];
    constructor(private readonly root?:string){}
    static require(value: unknown): asserts value { if (!value) throw new Error('API_RUNTIME_UNAVAILABLE'); }
    static owner(stat: Stats): void { this.require((stat.uid === 0 || stat.uid === process.getuid?.()) && ((stat.mode & 0o022) === 0 || (stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o1000) !== 0))); }
    private directory(path: string): number {
        RuntimeFiles.require(path.startsWith('/') && resolve(path) === path); let fd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), current = '/';
        try { for (const part of path.split('/')) if (part) { const next = openSync('/proc/self/fd/' + fd + '/' + part, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); closeSync(fd); fd = next; current = join(current, part); const stat = fstatSync(fd); RuntimeFiles.owner(stat); this.stamps.push({ path: current, stat, file:false }); } return fd; } catch (error) { closeSync(fd); throw error; }
    }
    read(path: string, maximum: number): Buffer {
        const parent = this.directory(dirname(path)); let fd = -1;
        try { fd = openSync('/proc/self/fd/' + parent + '/' + path.slice(dirname(path).length + 1), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); const before = fstatSync(fd); RuntimeFiles.owner(before); RuntimeFiles.require(before.isFile() && before.nlink === 1 && before.size <= maximum); const bytes = Buffer.alloc(before.size); let offset = 0; while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); RuntimeFiles.require(count > 0); offset += count; } this.same(before, fstatSync(fd)); this.stamps.push({ path, stat: before, file:true }); return bytes; } finally { if (fd !== -1) closeSync(fd); closeSync(parent); }
    }
    files(path: string, prefix = '', budget = { entries: 0 }): string[] {
        RuntimeFiles.require(prefix.split('/').length <= 64); const fd = this.directory(path), files: string[] = [];
        try { for (const entry of readdirSync('/proc/self/fd/' + fd, { withFileTypes: true })) { RuntimeFiles.require(++budget.entries <= 100000 && !entry.isSymbolicLink()); if (entry.isDirectory()) files.push(...this.files(join(path, entry.name), prefix + entry.name + '/', budget)); else { RuntimeFiles.require(entry.isFile()); files.push(prefix + entry.name); } } return files.sort(); } finally { closeSync(fd); }
    }
    private same(before: Stats, after: Stats, content=true): void { RuntimeFiles.require(!after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.uid === after.uid && (!before.isFile()||after.nlink===1) && (!content||(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs))); }
    verify(): void { for (const item of this.stamps) this.same(item.stat, lstatSync(item.path),item.file||(this.root!==undefined&&(this.root==='/'||item.path===this.root||item.path.startsWith(this.root+'/')))); }
}
export class ApiRuntimeAudit {
    static sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
    static order(a: { name: string }, b: { name: string }): number { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; }
    static assetOrder(a: { package: string; path: string }, b: { package: string; path: string }): number { const left = a.package + ':' + a.path, right = b.package + ':' + b.path; return left < right ? -1 : left > right ? 1 : 0; }
    static archive(path: string, sha256: string): Buffer { const files = new RuntimeFiles(), bytes = files.read(path, 64 * 1024 * 1024); RuntimeFiles.require(this.sha(bytes) === sha256); files.verify(); return bytes; }
    static async inspect(receipt: string, expectedAsset: string): Promise<{ packageSetDigest: string; entryDigest: string }> {
        try {
            const root = dirname(receipt), files = new RuntimeFiles(root), raw = ApiJson.parse(files.read(receipt, 1024 * 1024)) as Record<string, unknown>;
            RuntimeFiles.require(Object.keys(raw).sort().join(',') === 'assetDigest,baseImage,formatVersion,packageDigest,packages' && raw.formatVersion === 2 && PlatformSchemas.imageReference.safeParse(raw.baseImage).success && PlatformSchemas.digest.safeParse(raw.packageDigest).success && raw.assetDigest === expectedAsset && Array.isArray(raw.packages) && raw.packages.length > 0 && raw.packages.length <= 512);
            const packages: RuntimePackage[] = [], names = new Set<string>(), assets: Array<{ package: string; version: string; path: string; sha256: string }> = []; let entryDigest: string | null = null;
            for (const value of raw.packages) { const artifact = PlatformSchemas.resolvedArtifact.parse(value); RuntimeFiles.require(artifact.kind === 'package' && !names.has(artifact.name)); names.add(artifact.name); packages.push(artifact as RuntimePackage); }
            const sorted = [...packages].sort(ApiRuntimeAudit.order); RuntimeFiles.require(CanonicalJson.stringify(sorted) === CanonicalJson.stringify(packages) && CanonicalJson.digest(packages) === raw.packageDigest);
            const expectedArchives: string[] = [], installedFiles: string[] = [], metadata = new Map<string, Readonly<Record<string, unknown>>>(); let measuredBytes = 0;
            for (const item of packages) {
                const archivePath = join(root, 'archives', item.sha256 + '.tgz'), archiveBytes = files.read(archivePath, 64 * 1024 * 1024); RuntimeFiles.require(this.sha(archiveBytes) === item.sha256); expectedArchives.push(item.sha256 + '.tgz');
                const index = await PackageArchiveInspector.inspect(archivePath, item.sha256); RuntimeFiles.require(index.metadata.name === item.name && index.metadata.version === item.version);
                metadata.set(item.name, index.metadata);
                const target = join(root, 'node_modules', item.name), expected: string[] = [], identities = new Map<string, { sha256: string; size: number }>();
                for (const file of index.files) { measuredBytes += file.size; RuntimeFiles.require(measuredBytes <= 256 * 1024 * 1024 && installedFiles.length < 100000); const bytes = files.read(join(target, file.path), 8 * 1024 * 1024), sha256 = this.sha(bytes); RuntimeFiles.require(bytes.length === file.size && sha256 === file.sha256); expected.push(file.path); installedFiles.push(item.name + '/' + file.path); identities.set(file.path, { sha256, size: bytes.length }); if (item.name === '@treeseed-cordis/api' && file.path === 'dist/src/server.js') entryDigest = sha256; }
                RuntimeFiles.require(CanonicalJson.stringify(files.files(target)) === CanonicalJson.stringify(expected.sort()));
                if (index.metadata.cordisPackage !== undefined) { const descriptor = PluginManagementSchemas.packageDescriptor.parse(index.metadata.cordisPackage); RuntimeFiles.require(descriptor.package.name === item.name && descriptor.package.version === item.version); for (const asset of descriptor.assets) { const measured = identities.get(asset.path); RuntimeFiles.require(measured && measured.sha256 === asset.sha256 && measured.size === asset.size && /\.(?:js|css)$/.test(asset.path)); assets.push({ package: item.name, version: item.version, path: asset.path, sha256: measured.sha256 }); } }
            }
            RuntimeFiles.require(entryDigest && CanonicalJson.stringify(files.files(join(root, 'archives'))) === CanonicalJson.stringify(expectedArchives.sort()));
            ApiRuntimeClosure.validate(metadata); RuntimeFiles.require(CanonicalJson.stringify(files.files(join(root, 'node_modules'))) === CanonicalJson.stringify(installedFiles.sort()));
            assets.sort(ApiRuntimeAudit.assetOrder); RuntimeFiles.require(CanonicalJson.digest(assets) === expectedAsset); files.verify(); return { packageSetDigest: CanonicalJson.digest(packages), entryDigest };
        } catch { throw new Error('API_RUNTIME_UNAVAILABLE'); }
    }
}
