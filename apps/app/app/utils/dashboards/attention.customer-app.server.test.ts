import { CustomerApp, db, eq, Organization } from '@repo/database'
import { describe, expect, it } from 'vitest'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import {
	ATTENTION_DETECTORS,
	type DetectorContext,
} from './attention.server.ts'
import { ATTENTION_URGENCY } from './attention.ts'

const DAY = 24 * 60 * 60 * 1000

async function setup(snapshot: unknown, publisher: 'menuza' | 'restaurant') {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id)
	await db.insert(CustomerApp).values({
		organizationId: organization.id,
		slug: `slug-${organization.id}`.toLowerCase(),
		displayName: 'Acme',
		iosBundleId: `com.acme.${organization.id.toLowerCase()}`,
		androidPackage: `com.acme.a${organization.id.toLowerCase()}`,
		publisher,
		accountSnapshot: JSON.stringify(snapshot),
	})
	const [row] = await db
		.select()
		.from(Organization)
		.where(eq(Organization.id, organization.id))
	return {
		organization: row!,
		ctx: {
			organization: { id: organization.id },
			locations: [],
			hasLocations: false,
			has: () => true,
			now: new Date(),
		} as unknown as DetectorContext,
	}
}

const detector = ATTENTION_DETECTORS.find(
	(d) => d.kind === 'customer_app_account',
)!

describe('customer app account checks in the Needs attention feed (#156)', () => {
	it('is flagged behind customer_app.enabled and needs settings access', () => {
		expect(detector.flag).toBe('customer_app.enabled')
		expect(ATTENTION_URGENCY.customer_app_account).toBe('urgent')
		expect(ATTENTION_URGENCY.customer_app_expiring).toBe('todo')
	})

	it('raises an urgent item for a failing check on a restaurant-published app', async () => {
		const { ctx } = await setup(
			{
				developerAccountExpiresAt: Date.now() + 200 * DAY,
				termsAccepted: false,
				paymentTermsAccepted: true,
				accessOk: true,
			},
			'restaurant',
		)
		const items = await detector.detect(ctx)
		expect(items.map((item) => item.kind)).toEqual(['customer_app_account'])
		expect(items[0]!.dismissible).toBe(false)
	})

	it('raises an expiring item inside 30 days', async () => {
		const { ctx } = await setup(
			{
				developerAccountExpiresAt: Date.now() + 10 * DAY,
				termsAccepted: true,
				paymentTermsAccepted: true,
				accessOk: true,
			},
			'restaurant',
		)
		const items = await detector.detect(ctx)
		expect(items.map((item) => item.kind)).toEqual(['customer_app_expiring'])
		expect(items[0]!.dismissible).toBe(true)
	})

	it('shows nothing for an app published under Menuza’s own account', async () => {
		const { ctx } = await setup(
			{
				developerAccountExpiresAt: Date.now() - DAY,
				termsAccepted: false,
				paymentTermsAccepted: false,
				accessOk: false,
			},
			'menuza',
		)
		expect(await detector.detect(ctx)).toEqual([])
	})
})
