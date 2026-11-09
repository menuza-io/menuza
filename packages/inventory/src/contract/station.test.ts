import { describe, expect, test } from 'vitest'
import { receivePrefillLineSchema } from './receiving.ts'
import {
	classifyStationFailure,
	INVENTORY_POS_CONTRACT_VERSION,
	INVENTORY_POS_ERROR_CODES,
	INVENTORY_POS_PATHS,
	isLateSync,
	isStationOutage,
	STATION_BACKOFF_MS,
	STATION_ERROR_HANDLING,
	STATION_LATE_SYNC_MS,
	stationBackoffMs,
	stationCatalogSchema,
	stationCountEntriesSchema,
	stationCountSheetSchema,
	stationDeliveryResultSchema,
	stationDeliverySchema,
	stationOutboxItemSchema,
	stationStartCountResultSchema,
	stationStartCountSchema,
	stationUndoWasteResultSchema,
	stationWasteResultSchema,
	stationWasteSchema,
} from './station.ts'

/** Names of every object key reachable in a Zod 4 schema. */
function keysOf(schema: unknown, seen = new Set<unknown>()): string[] {
	if (!schema || typeof schema !== 'object' || seen.has(schema)) return []
	seen.add(schema)
	const def = (schema as { def?: Record<string, unknown> }).def
	if (!def) return []
	const out: string[] = []
	switch (def.type) {
		case 'object':
			for (const [key, value] of Object.entries(
				def.shape as Record<string, unknown>,
			)) {
				out.push(key, ...keysOf(value, seen))
			}
			break
		case 'array':
			out.push(...keysOf(def.element, seen))
			break
		case 'optional':
		case 'nullable':
		case 'default':
		case 'readonly':
			out.push(...keysOf(def.innerType, seen))
			break
		case 'union':
			for (const option of def.options as unknown[]) {
				out.push(...keysOf(option, seen))
			}
			break
		case 'record':
			out.push(...keysOf(def.valueType, seen))
			break
		case 'pipe':
			out.push(...keysOf(def.in, seen))
			break
	}
	return out
}

const MONEY = /(Minor|Micro)$|^currency$|^(cost|price(?!dByWeight|sPending))/i
describe('Station responses carry no money', () => {
	test.each([
		['catalog', stationCatalogSchema],
		['start count', stationStartCountResultSchema],
		['count sheet', stationCountSheetSchema],
		['waste result', stationWasteResultSchema],
		['delivery result', stationDeliveryResultSchema],
	])('%s', (_name, schema) => {
		const keys = keysOf(schema)
		expect(keys.length).toBeGreaterThan(3)
		const money = keys.filter((key) => MONEY.test(key))
		expect(money).toEqual([])
	})

	test('the walker sees money in a schema that has some', () => {
		expect(
			keysOf(receivePrefillLineSchema).filter((k) => MONEY.test(k)),
		).toEqual(['packPriceMinor', 'lineTotalMinor'])
		expect(keysOf(stationOutboxItemSchema)).toContain('payload')
	})
})

const staffEnvelope = { madeBy: 'staff_1', madeAt: 1_762_000_000_000 }

describe('Station requests', () => {
	test('start a count', () => {
		expect(
			stationStartCountSchema.safeParse({
				clientId: 'client-0001',
				locationId: 'main',
				listId: null,
				...staffEnvelope,
			}).success,
		).toBe(true)
		expect(
			stationStartCountSchema.safeParse({
				clientId: 'client-0001',
				locationId: 'main',
				listId: null,
				extra: true,
			}).success,
		).toBe(false)
	})

	test('count entries reuse the operator entry shape and add who and when', () => {
		const entry = {
			clientId: 'client-0002',
			itemId: 'it_1',
			areaId: 'a1',
			amount: 2.5,
			unit: 'kg',
		}
		expect(
			stationCountEntriesSchema.safeParse({
				entries: [{ ...entry, ...staffEnvelope }],
			}).success,
		).toBe(true)
		expect(
			stationCountEntriesSchema.safeParse({
				entries: [{ ...entry, amount: null }],
			}).success,
		).toBe(true)
		expect(
			stationCountEntriesSchema.safeParse({ entries: [{ ...entry, extra: 1 }] })
				.success,
		).toBe(false)
		expect(stationCountEntriesSchema.safeParse({ entries: [] }).success).toBe(
			false,
		)
	})

	test('waste reuses the operator entry shape and refuses system reasons', () => {
		const entry = {
			clientId: 'client-0003',
			locationId: 'main',
			itemId: 'it_1',
			amount: 2.3,
			unit: 'kg',
			reason: 'spoiled',
		}
		expect(
			stationWasteSchema.safeParse({
				entries: [{ ...entry, ...staffEnvelope }],
			}).success,
		).toBe(true)
		expect(
			stationWasteSchema.safeParse({
				entries: [{ ...entry, reason: 'remade_at_till' }],
			}).success,
		).toBe(true) // the reason list is checked by the region (`reason_not_allowed`)
		expect(
			stationWasteSchema.safeParse({ entries: [{ ...entry, amount: 0 }] })
				.success,
		).toBe(false)
		expect(stationUndoWasteResultSchema.safeParse({ id: 'w1' }).success).toBe(
			true,
		)
	})

	test('a delivery has quantities and no money', () => {
		const body = {
			clientId: 'client-0004',
			locationId: 'main',
			supplierId: 'sup_1',
			orderId: 'ord_1',
			invoiceNumber: 'INV-4471',
			lines: [
				{
					itemId: 'it_1',
					orderLineId: 'ol_1',
					quantity: 9_800_000,
					realWeightQuantity: 9_800_000,
				},
			],
			...staffEnvelope,
		}
		expect(stationDeliverySchema.safeParse(body).success).toBe(true)
		expect(
			stationDeliverySchema.safeParse({
				...body,
				lines: [{ itemId: 'it_1', quantity: 1000, lineTotalMinor: 5 }],
			}).success,
		).toBe(false)
		expect(
			stationDeliverySchema.safeParse({ ...body, totalMinor: 5 }).success,
		).toBe(false)
		expect(
			stationDeliverySchema.safeParse({ ...body, lines: [] }).success,
		).toBe(false)
	})

	test('paths', () => {
		expect(INVENTORY_POS_PATHS.countEntries('c1')).toBe(
			'/pos/inventory/counts/c1/entries',
		)
		expect(INVENTORY_POS_PATHS.deliveryPhotoConfirm('d1')).toBe(
			'/pos/inventory/deliveries/d1/photo/confirm',
		)
		expect(INVENTORY_POS_CONTRACT_VERSION).toBe(1)
	})
})

describe('Station failures', () => {
	test('every code has a status and an action', () => {
		for (const code of INVENTORY_POS_ERROR_CODES) {
			const handling = STATION_ERROR_HANDLING[code]
			expect(handling.status).toBeGreaterThanOrEqual(400)
			expect(['permanent', 'pause', 'retry', 'unpair']).toContain(
				handling.action,
			)
		}
	})

	test('known codes follow their action, unknown ones follow the status', () => {
		expect(classifyStationFailure({ status: 409, code: 'count_closed' })).toBe(
			'permanent',
		)
		expect(
			classifyStationFailure({ status: 401, code: 'staff_session_invalid' }),
		).toBe('pause')
		expect(
			classifyStationFailure({ status: 401, code: 'device_revoked' }),
		).toBe('unpair')
		expect(
			classifyStationFailure({ status: 403, code: 'receive_needs_manager' }),
		).toBe('pause')
		expect(classifyStationFailure({ status: 502 })).toBe('retry')
		expect(classifyStationFailure({ status: 0 })).toBe('retry')
		expect(classifyStationFailure({ status: 429 })).toBe('retry')
		expect(classifyStationFailure({ status: 400, code: 'something_new' })).toBe(
			'permanent',
		)
	})

	test('an outage is a dropped network, 429 or any 5xx; a refusal is not', () => {
		for (const status of [0, 429, 500, 502, 503, 504]) {
			expect(isStationOutage(status)).toBe(true)
		}
		for (const status of [200, 400, 401, 403, 404, 409]) {
			expect(isStationOutage(status)).toBe(false)
		}
	})

	test('backoff grows and stops growing', () => {
		expect(stationBackoffMs(1)).toBe(STATION_BACKOFF_MS[0])
		expect(stationBackoffMs(3)).toBe(60_000)
		expect(stationBackoffMs(50)).toBe(15 * 60_000)
		expect(stationBackoffMs(0)).toBe(STATION_BACKOFF_MS[0])
	})

	test('late sync is more than 48 hours old', () => {
		const now = 1_762_000_000_000
		expect(isLateSync(now - STATION_LATE_SYNC_MS, now)).toBe(false)
		expect(isLateSync(now - STATION_LATE_SYNC_MS - 1, now)).toBe(true)
	})
})

describe('the outbox item', () => {
	const base = {
		id: 'client-0005',
		locationId: 'main',
		madeBy: 'staff_1',
		madeAt: 1_762_000_000_000,
		createdAt: 1_762_000_000_000,
		attempts: 0,
		nextAttemptAt: null,
		status: 'queued',
		failure: null,
	}

	test('each kind has its own payload', () => {
		const items = [
			{ kind: 'count_start', payload: { listId: null } },
			{
				kind: 'count_entry',
				payload: {
					count: { clientId: 'client-0006' },
					entry: {
						clientId: 'client-0005',
						itemId: 'it_1',
						areaId: null,
						amount: 3,
						unit: 'kg',
					},
				},
			},
			{ kind: 'count_send', payload: { count: { id: 'c1' } } },
			{
				kind: 'waste',
				payload: {
					entry: {
						clientId: 'client-0005',
						locationId: 'main',
						itemId: 'it_1',
						amount: 1,
						unit: 'kg',
						reason: 'expired',
					},
				},
			},
			{ kind: 'waste_undo', payload: { waste: { clientId: 'client-0009' } } },
			{
				kind: 'delivery',
				payload: {
					supplierId: null,
					lines: [{ itemId: 'it_1', quantity: 1000 }],
				},
			},
			{
				kind: 'delivery_photo',
				payload: {
					delivery: { clientId: 'client-0010' },
					contentType: 'image/jpeg',
					sizeBytes: 900_000,
					blobKey: 'blob-1',
				},
			},
		]
		for (const item of items) {
			expect(
				stationOutboxItemSchema.safeParse({ ...base, ...item }).success,
			).toBe(true)
		}
		expect(
			stationOutboxItemSchema.safeParse({
				...base,
				kind: 'count_send',
				payload: { count: { id: 'c1', clientId: 'client-0006' } },
			}).success,
		).toBe(false)
		expect(
			stationOutboxItemSchema.safeParse({ ...base, kind: 'nope', payload: {} })
				.success,
		).toBe(false)
	})
})
