import { describe, expect, it, vi } from 'vitest'
import {
	assignReservationTable,
	fetchBookDayConditional,
	fetchReservationEvents,
	normalizeDayFeedResponse,
	normalizeReservationView,
	saveSectionServerAssignments,
	saveServiceNotes,
	transitionReservationStatus,
	updateReservation,
} from './book-api.ts'
import { type ReservationsScopedClient } from './reservations-client.ts'

function createMockClient(
	requestImpl?: (path: string, opts?: any) => Promise<any>,
	conditionalImpl?: (path: string, opts?: any) => Promise<any>,
): ReservationsScopedClient {
	return {
		scope: 'book',
		request: vi.fn(requestImpl ?? (async () => ({}))) as any,
		requestConditional: vi.fn(
			conditionalImpl ??
				(async () => ({ status: 200, data: {}, etag: '"v1"' })),
		) as any,
		getToken: vi.fn(),
		invalidate: vi.fn(),
	}
}

describe('book-api', () => {
	it('uses the occasion value as sent and never derives it from the tag id', () => {
		const base = {
			id: 'rsv-occ',
			confirmationCode: 'OCC123',
			partySize: 2,
			businessDate: '2026-04-20',
			localStartMin: 1140,
			durationMin: 90,
			status: 'booked',
			version: 1,
		}
		expect(
			normalizeReservationView({
				...base,
				occasion: 'anniversary',
				occasionTagId: 'tag_acme_anniversary',
			}).occasion,
		).toBe('anniversary')
		expect(
			normalizeReservationView({
				...base,
				occasion: null,
				occasionTagId: 'tag_acme_anniversary',
			}).occasion,
		).toBeNull()
	})

	it('normalizes day feed response including tables, reservations, pacing, section layouts, and service notes', () => {
		const feed = normalizeDayFeedResponse(
			{
				locationId: 'loc-1',
				businessDate: '2026-04-20',
				timezone: 'America/New_York',
				areas: [{ id: 'area-1', name: 'Main Dining' }],
				tables: [
					{
						id: 'tbl-1',
						areaId: 'area-1',
						label: 'T1',
						minCovers: 2,
						maxCovers: 4,
						posX: 120,
						posY: 80,
						w: 96,
						h: 96,
					},
				],
				services: [
					{
						id: 'svc-dinner',
						name: 'Dinner',
						firstSeatingMin: 1020,
						lastSeatingMin: 1290,
						endMin: 1380,
					},
				],
				reservations: [
					{
						id: 'rsv-1',
						confirmationCode: 'ABC123',
						guestName: 'Jane Doe',
						partySize: 4,
						businessDate: '2026-04-20',
						localStartMin: 1140,
						durationMin: 90,
						status: 'confirmed',
						tableIds: ['tbl-1'],
						serviceId: 'svc-dinner',
						areaPrefId: 'area-1',
						version: 3,
					},
				],
				pacing: [
					{
						localMin: 1140,
						bookedCovers: 24,
						maxCovers: 20,
					},
				],
				sectionLayouts: [
					{
						id: 'lay-1',
						name: 'Dinner Floor',
						isDefault: true,
						sections: [
							{
								id: 'sec-1',
								name: 'Section A',
								colorToken: '1',
								tableIds: ['tbl-1'],
							},
						],
					},
				],
				serviceNotes: [
					{
						id: 'note-1',
						serviceId: 'svc-dinner',
						note: '86 oysters tonight',
					},
				],
			},
			'"etag-day-1"',
		)

		expect(feed.etag).toBe('"etag-day-1"')
		expect(feed.tables[0]?.x).toBe(120)
		expect(feed.reservations[0]?.assignedTableLabels).toEqual(['T1'])
		expect(feed.reservations[0]?.hhmm).toBe('19:00')
		expect(feed.pacing[0]?.localStartMin).toBe(1140)
		expect(feed.pacing[0]?.isOverPaced).toBe(true)
		expect(feed.sections).toHaveLength(1)
		expect(feed.serviceNotes[0]?.note).toBe('86 oysters tonight')
	})

	it('handles 304 Not Modified and 200 OK in fetchBookDayConditional', async () => {
		const client304 = createMockClient(undefined, async () => ({
			status: 304,
			etag: '"same-etag"',
		}))
		const res304 = await fetchBookDayConditional(
			client304,
			{ locationId: 'loc-1', date: '2026-04-20' },
			'"same-etag"',
		)
		expect(res304).toEqual({ status: 304, etag: '"same-etag"' })

		const client200 = createMockClient(undefined, async () => ({
			status: 200,
			etag: '"new-etag"',
			data: {
				locationId: 'loc-1',
				businessDate: '2026-04-20',
				reservations: [],
			},
		}))
		const res200 = await fetchBookDayConditional(client200, {
			locationId: 'loc-1',
			date: '2026-04-20',
		})
		expect(res200.status).toBe(200)
		if (res200.status === 200) {
			expect(res200.data.locationId).toBe('loc-1')
			expect(res200.etag).toBe('"new-etag"')
		}
	})

	it('sends expectedVersion and lock/overbook flags on mutations', async () => {
		const requestSpy = vi.fn(async () => ({
			reservation: {
				id: 'rsv-1',
				guestName: 'Jane Doe',
				partySize: 2,
				localStartMin: 1140,
				durationMin: 90,
				status: 'seated',
				version: 2,
			},
			moveNotices: [],
		}))
		const client = createMockClient(requestSpy)

		await assignReservationTable(client, 'rsv-1', {
			tableIds: ['tbl-2'],
			locked: true,
			unlock: true,
			forceOverbook: true,
			overbookReason: 'VIP request',
			expectedVersion: 1,
		})
		expect(requestSpy).toHaveBeenCalledWith(
			'/operator/reservations/book/reservations/rsv-1/assign',
			expect.objectContaining({
				method: 'POST',
				body: expect.objectContaining({
					tableIds: ['tbl-2'],
					lock: true,
					locked: true,
					unlock: true,
					overbook: true,
					overbookReason: 'VIP request',
					expectedVersion: 1,
				}),
			}),
		)

		await updateReservation(client, 'rsv-1', {
			localStartMin: 1155,
			durationMin: 120,
			locked: false,
			expectedVersion: 2,
		})
		expect(requestSpy).toHaveBeenCalledWith(
			'/operator/reservations/book/reservations/rsv-1',
			expect.objectContaining({
				method: 'PATCH',
				body: expect.objectContaining({
					localStartMin: 1155,
					time: '19:15',
					durationMin: 120,
					lockTable: false,
					locked: false,
					expectedVersion: 2,
				}),
			}),
		)

		await transitionReservationStatus(client, 'rsv-1', {
			to: 'completed',
			expectedVersion: 3,
		})
		expect(requestSpy).toHaveBeenCalledWith(
			'/operator/reservations/book/reservations/rsv-1/status',
			expect.objectContaining({
				method: 'POST',
				body: expect.objectContaining({
					status: 'finished',
					toStatus: 'finished',
					expectedVersion: 3,
				}),
			}),
		)

		await saveServiceNotes(client, {
			locationId: 'loc-1',
			date: '2026-04-20',
			serviceId: 'svc-dinner',
			note: 'VIP table 4 arriving early',
		})
		expect(requestSpy).toHaveBeenCalledWith(
			'/operator/reservations/book/service-notes',
			expect.objectContaining({
				method: 'PUT',
			}),
		)

		await saveSectionServerAssignments(client, {
			locationId: 'loc-1',
			date: '2026-04-20',
			serviceId: 'svc-dinner',
			assignments: [{ sectionId: 'sec-1', serverLabel: 'Samir' }],
		})
		expect(requestSpy).toHaveBeenCalledWith(
			'/operator/reservations/book/sections/assignments',
			expect.objectContaining({
				method: 'PUT',
			}),
		)
	})

	it('sends service, area, source and tag filters and reads counters and move notices', async () => {
		const conditional = vi.fn(async () => ({
			status: 200,
			etag: '"e"',
			data: {
				locationId: 'loc-1',
				businessDate: '2026-04-20',
				reservations: [],
				counters: { parties: 3, covers: 11 },
				moveNotices: [
					{ reservationId: 'r1', fromTableIds: ['t1'], toTableIds: ['t2'] },
				],
			},
		}))
		const client = createMockClient(undefined, conditional)
		const res = await fetchBookDayConditional(client, {
			locationId: 'loc-1',
			date: '2026-04-20',
			serviceId: 'svc-1',
			areaId: 'area-1',
			source: 'phone',
			tag: 'tag_acme_vip',
		})
		expect(conditional).toHaveBeenCalledWith(
			'/operator/reservations/book/day',
			expect.objectContaining({
				query: {
					locationId: 'loc-1',
					date: '2026-04-20',
					serviceId: 'svc-1',
					areaId: 'area-1',
					source: 'phone',
					tag: 'tag_acme_vip',
				},
			}),
		)
		if (res.status !== 200) throw new Error('expected 200')
		expect(res.data.counters).toEqual({ parties: 3, covers: 11 })
		expect(res.data.moveNotices).toHaveLength(1)
		expect(res.data.moveNotices[0]).toMatchObject({
			reservationId: 'r1',
			toTableIds: ['t2'],
		})
	})

	it('loads reservation history from the events endpoint', async () => {
		const client = createMockClient(async () => ({
			events: [
				{
					id: 'ev1',
					type: 'seated',
					actorKind: 'operator',
					at: 1_790_000_000_000,
				},
			],
		}))
		const entries = await fetchReservationEvents(client, 'rsv 1')
		expect(client.request).toHaveBeenCalledWith(
			'/operator/reservations/book/reservations/rsv%201/events',
			expect.anything(),
		)
		expect(entries).toHaveLength(1)
		expect(entries[0]).toMatchObject({ id: 'ev1', action: 'seated' })
	})
})
