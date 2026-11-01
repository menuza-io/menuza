import type * as DatabaseModule from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_CODES_PER_ORG, MAX_DISCOUNTS_PER_ORG } from './discounts.server.ts'
import {
	buildOrderContextDiscounts,
	buildPublicMenuDiscounts,
} from './order-context.server.ts'

const flags = vi.hoisted(() => ({
	values: {} as Record<string, unknown>,
}))
const rowsByTable = vi.hoisted(() => ({
	discount: [] as unknown[],
	code: [] as unknown[],
}))
/** What the code query was asked: a join to active discounts, and a row limit. */
const codeQuery = vi.hoisted(() => ({
	joined: false,
	limit: null as number | null,
}))

vi.mock('@repo/common/feature-flags', () => ({
	getFeatureFlag: async (key: string) => flags.values[key] ?? null,
}))

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof DatabaseModule>()
	const chain = (rows: unknown[]) => {
		const self: Record<string, unknown> = {
			where: () => self,
			orderBy: () => self,
			innerJoin: () => {
				codeQuery.joined = true
				return self
			},
			limit: (n: number) => {
				codeQuery.limit = n
				return self
			},
			// oxlint-disable-next-line unicorn/no-thenable
			then: (resolve: (value: unknown[]) => unknown) =>
				Promise.resolve(rows).then(resolve),
		}
		return self
	}
	return {
		...actual,
		db: {
			select: () => ({
				from: (table: unknown) =>
					chain(
						table === actual.Discount ? rowsByTable.discount : rowsByTable.code,
					),
			}),
		},
	}
})

const NOW = new Date('2026-10-30T12:00:00.000Z')

function discountRow(overrides: Record<string, unknown> = {}) {
	return {
		id: 'disc_1',
		organizationId: 'org_1',
		name: 'Happy hour',
		internalName: null,
		description: null,
		status: 'active',
		application: 'automatic',
		valueType: 'percent',
		percentBp: 1000,
		amountMinor: null,
		currency: null,
		maxDiscountMinor: null,
		target:
			'{"scope":"order","itemIds":[],"categoryIds":[],"excludeItemIds":[],"excludeCategoryIds":[]}',
		requirement: null,
		quantityRule: '{"kind":"none"}',
		maxDiscountedUnits: null,
		minSubtotalMinor: null,
		locationIds: null,
		channels: '["web","qr","pos","app"]',
		fulfillments: '["pickup","delivery","dine_in"]',
		includeDrops: false,
		schedule: null,
		startsAt: null,
		endsAt: null,
		eligibility: 'everyone',
		totalLimit: null,
		perCustomerLimit: null,
		combinable: false,
		priority: 0,
		promoteOnMenu: false,
		requireApproval: false,
		version: 3,
		createdById: null,
		createdAt: new Date('2026-10-01T00:00:00.000Z'),
		updatedAt: new Date('2026-10-02T00:00:00.000Z'),
		...overrides,
	}
}

function codeRow(overrides: Record<string, unknown> = {}) {
	return {
		id: 'code_1',
		organizationId: 'org_1',
		discountId: 'disc_2',
		code: 'save-10',
		normalizedCode: 'SAVE10',
		maxUses: 5,
		archivedAt: null,
		createdAt: new Date('2026-10-01T00:00:00.000Z'),
		...overrides,
	}
}

describe('buildOrderContextDiscounts', () => {
	beforeEach(() => {
		flags.values = {}
		rowsByTable.discount = []
		rowsByTable.code = []
		codeQuery.joined = false
		codeQuery.limit = null
	})

	it('reads only the codes of active discounts, and one row past the cap', async () => {
		flags.values = {
			'discounts.enabled': true,
			'discounts.coupons': true,
		}
		await buildOrderContextDiscounts('org_1', NOW)
		expect(codeQuery.joined).toBe(true)
		expect(codeQuery.limit).toBe(MAX_CODES_PER_ORG + 1)
	})

	it('keeps the oldest past the caps and logs counts, never names or codes', async () => {
		flags.values = {
			'discounts.enabled': true,
			'discounts.automatic': true,
			'discounts.coupons': true,
		}
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		rowsByTable.discount = [
			discountRow({ id: 'disc_code', application: 'code', name: 'Secret' }),
			...Array.from({ length: MAX_DISCOUNTS_PER_ORG }, (_, index) =>
				discountRow({ id: `auto_${index}`, name: 'Hidden name' }),
			),
		]
		rowsByTable.code = Array.from(
			{ length: MAX_CODES_PER_ORG + 1 },
			(_, index) =>
				codeRow({
					id: `code_${index}`,
					discountId: 'disc_code',
					normalizedCode: `CODE${index}`,
				}),
		)
		const result = await buildOrderContextDiscounts('org_1', NOW)
		expect(result.discounts).toHaveLength(MAX_DISCOUNTS_PER_ORG)
		expect(result.codes).toHaveLength(MAX_CODES_PER_ORG)
		expect(result.codes.at(-1)?.id).toBe(`code_${MAX_CODES_PER_ORG - 1}`)
		const logged = warn.mock.calls.map((call) => String(call[0]))
		expect(logged.some((line) => line.includes('discount cap'))).toBe(true)
		expect(logged.some((line) => line.includes('code cap'))).toBe(true)
		for (const line of logged) {
			expect(line).not.toMatch(/Secret|Hidden name|CODE\d/)
		}
		warn.mockRestore()
	})

	it('is off without the master flag, even with sub-flags on', async () => {
		flags.values = { 'discounts.automatic': true, 'discounts.coupons': true }
		rowsByTable.discount = [discountRow()]
		expect(await buildOrderContextDiscounts('org_1', NOW)).toEqual({
			features: { automatic: false, coupons: false },
			discounts: [],
			codes: [],
		})
	})

	it('folds each sub-flag with the master flag', async () => {
		flags.values = { 'discounts.enabled': true, 'discounts.automatic': true }
		const result = await buildOrderContextDiscounts('org_1', NOW)
		expect(result.features).toEqual({ automatic: true, coupons: false })
	})

	it('sends automatic and code discounts with their codes', async () => {
		flags.values = {
			'discounts.enabled': true,
			'discounts.automatic': true,
			'discounts.coupons': true,
		}
		rowsByTable.discount = [
			discountRow(),
			discountRow({ id: 'disc_2', application: 'code', name: 'Welcome' }),
			discountRow({ id: 'disc_3', application: 'manual' }),
		]
		rowsByTable.code = [
			codeRow(),
			codeRow({ id: 'code_x', discountId: 'disc_3' }),
		]
		const result = await buildOrderContextDiscounts('org_1', NOW)
		expect(result.discounts.map((d) => d.id)).toEqual(['disc_1', 'disc_2'])
		expect(result.discounts[0]).toMatchObject({
			version: 3,
			createdAt: '2026-10-01T00:00:00.000Z',
		})
		// A code of a discount the region never sees is dropped.
		expect(result.codes).toEqual([
			{
				id: 'code_1',
				discountId: 'disc_2',
				normalizedCode: 'SAVE10',
				maxUses: 5,
			},
		])
	})

	it('omits code discounts and codes when coupons are off', async () => {
		flags.values = { 'discounts.enabled': true, 'discounts.automatic': true }
		rowsByTable.discount = [
			discountRow(),
			discountRow({ id: 'disc_2', application: 'code' }),
		]
		rowsByTable.code = [codeRow()]
		const result = await buildOrderContextDiscounts('org_1', NOW)
		expect(result.discounts.map((d) => d.id)).toEqual(['disc_1'])
		expect(result.codes).toEqual([])
	})

	it('omits automatic discounts when automatic is off', async () => {
		flags.values = { 'discounts.enabled': true, 'discounts.coupons': true }
		rowsByTable.discount = [
			discountRow(),
			discountRow({ id: 'disc_2', application: 'code' }),
		]
		const result = await buildOrderContextDiscounts('org_1', NOW)
		expect(result.discounts.map((d) => d.id)).toEqual(['disc_2'])
	})

	it('skips expired discounts but keeps ones ending today', async () => {
		flags.values = { 'discounts.enabled': true, 'discounts.automatic': true }
		rowsByTable.discount = [
			discountRow({ id: 'old', endsAt: '2026-10-20T10:00' }),
			discountRow({ id: 'today', endsAt: '2026-10-30T09:00' }),
		]
		const result = await buildOrderContextDiscounts('org_1', NOW)
		expect(result.discounts.map((d) => d.id)).toEqual(['today'])
	})

	it('skips rows that fail validation and logs ids only', async () => {
		flags.values = { 'discounts.enabled': true, 'discounts.automatic': true }
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		rowsByTable.discount = [
			discountRow({ id: 'broken', target: '{not json', name: 'Secret' }),
			discountRow({ id: 'bad_value', percentBp: null }),
			discountRow({ id: 'fine' }),
		]
		const result = await buildOrderContextDiscounts('org_1', NOW)
		expect(result.discounts.map((d) => d.id)).toEqual(['fine'])
		expect(warn).toHaveBeenCalledTimes(2)
		for (const call of warn.mock.calls) {
			expect(String(call[0])).not.toContain('Secret')
		}
		warn.mockRestore()
	})

	it('never sends a parked placeholder or an invalid code row, and keeps the rest', async () => {
		flags.values = { 'discounts.enabled': true, 'discounts.coupons': true }
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		rowsByTable.discount = [
			discountRow({ id: 'disc_2', application: 'code', name: 'Welcome' }),
		]
		rowsByTable.code = [
			codeRow({ id: 'parked_row', normalizedCode: `parked:${'c'.repeat(24)}` }),
			codeRow({ id: 'short_parked', normalizedCode: 'parked:' }),
			codeRow({ id: 'too_long', normalizedCode: 'A'.repeat(25) }),
			codeRow({ id: 'too_short', normalizedCode: 'AB' }),
			codeRow({ id: 'bad_uses', maxUses: 0 }),
			codeRow({ id: 'fine', normalizedCode: 'WELCOME5' }),
		]
		const result = await buildOrderContextDiscounts('org_1', NOW)
		expect(result.codes.map((c) => c.id)).toEqual(['fine'])
		expect(result.discounts.map((d) => d.id)).toEqual(['disc_2'])
		expect(warn).toHaveBeenCalledTimes(5)
		for (const call of warn.mock.calls) {
			expect(String(call[0])).not.toContain('WELCOME5')
			expect(String(call[0])).not.toContain('parked:cc')
		}
		warn.mockRestore()
	})
})

describe('buildPublicMenuDiscounts', () => {
	const features = {
		'discounts.enabled': true,
		'discounts.automatic': true,
		'discounts.coupons': true,
	}

	beforeEach(() => {
		flags.values = { ...features }
		rowsByTable.discount = []
		rowsByTable.code = []
	})

	it('publishes a code only for one unlimited code on a promoted discount', async () => {
		rowsByTable.discount = [
			discountRow({
				id: 'disc_open',
				application: 'code',
				name: 'Welcome',
				promoteOnMenu: true,
			}),
			discountRow({
				id: 'disc_pair',
				application: 'code',
				name: 'Two codes',
				promoteOnMenu: true,
			}),
			discountRow({
				id: 'disc_limited',
				application: 'code',
				name: 'Once',
				promoteOnMenu: true,
			}),
			discountRow({
				id: 'disc_hidden',
				application: 'code',
				promoteOnMenu: false,
			}),
			discountRow({ id: 'disc_auto', promoteOnMenu: true }),
		]
		rowsByTable.code = [
			codeRow({
				id: 'c_open',
				discountId: 'disc_open',
				code: 'WELCOME10',
				maxUses: null,
			}),
			codeRow({
				id: 'c1',
				discountId: 'disc_pair',
				code: 'PAIR1',
				maxUses: null,
			}),
			codeRow({
				id: 'c2',
				discountId: 'disc_pair',
				code: 'PAIR2',
				maxUses: null,
			}),
			codeRow({
				id: 'c_lim',
				discountId: 'disc_limited',
				code: 'ONCE10',
				maxUses: 1,
			}),
			codeRow({ id: 'c_hid', discountId: 'disc_hidden', code: 'HIDDEN' }),
			codeRow({
				id: 'c_auto',
				discountId: 'disc_auto',
				code: 'AUTOCODE',
				maxUses: null,
			}),
		]
		const { promotions } = await buildPublicMenuDiscounts('org_1', NOW)
		expect(promotions.map((p) => [p.id, p.code])).toEqual([
			['disc_open', 'WELCOME10'],
			['disc_pair', null],
			['disc_limited', null],
			['disc_auto', null],
		])
		const published = JSON.stringify(promotions)
		// Extra codes, use-limited codes, and codes the operator did not
		// promote stay off the public menu.
		expect(published).not.toContain('PAIR1')
		expect(published).not.toContain('PAIR2')
		expect(published).not.toContain('ONCE10')
		expect(published).not.toContain('HIDDEN')
		expect(published).not.toContain('AUTOCODE')
	})

	it('has no code when coupons are off', async () => {
		flags.values = {
			'discounts.enabled': true,
			'discounts.automatic': true,
		}
		rowsByTable.discount = [
			discountRow({ id: 'disc_2', application: 'code', promoteOnMenu: true }),
		]
		rowsByTable.code = [codeRow()]
		const { promotions } = await buildPublicMenuDiscounts('org_1', NOW)
		expect(promotions).toEqual([])
	})

	it('trims by the clocks of every location, not by UTC', async () => {
		// NOW is 12:00 UTC on the 30th: local clocks run from 00:00 on the 30th
		// (UTC-12) to 02:00 on the 31st (UTC+14).
		rowsByTable.discount = [
			// A UTC+14 location has reached this start; the page checks its zone.
			discountRow({
				id: 'starts_east',
				promoteOnMenu: true,
				startsAt: '2026-10-31T01:00',
			}),
			// No location's clock is this late yet.
			discountRow({
				id: 'not_yet',
				promoteOnMenu: true,
				startsAt: '2026-10-31T03:00',
			}),
			// Over by UTC, but a UTC-12 location still reads 00:00 on the 30th.
			discountRow({
				id: 'ends_west',
				promoteOnMenu: true,
				endsAt: '2026-10-30T01:00',
			}),
			// Over everywhere.
			discountRow({
				id: 'over',
				promoteOnMenu: true,
				endsAt: '2026-10-29T23:00',
			}),
		]
		const { promotions } = await buildPublicMenuDiscounts('org_1', NOW)
		expect(promotions.map((p) => p.id)).toEqual(['starts_east', 'ends_west'])
	})
})
