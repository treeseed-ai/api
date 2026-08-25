import type { DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';

type FailureInput={code?:unknown;reason?:unknown;message?:unknown};
function record(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}

export function assignmentFailureDisposition(input:FailureInput){
	const value=`${String(input.code??'')} ${String(input.reason??input.message??'')}`.toLowerCase();
	if(/deadline|timeout/u.test(value))return 'deadline_exhausted';
	if(/budget|quota|token|cost|capacity/u.test(value))return 'budget_exhausted';
	if(/cancel|abort/u.test(value))return 'cancelled';
	if(/block|authority|credential|dependency|evidence/u.test(value))return 'blocked';
	return 'failed';
}

export function archivedConversationCancellation(assignment:DurableProviderAssignment,input:FailureInput){
	const metadata=record(assignment.metadata);
	return assignment.executionKind==='conversation'&&metadata.cancellationRequested===true
		&&String(metadata.cancellationReason??'')==='discussion_archived'&&String(input.code??'')==='discussion_archived';
}
