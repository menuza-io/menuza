import { describe, expect, it } from 'vitest'
import {
	DEFAULT_PRINTER_ROUTES,
	formatPrintRef,
	generatePrinterPassword,
	isPrinterPassword,
	parsePrintRef,
	printerHealth,
	printerHealthReason,
	printerSetupSchema,
	readPrinterPassword,
	readPrinterRoutes,
	routeKitchenTicket,
	routeReceipt,
	type RoutablePrinter,
} from './print-devices.ts'

const printer = (
	id: string,
	routes: Partial<RoutablePrinter['routes']>,
	over: Partial<RoutablePrinter> = {},
): RoutablePrinter => ({
	id,
	locationId: 'loc-1',
	revokedAt: null,
	routes: { ...DEFAULT_PRINTER_ROUTES, ...routes },
	...over,
})

describe('routing a kitchen ticket to printers', () => {
	const lines = [
		{ stationIds: ['grill'] },
		{ stationIds: ['bar'] },
		{ stationIds: ['salad'] },
	]

	it('sends each item to its station\'s printer', () => {
		const routes = routeKitchenTicket({
			locationId: 'loc-1',
			lines,
			printers: [
				printer('p-grill', { kitchen: 'stations', stationIds: ['grill'] }),
				printer('p-bar', { kitchen: 'stations', stationIds: ['bar'] }),
			],
		})
		expect(routes.find((r) => r.printerId === 'p-grill')?.lineIndexes).toEqual([0])
		expect(routes.find((r) => r.printerId === 'p-bar')?.lineIndexes).toEqual([1])
		expect(routes.find((r) => r.printerId === 'p-grill')?.partial).toBe(true)
	})

	it('sends items of a station with no printer to the default printer', () => {
		const routes = routeKitchenTicket({
			locationId: 'loc-1',
			lines,
			printers: [
				printer('p-grill', { kitchen: 'stations', stationIds: ['grill'] }),
				printer('p-default', { kitchen: 'stations', stationIds: [], isDefault: true }),
			],
		})
		expect(routes.find((r) => r.printerId === 'p-default')?.lineIndexes).toEqual([1, 2])
		expect(routes.find((r) => r.printerId === 'p-grill')?.lineIndexes).toEqual([0])
	})

	it('gives an all-tickets printer the whole ticket and does not repeat it as the default', () => {
		const routes = routeKitchenTicket({
			locationId: 'loc-1',
			lines,
			printers: [
				printer('p-all', { kitchen: 'all', isDefault: true }),
				printer('p-grill', { kitchen: 'stations', stationIds: ['grill'] }),
			],
		})
		expect(routes.find((r) => r.printerId === 'p-all')).toEqual({
			printerId: 'p-all',
			lineIndexes: [0, 1, 2],
			partial: false,
		})
		expect(routes.filter((r) => r.printerId === 'p-all')).toHaveLength(1)
	})

	it('never reaches another location\'s printer or a removed one', () => {
		const routes = routeKitchenTicket({
			locationId: 'loc-1',
			lines,
			printers: [
				printer('other', { kitchen: 'all' }, { locationId: 'loc-2' }),
				printer('gone', { kitchen: 'all' }, { revokedAt: 5 }),
				printer('off', { kitchen: 'off', receipts: true }),
			],
		})
		expect(routes).toEqual([])
	})

	it('routes receipts to receipt printers at the location only', () => {
		expect(
			routeReceipt({
				locationId: 'loc-1',
				printers: [
					printer('a', { receipts: true }),
					printer('b', { receipts: false }),
					printer('c', { receipts: true }, { locationId: 'loc-2' }),
					printer('d', { receipts: true }, { revokedAt: 1 }),
				],
			}),
		).toEqual(['a'])
	})
})

describe('printer address, password and status', () => {
	it('addresses a printer by a public ref and a short password it can hold', () => {
		const ref = formatPrintRef('org_abc', 'c0ffee00-1111-2222-3333-444455556666')
		expect(parsePrintRef(ref)).toEqual({
			orgId: 'org_abc',
			printerId: 'c0ffee00-1111-2222-3333-444455556666',
		})
		expect(parsePrintRef('nope')).toBeNull()
		expect(parsePrintRef('a'.repeat(200))).toBeNull()
		const password = generatePrinterPassword()
		expect(password).toHaveLength(32)
		expect(isPrinterPassword(password)).toBe(true)
		expect(generatePrinterPassword()).not.toBe(password)
	})

	it('reads the password from Basic or Bearer and nothing else', () => {
		const password = 'A'.repeat(32)
		expect(readPrinterPassword(`Bearer ${password}`)).toBe(password)
		expect(readPrinterPassword(`Basic ${btoa(`anyone:${password}`)}`)).toBe(password)
		expect(readPrinterPassword(`Basic ${btoa(password)}`)).toBe(password)
		expect(readPrinterPassword('Basic !!!')).toBeNull()
		expect(readPrinterPassword(`Bearer short`)).toBeNull()
		expect(readPrinterPassword(null)).toBeNull()
	})

	it('says why a printer is not ready', () => {
		const now = 1_000_000
		const base = { lastSeenAt: now - 10_000, status: 'ok', revokedAt: null }
		expect(printerHealth(base, now)).toBe('online')
		expect(printerHealth({ ...base, lastSeenAt: null }, now)).toBe('never_seen')
		expect(printerHealth({ ...base, lastSeenAt: now - 10 * 60_000 }, now)).toBe('offline')
		expect(printerHealth({ ...base, status: 'out_of_paper' }, now)).toBe('out_of_paper')
		expect(printerHealth({ ...base, revokedAt: 1 }, now)).toBe('revoked')
		expect(printerHealthReason('offline')).toMatch(/disconnected/)
		expect(printerHealthReason('out_of_paper')).toMatch(/out of paper/)
		expect(printerHealthReason('online')).toBeNull()
	})

	it('validates a setup and reads stored routes defensively', () => {
		expect(
			printerSetupSchema.safeParse({
				locationId: 'loc-1',
				name: 'Bar',
				protocol: 'star_cloudprnt',
				widthMm: 58,
			}).success,
		).toBe(true)
		expect(
			printerSetupSchema.safeParse({
				locationId: 'loc-1',
				name: 'Bar',
				protocol: 'star_cloudprnt',
				widthMm: 72,
			}).success,
		).toBe(false)
		expect(readPrinterRoutes('{"kitchen":"all","receipts":true}')).toMatchObject({
			kitchen: 'all',
			receipts: true,
		})
		expect(readPrinterRoutes('not json')).toEqual(DEFAULT_PRINTER_ROUTES)
		expect(readPrinterRoutes({ kitchen: 'everything' })).toEqual(DEFAULT_PRINTER_ROUTES)
	})
})
