import { type OrderDetail, type OrderLine } from '@repo/inventory'
import { describe, expect, it } from 'vitest'
import {
	cutoffText,
	defaultSendChannel,
	draftLinesFromOrder,
	draftTotals,
	linesChanged,
	orderIsOpen,
	orderLinesPayload,
	packStep,
	shortDayText,
	textLocale,
	todayIso,
	weekdayShort,
} from './order-view.ts'

function line(overrides: Partial<OrderLine> = {}): OrderLine {
	return {
		id: 'l1',
		itemId: 'i1',
		itemName: 'Chicken thighs',
		baseUnit: 'g',
		countUnit: 'kg',
		supplierProductId: 'sp1',
		packName: 'Box',
		packBaseQuantity: 10_000_000,
		pricedByWeight: false,
		packs: 2,
		quantity: 20_000_000,
		receivedQuantity: 0,
		suggestedPacks: 2,
		packPriceMinor: 28_000,
		lineTotalMinor: 56_000,
		...overrides,
	}
}

function order(lines: OrderLine[]): OrderDetail {
	return { lines } as OrderDetail
}

describe('draft lines', () => {
	it('keeps every saved line, and sends back only the ones with packs and a supplier product', () => {
		const drafts = draftLinesFromOrder(
			order([
				line(),
				line({ id: 'l2', itemId: 'i2', supplierProductId: null }),
				line({ id: 'l3', itemId: 'i3', supplierProductId: 'sp3', packs: 3 }),
			]),
		)
		expect(drafts).toHaveLength(3)
		expect(orderLinesPayload(drafts)).toEqual([
			{ itemId: 'i1', supplierProductId: 'sp1', packs: 2 },
			{ itemId: 'i3', supplierProductId: 'sp3', packs: 3 },
		])
	})

	it('leaves out a line whose field is empty or zero', () => {
		const drafts = draftLinesFromOrder(order([line(), line({ id: 'l2' })]))
		drafts[0]!.packs = null
		drafts[1]!.packs = 0
		expect(orderLinesPayload(drafts)).toEqual([])
	})

	it('steps whole packs, and halves for a pack priced by weight', () => {
		expect(packStep({ pricedByWeight: false })).toBe(1)
		expect(packStep({ pricedByWeight: true })).toBe(0.5)
	})
})

describe('linesChanged', () => {
	it('is false for what was loaded and true after a change', () => {
		const saved = [
			line(),
			line({ id: 'l2', itemId: 'i2', supplierProductId: 'sp2' }),
		]
		const drafts = draftLinesFromOrder(order(saved))
		expect(linesChanged(drafts, saved)).toBe(false)
		drafts[0]!.packs = 3
		expect(linesChanged(drafts, saved)).toBe(true)
		drafts[0]!.packs = 2
		drafts.pop()
		expect(linesChanged(drafts, saved)).toBe(true)
	})
})

describe('draftTotals', () => {
	it('adds the priced lines and says how short of the minimum the order is', () => {
		const drafts = draftLinesFromOrder(
			order([
				line(),
				line({ id: 'l2', itemId: 'i2', packPriceMinor: 10_000, packs: 1 }),
			]),
		)
		expect(draftTotals(drafts, 100_000, true)).toEqual({
			totalMinor: 66_000,
			unpricedLines: 0,
			shortOfMinimumMinor: 34_000,
		})
		drafts[0]!.packs = 5
		expect(draftTotals(drafts, 100_000, true)).toMatchObject({
			totalMinor: 150_000,
			shortOfMinimumMinor: 0,
		})
	})

	it('counts lines without a price and leaves them out', () => {
		const drafts = draftLinesFromOrder(
			order([
				line(),
				line({ id: 'l2', itemId: 'i2', packPriceMinor: undefined }),
			]),
		)
		expect(draftTotals(drafts, null, true)).toMatchObject({
			totalMinor: 56_000,
			unpricedLines: 1,
		})
	})

	it('shows no money without the cost grant', () => {
		const drafts = draftLinesFromOrder(order([line()]))
		expect(draftTotals(drafts, 100_000, false)).toEqual({
			totalMinor: null,
			unpricedLines: 0,
			shortOfMinimumMinor: 0,
		})
	})
})

describe('defaultSendChannel', () => {
	it('follows how the supplier likes to be ordered from, when it can', () => {
		const both = { email: true, phone: true }
		expect(defaultSendChannel('email', both)).toBe('email')
		expect(defaultSendChannel('whatsapp', both)).toBe('whatsapp')
		expect(defaultSendChannel('phone', both)).toBe('email')
		expect(defaultSendChannel('email', { email: false, phone: true })).toBe(
			'whatsapp',
		)
		expect(defaultSendChannel('other', { email: false, phone: false })).toBe(
			'copy',
		)
	})
})

describe('dates and language', () => {
	it('reads the cut-off, the weekday and the day in the viewer language', () => {
		expect(cutoffText({ date: '2026-11-11', time: '16:00' }, 'en')).toMatch(
			/Wed.*4:00\s?PM/,
		)
		expect(weekdayShort('2026-11-12', 'en')).toBe('Thu')
		expect(shortDayText('2026-11-12', 'en')).toBe('Thu, Nov 12')
	})

	it('writes order texts in Arabic or English only', () => {
		expect(textLocale('ar')).toBe('ar')
		expect(textLocale('ar-SA')).toBe('ar')
		expect(textLocale('fr')).toBe('en')
	})

	it('knows which statuses can still be received against', () => {
		expect(
			(
				['draft', 'sent', 'partly_received', 'received', 'cancelled'] as const
			).map(orderIsOpen),
		).toEqual([true, true, true, false, false])
	})

	it('writes today as an ISO date in the local zone', () => {
		expect(todayIso(new Date(2026, 10, 9, 23, 59))).toBe('2026-11-09')
	})
})
