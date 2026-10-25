import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync } from 'node:fs';
import {parse} from 'jsonc-parser';
import {PackageArchiveInspector} from '@treeseed-cordis/deployment';
import {CanonicalJson} from '@treeseed-cordis/sdk';
import { join } from 'node:path';
import { InstalledApiFixture } from './installed-root-fixture.js';
class InstalledApiTests {
    private async lockDifference(bundle:string):Promise<string>{
        const lock=parse(readFileSync(join(bundle,'bun.lock'),'utf8'),[],{allowTrailingComma:true}) as {packages:Record<string,unknown[]>},release=JSON.parse(readFileSync(join(bundle,'release.json'),'utf8')) as {packages:Array<{name:string;path:string;sha256:string}>},inventory=new Set<string>(),extra:string[]=[],missing:string[]=[],metadata:unknown[]=[];
        for(const item of release.packages){inventory.add(item.name);const record=lock.packages[item.name];if(record){const index=await PackageArchiveInspector.inspect(join(bundle,item.path),item.sha256),locked=record[record.length===3?1:2] as Record<string,unknown>;for(const field of ['dependencies','peerDependencies'])if(CanonicalJson.stringify(index.metadata[field]??{})!==CanonicalJson.stringify(locked[field]??{}))metadata.push({name:item.name,field,declared:index.metadata[field],locked:locked[field]});const expected=Object.keys(index.metadata.peerDependenciesMeta as object??{}).sort();if(CanonicalJson.stringify(expected)!==CanonicalJson.stringify(locked.optionalPeers??[]))metadata.push({name:item.name,field:'optionalPeers',declared:expected,locked:locked.optionalPeers});}}
        for(const name of Object.keys(lock.packages))if(!inventory.has(name))extra.push(name);for(const name of inventory)if(!Object.hasOwn(lock.packages,name))missing.push(name);return '\nFixture lock difference '+JSON.stringify({extra,missing,metadata});
    }
    async program(): Promise<void> {
        const fixture = new InstalledApiFixture();
        try {
            await fixture.prepared(); const file = join(fixture.root, 'api-configuration.json'); writeFileSync(file, JSON.stringify(fixture.configuration));
            const result = spawnSync('node', ['dist/tests/installed-root-program.js', file], { encoding: 'utf8', timeout: 240000, maxBuffer: 4 * 1024 * 1024 });
            if (result.status !== 0) throw new Error(result.stderr+await this.lockDifference(fixture.bundle)); expect(result.stderr).toBe('');
            expect(JSON.parse(result.stdout)).toEqual({ fixtureOnly: true, genuineKeycloak: true, nativeApi: true, publicTls: true, unauthenticatedDenied: true, assetsVerified: true, sourceFree: true, retained: true });
        } finally { fixture.close(); }
    }
}
const installedApi = new InstalledApiTests();
test('smoke: genuine packed API default root composes typed database Keycloak and edge with measured assets and retained host state', installedApi.program.bind(installedApi), 600000);
