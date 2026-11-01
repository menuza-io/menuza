import { type DiscountDefinition } from '@repo/discounts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { createDiscount, setDiscountStatus } from './discounts.server.ts'
import {
	checkJourneyOffers,
	checkMarketingOffer,
	loadCouponDiscountOptions,
	readOfferField,
} from './marketing-offers.server.ts'

const flags = vi.hoisted(() => ({ values: {} as Record<string, unknown> }))

vi.mock('@repo/common/feature-flags', () => ({
	getFeatureFlag: async (key: string) => flags.values[key] ?? null,
}))

const ON = {
	'discounts.enabled': true,
	'discounts.automatic': true,
	'discounts.coupons': true,
}

const base: DiscountDefinition = {
	name: 'Welcome back',
	internalName: null,
	description: null,
	status: 'active',
	application: 'code',
	valueType: 'percent',
	percentBp: 1000,
	amountMinor: null,
	currency: null,
	maxDiscountMinor: null,
	target: {
		scope: 'order',
		itemIds: [],
		categoryIds: [],
		excludeItemIds: [],
		excludeCategoryIds: [],
	},
	requirement: null,
	quantityRule: { kind: 'none' },
	maxDiscountedUnits: null,
	minSubtotalMinor: null,
	locationIds: null,
	channels: ['web'],
	fulfillments: ['pickup'],
	includeDrops: false,
	schedule: null,
	startsAt: null,
	endsAt: null,
	eligibility: 'everyone',
	totalLimit: null,
	perCustomerLimit: null,
	combinable: true,
	priority: 0,
	promoteOnMenu: false,
	requireApproval: false,
}

async function setup(role: 'admin' | 'viewer' = 'admin') {
	const { user, organization } = await setupTestOrgWithUser(role)
	const withCode = await createDiscount({
		organizationId: organization.id,
		userId: user.id,
		definition: base,
		codes: [{ id: null, code: 'Save-10', maxUses: null }],
	})
	const marketingOnly = await createDiscount({
		organizationId: organization.id,
		userId: user.id,
		definition: { ...base, name: 'Lapsed guests' },
		codes: [],
	})
	const automatic = await createDiscount({
		organizationId: organization.id,
		userId: user.id,
		definition: { ...base, name: 'Happy hour', application: 'automatic' },
		codes: [],
	})
	if (!withCode.ok || !marketingOnly.ok || !automatic.ok) {
		throw new Error('setup failed')
	}
	return {
		userId: user.id,
		organizationId: organization.id,
		withCode: withCode.id,
		marketingOnly: marketingOnly.id,
		automatic: automatic.id,
	}
}

describe('coupons in marketing messages', () => {
	beforeEach(() => {
		flags.values = { ...ON }
	})

	it('lists active code discounts with their codes, including code-less ones', async () => {
		const org = await setup()
		const options = await loadCouponDiscountOptions(
			org.userId,
			org.organizationId,
		)
		expect(options).toEqual([
			{ id: org.marketingOnly, name: 'Lapsed guests', codes: [] },
			{ id: org.withCode, name: 'Welcome back', codes: ['Save-10'] },
		])
	})

	it('offers nothing while coupons are off or without read:discount:any', async () => {
		const org = await setup()
		flags.values = { ...ON, 'discounts.coupons': false }
		expect(
			await loadCouponDiscountOptions(org.userId, org.organizationId),
		).toBeNull()

		flags.values = { ...ON }
		const guest = await setupTestOrgWithUser('guest')
		expect(
			await loadCouponDiscountOptions(guest.user.id, guest.organization.id),
		).toBeNull()
	})

	it('accepts a unique coupon and a shared code, written as stored', async () => {
		const org = await setup()
		const unique = await checkMarketingOffer({
			...org,
			raw: { mode: 'unique', discountId: org.marketingOnly, prefix: 'back' },
			texts: ['Your code: {{couponCode}}'],
		})
		expect(unique).toEqual({
			ok: true,
			offer: {
				mode: 'unique',
				discountId: org.marketingOnly,
				prefix: 'BACK',
				validDays: 30,
			},
		})
		const shared = await checkMarketingOffer({
			...org,
			raw: { mode: 'shared', discountId: org.withCode, code: 'SAVE10' },
			texts: ['{{couponCode|SAVE10}}'],
		})
		expect(shared).toEqual({
			ok: true,
			offer: { mode: 'shared', discountId: org.withCode, code: 'Save-10' },
		})
	})

	it('refuses what the message cannot honour', async () => {
		const org = await setup()
		const check = (raw: unknown, texts = ['{{couponCode}}']) =>
			checkMarketingOffer({ ...org, raw, texts })

		expect(await check(null)).toEqual({ ok: false, error: 'offer_missing' })
		expect(await check(null, ['plain'])).toEqual({ ok: true, offer: null })
		expect(
			await check({ mode: 'unique', discountId: org.withCode }, ['plain']),
		).toEqual({ ok: false, error: 'tag_missing' })
		expect(await check({ mode: 'other' })).toEqual({
			ok: false,
			error: 'invalid',
		})
		expect(await check({ mode: 'unique', discountId: org.automatic })).toEqual({
			ok: false,
			error: 'discount_unavailable',
		})
		expect(
			await check({ mode: 'shared', discountId: org.withCode, code: 'NOPE' }),
		).toEqual({ ok: false, error: 'code_unavailable' })

		await setDiscountStatus({
			organizationId: org.organizationId,
			discountId: org.withCode,
			expectedVersion: 1,
			status: 'paused',
		})
		expect(await check({ mode: 'unique', discountId: org.withCode })).toEqual({
			ok: false,
			error: 'discount_unavailable',
		})
	})

	it('reads the posted field', () => {
		expect(readOfferField('')).toBeNull()
		expect(readOfferField(null)).toBeNull()
		expect(readOfferField('{"mode":"unique"}')).toEqual({ mode: 'unique' })
		expect(readOfferField('{oops')).toEqual({ invalid: true })
	})

	describe('automations', () => {
		const offer = (discountId: string) => ({
			mode: 'unique',
			discountId,
			prefix: '',
			validDays: 30,
		})

		it('checks each step, keeps checked coupons and drops empty ones', async () => {
			const org = await setup()
			const result = await checkJourneyOffers({
				...org,
				storedNodes: [],
				nodes: [
					{ id: 't', type: 'trigger', data: {} },
					{
						id: 'sms',
						type: 'action_sms',
						data: {
							messageText: 'Use {{couponCode}}',
							discountOffer: offer(org.marketingOnly),
						},
					},
					{
						id: 'mail',
						type: 'action_email',
						data: { subject: 'Hi', bodyHtml: '<p>Hi</p>', discountOffer: null },
					},
				],
			})
			expect(result).toEqual({
				ok: true,
				nodes: [
					{ id: 't', type: 'trigger', data: {} },
					{
						id: 'sms',
						type: 'action_sms',
						data: {
							messageText: 'Use {{couponCode}}',
							discountOffer: offer(org.marketingOnly),
						},
					},
					{
						id: 'mail',
						type: 'action_email',
						data: { subject: 'Hi', bodyHtml: '<p>Hi</p>' },
					},
				],
			})
		})

		it('lets someone without discount access keep a saved coupon, but not add one', async () => {
			const org = await setup()
			const guest = await setupTestOrgWithUser('guest')
			// The guest is checked against the first org's discounts here only
			// to model a member who cannot read discounts.
			const step = {
				id: 'sms',
				type: 'action_sms',
				data: {
					messageText: '{{couponCode}}',
					discountOffer: offer(org.marketingOnly),
				},
			}
			const asGuest = {
				userId: guest.user.id,
				organizationId: org.organizationId,
			}
			expect(
				await checkJourneyOffers({
					...asGuest,
					storedNodes: [],
					nodes: [step],
				}),
			).toEqual({ ok: false, error: 'not_allowed' })
			expect(
				await checkJourneyOffers({
					...asGuest,
					storedNodes: [step],
					nodes: [step],
				}),
			).toMatchObject({ ok: true })
		})
	})
})
