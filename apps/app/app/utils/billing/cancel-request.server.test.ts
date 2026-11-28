import {
	ConfigFlag,
	db,
	eq,
	Organization,
	OrganizationLocation,
	SubscriptionChangeRequest,
} from '@repo/database'
import type * as paymentsModule from '@repo/payments'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'

const provider = vi.hoisted(() => ({
	periodEnd: new Date('2026-12-14T00:00:00Z') as Date | null,
	calls: [] as string[],
}))

vi.mock('@repo/payments', async (importOriginal) => {
	const actual = await importOriginal<typeof paymentsModule>()
	return {
		...actual,
		createStripeProvider: () => ({
			getClient: () => ({
				subscriptions: { list: async () => ({ data: [] }) },
			}),
			getPlansAndPrices: async () => ({
				plans: {
					base: { id: 'prod_base', name: 'Base' },
					plus: { id: 'prod_plus', name: 'Plus' },
				},
				prices: { base: {}, plus: {} },
			}),
			retrieveSubscription: async () => {
				if (!provider.periodEnd) throw new Error('Stripe is down')
				return {
					id: 'sub_1',
					status: 'active',
					customerId: 'cus_1',
					productId: 'prod_plus',
					priceId: 'price',
					items: [],
					currentPeriodEnd: provider.periodEnd,
				}
			},
			// None of these may ever be called by a request.
			cancelSubscription: async (id: string) => {
				provider.calls.push(`cancel:${id}`)
			},
			updateSubscription: async () => {
				provider.calls.push('update')
			},
			payInvoice: async () => {
				provider.calls.push('pay')
			},
		}),
	}
})

const {
	createCancelRequest,
	loadCancelRequestContext,
	loadOpenChangeRequest,
	withdrawCancelRequest,
} = await import('./cancel-request.server.ts')

async function setup() {
	const user = await createTestUser()
	const organization = await createTestOrganization(user.id, 'admin')
	await db
		.update(Organization)
		.set({
			stripeCustomerId: 'cus_1',
			stripeSubscriptionId: 'sub_1',
			stripeProductId: 'prod_plus',
			planName: 'Plus',
			subscriptionStatus: 'active',
		})
		.where(eq(Organization.id, organization.id))
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization.id,
			name: 'Olaya',
			slug: `olaya-${crypto.randomUUID().slice(0, 8)}`,
			isActive: true,
			isDefault: true,
		})
		.returning()
	return {
		user,
		organization: {
			id: organization.id,
			stripeSubscriptionId: 'sub_1',
			subscriptionStatus: 'active' as string | null,
			stripeProductId: 'prod_plus',
		},
		location: location!,
	}
}

const body = (over: Record<string, unknown> = {}) => ({
	kind: 'cancel_organization',
	reason: 'too_expensive',
	subReason: 'price_too_high',
	note: 'Slow winter',
	confirm: true,
	...over,
})

describe('cancel or downgrade requests (#379)', () => {
	beforeEach(() => {
		provider.periodEnd = new Date('2026-12-14T00:00:00Z')
		provider.calls.length = 0
	})

	it('records the reason, sub-reason and cutoff', async () => {
		const { user, organization } = await setup()
		const result = await createCancelRequest({
			organization,
			userId: user.id,
			body: body(),
		})
		expect(result).toMatchObject({
			ok: true,
			effectiveAt: '2026-12-14T00:00:00.000Z',
		})
		const [row] = await db
			.select()
			.from(SubscriptionChangeRequest)
			.where(eq(SubscriptionChangeRequest.organizationId, organization.id))
		expect(row).toMatchObject({
			kind: 'cancel_organization',
			reason: 'too_expensive',
			subReason: 'price_too_high',
			note: 'Slow winter',
			status: 'requested',
			requestedById: user.id,
		})
		expect(row?.effectiveAt?.toISOString()).toBe('2026-12-14T00:00:00.000Z')
	})

	it('cancels, charges and deletes nothing', async () => {
		const { user, organization, location } = await setup()
		await createCancelRequest({
			organization,
			userId: user.id,
			body: body({ kind: 'cancel_locations', locationIds: [location.id] }),
		})
		expect(provider.calls).toEqual([])
		const [org] = await db
			.select({
				status: Organization.subscriptionStatus,
				plan: Organization.planName,
				sub: Organization.stripeSubscriptionId,
				active: Organization.active,
			})
			.from(Organization)
			.where(eq(Organization.id, organization.id))
		expect(org).toEqual({
			status: 'active',
			plan: 'Plus',
			sub: 'sub_1',
			active: true,
		})
		const [still] = await db
			.select({ isActive: OrganizationLocation.isActive })
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.id, location.id))
		expect(still?.isActive).toBe(true)
	})

	it('records which locations and which smaller plan', async () => {
		const { user, organization, location } = await setup()
		const locations = await createCancelRequest({
			organization,
			userId: user.id,
			body: body({ kind: 'cancel_locations', locationIds: [location.id] }),
		})
		expect(locations.ok).toBe(true)
		const open = await loadOpenChangeRequest(organization.id)
		expect(open?.locationIds).toEqual([location.id])
		await withdrawCancelRequest({
			organizationId: organization.id,
			requestId: open!.id,
			userId: user.id,
		})
		const downgrade = await createCancelRequest({
			organization,
			userId: user.id,
			body: body({ kind: 'downgrade', targetPlan: 'Base' }),
		})
		expect(downgrade.ok).toBe(true)
		expect((await loadOpenChangeRequest(organization.id))?.targetPlan).toBe(
			'Base',
		)
	})

	it('refuses without the cutoff, because the owner must see it before confirming', async () => {
		const { user, organization } = await setup()
		// The provider failing is expected here: it is logged, never thrown.
		vi.spyOn(console, 'error').mockImplementation(() => {})
		provider.periodEnd = null
		expect(
			await createCancelRequest({
				organization,
				userId: user.id,
				body: body(),
			}),
		).toEqual({ ok: false, error: 'cutoff_unknown' })
		expect(await loadOpenChangeRequest(organization.id)).toBeNull()
		expect((await loadCancelRequestContext(organization)).cutoff).toBeNull()
	})

	it('refuses without explicit confirmation, a reason or a matching sub-reason', async () => {
		const { user, organization } = await setup()
		for (const bad of [
			body({ confirm: false }),
			body({ reason: 'nonsense' }),
			body({ subReason: 'seasonal' }), // belongs to another reason
			body({ kind: 'cancel_locations', locationIds: [] }),
			body({ kind: 'downgrade', targetPlan: null }),
		]) {
			expect(
				await createCancelRequest({ organization, userId: user.id, body: bad }),
			).toEqual({ ok: false, error: 'invalid' })
		}
		expect(await loadOpenChangeRequest(organization.id)).toBeNull()
	})

	it("refuses locations that are not the organization's and a plan that does not exist", async () => {
		const { user, organization } = await setup()
		expect(
			await createCancelRequest({
				organization,
				userId: user.id,
				body: body({ kind: 'cancel_locations', locationIds: ['loc_other'] }),
			}),
		).toEqual({ ok: false, error: 'invalid_locations' })
		expect(
			await createCancelRequest({
				organization,
				userId: user.id,
				body: body({ kind: 'downgrade', targetPlan: 'Enterprise' }),
			}),
		).toEqual({ ok: false, error: 'no_smaller_plan' })
	})

	it('allows one open request at a time, and a withdrawn one frees the slot', async () => {
		const { user, organization } = await setup()
		const first = await createCancelRequest({
			organization,
			userId: user.id,
			body: body(),
		})
		expect(first.ok).toBe(true)
		expect(
			await createCancelRequest({
				organization,
				userId: user.id,
				body: body(),
			}),
		).toEqual({ ok: false, error: 'already_requested' })
		const open = await loadOpenChangeRequest(organization.id)
		expect(
			await withdrawCancelRequest({
				organizationId: organization.id,
				requestId: open!.id,
				userId: user.id,
			}),
		).toBe(true)
		expect(await loadOpenChangeRequest(organization.id)).toBeNull()
		expect(
			(
				await createCancelRequest({
					organization,
					userId: user.id,
					body: body(),
				})
			).ok,
		).toBe(true)
		expect(provider.calls).toEqual([])
	})

	it('has no subscription to change without a live one', async () => {
		const { user, organization } = await setup()
		expect(
			await createCancelRequest({
				organization: { ...organization, subscriptionStatus: 'canceled' },
				userId: user.id,
				body: body(),
			}),
		).toEqual({ ok: false, error: 'no_subscription' })
	})

	it('shows the retention offer when one is configured, as plain words only', async () => {
		const { organization } = await setup()
		expect(
			(await loadCancelRequestContext(organization)).retentionOffer,
		).toBeNull()
		await db.insert(ConfigFlag).values({
			key: 'billing.retention_offer',
			level: 'organization',
			organizationId: organization.id,
			value: 'Pause for two months, free. <b>Ask us.</b>',
		})
		const context = await loadCancelRequestContext(organization)
		expect(context.retentionOffer).toBe(
			'Pause for two months, free. bAsk us./b',
		)
		expect(context.downgradeTo).toBe('Base')
		expect(context.cutoff).toBe('2026-12-14T00:00:00.000Z')
	})
})
