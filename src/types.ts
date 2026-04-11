import type { AgentSdk } from '@treeseed/sdk/sdk';
import type { SdkQueueMessageEnvelope } from '@treeseed/sdk';
import type {
	ApiPrincipal,
	ApiScope,
	DeviceCodeApproveRequest as SdkDeviceCodeApproveRequest,
	DeviceCodePollRequest,
	DeviceCodePollResponse,
	DeviceCodeStartRequest,
	DeviceCodeStartResponse,
	RemoteWorkflowOperationRequest as WorkflowHttpOperationRequest,
	RemoteWorkflowOperationResponse as ApiWorkflowOperationResponse,
	RemoteSdkOperationRequest as SdkHttpOperationRequest,
	TokenRefreshRequest,
	TokenRefreshResponse,
} from '@treeseed/sdk/remote';

export type {
	ApiPrincipal,
	ApiScope,
	DeviceCodePollRequest,
	DeviceCodePollResponse,
	DeviceCodeStartRequest,
	DeviceCodeStartResponse,
	WorkflowHttpOperationRequest,
	ApiWorkflowOperationResponse,
	SdkHttpOperationRequest,
	TokenRefreshRequest,
	TokenRefreshResponse,
};

export type DeviceCodeApproveRequest = SdkDeviceCodeApproveRequest;

export interface ApiAuthProvider {
	readonly id: string;
	startDeviceFlow(request: DeviceCodeStartRequest): Promise<DeviceCodeStartResponse>;
	pollDeviceFlow(request: DeviceCodePollRequest): Promise<DeviceCodePollResponse>;
	refreshAccessToken(request: TokenRefreshRequest): Promise<TokenRefreshResponse>;
	approveDeviceFlow(request: DeviceCodeApproveRequest): Promise<{ ok: true }>;
	authenticateBearerToken(token: string): Promise<ApiPrincipal | null>;
}

export type ApiRuntimeProviderSelections = {
	auth: string;
	agents: {
		execution: string;
		queue: string;
		notification: string;
		repository: string;
		verification: string;
	};
};

export interface ApiConfig {
	name: string;
	host: string;
	port: number;
	baseUrl: string;
	issuer: string;
	repoRoot: string;
	authSecret: string;
	accessTokenTtlSeconds: number;
	refreshTokenTtlSeconds: number;
	deviceCodeTtlSeconds: number;
	deviceCodePollIntervalSeconds: number;
	templateCatalogPath?: string;
	providers: ApiRuntimeProviderSelections;
}

export type ApiProviderFactory<T> = (options: { config: ApiConfig }) => T;

export interface ApiRuntimeProviders {
	auth?: Record<string, ApiProviderFactory<ApiAuthProvider>>;
	agentExecution?: Record<string, unknown>;
	agentQueue?: Record<string, unknown>;
	agentNotification?: Record<string, unknown>;
	agentRepository?: Record<string, unknown>;
	agentVerification?: Record<string, unknown>;
}

export interface ResolvedApiRuntimeProviders {
	auth: ApiAuthProvider;
	registries: {
		auth: Map<string, ApiProviderFactory<ApiAuthProvider>>;
		agentExecution: Map<string, unknown>;
		agentQueue: Map<string, unknown>;
		agentNotification: Map<string, unknown>;
		agentRepository: Map<string, unknown>;
		agentVerification: Map<string, unknown>;
	};
	selections: ApiRuntimeProviderSelections;
}

export interface ApiServerOptions {
	config?: Partial<ApiConfig>;
	runtimeProviders?: ApiRuntimeProviders;
	sdk?: AgentSdk;
	log?: (message: string, details?: Record<string, unknown>) => void;
}

export interface GatewayQueueProducer {
	enqueue(request: {
		queueName?: string;
		message: SdkQueueMessageEnvelope;
		delaySeconds?: number;
	}): Promise<void>;
}

export interface GatewayServerOptions {
	sdk: AgentSdk;
	bearerToken: string;
	queueProducer?: GatewayQueueProducer;
	projectId?: string;
}
