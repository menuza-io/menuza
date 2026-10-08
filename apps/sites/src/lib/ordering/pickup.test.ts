import { describe, expect, it } from 'vitest'
import {
	buildPickupOptions,
	clearPickupSelection,
	formatPickupAddress,
	formatSlot,
	formatWindow,
	loadPickupSelection,
	pickupMapHref,
	pickupPhoneHref,
	resolvePickup,
	savePickupSelection,
	type PickupWindowData,
} from './pickup.ts'

/**
 * `2026-10-09 09:30` in Asia/Riyadh is `06:30Z` (UTC+3, no DST), so lead-time
 * math differs from the SSR host timezone (whatever it is) — a wrong
 * conversion would flip these results.
 */
const RIYADH = 'Asia/Riyadh'
const NOW = new Date('2026-10-09T05:00:00Z') // 08:00 in Riyadh

function window(overrides: Partial<PickupWindowData> = {}): PickupWindowData {
	return {
		id: 'w1',
		locationId: 'baxter',
		date: '2026-10-09',
		startTime: '09:00',
		endTime: '10:00',
		slotIntervalMinutes: 30,
		maxOrdersPerSlot: 5,
		orderLeadTimeMinutes: 0,
		slots: [
			{ time: '09:00', displayTime: '9:00 AM' },
			{ time: '09:30', displayTime: '9:30 AM' },
		],
		location: {
			id: 'baxter',
			name: 'Baxter Village',
			phone: '+1 (555) 000-0000',
			address: {
				formattedAddress: '123 Market St, San Francisco, CA 94105',
			},
			timezone: RIYADH,
		},
		...overrides,
	}
}

describe('buildPickupOptions', () => {
	it('groups windows into locations and dates with slot availability', () => {
		const options = buildPickupOptions(
			[
				window({
					id: 'w1',
					orderLeadTimeMinutes: 60,
					slots: [{ time: '09:00' }, { time: '09:30' }],
				}),
			],
			NOW,
		)
		expect(options).toHaveLength(1)
		const location = options[0]!
		expect(location.name).toBe('Baxter Village')
		expect(location.timezone).toBe(RIYADH)
		expect(location.dates).toHaveLength(1)
		const slots = location.dates[0]!.slots
		// 09:00 Riyadh = 06:00Z. With a 60-minute lead the order cut-off is
		// 05:00Z, which is exactly now → "no longer available".
		expect(slots[0]!.start).toBe('09:00')
		expect(slots[0]!.available).toBe(false)
		expect(slots[0]!.end).toBe('09:30')
		// 09:30 Riyadh = 06:30Z; the 60-minute cut-off is 05:30Z, still open.
		expect(slots[1]!.start).toBe('09:30')
		expect(slots[1]!.available).toBe(true)
		expect(slots[1]!.startInstant?.toISOString()).toBe(
			'2026-10-09T06:30:00.000Z',
		)
	})

	it('applies lead time using the location timezone, not the host clock', () => {
		// Lead of 90 minutes: the 09:30 slot (06:30Z) is only 90 minutes out,
		// so its cut-off (05:00Z) is now and it closes.
		const options = buildPickupOptions(
			[window({ orderLeadTimeMinutes: 90 })],
			NOW,
		)
		expect(options[0]!.dates[0]!.slots[1]!.available).toBe(false)
	})

	it('separates dates and locations and sorts them', () => {
		const options = buildPickupOptions(
			[
				window({
					id: 'w-b',
					locationId: 'eastside',
					date: '2026-10-12',
					slots: [{ time: '10:00' }],
					location: {
						id: 'eastside',
						name: 'Eastside Market',
						phone: null,
						address: null,
						timezone: 'America/Chicago',
					},
				}),
				window({
					id: 'w-a',
					date: '2026-10-10',
					slots: [{ time: '09:00' }],
				}),
				window({
					id: 'w-a2',
					date: '2026-10-10',
					startTime: '14:00',
					endTime: '15:00',
					slots: [{ time: '14:00' }],
				}),
			],
			NOW,
		)
		expect(options.map((o) => o.locationId)).toEqual(['baxter', 'eastside'])
		const baxter = options[0]!
		expect(baxter.dates.map((d) => d.date)).toEqual(['2026-10-10'])
		expect(baxter.dates[0]!.slots.map((s) => s.start)).toEqual([
			'09:00',
			'14:00',
		])
	})

	it('skips windows without a location or timezone and keeps unique slots', () => {
		const options = buildPickupOptions(
			[
				window({ location: null }),
				window({
					location: {
						id: 'baxter',
						name: 'Baxter Village',
						phone: null,
						address: null,
						timezone: null,
					},
				}),
				window(), // duplicate of the first valid window
			],
			NOW,
		)
		expect(options).toHaveLength(1)
		expect(options[0]!.dates[0]!.slots).toHaveLength(2)
	})
})

describe('resolvePickup', () => {
	it('resolves a valid stored selection', () => {
		const options = buildPickupOptions([window()], NOW)
		const resolved = resolvePickup(options, {
			locationId: 'baxter',
			date: '2026-10-09',
			slotStart: '09:30',
			slotEnd: '10:00',
		})
		expect(resolved?.location.name).toBe('Baxter Village')
		expect(resolved?.slot.start).toBe('09:30')
	})

	it('rejects stale, unknown and unavailable selections', () => {
		const options = buildPickupOptions(
			[window({ orderLeadTimeMinutes: 240 })],
			NOW,
		)
		expect(
			resolvePickup(options, {
				locationId: 'gone',
				date: '2026-10-09',
				slotStart: '09:30',
				slotEnd: '10:00',
			}),
		).toBeNull()
		expect(
			resolvePickup(options, {
				locationId: 'baxter',
				date: '2020-01-01',
				slotStart: '09:30',
				slotEnd: '10:00',
			}),
		).toBeNull()
		// Both slots are inside the 4-hour lead time.
		expect(
			resolvePickup(options, {
				locationId: 'baxter',
				date: '2026-10-09',
				slotStart: '09:30',
				slotEnd: '10:00',
			}),
		).toBeNull()
		expect(resolvePickup(options, null)).toBeNull()
	})
})

describe('formatting', () => {
	it('formats a window with date and time range in the location timezone', () => {
		const text = formatWindow(
			window({ startTime: '09:00', endTime: '12:00' }),
			'en-US',
		)
		expect(text.replace(/[\u202f\u2009\u00a0]/g, ' ')).toBe(
			'Fri, Oct 9 · 9:00 AM – 12:00 PM',
		)
	})

	it('formats a chosen slot with date and time', () => {
		const text = formatSlot('2026-10-09', '09:30', 'en-US', RIYADH)
		expect(text.replace(/[\u202f\u2009\u00a0]/g, ' ')).toBe(
			'Fri, Oct 9 · 9:30 AM',
		)
	})

	it('formats addresses and contact links', () => {
		expect(formatPickupAddress({ formattedAddress: '  12 Main St ' })).toBe(
			'12 Main St',
		)
		expect(
			formatPickupAddress({
				streetNumber: '123',
				streetName: 'Market St',
				city: 'San Francisco',
				state: 'CA',
				postalCode: '94105',
			}),
		).toBe('123 Market St, San Francisco, CA 94105')
		expect(formatPickupAddress(null)).toBe('')
		expect(pickupMapHref({ name: 'Baxter Village', address: null })).toContain(
			encodeURIComponent('Baxter Village'),
		)
		expect(pickupPhoneHref('+1 (555) 234-5678')).toBe('tel:+15552345678')
		expect(pickupPhoneHref(null)).toBeNull()
	})
})

describe('pickup selection storage', () => {
	function memory() {
		const map = new Map<string, string>()
		return {
			getItem: (k: string) => map.get(k) ?? null,
			setItem: (k: string, v: string) => void map.set(k, v),
			removeItem: (k: string) => void map.delete(k),
		}
	}

	it('round-trips a selection under the per-drop key', () => {
		const storage = memory()
		const selection = {
			locationId: 'baxter',
			date: '2026-10-09',
			slotStart: '09:30',
			slotEnd: '10:00',
		}
		savePickupSelection('drop-1', selection, storage)
		expect(storage.getItem('menuza_drop_pickup_drop-1')).toBeTruthy()
		expect(loadPickupSelection('drop-1', storage)).toEqual(selection)
		clearPickupSelection('drop-1', storage)
		expect(loadPickupSelection('drop-1', storage)).toBeNull()
	})

	it('rejects malformed stored values', () => {
		const storage = memory()
		storage.setItem('menuza_drop_pickup_drop-1', '{"locationId":42}')
		expect(loadPickupSelection('drop-1', storage)).toBeNull()
		storage.setItem('menuza_drop_pickup_drop-1', 'not json')
		expect(loadPickupSelection('drop-1', storage)).toBeNull()
	})

	it('tolerates unavailable storage', () => {
		expect(loadPickupSelection('drop-1', null)).toBeNull()
		expect(() =>
			savePickupSelection(
				'drop-1',
				{
					locationId: 'a',
					date: '2026-10-09',
					slotStart: '09:30',
					slotEnd: '10:00',
				},
				null,
			),
		).not.toThrow()
	})
})
