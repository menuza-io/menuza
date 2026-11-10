import { describe, expect, it } from 'vitest'
import {
	buildWasteEntry,
	newClientId,
	RECENT_WASTE_LIMIT,
	readRecentWaste,
	rememberRecentWaste,
	wasteBaseQuantity,
	wasteCostPreviewMinor,
	type WasteDraft,
	wasteDraftProblems,
} from './waste-form.ts'

const ITEM = {
	id: 'itm_1',
	baseUnit: 'g' as const,
	units: [
		{
			id: 'box',
			name: 'Box',
			baseQuantity: 10_000_000,
			used: false,
			archived: false,
		},
	],
}

const DRAFT: WasteDraft = {
	item: ITEM,
	amountText: '2.3',
	unit: 'kg',
	reason: 'expired',
	note: '  left out overnight ',
}

function memoryStorage(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial))
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
		data,
	}
}

describe('waste draft', () => {
	it('lists what is missing', () => {
		expect(
			wasteDraftProblems({
				item: null,
				amountText: '',
				unit: null,
				reason: null,
				note: '',
			}),
		).toEqual(['item', 'amount', 'unit', 'reason'])
		expect(wasteDraftProblems({ ...DRAFT, amountText: '0' })).toEqual([
			'amount',
		])
		expect(wasteDraftProblems(DRAFT)).toEqual([])
	})

	it('builds the wire entry with a trimmed note', () => {
		expect(
			buildWasteEntry(DRAFT, { clientId: 'w-12345678', locationId: 'main' }),
		).toEqual({
			clientId: 'w-12345678',
			locationId: 'main',
			itemId: 'itm_1',
			amount: 2.3,
			unit: 'kg',
			reason: 'expired',
			note: 'left out overnight',
		})
		expect(
			buildWasteEntry(
				{ ...DRAFT, note: '  ' },
				{ clientId: 'w-12345678', locationId: 'main' },
			),
		).not.toHaveProperty('note')
		expect(
			buildWasteEntry(
				{ ...DRAFT, reason: null },
				{ clientId: 'x', locationId: 'main' },
			),
		).toBeNull()
	})

	it('reads an amount typed with Arabic digits or a fraction', () => {
		expect(wasteDraftProblems({ ...DRAFT, amountText: '٢٫٥' })).toEqual([])
		expect(
			buildWasteEntry(
				{ ...DRAFT, amountText: '1½' },
				{ clientId: 'w-12345678', locationId: 'main' },
			)?.amount,
		).toBe(1.5)
	})

	it('converts to base thousandths', () => {
		expect(wasteBaseQuantity(2.3, 'kg', 'g', ITEM.units)).toBe(2_300_000)
		expect(wasteBaseQuantity(1.5, 'unit:box', 'g', ITEM.units)).toBe(15_000_000)
		expect(wasteBaseQuantity(1, 'l', 'g', ITEM.units)).toBeNull()
		expect(wasteBaseQuantity(1, 'unit:gone', 'g', ITEM.units)).toBeNull()
	})

	it('previews the cost only with a known cost', () => {
		expect(wasteCostPreviewMinor(DRAFT, 28_000)).toBe(64)
		expect(wasteCostPreviewMinor(DRAFT, null)).toBeNull()
		expect(wasteCostPreviewMinor(DRAFT, undefined)).toBeNull()
		expect(
			wasteCostPreviewMinor({ ...DRAFT, amountText: '' }, 28_000),
		).toBeNull()
	})

	it('makes keys the region accepts', () => {
		expect(newClientId()).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
		expect(newClientId()).not.toBe(newClientId())
	})
})

describe('recent waste items', () => {
	it('remembers the latest first, without duplicates, up to six', () => {
		const storage = memoryStorage()
		for (let index = 1; index <= 8; index++) {
			rememberRecentWaste(
				'acme',
				'main',
				{ id: `i${index}`, name: `Item ${index}` },
				storage,
			)
		}
		rememberRecentWaste('acme', 'main', { id: 'i5', name: 'Item 5' }, storage)
		const recents = readRecentWaste('acme', 'main', storage)
		expect(recents).toHaveLength(RECENT_WASTE_LIMIT)
		expect(recents[0]).toEqual({ id: 'i5', name: 'Item 5' })
		expect(recents.filter((entry) => entry.id === 'i5')).toHaveLength(1)
	})

	it('keeps organizations and locations apart', () => {
		const storage = memoryStorage()
		rememberRecentWaste('acme', 'main', { id: 'a', name: 'A' }, storage)
		expect(readRecentWaste('acme', 'other', storage)).toEqual([])
		expect(readRecentWaste('globex', 'main', storage)).toEqual([])
	})

	it('survives bad or missing storage', () => {
		expect(readRecentWaste('acme', 'main', null)).toEqual([])
		expect(
			readRecentWaste('acme', 'main', {
				getItem: () => '{not json',
			}),
		).toEqual([])
		expect(
			readRecentWaste('acme', 'main', {
				getItem: () =>
					JSON.stringify([{ id: 1 }, { id: 'ok', name: 'Ok' }, 'x']),
			}),
		).toEqual([{ id: 'ok', name: 'Ok' }])
		expect(() =>
			rememberRecentWaste(
				'acme',
				'main',
				{ id: 'a', name: 'A' },
				{
					getItem: () => null,
					setItem: () => {
						throw new Error('quota')
					},
				},
			),
		).not.toThrow()
	})
})
