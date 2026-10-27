import { firefox, type BrowserContext, type Response } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformOperations, type ServicePlan } from '@treeseed-cordis/sdk';
import { ServiceCredentials } from '@treeseed-cordis/deployment';
import {AdminRoutes} from '@treeseed-cordis/admin';
import { ApiJson } from '../../src/json.js';
class BrowserRequest {
    static async read(path: string): Promise<{status:number;value:unknown}> {const response=await fetch(path,{credentials:'same-origin',redirect:'error'});return {status:response.status,value:await response.json()};}
    static async refusedLogout(): Promise<number> {return (await fetch('/admin/logout',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'csrf=invalid'})).status;}
}
class BrowserEvents {readonly errors:string[]=[];failed(error:Error):void{this.errors.push(error.name);}}
/** Real Keycloak/browser fixture only. Secret values stay in memory and the isolated profile. */
export class InstalledApiBrowser {
    private static require(value:unknown):asserts value {if(!value)throw new Error('Genuine installed browser qualification failed');}
    private static command(args:string[]):void {const result=spawnSync('certutil',args,{encoding:'utf8'});this.require(result.status===0);}
    private static logoutResponse(response:Response):boolean{return response.url().endsWith('/admin/logout');}
    static async verify(plan: ServicePlan, authority: Buffer, applicationId:string):Promise<{name:string;value:string}> {
        const directory=mkdtempSync(join(tmpdir(),'cordis-api-browser-'));let browser:BrowserContext|undefined;let stage='prerequisites';
        try {
            const profile=join(directory,'firefox'),ca=join(directory,'authority.pem');mkdirSync(profile,{mode:0o700});writeFileSync(ca,authority,{mode:0o600});this.command(['-N','-d','sql:'+profile,'--empty-password']);this.command(['-A','-n','CordisApiFixture','-t','C,,','-i',ca,'-d','sql:'+profile]);
            browser=await firefox.launchPersistentContext(profile,{headless:true,ignoreHTTPSErrors:false});const page=await browser.newPage(),events=new BrowserEvents();page.on('pageerror',events.failed.bind(events));
            const origin=plan.configuration.origin,secret=new ServiceCredentials(plan).read('issuer-main','secret://issuer-main/bootstrap'),credential=ApiJson.parse(secret) as {username:string;password:string};this.require(credential.username==='admin'&&typeof credential.password==='string'&&credential.password.length>=32);
            stage='login';await page.goto(origin+'/admin');await page.locator('#username').fill(credential.username);await page.locator('#password').fill(credential.password);await page.getByRole('button',{name:'Sign In',exact:true}).click();await page.waitForURL(origin+'/admin');
            stage='session';const cookies=await browser.cookies(origin);let session:{name:string;value:string}|undefined;for(const cookie of cookies)if(cookie.name===AdminRoutes.sessionCookieName(plan.configuration)){this.require(cookie.secure&&cookie.httpOnly&&cookie.sameSite==='Lax'&&cookie.path==='/');session={name:cookie.name,value:cookie.value};}this.require(session);
            stage='status';const status=await page.evaluate(BrowserRequest.read,'/v1/platform/status');this.require(status.status===200);const parsed=PlatformOperations.status.parseOutput(status.value);this.require('formatVersion' in parsed&&parsed.formatVersion===3&&parsed.ready&&parsed.activeComposition===plan.compositionGeneration);
            stage='application';const record=await page.evaluate(BrowserRequest.read,'/v1/platform/applications/'+applicationId);this.require(record.status===200);const projected=PlatformOperations.get.parseOutput(record.value);this.require(projected.id===applicationId&&projected.result==='ready'&&projected.activeComposition===plan.compositionGeneration&&!JSON.stringify(record.value).includes('idempotencyKey'));
            stage='refresh';this.require(events.errors.length===0&&!(await page.content()).includes(credential.password));await page.getByRole('button',{name:'Refresh status'}).click();await page.getByRole('cell',{name:'api-main',exact:true}).waitFor();
            stage='responsive';for(const width of [320,375,768,1024,1440,1920,2560]){await page.setViewportSize({width,height:900});const bounds=await page.getByRole('button',{name:'Sign out'}).boundingBox();this.require(bounds&&bounds.width>=44&&bounds.height>=44);}
            stage='logout';this.require(await page.evaluate(BrowserRequest.refusedLogout)===403);const loggedOut=page.waitForResponse(this.logoutResponse);await page.getByRole('button',{name:'Sign out'}).click();const response=await loggedOut;this.require(response.status()===200&&(await response.json()).success===true&&events.errors.length===0);return session;
        } catch {throw new Error('Genuine installed browser qualification failed at '+stage);} finally {await browser?.close();rmSync(directory,{recursive:true,force:true});}
    }
}
