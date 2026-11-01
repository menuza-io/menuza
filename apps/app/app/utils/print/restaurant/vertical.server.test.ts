import type * as AuthModuleNs from '@repo/auth'
import { Discount, db, eq } from '@repo/database'
import { type DiscountDefinition } from '@repo/discounts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import type * as AccessModuleNs from '../access.server.ts'

type AccessModule = typeof AccessModuleNs
type AuthModule = typeof AuthModuleNs

const mocks = vi.hoisted(() => ({
	enabled: true,
	allowed: true,
	printShop: true,
}))

vi.mock('#app/utils/discounts/access.server.ts', () => ({
	getDiscountsFeatures: async () => ({
		enabled: mocks.enabled,
		automatic: true,
		coupons: true,
	}),
}))
vi.mock('../access.server.ts', async (importOriginal) => ({
	...(await importOriginal<AccessModule>()),
	getPrintShopFeatures: async () => ({
		enabled: mocks.printShop,
		shipping: true,
		canva: false,
	}),
}))
vi.mock('@repo/auth', async (importOriginal) => ({
	...(await importOriginal<AuthModule>()),
	userHasOrganizationPermission: async () => mocks.allowed,
}))

const { createDiscount } =
	await import('#app/utils/discounts/discounts.server.ts')
const { restaurantPrintVertical } = await import('./vertical.server.ts')
const { couponPrintHref } = await import('./coupon.server.ts')

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

const coupon = restaurantPrintVertical.qrTargets!.coupon!

async function setup(
	definition: DiscountDefinition = base,
	codes = ['SAVE10'],
) {
	const { user, organization } = await setupTestOrgWithUser()
	const created = await createDiscount({
		organizationId: organization.id,
		userId: user.id,
		definition,
		codes: codes.map((code) => ({ id: null, code, maxUses: null })),
	})
	if (!created.ok) throw new Error('create failed')
	const access = {
		userId: user.id,
		organization: { id: organization.id, slug: organization.slug },
	} as never
	const context = {
		request: new Request('https://app.test/'),
		access,
		designId: 'design1',
		siteOrigin: 'https://acme.example',
		utm: { utm_source: 'print' },
	}
	const add = async (more: DiscountDefinition, moreCodes: string[] = []) => {
		const made = await createDiscount({
			organizationId: organization.id,
			userId: user.id,
			definition: more,
			codes: moreCodes.map((code) => ({ id: null, code, maxUses: null })),
		})
		if (!made.ok) throw new Error('create failed')
		return made
	}
	const firstCodeId = async (discountId: string) => {
		const editor = (await coupon.editorData!(context.request, access)) as {
			discounts: Array<{ id: string; codes: Array<{ id: string }> }>
		}
		return editor.discounts.find((d) => d.id === discountId)?.codes[0]?.id
	}
	return { created, organization, user, access, context, add, firstCodeId }
}

describe('coupon print target', () => {
	beforeEach(() => {
		mocks.enabled = true
		mocks.allowed = true
		mocks.printShop = true
	})

	it('prints the code and a menu link that carries it', async () => {
		const { created, context, access } = await setup()
		const editor = (await coupon.editorData!(context.request, access)) as {
			discounts: Array<{ id: string; codes: Array<{ id: string }> }>
		}
		const codeId = editor.discounts.find((d) => d.id === created.id)!.codes[0]!
			.id
		const { pieces, facts } = await coupon.resolve(
			{ kind: 'coupon', discountId: created.id, codeId },
			context,
		)
		expect(pieces).toHaveLength(1)
		expect(pieces[0]!.label).toBe('SAVE10')
		const url = new URL(pieces[0]!.qrUrl!)
		expect(url.origin + url.pathname).toBe('https://acme.example/menu')
		expect(url.searchParams.get('coupon')).toBe('SAVE10')
		expect(url.searchParams.get('utm_source')).toBe('print')
		expect(facts).toEqual([
			{ id: `code:${codeId}`, label: 'SAVE10', version: 1 },
		])
	})

	it('prints nothing once the discount is paused, so approval is refused', async () => {
		const { created, context } = await setup()
		await db
			.update(Discount)
			.set({ status: 'paused' })
			.where(eq(Discount.id, created.id))
		const result = await coupon.resolve(
			{ kind: 'coupon', discountId: created.id, codeId: 'whatever' },
			context,
		)
		expect(result).toEqual({ pieces: [], facts: [] })
	})

	it('prints nothing for a removed code or another organization’s discount', async () => {
		const mine = await setup()
		const other = await setup()
		expect(
			await coupon.resolve(
				{ kind: 'coupon', discountId: mine.created.id, codeId: 'gone' },
				mine.context,
			),
		).toEqual({ pieces: [], facts: [] })
		expect(
			await coupon.resolve(
				{ kind: 'coupon', discountId: other.created.id, codeId: null },
				mine.context,
			),
		).toEqual({ pieces: [], facts: [] })
	})

	it('links an automatic discount to the menu without a code', async () => {
		const { created, context } = await setup(
			{ ...base, application: 'automatic' },
			[],
		)
		const { pieces } = await coupon.resolve(
			{ kind: 'coupon', discountId: created.id, codeId: null },
			context,
		)
		expect(pieces[0]!.label).toBeNull()
		expect(new URL(pieces[0]!.qrUrl!).searchParams.has('coupon')).toBe(false)
	})

	it('refuses the codes without the feature or the permission', async () => {
		const { created, context, access } = await setup()
		const target = { kind: 'coupon', discountId: created.id, codeId: null }
		mocks.allowed = false
		expect(await coupon.canView!(access)).toBe(false)
		await expect(coupon.resolve(target, context)).rejects.toMatchObject({
			status: 403,
		})
		mocks.allowed = true
		mocks.enabled = false
		expect(await coupon.available!(access)).toBe(false)
	})

	it('starts the headline, message and call to action from the discount', async () => {
		const { created, access, firstCodeId } = await setup({
			...base,
			endsAt: '2027-01-01T00:00',
			minSubtotalMinor: 2000,
			currency: 'USD',
		})
		const target = {
			kind: 'coupon',
			discountId: created.id,
			codeId: (await firstCodeId(created.id))!,
		}
		expect(await coupon.defaultCopy!(target, 'en', access)).toEqual({
			headline: '10% off',
			body: 'Valid until December 31, 2026. Pickup orders only. Online orders only. Minimum order $20.',
			callToAction: 'Scan to order. Your code is added for you.',
		})
		expect(
			await coupon.defaultCopy!(
				{ ...target, discountId: 'missing' },
				'en',
				access,
			),
		).toBeNull()
	})

	it('lists only offers a printed QR can use', async () => {
		const { created, access, context, add } = await setup()
		const tillOnly = await add({ ...base, name: 'Till', channels: ['pos'] }, [
			'TILL1',
		])
		const ended = await add(
			{
				...base,
				name: 'Ended',
				startsAt: '2025-01-01T00:00',
				endsAt: '2025-02-01T00:00',
			},
			['OLD1'],
		)
		const automatic = await add({
			...base,
			name: 'Auto',
			application: 'automatic',
		})
		const editor = (await coupon.editorData!(context.request, access)) as {
			discounts: Array<{ id: string; application: string; href: string }>
			hidden: number
		}
		expect(editor.discounts.map((d) => d.id).sort()).toEqual(
			[created.id, automatic.id].sort(),
		)
		expect(editor.hidden).toBe(2)
		expect(editor.discounts[0]!.href).toMatch(/\/discounts\//)
		for (const id of [tillOnly.id, ended.id]) {
			expect(
				await coupon.resolve(
					{ kind: 'coupon', discountId: id, codeId: null },
					context,
				),
			).toEqual({ pieces: [], facts: [] })
		}
	})

	it('opens the menu of the one location the offer works at', async () => {
		const { created, context, firstCodeId } = await setup({
			...base,
			locationIds: ['loc_1'],
		})
		const { pieces } = await coupon.resolve(
			{
				kind: 'coupon',
				discountId: created.id,
				codeId: (await firstCodeId(created.id))!,
			},
			context,
		)
		expect(new URL(pieces[0]!.qrUrl!).searchParams.get('location')).toBe(
			'loc_1',
		)
	})

	it('starts a coupon card on the latest offer, or on the one it came from', async () => {
		const { created, access, add, firstCodeId } = await setup()
		const other = await add({ ...base, name: 'Other' }, ['OTHER1'])
		const product = { key: 'coupon_card' } as never
		const flyer = { key: 'flyer' } as never
		const fromRef = await coupon.defaultFor!(access, {
			product: flyer,
			scope: null,
			ref: created.id,
		})
		expect(fromRef).toEqual({
			kind: 'coupon',
			discountId: created.id,
			codeId: await firstCodeId(created.id),
		})
		const latest = await coupon.defaultFor!(access, { product, scope: null })
		expect([created.id, other.id]).toContain(
			(latest as unknown as { discountId: string }).discountId,
		)
		// A flyer keeps its own start unless it came from a discount.
		expect(
			await coupon.defaultFor!(access, { product: flyer, scope: null }),
		).toBeNull()
		// An id from the address bar that is not a printable offer of the org.
		expect(
			await coupon.defaultFor!(access, {
				product,
				scope: null,
				ref: 'someone-elses',
			}),
		).toBeNull()
	})

	it('links "Print coupons" only when the offer and the Print shop allow it', async () => {
		const { created, organization, user } = await setup()
		const input = {
			userId: user.id,
			organization: { id: organization.id, slug: organization.slug },
			discount: {
				id: created.id,
				status: 'active',
				definition: base,
				codeCount: 1,
			},
		}
		expect(await couponPrintHref(input)).toBe(
			`/${organization.slug}/marketing/print/new?product=coupon_card&start=coupon%3A${created.id}`,
		)
		expect(
			await couponPrintHref({
				...input,
				discount: { ...input.discount, codeCount: 0 },
			}),
		).toBeNull()
		expect(
			await couponPrintHref({
				...input,
				discount: { ...input.discount, status: 'paused' },
			}),
		).toBeNull()
		mocks.printShop = false
		expect(await couponPrintHref(input)).toBeNull()
		mocks.printShop = true
		mocks.allowed = false
		expect(await couponPrintHref(input)).toBeNull()
	})

	it('reads the form back', () => {
		const form = new FormData()
		expect(coupon.fromForm(form)).toBe('empty')
		form.set('couponDiscountId', 'd1')
		expect(coupon.fromForm(form)).toEqual({
			kind: 'coupon',
			discountId: 'd1',
			codeId: null,
		})
		form.set('couponCodeId', 'c1')
		expect(coupon.fromForm(form)).toMatchObject({ codeId: 'c1' })
	})
})
