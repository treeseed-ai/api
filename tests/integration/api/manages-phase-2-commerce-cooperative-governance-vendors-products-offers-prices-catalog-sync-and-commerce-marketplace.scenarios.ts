import { createTestApp, describe, it } from '../../support/api-harness.ts';
import { verifyCommerceCatalogPublication } from '../../support/commerce-catalog-publication.ts';
import { verifyCommerceGovernanceSetup } from '../../support/commerce-governance.ts';

describe('market api', () => {
	it('manages phase 2 commerce cooperative governance vendors, products, offers, prices, catalog sync, and commerce marketplace catalog', async () => {
		const app = createTestApp();
		const state = await verifyCommerceGovernanceSetup(app);
		await verifyCommerceCatalogPublication(app, state);
	});
});
