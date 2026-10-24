import {Service} from 'cordis';
import {readFileSync,writeFileSync} from 'node:fs';
import {InstalledSchemas,InstalledDeclarations,InstalledTokens,PlatformSchemas,type ContainerEngine,type ReadyContainer,type ProviderDeclaration} from '@treeseed-cordis/sdk';
import {Context} from '@treeseed-cordis/sdk/runtime';
export class NodeApiContainerPlugin implements ReadyContainer {
 static readonly declaration=InstalledDeclarations.service('node-api','container.api',['deployment.engine','container.database','container.identity']);
 static readonly definition=InstalledSchemas.definition.parse({role:'api',service:{command:['--serve','--configuration','/run/secrets/api-config'],user:'installation-owner',workerSocket:true,volumes:[],secrets:[{source:'api-config',target:'/run/secrets/api-config'}],portTarget:null},slots:{'api-config':{kind:'json',value:{installationId:{$installationId:true},origin:{$origin:''},issuer:{$origin:'/identity/realms/cordis'},identityInternalOrigin:'http://identity:8080',clientId:'cordis-admin',clientSecret:{$secret:'oidc-client'},databaseUrl:{$template:['postgresql://cordis:',{$secret:'database-password'},'@database:5432/cordis']},bootstrapSubject:{$secret:'bootstrap-subject'},workerSocket:'/run/cordis-host/worker.sock',assetDigest:{$assetDigest:true}}}},readiness:{kind:'http-json',path:'/health/ready',expected:{ready:true,installationId:{$installationId:true},assetDigest:{$assetDigest:true},nativeComposition:true}}});
 static readonly provide=this.declaration.provide;static readonly inject=this.declaration.inject;static readonly Config=PlatformSchemas.empty;
 private readonly engine:ContainerEngine;
 constructor(private readonly context:Context){this.engine=InstalledTokens.engine.parse(Reflect.get(context,InstalledTokens.engine.id));}
 async [Service.init]():Promise<void>{await this.engine.start('api',NodeApiContainerPlugin.definition);if(!await this.ready())throw new Error('API readiness failed');this.context.provide(InstalledTokens.api.id,this);}
 identity():Readonly<{installationId:string;composition:string}>{return this.engine.identity();}
 ready():Promise<boolean>{return this.engine.ready('api');}
}
export {NodeApiContainerPlugin as Provider};
export class ApiContainerBuild {
 static metadata():ProviderDeclaration{return NodeApiContainerPlugin.declaration;}
 static run():void{if(!import.meta.main)return;if(process.argv[2]==='--metadata'){const metadata=JSON.parse(readFileSync('package.json','utf8')) as Record<string,unknown>;metadata.cordis=this.metadata();metadata.cordisService=NodeApiContainerPlugin.definition;writeFileSync('package.json',JSON.stringify(metadata,null,2)+'\n');}else if(process.argv[2]==='--describe')process.stdout.write(JSON.stringify(this.metadata())+'\n');else{process.stderr.write('Unsupported API container program invocation.\n');process.exitCode=2;}}
}
ApiContainerBuild.run();
