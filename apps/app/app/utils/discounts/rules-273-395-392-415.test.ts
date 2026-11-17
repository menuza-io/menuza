import { describe, expect, it, vi } from 'vitest'
import { type DiscountRecord } from '@repo/discounts'
import {
	discountAlertKindFromNotificationType,
	discountAlertPath,
} from './discount-alerts.ts'
import {
	emptyEditorState,
	promoteOnMenuAllowed,
	stateFromDefinition,
	stateToDefinition,
	type EditorState,
} from './editor-model.ts'
import { discountDisplayState } from './labels.ts'
import { publicPromotionFor } from './public-promotion.ts'
import { createDiscountUsageClient } from './usage-client.ts'

const EN = { locales: ['en'], defaultLocale: 'en' }
const OPTIONS = { currency: 'USD', status: 'active' as const, locales: EN }

function state(overrides: Partial<EditorState>): EditorState {
	return {
		...emptyEditorState(),
		name: { en: 'Pizza deal' },
		percent: '20',
		...overrides,
	}
}
const convert = (overrides: Partial<EditorState>) =>
	stateToDefinition(state(overrides), OPTIONS)

const ITEMS = { scope: 'items' as const, itemIds: ['pizza'] }

describe('the cap and the item limit (#273)', () => {
	it('stores a maximum on a percentage in the currency minor unit', () => {
		const result = convert({ maxDiscount: '15' })
		expect(result.ok && result.definition).toMatchObject({
			percentBp: 2000,
			maxDiscountMinor: 1500,
			currency: 'USD',
		})
	})

	it('stores an item limit on an item discount', () => {
		const result = convert({ ...ITEMS, maxUnits: '2' })
		expect(result.ok && result.definition).toMatchObject({
			maxDiscountedUnits: 2,
		})
	})
})

describe('which eligible item is discounted first (#395)', () => {
	it('stores cheapest first only with an item limit, and leaves the default out', () => {
		const cheapest = convert({ ...ITEMS, maxUnits: '1', itemChoice: 'cheapest' })
		expect(cheapest.ok && cheapest.definition.itemChoice).toBe('cheapest')
		const dearest = convert({ ...ITEMS, maxUnits: '1', itemChoice: 'dearest' })
		expect(dearest.ok && 'itemChoice' in dearest.definition).toBe(false)
	})

	it('drops the choice when it would mean nothing', () => {
		// No limit, a whole-order discount, a buy-one-get-one rule.
		for (const overrides of [
			{ ...ITEMS, maxUnits: '' },
			{ scope: 'order' as const, maxUnits: '1' },
			{
				...ITEMS,
				maxUnits: '1',
				quantityKind: 'bogo' as const,
				buyQuantity: '1',
				getQuantity: '1',
			},
		]) {
			const result = convert({ ...overrides, itemChoice: 'cheapest' })
			expect(result.ok).toBe(true)
			expect(result.ok && 'itemChoice' in result.definition).toBe(false)
		}
	})

	it('opens an old discount as most expensive first, and a cheapest one as cheapest', () => {
		const stored = convert({ ...ITEMS, maxUnits: '1', itemChoice: 'cheapest' })
		if (!stored.ok) throw new Error('definition')
		expect(
			stateFromDefinition(stored.definition, [], 'USD', EN).itemChoice,
		).toBe('cheapest')
		const { itemChoice: ignored, ...older } = stored.definition
		expect(stateFromDefinition(older, [], 'USD', EN).itemChoice).toBe('dearest')
	})
})

describe('a weekly budget (#392)', () => {
	it('stores the budget in the currency and for automatic and code discounts only', () => {
		const result = convert({ weeklyBudget: '100' })
		expect(result.ok && result.definition).toMatchObject({
			weeklyBudgetMinor: 10_000,
			currency: 'USD',
		})
		const manual = convert({ application: 'manual', weeklyBudget: '100' })
		expect(manual.ok && 'weeklyBudgetMinor' in manual.definition).toBe(false)
	})

	it('says when the amount is not a number', () => {
		expect(convert({ weeklyBudget: 'lots' })).toEqual({
			ok: false,
			errors: { weeklyBudget: 'amount' },
		})
	})

	it('round trips', () => {
		const result = convert({ weeklyBudget: '100' })
		if (!result.ok) throw new Error('definition')
		expect(
			stateFromDefinition(result.definition, [], 'USD', EN).weeklyBudget,
		).toBe('100.00')
	})

	it('shows Paused: budget reached once the week has spent it', () => {
		const input = {
			status: 'active',
			startsAt: null,
			endsAt: null,
			totalLimit: null,
			uses: 0,
			weeklyBudgetMinor: 10_000,
		}
		expect(discountDisplayState({ ...input, weekGivenMinor: 9_999 }, null)).toBe(
			'active',
		)
		expect(
			discountDisplayState({ ...input, weekGivenMinor: 10_000 }, null),
		).toBe('budget_reached')
		// Not read yet, or no budget: nothing to say.
		expect(discountDisplayState({ ...input, weekGivenMinor: null }, null)).toBe(
			'active',
		)
		expect(
			discountDisplayState(
				{ ...input, weeklyBudgetMinor: null, weekGivenMinor: 99_999 },
				null,
			),
		).toBe('active')
		// A paused discount stays paused.
		expect(
			discountDisplayState(
				{ ...input, status: 'paused', weekGivenMinor: 10_000 },
				null,
			),
		).toBe('paused')
	})
})

describe('a saved audience (#415)', () => {
	it('stores the audience and makes the discount for signed-in guests', () => {
		const result = convert({ audienceId: 'aud_1' })
		expect(result.ok && result.definition).toMatchObject({
			audienceId: 'aud_1',
			eligibility: 'signed_in',
		})
	})

	it('keeps a stricter eligibility as chosen', () => {
		const result = convert({ audienceId: 'aud_1', eligibility: 'loyalty_member' })
		expect(result.ok && result.definition.eligibility).toBe('loyalty_member')
	})

	it('is not stored for a till discount, and leaves a discount without one alone', () => {
		const manual = convert({ application: 'manual', audienceId: 'aud_1' })
		expect(manual.ok && 'audienceId' in manual.definition).toBe(false)
		const plain = convert({})
		expect(plain.ok && 'audienceId' in plain.definition).toBe(false)
		expect(plain.ok && plain.definition.eligibility).toBe('everyone')
	})

	it('is never promoted on the menu', () => {
		expect(promoteOnMenuAllowed({ eligibility: 'everyone' })).toBe(true)
		expect(
			promoteOnMenuAllowed({ eligibility: 'signed_in', audienceId: 'aud_1' }),
		).toBe(false)
		const result = convert({ audienceId: 'aud_1', promoteOnMenu: true })
		expect(result.ok && result.definition.promoteOnMenu).toBe(false)
	})

	it('round trips', () => {
		const result = convert({ audienceId: 'aud_1' })
		if (!result.ok) throw new Error('definition')
		expect(
			stateFromDefinition(result.definition, [], 'USD', EN).audienceId,
		).toBe('aud_1')
	})
})

describe('what the public menu says about the limits (#273)', () => {
	const record = (overrides: Record<string, unknown> = {}): DiscountRecord =>
		({
			id: 'd1',
			version: 1,
			createdAt: '2026-01-01T00:00:00.000Z',
			name: 'Twenty off',
			internalName: null,
			description: null,
			status: 'active',
			application: 'automatic',
			valueType: 'percent',
			percentBp: 2000,
			amountMinor: null,
			currency: 'USD',
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
			fulfillments: ['pickup', 'delivery', 'dine_in'],
			includeDrops: false,
			schedule: null,
			startsAt: null,
			endsAt: null,
			eligibility: 'everyone',
			totalLimit: null,
			perCustomerLimit: null,
			combinable: false,
			priority: 0,
			promoteOnMenu: true,
			requireApproval: false,
			...overrides,
		}) as DiscountRecord

	it('carries a cap, and shows the offer by name', () => {
		const promotion = publicPromotionFor(record({ maxDiscountMinor: 1500 }))
		expect(promotion).toMatchObject({
			maxDiscountMinor: 1500,
			currency: 'USD',
			showName: true,
		})
		expect(promotion && 'maxUnits' in promotion).toBe(false)
	})

	it('carries an item limit on an item discount', () => {
		const promotion = publicPromotionFor(
			record({
				target: {
					scope: 'items',
					itemIds: ['pizza'],
					categoryIds: [],
					excludeItemIds: [],
					excludeCategoryIds: [],
				},
				maxDiscountedUnits: 2,
			}),
		)
		expect(promotion).toMatchObject({ maxUnits: 2, showName: true })
	})

	it('leaves both out when there are none, so an older menu reads the same', () => {
		const promotion = publicPromotionFor(record())
		expect(promotion && 'maxDiscountMinor' in promotion).toBe(false)
		expect(promotion && 'maxUnits' in promotion).toBe(false)
	})
})

describe('the discount usage client', () => {
	const TOKEN = {
		jwt: 'jwt-1',
		tenantApiUrl: 'https://us.example.test/',
		expiresAt: 10_000_000,
	}

	it('asks for the week a budget is spent in', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(JSON.stringify(TOKEN)))
			.mockResolvedValue(
				new Response(
					JSON.stringify({
						usage: [
							{
								discountId: 'd1',
								uses: 1,
								reserved: 0,
								consumed: 1,
								refunded: 0,
								discountMinor: 200,
								capReached: 1,
								weekGivenMinor: 200,
							},
						],
					}),
				),
			)
		const client = createDiscountUsageClient({
			orgSlug: 'acme',
			fetchImpl,
			now: () => 0,
		})
		const usage = await client.fetchUsage(['d1'], undefined, {
			week: '2026-W46',
		})
		expect(usage?.d1).toMatchObject({ capReached: 1, weekGivenMinor: 200 })
		expect(String(fetchImpl.mock.calls[1]![0])).toContain('week=2026-W46')
	})

	it('reads performance for a period and basis', async () => {
		const body = {
			basis: 'gross',
			entries: [
				{ discountId: 'd1', orders: 10, salesMinor: 18_000, discountMinor: 2000 },
			],
			ordersTotal: 40,
			ordersWithDiscount: 10,
		}
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(JSON.stringify(TOKEN)))
			.mockResolvedValue(new Response(JSON.stringify(body)))
		const client = createDiscountUsageClient({
			orgSlug: 'acme',
			fetchImpl,
			now: () => 0,
		})
		const result = await client.fetchPerformance({
			ids: ['d1'],
			from: '2026-11-01',
			to: '2026-11-30',
			tz: 'America/New_York',
			basis: 'gross',
		})
		expect(result).toEqual(body)
		const url = new URL(String(fetchImpl.mock.calls[1]![0]))
		expect(url.pathname).toBe('/operator/discounts/performance')
		expect(Object.fromEntries(url.searchParams)).toEqual({
			ids: 'd1',
			from: '2026-11-01',
			to: '2026-11-30',
			basis: 'gross',
			tz: 'America/New_York',
		})
	})

	it('answers null when the region does not', async () => {
		const client = createDiscountUsageClient({
			orgSlug: 'acme',
			now: () => 0,
			fetchImpl: vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(new Response(JSON.stringify(TOKEN)))
				.mockResolvedValueOnce(new Response('{}', { status: 500 })),
		})
		expect(
			await client.fetchPerformance({
				ids: ['d1'],
				from: '2026-11-01',
				to: '2026-11-30',
				basis: 'net',
			}),
		).toBeNull()
	})
})

describe('discount alerts', () => {
	it('reads the notification type and leads to the discount', () => {
		expect(discountAlertKindFromNotificationType('discount_budget_reached')).toBe(
			'budget_reached',
		)
		expect(discountAlertKindFromNotificationType('mention')).toBeNull()
		expect(discountAlertPath('abc 1')).toBe('/discounts/abc%201')
	})
})
