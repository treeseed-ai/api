declare module '../persistence/store.ts' {
	interface ControlPlaneStore {
		principalCanManageServices: OmitThisParameter<typeof import('./teams/services/service-permissions.ts').principalCanManageServicesMethod>;
		listTeamServiceConnections: OmitThisParameter<typeof import('./teams/services/service-connections.ts').listTeamServiceConnectionsMethod>;
		getTeamServiceConnection: OmitThisParameter<typeof import('./teams/services/service-connections.ts').getTeamServiceConnectionMethod>;
		createTeamServiceConnection: OmitThisParameter<typeof import('./teams/services/service-connections.ts').createTeamServiceConnectionMethod>;
		updateTeamServiceConnection: OmitThisParameter<typeof import('./teams/services/service-connections.ts').updateTeamServiceConnectionMethod>;
		upsertTeamServiceCapability: OmitThisParameter<typeof import('./teams/services/service-connections.ts').upsertTeamServiceCapabilityMethod>;
		disconnectTeamServiceConnection: OmitThisParameter<typeof import('./teams/services/service-connections.ts').disconnectTeamServiceConnectionMethod>;
	}
}

export { };
