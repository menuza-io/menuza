import { describe, expect, test } from 'vitest'
import { stationOutboxItemSchema } from './station.ts'
import {
	patchTransferSchema,
	putTransferTermsSchema,
	transferDetailSchema,
	transferTermSchema,
} from './transfers.ts'
import {
	correctWasteSchema,
	logWasteDishSchema,
	wasteEntrySchema,
} from './waste.ts'
import { varianceSchema } from './variance.ts'

/**
 * The wire rules of the transfers, dish waste, correction and variance
 * contracts (#477, #515, #526, #517, #522, #509).
 */

const CLIENT = 'client-id-0001'

describe('editing a planned transfer (#477)', () => {
	test('a patch changes lines or the note, with the version read and optionally the place editing', () => {
		const line = { itemId: 'it_1', amount: 2, unit: 'kg' }
		expect(
			patchTransferSchema.safeParse({ expectedVersion: 1, lines: [line] })
				.success,
		).toBe(true)
		expect(
			patchTransferSchema.safeParse({
				expectedVersion: 1,
				lines: [line],
				locationId: 'loc_central',
			}).success,
		).toBe(true)
		// Nothing to change, and an item twice, are refused.
		expect(patchTransferSchema.safeParse({ expectedVersion: 1 }).success).toBe(
			false,
		)
		expect(
			patchTransferSchema.safeParse({
				expectedVersion: 1,
				lines: [line, line],
			}).success,
		).toBe(false)
	})

	test('a transfer shows a request the sender changed, and what a line first asked for', () => {
		const parsed = transferDetailSchema.parse({
			id: 't1',
			number: 1,
			kind: 'request',
			status: 'requested',
			fromLocationId: 'a',
			toLocationId: 'b',
			lineCount: 1,
			note: null,
			createdAt: 1,
			sentAt: null,
			receivedAt: null,
			missingLines: 0,
			editedAt: 5,
			changedBySender: true,
			version: 2,
			lines: [
				{
					itemId: 'it_1',
					itemName: 'Flour',
					baseUnit: 'g',
					countUnit: 'kg',
					units: [],
					requestedQuantity: 2_000_000,
					sentQuantity: null,
					receivedQuantity: null,
					missingQuantity: null,
					onHandAtSender: 0,
					askedQuantity: 3_000_000,
				},
			],
		})
		expect(parsed.changedBySender).toBe(true)
		expect(parsed.lines[0]!.askedQuantity).toBe(3_000_000)
	})
})

describe('transfer prices (#526)', () => {
	test('a fixed price names its unit and currency, a cost-plus price its percentage', () => {
		expect(
			putTransferTermsSchema.safeParse({
				locationId: 'loc_1',
				expectedVersion: 0,
				priceMode: 'fixed',
				fixedPrice: { priceMinor: 500, per: 'kg', currency: 'SAR' },
			}).success,
		).toBe(true)
		expect(
			putTransferTermsSchema.safeParse({
				locationId: 'loc_1',
				expectedVersion: 0,
				priceMode: 'fixed',
			}).success,
		).toBe(false)
		expect(
			putTransferTermsSchema.safeParse({
				locationId: 'loc_1',
				expectedVersion: 0,
				priceMode: 'cost_plus',
				markupBp: 5000,
			}).success,
		).toBe(true)
		expect(
			putTransferTermsSchema.safeParse({
				locationId: 'loc_1',
				expectedVersion: 0,
				priceMode: 'cost_plus',
			}).success,
		).toBe(false)
		// The request switch alone needs no price; an empty change is refused.
		expect(
			putTransferTermsSchema.safeParse({
				locationId: 'loc_1',
				expectedVersion: 0,
				branchRequestable: false,
			}).success,
		).toBe(true)
		expect(
			putTransferTermsSchema.safeParse({
				locationId: 'loc_1',
				expectedVersion: 0,
			}).success,
		).toBe(false)
	})

	test('a term without the cost grant carries no money field', () => {
		const plain = transferTermSchema.parse({
			itemId: 'it_1',
			itemName: 'Flour',
			baseUnit: 'g',
			branchRequestable: false,
			version: 1,
		})
		expect(Object.keys(plain).sort()).toEqual([
			'baseUnit',
			'branchRequestable',
			'itemId',
			'itemName',
			'version',
		])
	})
})

describe('a whole dish as waste (#517)', () => {
	test('names the dish, size and options, a quantity and a reason', () => {
		const body = {
			clientId: CLIENT,
			locationId: 'loc_1',
			menuItemId: 'dish_1',
			variantId: 'var_1',
			options: [{ optionId: 'opt_1', quantity: 2 }],
			quantity: 2,
			reason: 'dropped',
		}
		expect(logWasteDishSchema.safeParse(body).success).toBe(true)
		expect(logWasteDishSchema.safeParse({ ...body, quantity: 0 }).success).toBe(
			false,
		)
		expect(
			logWasteDishSchema.safeParse({ ...body, quantity: 51 }).success,
		).toBe(false)
		expect(logWasteDishSchema.safeParse({ ...body, extra: 1 }).success).toBe(
			false,
		)
	})

	test('a tablet queues a dish and its undo', () => {
		const base = {
			id: 'row-id-0001',
			locationId: 'loc_1',
			madeBy: null,
			madeAt: 1,
			createdAt: 1,
			attempts: 0,
			nextAttemptAt: null,
			status: 'queued' as const,
			failure: null,
		}
		expect(
			stationOutboxItemSchema.safeParse({
				...base,
				kind: 'waste_dish',
				payload: {
					dish: { menuItemId: 'dish_1', quantity: 2, reason: 'dropped' },
				},
			}).success,
		).toBe(true)
		expect(
			stationOutboxItemSchema.safeParse({
				...base,
				kind: 'waste_dish_undo',
				payload: { waste: { clientId: 'row-id-0002' } },
			}).success,
		).toBe(true)
		expect(
			stationOutboxItemSchema.safeParse({
				...base,
				kind: 'transfer_receive',
				payload: { transferId: 'trf_1', expectedVersion: 3 },
			}).success,
		).toBe(true)
	})
})

describe('correcting a waste entry later (#522)', () => {
	test('a reversal takes no quantity; a change takes an amount and unit, or a number of dishes, and always a reason', () => {
		expect(
			correctWasteSchema.safeParse({
				clientId: CLIENT,
				kind: 'reverse',
				reason: 'Logged twice',
			}).success,
		).toBe(true)
		expect(
			correctWasteSchema.safeParse({
				clientId: CLIENT,
				kind: 'reverse',
				amount: 1,
				unit: 'kg',
				reason: 'Logged twice',
			}).success,
		).toBe(false)
		expect(
			correctWasteSchema.safeParse({
				clientId: CLIENT,
				kind: 'quantity',
				amount: 5,
				unit: 'g',
				reason: 'It was 5 g',
			}).success,
		).toBe(true)
		expect(
			correctWasteSchema.safeParse({
				clientId: CLIENT,
				kind: 'quantity',
				dishes: 3,
				reason: 'Three fell',
			}).success,
		).toBe(true)
		// Neither, or both, is no answer.
		for (const extra of [{}, { amount: 5, unit: 'g', dishes: 2 }]) {
			expect(
				correctWasteSchema.safeParse({
					clientId: CLIENT,
					kind: 'quantity',
					reason: 'Check',
					...extra,
				}).success,
			).toBe(false)
		}
		expect(
			correctWasteSchema.safeParse({
				clientId: CLIENT,
				kind: 'reverse',
				reason: 'ab',
			}).success,
		).toBe(false)
	})

	test('an entry shows the original beside its corrections', () => {
		const entry = wasteEntrySchema.parse({
			id: 'w1',
			locationId: 'loc_1',
			itemId: 'it_1',
			itemName: 'Chicken',
			category: 'meat',
			baseUnit: 'g',
			quantity: 5_000_000,
			reason: 'spoiled',
			note: null,
			actor: { kind: 'operator', id: 'u1' },
			businessDate: '2026-11-01',
			createdAt: 1,
			undoneAt: null,
			reversesId: null,
			currentQuantity: 5_000,
			corrections: [
				{
					id: 'c1',
					kind: 'quantity',
					previousQuantity: 5_000_000,
					newQuantity: 5_000,
					stockEffect: 'covered_by_count',
					reason: 'It was 5 g',
					actor: { kind: 'operator', id: 'u1' },
					createdAt: 2,
				},
			],
			countedSince: true,
		})
		expect(entry.quantity).toBe(5_000_000)
		expect(entry.corrections![0]!.stockEffect).toBe('covered_by_count')
	})
})

describe('expected versus actual use (#509)', () => {
	test('a report without the cost grant has no money field and no totals', () => {
		const parsed = varianceSchema.parse({
			state: 'ok',
			period: {
				openingCountId: 'a',
				closingCountId: 'b',
				from: '2026-10-01',
				to: '2026-10-08',
				openingAt: 1,
				closingAt: 2,
			},
			periods: [],
			rows: [],
		})
		expect(parsed.totals).toBeUndefined()
		expect(parsed.salesMinor).toBeUndefined()
	})
})
