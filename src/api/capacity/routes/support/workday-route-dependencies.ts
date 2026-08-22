import type { Context } from 'hono';
import type { CapacityOperatorStore } from './operator.ts';

type Access = { response?: Response | null; principal?: { id?: string } };

export interface WorkdayRouteDependencies {
	store: CapacityOperatorStore;
	read(c: Context): Promise<Access>;
	manage(c: Context): Promise<Access>;
	diagnose(c: Context): Promise<Access>;
	query(c: Context, name: string): string | null;
	page(c: Context): { limit: number; cursor: ReturnType<typeof import('@treeseed/sdk/capacity-pagination').decodeCapacityPageCursor> };
	notFound(c: Context, message: string): Response;
	operatorError(error: unknown): Response;
	requireTeamAccess(c: Context, teamId: string): Promise<Access>;
	runtimeControlPlaneAuthProvider?: { createServiceToken(input: { serviceId: string; name: string; roles?: string[]; permissions?: string[] }): Promise<{ id: string; serviceId: string; secret: string }> };
	environment?: string;
}
