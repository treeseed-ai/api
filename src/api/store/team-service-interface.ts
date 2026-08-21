declare module '../persistence/store.ts' {
	interface ControlPlaneStore {
		principalCanManageServices: OmitThisParameter<typeof import('./teams/services/service-permissions.ts').principalCanManageServicesMethod>;
		principalCanManageServiceVault: OmitThisParameter<typeof import('./teams/services/service-permissions.ts').principalCanManageServiceVaultMethod>;
		listTeamServiceConnections: OmitThisParameter<typeof import('./teams/services/service-connections.ts').listTeamServiceConnectionsMethod>;
		getTeamServiceConnection: OmitThisParameter<typeof import('./teams/services/service-connections.ts').getTeamServiceConnectionMethod>;
		createTeamServiceConnection: OmitThisParameter<typeof import('./teams/services/service-connections.ts').createTeamServiceConnectionMethod>;
		updateTeamServiceConnection: OmitThisParameter<typeof import('./teams/services/service-connections.ts').updateTeamServiceConnectionMethod>;
		upsertTeamServiceCapability: OmitThisParameter<typeof import('./teams/services/service-connections.ts').upsertTeamServiceCapabilityMethod>;
		disconnectTeamServiceConnection: OmitThisParameter<typeof import('./teams/services/service-connections.ts').disconnectTeamServiceConnectionMethod>;
		getUserVaultKey: OmitThisParameter<typeof import('./teams/services/service-vaults.ts').getUserVaultKeyMethod>;
		upsertUserVaultKey: OmitThisParameter<typeof import('./teams/services/service-vaults.ts').upsertUserVaultKeyMethod>;
		getTeamVaultSummary: OmitThisParameter<typeof import('./teams/services/service-vaults.ts').getTeamVaultSummaryMethod>;
		initializeTeamVault: OmitThisParameter<typeof import('./teams/services/service-vaults.ts').initializeTeamVaultMethod>;
		createTeamVaultGrant: OmitThisParameter<typeof import('./teams/services/service-vaults.ts').createTeamVaultGrantMethod>;
		revokeTeamVaultGrant: OmitThisParameter<typeof import('./teams/services/service-vaults.ts').revokeTeamVaultGrantMethod>;
		resetTeamVault: OmitThisParameter<typeof import('./teams/services/service-vaults.ts').resetTeamVaultMethod>;
		upsertServiceCredentialEnvelope: OmitThisParameter<typeof import('./teams/services/service-vaults.ts').upsertServiceCredentialEnvelopeMethod>;
		listServiceCredentialEnvelopes: OmitThisParameter<typeof import('./teams/services/service-vaults.ts').listServiceCredentialEnvelopesMethod>;
		listTeamCredentialEnvelopes: OmitThisParameter<typeof import('./teams/services/service-vaults.ts').listTeamCredentialEnvelopesMethod>;
		rotateTeamVault: OmitThisParameter<typeof import('./teams/services/service-vaults.ts').rotateTeamVaultMethod>;
		createSecretOperationLease: OmitThisParameter<typeof import('./teams/services/secret-operation-leases.ts').createSecretOperationLeaseMethod>;
		listAwaitingSecretOperationLeases: OmitThisParameter<typeof import('./teams/services/secret-operation-leases.ts').listAwaitingSecretOperationLeasesMethod>;
		registerSecretOperationLeaseKey: OmitThisParameter<typeof import('./teams/services/secret-operation-leases.ts').registerSecretOperationLeaseKeyMethod>;
		getSecretOperationLease: OmitThisParameter<typeof import('./teams/services/secret-operation-leases.ts').getSecretOperationLeaseMethod>;
		submitSecretOperationPayload: OmitThisParameter<typeof import('./teams/services/secret-operation-leases.ts').submitSecretOperationPayloadMethod>;
		consumeSecretOperationLease: OmitThisParameter<typeof import('./teams/services/secret-operation-leases.ts').consumeSecretOperationLeaseMethod>;
		cancelSecretOperationLease: OmitThisParameter<typeof import('./teams/services/secret-operation-leases.ts').cancelSecretOperationLeaseMethod>;
		listExternalVaultBindings: OmitThisParameter<typeof import('./teams/services/external-vault-bindings.ts').listExternalVaultBindingsMethod>;
		createExternalVaultBinding: OmitThisParameter<typeof import('./teams/services/external-vault-bindings.ts').createExternalVaultBindingMethod>;
		removeExternalVaultBinding: OmitThisParameter<typeof import('./teams/services/external-vault-bindings.ts').removeExternalVaultBindingMethod>;
	}
}

export { };
