function optionalString(value) {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function booleanValue(value) {
	return value === true;
}

function arrayValue(value) {
	return Array.isArray(value) ? value.map((entry) => String(entry ?? '').trim()).filter(Boolean) : [];
}

function objectValue(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stripeSecretKey(config = {}) {
	return optionalString(config.stripeSecretKey)
		?? optionalString(config.STRIPE_SECRET_KEY)
		?? optionalString(process.env.TREESEED_STRIPE_SECRET_KEY)
		?? optionalString(process.env.STRIPE_SECRET_KEY);
}

export function resolveStripeEnvironment(config = {}) {
	const value = optionalString(config.stripeMode)
		?? optionalString(config.STRIPE_MODE)
		?? optionalString(process.env.TREESEED_STRIPE_MODE)
		?? optionalString(process.env.STRIPE_MODE);
	return value === 'live' ? 'live' : 'test';
}

function normalizeAccountStatus(account) {
	const requirements = objectValue(account?.requirements);
	const currentlyDue = arrayValue(requirements.currently_due);
	const pastDue = arrayValue(requirements.past_due);
	const disabledReason = optionalString(requirements.disabled_reason);
	if (disabledReason && /disabled|rejected|listed|fraud|terms/i.test(disabledReason)) return 'disabled';
	if (currentlyDue.length > 0 || pastDue.length > 0 || disabledReason) return 'restricted';
	if (account?.charges_enabled === true && account?.payouts_enabled === true && account?.details_submitted === true) return 'enabled';
	return 'pending';
}

export function stripeAccountToConnectedAccountPatch(account, environment = 'test') {
	const requirements = objectValue(account?.requirements);
	return {
		environment,
		stripeAccountId: String(account?.id ?? ''),
		accountStatus: normalizeAccountStatus(account),
		onboardingStatus: account?.details_submitted === true ? 'completed' : undefined,
		chargesEnabled: booleanValue(account?.charges_enabled),
		payoutsEnabled: booleanValue(account?.payouts_enabled),
		detailsSubmitted: booleanValue(account?.details_submitted),
		requirementsCurrentlyDue: arrayValue(requirements.currently_due),
		requirementsEventuallyDue: arrayValue(requirements.eventually_due),
		requirementsPastDue: arrayValue(requirements.past_due),
		requirementsDisabledReason: optionalString(requirements.disabled_reason),
		capabilities: Object.fromEntries(
			Object.entries(objectValue(account?.capabilities))
				.map(([key, value]) => [key, String(value ?? '')])
				.filter(([, value]) => value),
		),
		lastSyncedAt: new Date().toISOString(),
	};
}

function sanitizeStripeError(error) {
	const message = optionalString(error?.message) ?? 'Stripe request failed.';
	const sanitized = message.replace(/sk_(?:live|test)_[A-Za-z0-9_]+/gu, '[redacted]');
	const next = new Error(sanitized) as Error & {
		status: number;
		details: {
			type: string | null;
			code: string | null;
		};
	};
	next.status = 502;
	next.details = {
		type: optionalString(error?.type),
		code: optionalString(error?.code),
	};
	return next;
}

export function createStripeConnectService(options = {}) {
	const config = options.config ?? {};
	const environment = options.environment ?? resolveStripeEnvironment(config);
	let stripePromise = null;

	async function stripeClient() {
		if (options.stripe) return options.stripe;
		const secretKey = stripeSecretKey(config);
		if (!secretKey) return null;
		if (!stripePromise) {
			stripePromise = import('stripe').then(({ default: Stripe }) => new Stripe(secretKey));
		}
		return stripePromise;
	}

	return {
		environment,
		async isConfigured() {
			return Boolean(options.stripe) || Boolean(stripeSecretKey(config));
		},
		async createExpressAccount({ vendor, team }) {
			const stripe = await stripeClient();
			if (!stripe) return null;
			try {
				return await stripe.accounts.create({
					type: 'express',
					business_profile: {
						name: vendor.displayName,
						product_description: 'TreeSeed marketplace vendor account',
					},
					metadata: {
						treeseed_vendor_id: vendor.id,
						treeseed_team_id: vendor.teamId,
						treeseed_environment: environment,
						...(team?.slug ? { treeseed_team_slug: team.slug } : {}),
					},
					capabilities: {
						card_payments: { requested: true },
						transfers: { requested: true },
					},
				});
			} catch (error) {
				throw sanitizeStripeError(error);
			}
		},
		async createOnboardingLink({ stripeAccountId, returnUrl, refreshUrl }) {
			const stripe = await stripeClient();
			if (!stripe) return null;
			try {
				return await stripe.accountLinks.create({
					account: stripeAccountId,
					return_url: returnUrl,
					refresh_url: refreshUrl,
					type: 'account_onboarding',
				});
			} catch (error) {
				throw sanitizeStripeError(error);
			}
		},
		async retrieveAccount(stripeAccountId) {
			const stripe = await stripeClient();
			if (!stripe) return null;
			try {
				return await stripe.accounts.retrieve(stripeAccountId);
			} catch (error) {
				throw sanitizeStripeError(error);
			}
		},
		async createLoginLink(stripeAccountId) {
			const stripe = await stripeClient();
			if (!stripe) return null;
			try {
				return await stripe.accounts.createLoginLink(stripeAccountId);
			} catch (error) {
				throw sanitizeStripeError(error);
			}
		},
		async createProductMirror({ connectedAccountId, params }) {
			const stripe = await stripeClient();
			if (!stripe) return null;
			try {
				return await stripe.products.create(params, { stripeAccount: connectedAccountId });
			} catch (error) {
				throw sanitizeStripeError(error);
			}
		},
		async updateProductMirror({ connectedAccountId, stripeProductId, params }) {
			const stripe = await stripeClient();
			if (!stripe) return null;
			try {
				return await stripe.products.update(stripeProductId, params, { stripeAccount: connectedAccountId });
			} catch (error) {
				throw sanitizeStripeError(error);
			}
		},
		async retrieveProductMirror({ connectedAccountId, stripeProductId }) {
			const stripe = await stripeClient();
			if (!stripe) return null;
			try {
				return await stripe.products.retrieve(stripeProductId, { stripeAccount: connectedAccountId });
			} catch (error) {
				throw sanitizeStripeError(error);
			}
		},
		async createPriceMirror({ connectedAccountId, params }) {
			const stripe = await stripeClient();
			if (!stripe) return null;
			try {
				return await stripe.prices.create(params, { stripeAccount: connectedAccountId });
			} catch (error) {
				throw sanitizeStripeError(error);
			}
		},
		async updatePriceMirror({ connectedAccountId, stripePriceId, params }) {
			const stripe = await stripeClient();
			if (!stripe) return null;
			try {
				return await stripe.prices.update(stripePriceId, params, { stripeAccount: connectedAccountId });
			} catch (error) {
				throw sanitizeStripeError(error);
			}
		},
		async retrievePriceMirror({ connectedAccountId, stripePriceId }) {
			const stripe = await stripeClient();
			if (!stripe) return null;
			try {
				return await stripe.prices.retrieve(stripePriceId, { stripeAccount: connectedAccountId });
			} catch (error) {
				throw sanitizeStripeError(error);
			}
		},
		async createPaymentIntent({ connectedAccountId, params }) {
			const stripe = await stripeClient();
			if (!stripe) return null;
			try {
				return await stripe.paymentIntents.create(params, { stripeAccount: connectedAccountId });
			} catch (error) {
				throw sanitizeStripeError(error);
			}
		},
		async retrievePaymentIntent({ connectedAccountId, paymentIntentId }) {
			const stripe = await stripeClient();
			if (!stripe) return null;
			try {
				return await stripe.paymentIntents.retrieve(paymentIntentId, { stripeAccount: connectedAccountId });
			} catch (error) {
				throw sanitizeStripeError(error);
			}
		},
		async cancelPaymentIntent({ connectedAccountId, paymentIntentId }) {
			const stripe = await stripeClient();
			if (!stripe) return null;
			try {
				return await stripe.paymentIntents.cancel(paymentIntentId, {}, { stripeAccount: connectedAccountId });
			} catch (error) {
				throw sanitizeStripeError(error);
			}
		},
		async createRefund({ connectedAccountId, params, idempotencyKey }) {
			const stripe = await stripeClient();
			if (!stripe) return null;
			try {
				const requestOptions: { stripeAccount: string; idempotencyKey?: string } = { stripeAccount: connectedAccountId };
				if (idempotencyKey) requestOptions.idempotencyKey = idempotencyKey;
				return await stripe.refunds.create(params, requestOptions);
			} catch (error) {
				throw sanitizeStripeError(error);
			}
		},
		async retrieveRefund({ connectedAccountId, refundId }) {
			const stripe = await stripeClient();
			if (!stripe) return null;
			try {
				return await stripe.refunds.retrieve(refundId, { stripeAccount: connectedAccountId });
			} catch (error) {
				throw sanitizeStripeError(error);
			}
		},
		async createCustomer({ connectedAccountId, params }) {
			const stripe = await stripeClient();
			if (!stripe) return null;
			try {
				return await stripe.customers.create(params, { stripeAccount: connectedAccountId });
			} catch (error) {
				throw sanitizeStripeError(error);
			}
		},
		async retrieveCustomer({ connectedAccountId, customerId }) {
			const stripe = await stripeClient();
			if (!stripe) return null;
			try {
				return await stripe.customers.retrieve(customerId, { stripeAccount: connectedAccountId });
			} catch (error) {
				throw sanitizeStripeError(error);
			}
		},
		async createSubscription({ connectedAccountId, params }) {
			const stripe = await stripeClient();
			if (!stripe) return null;
			try {
				return await stripe.subscriptions.create(params, { stripeAccount: connectedAccountId });
			} catch (error) {
				throw sanitizeStripeError(error);
			}
		},
		async retrieveSubscription({ connectedAccountId, subscriptionId }) {
			const stripe = await stripeClient();
			if (!stripe) return null;
			try {
				return await stripe.subscriptions.retrieve(subscriptionId, { stripeAccount: connectedAccountId });
			} catch (error) {
				throw sanitizeStripeError(error);
			}
		},
		async cancelSubscription({ connectedAccountId, subscriptionId, params = {} }) {
			const stripe = await stripeClient();
			if (!stripe) return null;
			try {
				return await stripe.subscriptions.cancel(subscriptionId, params, { stripeAccount: connectedAccountId });
			} catch (error) {
				throw sanitizeStripeError(error);
			}
		},
		async constructWebhookEvent({ payload, signature, webhookSecret }) {
			const stripe = await stripeClient();
			if (!stripe) return null;
			try {
				return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
			} catch (error) {
				throw sanitizeStripeError(error);
			}
		},
	};
}
