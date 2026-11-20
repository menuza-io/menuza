import {
	COUPON_NOT_VALID_ONLINE,
	sitePopupInputSchema,
} from '@repo/common/site-popup'
import { db, eq, SitePopup } from '@repo/database'
import { type DiscountDefinition } from '@repo/discounts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDiscount } from '#app/utils/discounts/discounts.server.ts'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import {
	checkPopupCoupon,
	loadPublicPopups,
	popupsEnabled,
	safePopupButtonUrl,
	savePopup,
	setPopupStatus,
	type UsageReader,
} from './popups.server.ts'

const flags = vi.hoisted(() => ({ values: {} as Record<string, unknown> }))

vi.mock('@repo/common/feature-flags', () => ({
	getFeatureFlag: async (key: string) => flags.values[key] ?? null,
}))

const ON = {
	'discounts.enabled': true,
	'discounts.automatic': true,
	'discounts.coupons': true,
	'website.popups': true,
}

const base: DiscountDefinition = {
	name: 'Welcome',
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

const NOW = new Date(Date.UTC(2026, 10, 20, 12, 0, 0))
const noUses: UsageReader = async () => ({})

async function setup(
	overrides: Partial<DiscountDefinition> = {},
	role: 'admin' | 'viewer' = 'admin',
) {
	const { user, organization } = await setupTestOrgWithUser(role)
	const created = await createDiscount({
		organizationId: organization.id,
		userId: user.id,
		definition: { ...base, ...overrides },
		codes: [{ id: null, code: 'WELCOME', maxUses: null }],
	})
	if (!created.ok) throw new Error('setup failed')
	return {
		userId: user.id,
		organization: { id: organization.id, dataRegion: 'us' as string | null },
		discountId: created.id,
	}
}

const values = (discountId: string | null) =>
	sitePopupInputSchema.parse({
		name: 'First order',
		title: 'Get 10% off',
		body: 'Use code WELCOME at checkout',
		buttonLabel: 'Order now',
		discountId,
	})

describe('popup coupons (#132)', () => {
	beforeEach(() => {
		flags.values = { ...ON }
	})

	it('saves a popup with a valid online coupon', async () => {
		const org = await setup()
		const saved = await savePopup({
			userId: org.userId,
			organization: org.organization,
			popupId: null,
			values: values(org.discountId),
			now: NOW,
			readUses: noUses,
		})
		expect(saved.ok).toBe(true)
	})

	it('refuses an in-store-only coupon with coupon_not_valid_online', async () => {
		const org = await setup({ channels: ['pos'] })
		const saved = await savePopup({
			userId: org.userId,
			organization: org.organization,
			popupId: null,
			values: values(org.discountId),
			now: NOW,
			readUses: noUses,
		})
		expect(saved).toEqual({ ok: false, error: COUPON_NOT_VALID_ONLINE })
		expect(
			await db
				.select()
				.from(SitePopup)
				.where(eq(SitePopup.organizationId, org.organization.id)),
		).toHaveLength(0)
	})

	it('refuses an expired coupon with coupon_not_valid_online', async () => {
		const org = await setup({ endsAt: '2026-11-19T00:00' })
		const saved = await savePopup({
			userId: org.userId,
			organization: org.organization,
			popupId: null,
			values: values(org.discountId),
			now: NOW,
			readUses: noUses,
		})
		expect(saved).toEqual({ ok: false, error: COUPON_NOT_VALID_ONLINE })
	})

	it('refuses a coupon that is used up, paused or not yet started', async () => {
		const usedUp = await setup({ totalLimit: 5 })
		expect(
			await savePopup({
				userId: usedUp.userId,
				organization: usedUp.organization,
				popupId: null,
				values: values(usedUp.discountId),
				now: NOW,
				readUses: async () => ({ [usedUp.discountId]: 5 }),
			}),
		).toEqual({ ok: false, error: COUPON_NOT_VALID_ONLINE })
		const paused = await setup({ status: 'paused' })
		expect(
			await savePopup({
				userId: paused.userId,
				organization: paused.organization,
				popupId: null,
				values: values(paused.discountId),
				now: NOW,
				readUses: noUses,
			}),
		).toEqual({ ok: false, error: COUPON_NOT_VALID_ONLINE })
		const early = await setup({ startsAt: '2026-12-01T00:00' })
		expect(
			(
				await checkPopupCoupon({
					organization: early.organization,
					discountId: early.discountId,
					now: NOW,
					readUses: noUses,
					timeZone: 'UTC',
				})
			).ok,
		).toBe(false)
	})

	it('a coupon needs the discounts permission, like marketing coupons', async () => {
		const org = await setup({}, 'viewer')
		const saved = await savePopup({
			userId: org.userId,
			organization: org.organization,
			popupId: null,
			values: values(org.discountId),
			now: NOW,
			readUses: noUses,
		})
		expect(saved).toEqual({ ok: false, error: 'coupon_not_allowed' })
	})

	it('a discount of another organization is not a valid coupon', async () => {
		const mine = await setup()
		const other = await setup()
		const saved = await savePopup({
			userId: mine.userId,
			organization: mine.organization,
			popupId: null,
			values: values(other.discountId),
			now: NOW,
			readUses: noUses,
		})
		expect(saved).toEqual({ ok: false, error: COUPON_NOT_VALID_ONLINE })
	})

	it('a popup with no coupon saves without the discounts permission', async () => {
		const org = await setup({}, 'viewer')
		expect(
			(
				await savePopup({
					userId: org.userId,
					organization: org.organization,
					popupId: null,
					values: values(null),
				})
			).ok,
		).toBe(true)
	})
})

describe('the public popups (#132)', () => {
	beforeEach(() => {
		flags.values = { ...ON }
	})

	async function published(org: Awaited<ReturnType<typeof setup>>) {
		const saved = await savePopup({
			userId: org.userId,
			organization: org.organization,
			popupId: null,
			values: values(org.discountId),
			now: NOW,
			readUses: noUses,
		})
		if (!saved.ok) throw new Error('save failed')
		const status = await setPopupStatus({
			organization: org.organization,
			popupId: saved.id,
			status: 'published',
			now: NOW,
			readUses: noUses,
		})
		expect(status).toEqual({ ok: true })
		return saved.id
	}
	const load = (org: Awaited<ReturnType<typeof setup>>, now = NOW) =>
		loadPublicPopups({
			organization: org.organization,
			locale: 'en',
			defaultLocale: 'en',
			now,
			readUses: noUses,
		})

	it('sends the coupon code of a published popup', async () => {
		const org = await setup()
		const id = await published(org)
		const popups = await load(org)
		expect(popups).toHaveLength(1)
		expect(popups[0]).toMatchObject({
			id,
			couponCode: 'WELCOME',
			buttonUrl: null,
			trigger: 'delay',
			frequency: 'day',
			pages: ['all'],
		})
	})

	it('stops showing when the coupon expires after publishing', async () => {
		const org = await setup({ endsAt: '2026-11-21T00:00' })
		await published(org)
		expect(await load(org)).toHaveLength(1)
		const later = new Date(Date.UTC(2026, 10, 22, 12, 0, 0))
		expect(await load(org, later)).toHaveLength(0)
	})

	it('stops showing when the coupon is switched off', async () => {
		const org = await setup()
		await published(org)
		await db
			.update((await import('@repo/database')).Discount)
			.set({ status: 'paused' })
			.where(eq((await import('@repo/database')).Discount.id, org.discountId))
		expect(await load(org)).toHaveLength(0)
	})

	it('sends nothing while website.popups is off or for a draft', async () => {
		const org = await setup()
		await published(org)
		flags.values = { ...ON, 'website.popups': false }
		expect(await load(org)).toEqual([])
		expect(await popupsEnabled(org.organization.id)).toBe(false)
		flags.values = { ...ON }
		await db.update(SitePopup).set({ status: 'draft' })
		expect(await load(org)).toEqual([])
	})

	it('refuses to publish a popup whose coupon is dead', async () => {
		const org = await setup({ endsAt: '2026-11-19T00:00' })
		const [row] = await db
			.insert(SitePopup)
			.values({
				organizationId: org.organization.id,
				name: 'x',
				title: 't',
				discountId: org.discountId,
			})
			.returning({ id: SitePopup.id })
		expect(
			await setPopupStatus({
				organization: org.organization,
				popupId: row!.id,
				status: 'published',
				now: NOW,
				readUses: noUses,
			}),
		).toEqual({ ok: false, error: COUPON_NOT_VALID_ONLINE })
	})

	it('only passes a button link that stays on the site or is https', () => {
		expect(safePopupButtonUrl('/menu')).toBe('/menu')
		expect(safePopupButtonUrl('https://example.com/x')).toBe(
			'https://example.com/x',
		)
		expect(safePopupButtonUrl('javascript:alert(1)')).toBeNull()
		expect(safePopupButtonUrl('//evil.example')).toBeNull()
		expect(safePopupButtonUrl('http://example.com')).toBeNull()
		expect(safePopupButtonUrl(null)).toBeNull()
	})
})
