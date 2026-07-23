import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { governanceVotingProvider } from '@treeseed/sdk';
import { containsTreeseedPlaintextSecretMaterial, validateTreeseedClientEncryptedEscrowMetadata, validateTreeseedSecretsCapabilityRegistry, validateTreeseedWritableSecretMetadata, } from '@treeseed/sdk/secrets-capability';
import { redactDeploymentValue } from '../../../market/deployment-actions.ts';
import { projectDeploymentAuditPayload } from '../../../market/deployment-governance.ts';
import { serializeCommerceVendor, serializeCommerceVendorStripeAccount, serializeCommerceProduct, serializeCommerceOwnershipRecord, serializeCommerceStewardshipAssignment, serializeCommerceContribution, serializeCommerceGovernancePolicy, serializeCommerceOwnershipTransfer, serializeCommerceSuccessionEvent, serializeCommerceOwnershipWorkflowSummary, serializeCommerceProductVersion, serializeCommerceOffer, serializeCommercePrice, serializeCommerceGovernanceEvent, serializeCommerceCart, serializeCommerceCartItem, serializeCommerceCheckout, serializeCommerceOrder, serializeCommerceOrderItem, serializeCommerceRefund, serializeCommerceFulfillmentEvent, serializeCommerceServiceRequest, serializeCommerceServiceQuote, serializeCommerceServiceContract, serializeCommerceServiceEvent, serializeCommerceCapacityListing, serializeCommerceCapacityListingInquiry, serializeCommerceVendorOrderSummary, serializeCommercePaymentGroup, serializeCommerceSubscription, serializeCommerceEntitlement, serializeCommerceBuyerStripeCustomer, serializeCommerceWebhookEvent } from './index.ts';

export const COMMERCE_PRODUCT_KINDS = [
    'template',
    'knowledge_pack',
    'ui_library',
    'admin_interface',
    'api_platform',
    'hosted_project',
    'professional_hosting',
    'scoped_service',
    'capacity_listing',
];

export const COMMERCE_OFFER_MODES = [
    'free',
    'private',
    'contact',
    'one_time',
    'one_time_current_version',
    'subscription',
    'subscription_updates',
    'professional_hosting',
    'scoped_contract',
    'external',
];

export const COMMERCE_VENDOR_TRUST_LEVELS = [
    'public_publisher',
    'verified_seller',
    'trusted_service_vendor',
    'trusted_capacity_vendor',
    'integration_partner',
];

export const COMMERCE_GOVERNANCE_STATES = [
    'draft',
    'submitted',
    'approved',
    'rejected',
    'suspended',
    'archived',
];

export const COMMERCE_OWNERSHIP_MODELS = [
    'team_owned',
    'individual_contributor_owned',
    'multi_contributor_attributed',
    'steward_maintained',
    'cooperative_owned',
    'community_governed',
    'foundation_or_trust_held',
    'transferred_or_succeeded',
];

export const COMMERCE_STEWARDSHIP_ROLES = [
    'owner',
    'seller',
    'maintainer',
    'governance_steward',
    'support_steward',
    'security_steward',
    'community_steward',
    'successor',
];

export const COMMERCE_STRIPE_ACCOUNT_STATUSES = [
    'not_started',
    'pending',
    'restricted',
    'enabled',
    'disabled',
];

export const COMMERCE_STRIPE_ONBOARDING_STATUSES = [
    'not_started',
    'started',
    'returned',
    'completed',
    'expired',
];

export const COMMERCE_STRIPE_ENVIRONMENTS = ['test', 'live'];

export const COMMERCE_STRIPE_SYNC_STATUSES = [
    'not_synced',
    'pending',
    'synced',
    'blocked',
    'drifted',
    'failed',
];

export const COMMERCE_ENTITLEMENT_STATUSES = ['pending', 'active', 'past_due', 'expired', 'revoked', 'refunded', 'canceled'];

export const COMMERCE_CART_STATUSES = ['active', 'checkout_pending', 'converted', 'abandoned'];

export const COMMERCE_CHECKOUT_STATUSES = ['draft', 'requires_confirmation', 'processing', 'partially_confirmed', 'confirmed', 'completed', 'canceled', 'failed'];

export const COMMERCE_ORDER_STATUSES = ['draft', 'pending_payment', 'requires_action', 'processing', 'paid', 'partially_refunded', 'refunded', 'canceled', 'failed'];

export const COMMERCE_ORDER_ITEM_STATUSES = ['pending', 'paid', 'fulfilled', 'refunded', 'revoked', 'canceled'];

export const COMMERCE_SUBSCRIPTION_STATUSES = ['incomplete', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'];

export const COMMERCE_PAYMENT_GROUP_STATUSES = ['pending', 'requires_confirmation', 'requires_action', 'processing', 'succeeded', 'failed', 'canceled'];

export const COMMERCE_WEBHOOK_EVENT_STATUSES = ['received', 'processing', 'processed', 'ignored', 'failed'];

export const COMMERCE_REFUND_STATUSES = ['processing', 'succeeded', 'failed', 'canceled'];

export const COMMERCE_FULFILLMENT_STATUSES = ['pending', 'ready', 'delivered', 'failed', 'revoked'];

export const COMMERCE_FULFILLMENT_EVENT_TYPES = ['artifact_released', 'artifact_delivered', 'manual_status', 'revoked'];

export const COMMERCE_SERVICE_REQUEST_STATUSES = ['requested', 'scoping', 'quoted', 'buyer_approved', 'vendor_approved', 'checkout_pending', 'active', 'fulfilled', 'declined', 'canceled', 'expired'];

export const COMMERCE_SERVICE_QUOTE_STATUSES = ['draft', 'submitted', 'buyer_approved', 'vendor_approved', 'accepted', 'rejected', 'expired', 'superseded', 'canceled'];

export const COMMERCE_SERVICE_CONTRACT_STATUSES = ['pending_checkout', 'active', 'fulfilled', 'canceled', 'disputed'];

export const COMMERCE_SERVICE_EVENT_TYPES = ['requested', 'scoping_started', 'scope_updated', 'quote_created', 'quote_submitted', 'quote_buyer_approved', 'quote_vendor_approved', 'quote_rejected', 'quote_expired', 'checkout_created', 'contract_activated', 'work_linked', 'manual_update', 'fulfilled', 'declined', 'canceled'];

export const COMMERCE_CAPACITY_LISTING_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'suspended', 'archived'];

export const COMMERCE_CAPACITY_INQUIRY_STATUSES = ['requested', 'reviewing', 'approved_for_scoping', 'declined', 'canceled'];

export const COMMERCE_CAPACITY_ACCESS_LEVELS = ['public_summary', 'buyer_gated', 'governance_required', 'private_invite'];

export const COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVELS = ['none', 'project_scoped', 'tenant_isolated', 'dedicated_runtime', 'external_only'];

export const COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVELS = ['none', 'review_only', 'operator_assisted', 'human_delivered'];

export const COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVELS = ['none', 'assistive', 'agentic', 'model_hosted'];

export const COMMERCE_CAPACITY_DATA_ACCESS_LEVELS = ['none', 'public_only', 'buyer_provided', 'project_scoped', 'sensitive_review_required'];

export const COMMERCE_CAPACITY_SECRET_ACCESS_LEVELS = ['none', 'buyer_managed', 'delegated_scoped', 'market_admin_review_required'];

export const COMMERCE_PRODUCT_KIND_SET = new Set(COMMERCE_PRODUCT_KINDS);

export const COMMERCE_OFFER_MODE_SET = new Set(COMMERCE_OFFER_MODES);

export const COMMERCE_VENDOR_TRUST_LEVEL_SET = new Set(COMMERCE_VENDOR_TRUST_LEVELS);

export const COMMERCE_GOVERNANCE_STATE_SET = new Set(COMMERCE_GOVERNANCE_STATES);

export const COMMERCE_OWNERSHIP_MODEL_SET = new Set(COMMERCE_OWNERSHIP_MODELS);

export const COMMERCE_STEWARDSHIP_ROLE_SET = new Set(COMMERCE_STEWARDSHIP_ROLES);

export const COMMERCE_STRIPE_ACCOUNT_STATUS_SET = new Set(COMMERCE_STRIPE_ACCOUNT_STATUSES);

export const COMMERCE_STRIPE_ONBOARDING_STATUS_SET = new Set(COMMERCE_STRIPE_ONBOARDING_STATUSES);

export const COMMERCE_STRIPE_ENVIRONMENT_SET = new Set(COMMERCE_STRIPE_ENVIRONMENTS);

export const COMMERCE_STRIPE_SYNC_STATUS_SET = new Set(COMMERCE_STRIPE_SYNC_STATUSES);

export const COMMERCE_ENTITLEMENT_STATUS_SET = new Set(COMMERCE_ENTITLEMENT_STATUSES);

export const COMMERCE_CART_STATUS_SET = new Set(COMMERCE_CART_STATUSES);

export const COMMERCE_CHECKOUT_STATUS_SET = new Set(COMMERCE_CHECKOUT_STATUSES);

export const COMMERCE_ORDER_STATUS_SET = new Set(COMMERCE_ORDER_STATUSES);

export const COMMERCE_ORDER_ITEM_STATUS_SET = new Set(COMMERCE_ORDER_ITEM_STATUSES);

export const COMMERCE_SUBSCRIPTION_STATUS_SET = new Set(COMMERCE_SUBSCRIPTION_STATUSES);

export const COMMERCE_PAYMENT_GROUP_STATUS_SET = new Set(COMMERCE_PAYMENT_GROUP_STATUSES);

export const COMMERCE_WEBHOOK_EVENT_STATUS_SET = new Set(COMMERCE_WEBHOOK_EVENT_STATUSES);

export const COMMERCE_REFUND_STATUS_SET = new Set(COMMERCE_REFUND_STATUSES);

export const COMMERCE_FULFILLMENT_STATUS_SET = new Set(COMMERCE_FULFILLMENT_STATUSES);

export const COMMERCE_FULFILLMENT_EVENT_TYPE_SET = new Set(COMMERCE_FULFILLMENT_EVENT_TYPES);

export const COMMERCE_SERVICE_REQUEST_STATUS_SET = new Set(COMMERCE_SERVICE_REQUEST_STATUSES);

export const COMMERCE_SERVICE_QUOTE_STATUS_SET = new Set(COMMERCE_SERVICE_QUOTE_STATUSES);

export const COMMERCE_SERVICE_CONTRACT_STATUS_SET = new Set(COMMERCE_SERVICE_CONTRACT_STATUSES);

export const COMMERCE_SERVICE_EVENT_TYPE_SET = new Set(COMMERCE_SERVICE_EVENT_TYPES);

export const COMMERCE_CAPACITY_LISTING_STATUS_SET = new Set(COMMERCE_CAPACITY_LISTING_STATUSES);

export const COMMERCE_CAPACITY_INQUIRY_STATUS_SET = new Set(COMMERCE_CAPACITY_INQUIRY_STATUSES);

export const COMMERCE_CAPACITY_ACCESS_LEVEL_SET = new Set(COMMERCE_CAPACITY_ACCESS_LEVELS);

export const COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVEL_SET = new Set(COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVELS);

export const COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVEL_SET = new Set(COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVELS);

export const COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVEL_SET = new Set(COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVELS);

export const COMMERCE_CAPACITY_DATA_ACCESS_LEVEL_SET = new Set(COMMERCE_CAPACITY_DATA_ACCESS_LEVELS);

export const COMMERCE_CAPACITY_SECRET_ACCESS_LEVEL_SET = new Set(COMMERCE_CAPACITY_SECRET_ACCESS_LEVELS);

export const COMMERCE_VISIBILITY_SET = new Set(['public', 'authenticated', 'team', 'private']);

export const COMMERCE_FULFILLMENT_MODE_SET = new Set(['automatic', 'manual', 'scoped', 'external']);

export const COMMERCE_PRICE_STATUS_SET = new Set(['draft', 'active', 'archived']);

export const COMMERCE_PRICE_INTERVAL_SET = new Set(['one_time', 'month', 'year', 'custom']);

export const COMMERCE_TAX_BEHAVIOR_SET = new Set(['exclusive', 'inclusive', 'unspecified']);

export const COMMERCE_COMMERCIAL_OFFER_MODES = new Set([
    'one_time',
    'one_time_current_version',
    'subscription',
    'subscription_updates',
    'professional_hosting',
    'scoped_contract',
]);

export const COMMERCE_ZERO_PRICE_OFFER_MODES = new Set(['free', 'private', 'contact', 'external']);

export const COMMERCE_CAPACITY_LISTING_OFFER_MODES = new Set(['contact', 'private', 'external']);
