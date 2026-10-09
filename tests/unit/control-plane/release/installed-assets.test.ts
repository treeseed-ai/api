import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import ts from 'typescript';

const assets=['treeseed.package.yaml','guarantees/verifiers/golden.verifiers.yaml','tests/acceptance/execution-schema.ts','tests/acceptance/execution-inventory.ts'];
const execute=async(command:string,args:string[],cwd=process.cwd())=>(await promisify(execFile)(command,args,{cwd,encoding:'utf8',maxBuffer:8*1024*1024})).stdout;
type Packed={filename:string;integrity:string;files:Array<{path:string}>};

it('ships the existing selected API definitions and acceptance asset with only published runtime module dependencies',async()=>{
 const [packed]=JSON.parse(await execute('npm',['pack','--dry-run','--ignore-scripts','--json'])) as Packed[];
 expect(packed).toBeDefined();const paths=new Set(packed!.files.map(file=>file.path));
 const source=ts.createSourceFile('execution-schema.ts',readFileSync('tests/acceptance/execution-schema.ts','utf8'),ts.ScriptTarget.Latest,true);
 const privateImports=source.statements.flatMap(statement=>ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)&&statement.moduleSpecifier.text.includes('/src/')?[statement.moduleSpecifier.text]:[]);
 const checkoutCliPaths:string[]=[];const visit=(node:ts.Node)=>{if(ts.isStringLiteral(node)&&node.text.includes('packages/cli/'))checkoutCliPaths.push(node.text);ts.forEachChild(node,visit);};visit(source);
 expect({missing:assets.filter(path=>!paths.has(path)),privateImports,checkoutCliPaths}).toEqual({missing:[],privateImports:[],checkoutCliPaths:[]});
});

it('native production API archive retains exact acceptance bytes and loads its owning published runtime contracts without source or development dependencies',async()=>{
 const root=mkdtempSync(resolve(tmpdir(),'api-installed-assets-'));
 try{
  const [sdk]=JSON.parse(await execute('npm',['pack','./node_modules/@treeseed/sdk','--ignore-scripts','--json','--pack-destination',root])) as Packed[];
  const [packed]=JSON.parse(await execute('npm',['pack','--ignore-scripts','--json','--pack-destination',root])) as Packed[];
  expect(sdk).toBeDefined();expect(packed).toBeDefined();const sdkArchive=resolve(root,sdk!.filename),archive=resolve(root,packed!.filename);
  const bytes=readFileSync(archive),sdkBytes=readFileSync(sdkArchive);
  expect(`sha512-${createHash('sha512').update(bytes).digest('base64')}`).toBe(packed!.integrity);
  expect(`sha512-${createHash('sha512').update(sdkBytes).digest('base64')}`).toBe(sdk!.integrity);
  // npm's existing override binds the sole held SDK archive rather than resolving a second Git copy.
  writeFileSync(resolve(root,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{'@treeseed/api':`file:${archive}`,'@treeseed/sdk':`file:${sdkArchive}`},overrides:{'@treeseed/sdk':'$@treeseed/sdk'}}));
  await execute('npm',['install','--prefix',root,'--omit=dev','--ignore-scripts','--package-lock=false','--no-save','--no-audit','--no-fund',archive,sdkArchive],root);
  const installed=resolve(root,'node_modules/@treeseed/api');expect(realpathSync(installed)).toBe(installed);expect(lstatSync(installed).isSymbolicLink()).toBe(false);
  for(const path of ['src','node_modules/@treeseed/sdk'])expect(existsSync(resolve(installed,path))).toBe(false);
  for(const path of ['vitest','tsx'])expect(existsSync(resolve(root,'node_modules',path)),path).toBe(false);
  const sdkManifest=JSON.parse(readFileSync(resolve(root,'node_modules/@treeseed/sdk/package.json'),'utf8')) as {dependencies:Record<string,string>};
  expect(sdkManifest.dependencies.typescript).toBeDefined();
  await execute('npm',['ls','--all','--omit=dev','--json'],root);
  for(const path of assets)expect(readFileSync(resolve(installed,path)),path).toEqual(readFileSync(path));
  writeFileSync(resolve(root,'consumer.ts'),`import assert from 'node:assert/strict';
import {resolveApiDatabaseUrl} from './node_modules/@treeseed/api/dist/api/configuration/runtime-config.js';
import {verifyDatabaseMigrations} from './node_modules/@treeseed/api/dist/api/support/verify-database-migrations.js';
import {createDiagnosticEnvelopeService} from './node_modules/@treeseed/api/dist/security/diagnostic-envelope.js';
assert.equal(resolveApiDatabaseUrl({TREESEED_DATABASE_URL:'postgres://native:isolated@127.0.0.1/native'}),'postgres://native:isolated@127.0.0.1/native');
assert.throws(()=>resolveApiDatabaseUrl({TREESEED_DATABASE_URL:'postgres://native:isolated@127.0.0.1/native',TREESEED_DATABASE_URL_FILE:'/unavailable'}));
assert.throws(()=>createDiagnosticEnvelopeService({}));assert.equal(typeof verifyDatabaseMigrations,'function');
console.log(JSON.stringify({installedRuntimeContracts:'passed'}));\n`);
  const env=process.env.TREESEED_DIAGNOSTICS_ENCRYPTION_KEY_FILE;
  // The consumer denies absent custody; it never receives a host credential path.
  const result=await promisify(execFile)(process.execPath,['consumer.ts'],{cwd:root,encoding:'utf8',env:{...process.env,TREESEED_DIAGNOSTICS_ENCRYPTION_KEY_FILE:''}});
  expect(JSON.parse(result.stdout)).toEqual({installedRuntimeContracts:'passed'});expect(process.env.TREESEED_DIAGNOSTICS_ENCRYPTION_KEY_FILE).toBe(env);
  expect(readFileSync(archive)).toEqual(bytes);expect(readFileSync(sdkArchive)).toEqual(sdkBytes);
  console.log(JSON.stringify({archive:packed!.filename,sha256:createHash('sha256').update(bytes).digest('hex'),sdkSha256:createHash('sha256').update(sdkBytes).digest('hex'),installedRuntimeContracts:'passed'}));
 }finally{rmSync(root,{recursive:true,force:true});expect(existsSync(root)).toBe(false);}
});
