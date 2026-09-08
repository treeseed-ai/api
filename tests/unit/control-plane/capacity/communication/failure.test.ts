import { describe, expect, it } from 'vitest';
import { communicationFailure } from '../../../../../src/api/control-plane/repositories/capacity/communication/failure.ts';

describe('send failure cause', () => {
	it('retains the execution cause under a terminal wrapper', () => {
		expect(communicationFailure({code:'terminal_assignment_without_final_response',lifecycleCode:'agent_executor_failed',lifecycleReason:'Required MCP server failed.'})).toEqual({code:'agent_executor_failed',message:'Required MCP server failed.'});
	});
	it('retains admission errors and never exposes unrelated metadata', () => {
		expect(communicationFailure({code:'admission_denied',message:'No capacity',secret:'hidden'})).toEqual({code:'admission_denied',message:'No capacity'});
		expect(communicationFailure({})).toBeNull();
	});
});
