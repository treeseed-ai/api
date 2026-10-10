import { expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execute } from './installed-assets-process.ts';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

it('native unchanged owning Vitest configuration finishes archive ownership before retaining simultaneous database workers and complete reports', async () => {
 const root=mkdtempSync(resolve(tmpdir(),'api-suite-resource-')),reportPath=resolve(root,'report.json');let originalFailure:unknown;
 try {
  copyFileSync('vitest.control-plane.config.ts',resolve(root,'vitest.control-plane.config.ts'));
  writeFileSync(resolve(root,'package.json'),JSON.stringify({type:'module'}));
  symlinkSync(resolve('node_modules'),resolve(root,'node_modules'),'dir');
  const archive=resolve(root,'tests/unit/control-plane/release/installed-assets.test.ts');mkdirSync(dirname(archive),{recursive:true});
  writeFileSync(archive,`import{it,expect}from'vitest';import{existsSync,writeFileSync}from'node:fs';
it('native archive ownership',async()=>{expect(existsSync('left.active')).toBe(false);expect(existsSync('right.active')).toBe(false);writeFileSync('archive.active','original');await new Promise(resolve=>setTimeout(resolve,300));expect(existsSync('left.active')).toBe(false);expect(existsSync('right.active')).toBe(false);writeFileSync('archive.closed','complete');});`);
  for(const [name,other] of [['left','right'],['right','left']]) {
   writeFileSync(resolve(root,`tests/unit/control-plane/${name}.test.ts`),`import{it,expect}from'vitest';import{existsSync,writeFileSync}from'node:fs';
it('native ${name} database worker',async()=>{expect(existsSync('archive.closed'),'archive must finish before database work').toBe(true);writeFileSync('${name}.active','original');const deadline=Date.now()+2000;while(!existsSync('${other}.active')){expect(Date.now(),'both original workers remain simultaneous').toBeLessThan(deadline);await new Promise(resolve=>setTimeout(resolve,10));}});`);
  }
  await execute(process.execPath,[resolve('node_modules/vitest/vitest.mjs'),'run','--config','vitest.control-plane.config.ts','--reporter=json',`--outputFile=${reportPath}`],
   root,AbortSignal.timeout(8_000),{...process.env,TREESEED_SDK_SOURCE_ROOT:''});
  const report=JSON.parse(readFileSync(reportPath,'utf8'));
  expect(report).toMatchObject({success:true,numTotalTests:3,numPassedTests:3,numFailedTests:0,numPendingTests:0,numTodoTests:0});
  const assertions=report.testResults.flatMap((file:{assertionResults:Array<{title:string;status:string}>})=>file.assertionResults);
  expect(assertions.map((row:{title:string})=>row.title).sort()).toEqual(['native archive ownership','native left database worker','native right database worker']);
  expect(assertions.every((row:{status:string})=>row.status==='passed')).toBe(true);
  expect(readFileSync(resolve(root,'archive.closed'),'utf8')).toBe('complete');
 } catch(error) {originalFailure=error;throw error;} finally {
  try {
   if(existsSync(reportPath)) {
    const observed=JSON.parse(readFileSync(reportPath,'utf8'));
    console.info(JSON.stringify({nativeSuiteResourceObservation:{success:observed.success,total:observed.numTotalTests,passed:observed.numPassedTests,failed:observed.numFailedTests,
     assertions:observed.testResults.flatMap((file:{assertionResults:Array<{title:string;status:string;duration:number}>})=>file.assertionResults.map(({title,status,duration})=>({title,status,duration})))}}));
   }
  } catch(observationFailure) {
   originalFailure=originalFailure?new AggregateError([originalFailure,observationFailure],'Native resource failure and observation both failed'):observationFailure;throw originalFailure;
  } finally {
   try {rmSync(root,{recursive:true,force:true});expect(existsSync(root)).toBe(false);}
   catch(cleanupFailure) {throw originalFailure?new AggregateError([originalFailure,cleanupFailure],'Native resource proof and scoped cleanup both failed'):cleanupFailure;}
  }
 }
});
