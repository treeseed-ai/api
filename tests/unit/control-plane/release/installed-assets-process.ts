import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';

export const execute=(command:string,args:string[],cwd=process.cwd(),signal?:AbortSignal,env=process.env):Promise<string>=>new Promise((accept,reject)=>{
 const startedAt=new Date().toISOString(),started=performance.now();
 if(signal?.aborted){reject(new Error('Native archive command interrupted before launch'));return;}
 writeSync(1,JSON.stringify({installedAssetCommand:{command,args,startedAt}})+'\n');
 const child=spawn(command,args,{cwd,env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',size=0,failure:Error|undefined;
 const terminate=()=>{if(child.pid)try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid,'SIGKILL');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')failure??=error as Error;}};
 const abort=()=>{failure??=new Error('Native archive command interrupted');terminate();};
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 for(const [stream,kind] of [[child.stdout,'stdout'],[child.stderr,'stderr']] as const)stream.setEncoding('utf8').on('data',(text:string)=>{
  size+=Buffer.byteLength(text,'utf8');if(size>8*1024*1024){failure??=new Error('Native archive command exceeded its original output bound');terminate();return;}
  if(kind==='stdout')stdout+=text;else stderr+=text;
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
