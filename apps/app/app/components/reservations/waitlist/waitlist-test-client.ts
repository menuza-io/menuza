import { vi } from 'vitest'
import {
	ReservationsApiError,
	type ReservationsScopedClient,
} from '#app/utils/reservations/reservations-client.ts'
import { type WaitlistEntry } from '#app/utils/reservations/waitlist-api.ts'
import {
	makeWaitlistListing,
	WAITLIST_NOW,
} from '#app/utils/reservations/waitlist-fixtures.ts'

export type FakeCall = {
	path: string
	method: string
	body: Record<string, any> | undefined
	headers: Record<string, string> | undefined
	query: Record<string, unknown> | undefined
}

const BASE = '/operator/reservations/book/waitlist'
const ACTIVE = new Set(['waiting', 'notified', 'on_the_way'])

/**
 * An in-memory stand-in for the waitlist routes. It enforces `expectedVersion`
 * and the table rules the real server applies, so the screens can be driven
 * end to end without a network.
 */
export function createFakeWaitlistClient(
	initial: WaitlistEntry[],
	options: {
		responseMin?: number
		occupiedTableIds?: string[]
		/** Status of the booking sitting on an occupied table (default `booked`). */
		occupantStatus?: string
	} = {},
) {
	let entries = initial.map((entry) => ({ ...entry }))
	const calls: FakeCall[] = []
	const occupied = new Set(options.occupiedTableIds ?? [])
	let failure: {
		suffix: string
		status: number
		body: unknown
		method: string
	} | null = null
	let nextId = 1

	const withPositions = () => {
		let position = 0
		return entries.map((entry) => ({
			...entry,
			position: ACTIVE.has(entry.status) ? ++position : null,
		}))
	}
	const listing = () =>
		makeWaitlistListing(withPositions(), {
			waitlistResponseMin: options.responseMin ?? 10,
		})

	const find = (id: string) => {
		const entry = entries.find((candidate) => candidate.id === id)
		if (!entry) {
			throw new ReservationsApiError('missing', 404, { error: 'not_found' })
		}
		return entry
	}
	const touch = (
		id: string,
		expected: unknown,
		patch: Partial<WaitlistEntry>,
	) => {
		const entry = find(id)
		if (typeof expected === 'number' && expected !== entry.version) {
			throw new ReservationsApiError('stale', 409, { error: 'stale_version' })
		}
		Object.assign(entry, patch, { version: entry.version + 1 })
		return {
			...entry,
			position: withPositions().find((e) => e.id === id)?.position ?? null,
		}
	}

	const request = vi.fn(
		async (
			path: string,
			opts: {
				method?: string
				body?: Record<string, any>
				headers?: Record<string, string>
				query?: Record<string, unknown>
			} = {},
		) => {
			const method = opts.method ?? 'GET'
			calls.push({
				path,
				method,
				body: opts.body,
				headers: opts.headers,
				query: opts.query,
			})
			if (
				failure &&
				failure.method === method &&
				path.endsWith(failure.suffix)
			) {
				const { status, body } = failure
				failure = null
				throw new ReservationsApiError('failed', status, body)
			}
			const body = opts.body ?? {}
			if (path === `${BASE}/quote`) {
				return {
					locationId: 'loc_1',
					businessDate: '2026-04-20',
					partySize: Number(opts.query?.partySize ?? 2),
					quotedMin: 15 + 5 * Number(opts.query?.partySize ?? 2),
					quotedReadyAt: WAITLIST_NOW,
					position: withPositions().filter((e) => e.position).length + 1,
					now: WAITLIST_NOW,
				}
			}
			if (path === BASE && method === 'POST') {
				const entry: WaitlistEntry = {
					id: `new_${nextId++}`,
					locationId: 'loc_1',
					businessDate: '2026-04-20',
					guestId: null,
					displayName: body.displayName,
					firstName: String(body.displayName).split(' ')[0] ?? '',
					lastName: String(body.displayName).split(' ').slice(1).join(' '),
					phone: body.phone ?? null,
					email: null,
					partySize: body.partySize,
					areaPrefId: body.areaPrefId ?? null,
					channel: 'walk_in',
					status: 'waiting',
					quotedMin: 20,
					quotedReadyAt: null,
					notifiedAt: null,
					responseDeadlineAt: null,
					reservationId: null,
					sortKey: entries.length + 1,
					notes: body.notes ?? null,
					smsOptIn: Boolean(body.smsOptIn),
					locale: 'en',
					version: 1,
					joinedAt: WAITLIST_NOW,
					createdAt: WAITLIST_NOW,
					position: null,
				}
				entries.push(entry)
				return { entry }
			}
			if (path === `${BASE}/reorder`) {
				const ids: string[] = body.ids
				const byId = new Map(entries.map((entry) => [entry.id, entry]))
				const listed = ids.map((id) => byId.get(id)!)
				const slots = entries
					.map((entry, index) => (ids.includes(entry.id) ? index : -1))
					.filter((index) => index >= 0)
				const next = [...entries]
				slots.forEach((slot, i) => {
					next[slot] = listed[i]!
				})
				entries = next
				return listing()
			}
			const match = path.match(new RegExp(`^${BASE}/([^/]+)(?:/(\\w+))?$`))
			if (match) {
				const [, id, action] = match as [string, string, string | undefined]
				if (!action && method === 'PATCH') {
					const { expectedVersion, ...patch } = body
					return { entry: touch(id, expectedVersion, patch) }
				}
				if (action === 'notify') {
					const current = find(id)
					if (current.status === 'notified') {
						return { entry: current, changed: false }
					}
					return {
						entry: touch(id, body.expectedVersion, {
							status: 'notified',
							notifiedAt: WAITLIST_NOW,
							responseDeadlineAt:
								WAITLIST_NOW + (options.responseMin ?? 10) * 60_000,
						}),
						changed: true,
					}
				}
				if (action === 'status') {
					return {
						entry: touch(id, body.expectedVersion, {
							status: body.status,
							...(body.status === 'waiting'
								? { notifiedAt: null, responseDeadlineAt: null }
								: {}),
						}),
						changed: true,
					}
				}
				if (action === 'seat') {
					const tableIds: string[] = body.tableIds ?? []
					const taken = tableIds.some((tableId) => occupied.has(tableId))
					if (taken && !body.overbook && !body.resolution) {
						const occupantStatus = options.occupantStatus ?? 'booked'
						const occupant = {
							kind: 'reservation',
							reservationId: 'rsv_occ',
							confirmationCode: 'ABC123',
							status: occupantStatus,
							partySize: 3,
							startAt: WAITLIST_NOW,
							endAt: WAITLIST_NOW + 90 * 60_000,
							tableIds,
							guestName: 'Lina Haddad',
						}
						throw new ReservationsApiError('occupied', 409, {
							error: 'table_occupied',
							occupant,
							occupants: [occupant],
							resolutions:
								occupantStatus === 'seated'
									? ['move', 'overbook']
									: ['swap', 'move', 'overbook'],
						})
					}
					return {
						entry: touch(id, body.expectedVersion, {
							status: 'seated',
							reservationId: 'rsv_1',
						}),
						reservation: null,
						moves: [],
					}
				}
			}
			throw new Error(`Unhandled fake waitlist call ${method} ${path}`)
		},
	)

	const requestConditional = vi.fn(async (path: string, opts: any) => {
		calls.push({
			path,
			method: 'GET',
			body: undefined,
			headers: undefined,
			query: opts?.query,
		})
		if (failure && failure.method === 'GET' && path.endsWith(failure.suffix)) {
			const { status, body } = failure
			failure = null
			throw new ReservationsApiError('failed', status, body)
		}
		return { status: 200 as const, data: listing(), etag: null }
	})

	const client = {
		scope: 'book',
		request,
		requestConditional,
		getToken: vi.fn(),
		invalidate: vi.fn(),
	} as unknown as ReservationsScopedClient

	return {
		client,
		calls,
		callsTo: (suffix: string) =>
			calls.filter(
				(call) => call.path.endsWith(suffix) && call.method !== 'GET',
			),
		/** Fail the next `method` request whose path ends with `suffix`. */
		failNext: (
			suffix: string,
			status: number,
			body: unknown,
			method = 'POST',
		) => {
			failure = { suffix, status, body, method }
		},
		/** Change a party behind the screen's back, as another host would. */
		mutate: (id: string, patch: Partial<WaitlistEntry>) => {
			const entry = find(id)
			Object.assign(entry, patch, { version: entry.version + 1 })
		},
		entries: () => withPositions(),
	}
}
