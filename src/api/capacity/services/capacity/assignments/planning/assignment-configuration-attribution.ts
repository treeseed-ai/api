import { createHash } from 'node:crypto';

type JsonRecord=Record<string,unknown>;
function record(value:unknown):JsonRecord{return value&&typeof value==='object'&&!Array.isArray(value)?value as JsonRecord:{};}
function text(value:unknown,fallback=''){return typeof value==='string'&&value.trim()?value.trim():fallback;}
function digest(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}

export function assignmentConfigurationAttribution(input:{payload:JsonRecord;projectAgentClassId:string;activityType:string;handlerId:string;contentBaseRef:string;executionProvider?:JsonRecord|null}){
	const groupIds=Array.isArray(input.payload.groupIds)?input.payload.groupIds.map(String).filter(Boolean):[];
	const planningGraph=record(input.payload.planningGraph);const agentDefinition=record(input.payload.agentDefinition);
	const activity={activityType:input.activityType,handlerId:input.handlerId,contextQueryRefs:input.payload.contextQueryRefs,instructionTemplateRefs:input.payload.instructionTemplateRefs,permissions:input.payload.permissions,toolPolicy:input.payload.toolPolicy,signalPolicy:input.payload.signalPolicy,outputContract:input.payload.outputContract};
	const executionProvider=input.executionProvider??{};
	return {groupIds,configurationRevisions:{planningGraphRevision:text(planningGraph.revision)||null,agentDefinitionRevision:text(agentDefinition.immutableRef,input.contentBaseRef)||null,agentClassRevision:digest({projectAgentClassId:input.projectAgentClassId,agentDefinition,groupIds,activity}),activityProfileRevision:digest(activity),handlerRevision:text(input.payload.handlerRevision)||digest({handlerId:input.handlerId,activityType:input.activityType}),groupMembershipRevision:digest(groupIds),executionProviderConfigurationRevision:text(executionProvider.configurationRevision,text(record(executionProvider.metadata).configurationRevision))||null}};
}
