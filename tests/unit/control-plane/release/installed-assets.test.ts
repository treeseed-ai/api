import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import ts from 'typescript';

const assets=['treeseed.package.yaml','guarantees/verifiers/golden.verifiers.yaml','tests/acceptance/execution-schema.ts','tests/acceptance/execution-inventory.ts'];
const execute=(command:string,args:string[],cwd=process.cwd(),signal?:AbortSignal,env=process.env):Promise<string>=>new Promise((accept,reject)=>{
 const startedAt=new Date().toISOString(),started=performance.now();
 if(signal?.aborted){reject(new Error('Native archive command interrupted before launch'));return;}
 writeSync(1,JSON.stringify({installedAssetCommand:{command,args,startedAt}})+'\n');
 const child=spawn(command,args,{cwd,env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',size=0,failure:Error|undefined;
 const terminate=()=>{if(child.pid)try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid,'SIGKILL');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')failure??=error as Error;}};
 const abort=()=>{failure??=new Error('Native archive command interrupted');terminate();};
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 for(const [stream,kind] of [[child.stdout,'stdout'],[child.stderr,'stderr']] as const)stream.on('data',(bytes:Buffer)=>{
  size+=bytes.length;if(size>8*1024*1024){failure??=new Error('Native archive command exceeded its original output bound');terminate();return;}
  if(kind==='stdout')stdout+=bytes.toString('utf8');else stderr+=bytes.toString('utf8');
 });
 child.once('error',error=>{failure??=error;terminate();});
 child.once('close',(code,exitSignal)=>{
  signal?.removeEventListener('abort',abort);
  if(code!==0||exitSignal)failure??=new Error(stderr.trim()||`Native archive command failed: ${command} code=${code} signal=${exitSignal}`);
  writeSync(1,JSON.stringify({installedAssetCommand:{command,args,startedAt,completedAt:new Date().toISOString(),elapsedMs:performance.now()-started,
   exitCode:code,signal:exitSignal,status:failure?'failed':'passed'}})+'\n');
  if(failure)reject(failure);else accept(stdout);
 });
});
type Packed={name:string;filename:string;integrity:string;files:Array<{path:string}>};

it('ships the existing selected API definitions and acceptance asset with only published runtime module dependencies',async()=>{
 const [packed]=JSON.parse(await execute('npm',['pack','--dry-run','--ignore-scripts','--json'])) as Packed[];
 expect(packed).toBeDefined();const paths=new Set(packed!.files.map(file=>file.path));
 const source=ts.createSourceFile('execution-schema.ts',readFileSync('tests/acceptance/execution-schema.ts','utf8'),ts.ScriptTarget.Latest,true);
 const privateImports=source.statements.flatMap(statement=>ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)&&statement.moduleSpecifier.text.includes('/src/')?[statement.moduleSpecifier.text]:[]);
 const checkoutCliPaths:string[]=[];const visit=(node:ts.Node)=>{if(ts.isStringLiteral(node)&&node.text.includes('packages/cli/'))checkoutCliPaths.push(node.text);ts.forEachChild(node,visit);};visit(source);
 expect({missing:assets.filter(path=>!paths.has(path)),privateImports,checkoutCliPaths}).toEqual({missing:[],privateImports:[],checkoutCliPaths:[]});
});

it('native production API archive retains exact acceptance bytes and loads its owning published runtime contracts without source or development dependencies',async()=>{
 const root=mkdtempSync(resolve(tmpdir(),'api-installed-assets-')),controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),28_000);
 const run=(command:string,args:string[],cwd=process.cwd(),env=process.env)=>execute(command,args,cwd,controller.signal,env);
 try{
  const archives=JSON.parse(await run('npm',['pack','./node_modules/@treeseed/sdk','.','--ignore-scripts','--json','--pack-destination',root])) as Packed[];
  expect(archives).toHaveLength(2);const sdk=archives.find(value=>value.name==='@treeseed/sdk'),packed=archives.find(value=>value.name==='@treeseed/api');
  expect(sdk).toBeDefined();expect(packed).toBeDefined();const sdkArchive=resolve(root,sdk!.filename),archive=resolve(root,packed!.filename);
  const bytes=readFileSync(archive),sdkBytes=readFileSync(sdkArchive);
  expect(`sha512-${createHash('sha512').update(bytes).digest('base64')}`).toBe(packed!.integrity);
  expect(`sha512-${createHash('sha512').update(sdkBytes).digest('base64')}`).toBe(sdk!.integrity);
  // npm's existing override binds the sole held SDK archive rather than resolving a second Git copy.
  writeFileSync(resolve(root,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{'@treeseed/api':`file:${archive}`,'@treeseed/sdk':`file:${sdkArchive}`},overrides:{'@treeseed/sdk':'$@treeseed/sdk'}}));
  await run('npm',['install','--prefer-offline','--prefix',root,'--omit=dev','--ignore-scripts','--package-lock=false','--no-save','--no-audit','--no-fund',archive,sdkArchive],root);
  const installed=resolve(root,'node_modules/@treeseed/api');expect(realpathSync(installed)).toBe(installed);expect(lstatSync(installed).isSymbolicLink()).toBe(false);
  for(const path of ['src','node_modules/@treeseed/sdk'])expect(existsSync(resolve(installed,path))).toBe(false);
  for(const path of ['vitest','tsx'])expect(existsSync(resolve(root,'node_modules',path)),path).toBe(false);
  const sdkManifest=JSON.parse(readFileSync(resolve(root,'node_modules/@treeseed/sdk/package.json'),'utf8')) as {dependencies:Record<string,string>};
  expect(sdkManifest.dependencies.typescript).toBeDefined();
  await run('npm',['ls','--all','--omit=dev','--json'],root);
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
  const result=await run(process.execPath,['consumer.ts'],root,{...process.env,TREESEED_DIAGNOSTICS_ENCRYPTION_KEY_FILE:''});
  expect(JSON.parse(result)).toEqual({installedRuntimeContracts:'passed'});expect(process.env.TREESEED_DIAGNOSTICS_ENCRYPTION_KEY_FILE).toBe(env);
  expect(readFileSync(archive)).toEqual(bytes);expect(readFileSync(sdkArchive)).toEqual(sdkBytes);
  controller.signal.throwIfAborted();console.log(JSON.stringify({archive:packed!.filename,sha256:createHash('sha256').update(bytes).digest('hex'),sdkSha256:createHash('sha256').update(sdkBytes).digest('hex'),installedRuntimeContracts:'passed'}));
 }finally{clearTimeout(timer);controller.abort();rmSync(root,{recursive:true,force:true});expect(existsSync(root)).toBe(false);}
});

it('native archive command interruption closes its entire owned subprocess group before scoped fixture cleanup without a later passing observation',async()=>{
 const root=mkdtempSync(resolve(tmpdir(),'api-asset-interruption-')),controller=new AbortController();
 const environment=process.env.NODE_TEST_CONTEXT;const pids:number[]=[];
 try{
  writeFileSync(resolve(root,'grandchild.ts'),`import {writeFileSync} from 'node:fs';writeFileSync('grandchild.pid',String(process.pid));setTimeout(()=>writeFileSync('late-write','unauthorized after interruption'),1000);`);
  writeFileSync(resolve(root,'child.ts'),`import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';writeFileSync('child.pid',String(process.pid));spawn(process.execPath,['grandchild.ts'],{stdio:'inherit'});setTimeout(()=>{},1000);`);
  const running=execute(process.execPath,['child.ts'],root,controller.signal);
  const ready=Date.now()+2000;
  while(!existsSync(resolve(root,'grandchild.pid'))){expect(Date.now()).toBeLessThan(ready);await new Promise(accept=>setTimeout(accept,10));}
  for(const file of ['child.pid','grandchild.pid'])pids.push(Number(readFileSync(resolve(root,file),'utf8')));
  controller.abort();await expect(running).rejects.toThrow();
  const closed=Date.now()+2000;
  const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');return false;}};
  while(pids.some(alive)){expect(Date.now()).toBeLessThan(closed);await new Promise(accept=>setTimeout(accept,10));}
  expect(existsSync(resolve(root,'late-write'))).toBe(false);expect(process.env.NODE_TEST_CONTEXT).toBe(environment);
 }finally{
  controller.abort();for(const pid of pids)try{process.kill(pid,'SIGKILL');}catch(error){expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');}
  rmSync(root,{recursive:true,force:true});expect(existsSync(root)).toBe(false);
 }
});

it('native archive commands retain split UTF8 and literal arguments and reject original nonzero or unavailable subprocesses',async()=>{
 const root=mkdtempSync(resolve(tmpdir(),'api-asset-stream-'));
 try{
  writeFileSync(resolve(root,'stream.ts'),`import {writeFileSync} from 'node:fs';writeFileSync('arguments.json',JSON.stringify(process.argv.slice(2)));process.stdout.write(Buffer.from([0xce]));setTimeout(()=>process.stdout.write(Buffer.from([0xbb])),100);`);
  const literal='$(touch unauthorized-command)';
  expect(await execute(process.execPath,['stream.ts',literal],root)).toBe('λ');
  expect(JSON.parse(readFileSync(resolve(root,'arguments.json'),'utf8'))).toEqual([literal]);expect(existsSync(resolve(root,'unauthorized-command'))).toBe(false);
  writeFileSync(resolve(root,'failure.ts'),`process.stderr.write('original subprocess failure');process.exitCode=7;`);
  await expect(execute(process.execPath,['failure.ts'],root)).rejects.toThrow('original subprocess failure');
  await expect(execute(resolve(root,'unavailable-executable'),[],root)).rejects.toThrow(/ENOENT/u);
 }finally{rmSync(root,{recursive:true,force:true});expect(existsSync(root)).toBe(false);}
});
