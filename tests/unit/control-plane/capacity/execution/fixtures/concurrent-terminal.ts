import {assignment as completeAssignment} from './assignment.ts';
import {assignmentAttemptSchema,type ExecutionNode} from '@treeseed/sdk/agent-capacity';

/** Complete controlled inputs for the original five-result native SQL case. */
export function concurrentTerminalNodes(sourceRef:ExecutionNode['sourceRef']):ExecutionNode[]{
 return Array.from({ length: 5 }, (_, index) => ({
				schemaVersion: 'treeseed.execution-node/v1', id: `node-${index}`, teamId: 'team', projectId: 'project',
				kind: 'planning', pairRole: null, sourceRef, authorityRefs: [], ruleRevision: 1, nodeRevision: 1,
				estimate: completeAssignment.estimate, requiredCapabilities: ['treeseed.coordination.planning'],
				requestedPermissions: { content: { read: ['proposal'], write: [] }, tools: ['source.read'] }, workspace: 'read-only',
				agentClass: 'engineer', status: 'running', graphRevisionCreated: 1, graphRevisionUpdated: 1,
			}))
}
export function concurrentTerminalAttempt(node:ExecutionNode,now:string){
 const sourceRef=node.sourceRef;return assignmentAttemptSchema.parse({...completeAssignment,
				id:'assignment-'+node.id,idempotencyKey:'assignment-'+node.id,nodeId:node.id,workdayId:'terminal-workday',graphRevision:1,nodeRevision:1,
				sourceRef,authorityRefs:[],requiredCapabilities:node.requiredCapabilities,estimate:node.estimate,
				effectiveProfile:{...completeAssignment.effectiveProfile,activity:'planning',permissionCeiling:node.requestedPermissions},
				workspace:{mode:'read-only'},grant:{...completeAssignment.grant,contentRead:[sourceRef],sourceWrite:[],tools:['source.read']},contextRefs:[sourceRef],
				reservationId:'reservation-'+node.id,createdAt:now,deadline:new Date(Date.parse(now)+Date.parse(completeAssignment.deadline)-Date.parse(completeAssignment.createdAt)).toISOString()};
}
