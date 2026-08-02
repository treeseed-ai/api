export function installCommerceStripePriceReconciliationAndGovernanceEventsRoutes(context: any) {
	const { app, commerceErrorResponse, ensurePrincipal, jsonError, optionalTrimmedString, principalIsSeedAdmin, requireTeamAccess, store, stripeConnectService, syncCommercePriceStripePrice } = context;
	app.post('/v1/commerce/prices/:priceId/stripe/reconcile', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					try {
						const price = await store.getCommercePrice(c.req.param('priceId'));
						if (!price) return jsonError(c, 404, `Unknown commerce price "${c.req.param('priceId')}".`);
						const offer = await store.getCommerceOffer(price.offerId);
						const access = await requireTeamAccess(c, store, offer.sellerTeamId, 'teams:manage:team');
						if (access.response) return access.response;
						const result = await syncCommercePriceStripePrice({
							store,
							stripeConnectService,
							price,
							actorType: principalIsSeedAdmin(auth.principal) ? 'operator' : 'user',
							actorId: auth.principal.id ?? null,
							reconcile: true,
							throwOnBlocked: true,
						});
						return c.json({ ok: true, payload: result });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commerce/governance-events', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const teamId = optionalTrimmedString(c.req.query('teamId'));
					if (teamId && !principalIsSeedAdmin(auth.principal)) {
						const access = await requireTeamAccess(c, store, teamId, 'projects:read:team');
						if (access.response) return access.response;
					}
					return c.json({ ok: true, payload: await store.listCommerceGovernanceEvents({
						objectType: optionalTrimmedString(c.req.query('objectType')),
						objectId: optionalTrimmedString(c.req.query('objectId')),
						productId: optionalTrimmedString(c.req.query('productId')),
						offerId: optionalTrimmedString(c.req.query('offerId')),
						teamId,
					}) });
				});
}
