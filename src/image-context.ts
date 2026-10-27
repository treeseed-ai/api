import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CanonicalJson, PlatformSchemas, PluginManagementSchemas } from '@treeseed-cordis/sdk';
import { PackageArchiveInspector, PackageArchiveMaterializer } from '@treeseed-cordis/deployment';
import { ApiRuntimeAudit, ApiRuntimeClosure } from './runtime-audit.js';
export interface ApiRuntimePackageSource { name: string; version: string; path: string; sha256: string; }
export class ApiImageContext {
    private static require(value: unknown): asserts value { if (!value) throw new Error('API_IMAGE_CONTEXT_UNAVAILABLE'); }
    static async prepare(directory: string, baseImage: string, sources: readonly ApiRuntimePackageSource[]): Promise<{ packageDigest: string; assetDigest: string; entryDigest: string }> {
        this.require(directory.startsWith('/') && resolve(directory) === directory && PlatformSchemas.imageReference.safeParse(baseImage).success && sources.length > 0 && sources.length <= 512);
        let current = directory; while (true) { this.require(!lstatSync(current).isSymbolicLink()); const parent = dirname(current); if (parent === current) break; current = parent; }
        const before = lstatSync(directory); this.require(before.isDirectory() && before.uid === process.getuid?.() && (before.mode & 0o777) === 0o700 && readdirSync(directory).length === 0);
        const runtime = join(directory, 'runtime'), modules = join(runtime, 'node_modules'), archives = join(runtime, 'archives'); mkdirSync(runtime, { mode: 0o755 }); mkdirSync(modules, { mode: 0o755 }); mkdirSync(archives, { mode: 0o755 });
        const artifacts = [], metadata = new Map<string, Readonly<Record<string, unknown>>>(), assets: Array<{ package: string; version: string; path: string; sha256: string }> = [];
        for (const item of [...sources].sort(ApiRuntimeAudit.order)) {
            PlatformSchemas.packageName.parse(item.name); PlatformSchemas.version.parse(item.version); PlatformSchemas.digest.parse(item.sha256); this.require(!metadata.has(item.name));
            const index = await PackageArchiveInspector.inspect(item.path, item.sha256); this.require(index.metadata.name === item.name && index.metadata.version === item.version); metadata.set(item.name, index.metadata);
            const retained = join(archives, item.sha256 + '.tgz'); writeFileSync(retained, ApiRuntimeAudit.archive(item.path, item.sha256), { flag: 'wx', mode: 0o644 });
            const target = join(modules, item.name); if (item.name.startsWith('@')) { const scope = dirname(target); try { mkdirSync(scope, { mode: 0o755 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; this.require(lstatSync(scope).isDirectory() && !lstatSync(scope).isSymbolicLink()); } }
            mkdirSync(target, { mode: 0o700 }); await PackageArchiveMaterializer.materialize(retained, item.sha256, target); artifacts.push({ kind: 'package', name: item.name, version: item.version, sha256: item.sha256 });
            if (index.metadata.cordisPackage !== undefined) { const descriptor = PluginManagementSchemas.packageDescriptor.parse(index.metadata.cordisPackage); this.require(descriptor.package.name === item.name && descriptor.package.version === item.version); for (const asset of descriptor.assets) { const bytes = readFileSync(join(target, asset.path)); this.require(bytes.length === asset.size && ApiRuntimeAudit.sha(bytes) === asset.sha256); assets.push({ package: item.name, version: item.version, path: asset.path, sha256: asset.sha256 }); } }
        }
        ApiRuntimeClosure.validate(metadata); assets.sort(ApiRuntimeAudit.assetOrder);
        const packageDigest = CanonicalJson.digest(artifacts), assetDigest = CanonicalJson.digest(assets), receipt = join(runtime, 'cordis-runtime.json');
        writeFileSync(receipt, CanonicalJson.stringify({ formatVersion: 2, baseImage, packageDigest, assetDigest, packages: artifacts }) + '\n', { mode: 0o644, flag: 'wx' });
        const measured = await ApiRuntimeAudit.inspect(receipt, assetDigest); this.require(measured.packageSetDigest === packageDigest);
        const dockerfile = 'FROM ' + baseImage + '\nWORKDIR /app\nCOPY runtime/ /app/\nLABEL ai.treeseed.cordis.package-set="' + packageDigest + '" ai.treeseed.cordis.admin-asset="' + assetDigest + '" ai.treeseed.cordis.runtime-entry="' + measured.entryDigest + '"\nENTRYPOINT ["node","/app/node_modules/@treeseed-cordis/api/dist/src/server.js"]\nCMD ["--serve","--configuration","/run/secrets/api-config"]\n';
        writeFileSync(join(directory, 'Dockerfile'), dockerfile, { mode: 0o600, flag: 'wx' }); const after = lstatSync(directory); this.require(after.isDirectory() && !after.isSymbolicLink() && after.ino === before.ino && after.dev === before.dev && after.uid === before.uid && after.mode === before.mode);
        return { packageDigest, assetDigest, entryDigest: measured.entryDigest };
    }
}
