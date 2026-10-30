import { describe, expect, it, jest } from '@jest/globals'
import {
	needsApproval,
	partyCeiling,
	reservationManageViewSchema,
	reservationsConfigSchema,
} from './models'
import {
	requestMinuteOptions,
	ReservationsStore,
	type ReservationsStoreOptions,
	splitProfileName,
	venueTelUrl,
} from './reservations-store'
import {
	createMemoryReservationTokenStore,
	type StoredReservationTokens,
} from './token-store'
import { type HttpRequest } from '@/lib/api/http'
import {
	decodeFixture,
	fixtureJson,
	type FixtureName,
	fixtureText,
} from '@/test/reservations/fixtures'
import { flush, ManualClock } from '@/test/reservations/manual-clock'
import { makeReservationsClient } from '@/test/reservations/session'
import {
	header,
	sleep,
	type StubReply,
	StubTransport,
} from '@/test/stub-transport'

const SERVER_NOW = Date.parse('2030-06-14T16:00:00.000Z')

function ok(name: FixtureName): StubReply {
	return { status: 200, raw: fixtureText(name) }
}

type Route = StubReply | ((request: HttpRequest) => StubReply)

/** Answers by `METHOD /path`; an unknown route is a 404 so a stray call fails loudly. */
function router(routes: Record<string, Route>): StubTransport {
	return new StubTransport((request) => {
		const url = new URL(request.url)
		const route = routes[`${request.method} ${url.pathname}`]
		if (route === undefined)
			return { status: 404, json: { error: 'not_found' } }
		return typeof route === 'function' ? route(request) : route
	})
}

function sequence(...replies: StubReply[]): () => StubReply {
	let index = 0
	return () => {
		const reply = replies[Math.min(index, replies.length - 1)] ?? {
			status: 500,
		}
		index += 1
		return reply
	}
}

async function makeStore(
	transport: StubTransport,
	options: {
		tokens?: StoredReservationTokens
		clock?: ManualClock
		openBrowser?: ReservationsStoreOptions['openBrowser']
		openUrl?: ReservationsStoreOptions['openUrl']
		appActivity?: ReservationsStoreOptions['appActivity']
	} = {},
) {
	const client = await makeReservationsClient(transport.send)
	const tokens = createMemoryReservationTokenStore(options.tokens)
	const clock = options.clock ?? new ManualClock(SERVER_NOW)
	let keys = 0
	const store = new ReservationsStore({
		client,
		tokens,
		localeCode: 'en',
		now: clock.now,
		timers: clock.timers,
		openBrowser: options.openBrowser ?? (async () => undefined),
		openUrl: options.openUrl ?? (async () => undefined),
		appActivity: options.appActivity,
		makeKey: () => {
			keys += 1
			return `key-${keys}`
		},
	})
	return { store, tokens, clock }
}

/** The app's foreground state, switched by hand. */
function manualActivity() {
	let active = true
	const listeners = new Set<(active: boolean) => void>()
	return {
		isActive: () => active,
		subscribe(listener: (active: boolean) => void) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		set(next: boolean) {
			active = next
			for (const listener of listeners) listener(next)
		},
		get listeners() {
			return listeners.size
		},
	}
}

function countOf(transport: StubTransport, path: string): number {
	return transport.paths.filter((entry) => entry === path).length
}

const guest = {
	firstName: 'Ada',
	lastName: 'Lovelace',
	phone: '+14155553001',
}

describe('ReservationsStore (iOS ReservationsStoreTests)', () => {
	it('restores the waitlist entry after a relaunch', async () => {
		const transport = router({
			'GET /reservations/waitlist/status': ok('waitlist-status'),
		})
		const { store, tokens } = await makeStore(transport, {
			tokens: { manage: {}, waitlist: { entry_1: 'tok_wait_0001' } },
		})

		expect(store.getSnapshot().waitlist.statusToken).toBeNull()
		await store.restoreWaitlist()

		const { waitlist } = store.getSnapshot()
		expect(waitlist.statusToken).toBe('tok_wait_0001')
		expect(waitlist.phase).toEqual({ kind: 'waiting' })
		expect(waitlist.status?.status).toBe('waiting')
		expect(header(transport.lastRequest, 'X-Reservation-Token')).toBe(
			'tok_wait_0001',
		)
		expect((await tokens.load()).waitlist.entry_1).toBe('tok_wait_0001')
	})

	it('clears an unknown waitlist token so the guest can join again', async () => {
		const transport = router({
			'GET /reservations/waitlist/status': {
				status: 404,
				json: { error: 'not_found' },
			},
		})
		const { store, tokens } = await makeStore(transport, {
			tokens: { manage: {}, waitlist: { entry_1: 'tok_dead_0001' } },
		})

		await store.restoreWaitlist()
		await flush()

		expect(store.getSnapshot().waitlist.statusToken).toBeNull()
		expect(store.getSnapshot().waitlist.phase).toEqual({ kind: 'idle' })
		expect((await tokens.load()).waitlist).toEqual({})
	})

	it('forgets a finished waitlist entry on restore', async () => {
		const done = { ...fixtureJson('waitlist-status'), status: 'left' }
		const transport = router({
			'GET /reservations/waitlist/status': { json: done },
		})
		const { store, tokens } = await makeStore(transport, {
			tokens: { manage: {}, waitlist: { entry_1: 'tok_wait_0001' } },
		})

		await store.restoreWaitlist()
		await flush()

		expect(store.getSnapshot().waitlist.statusToken).toBeNull()
		expect((await tokens.load()).waitlist).toEqual({})
	})

	it('keeps the capability when the restore is offline', async () => {
		const transport = new StubTransport(() => {
			throw new TypeError('Network request failed')
		})
		const { store, tokens } = await makeStore(transport, {
			tokens: { manage: {}, waitlist: { entry_1: 'tok_wait_0001' } },
		})

		await store.restoreWaitlist()

		expect(store.getSnapshot().waitlist.statusToken).toBe('tok_wait_0001')
		expect((await tokens.load()).waitlist.entry_1).toBe('tok_wait_0001')
	})

	it('reset clears the persisted and in-memory capabilities', async () => {
		const transport = router({
			'GET /reservations/config': ok('config'),
			'GET /reservations/mine': ok('mine'),
			'GET /reservations/manage': ok('manage'),
			'GET /reservations/waitlist/status': ok('waitlist-status'),
			'POST /reservations/waitlist/status/leave': ok('waitlist-status'),
		})
		const { store, tokens } = await makeStore(transport, {
			tokens: {
				manage: { rsv_1: 'tok_manage_0001' },
				waitlist: { entry_1: 'tok_wait_0001' },
			},
		})
		await store.loadConfig()
		await store.loadMine()
		await store.loadManage('tok_manage_0001')
		await store.restoreWaitlist()
		store.updateDraft({ firstName: 'Previous' })
		expect(store.getSnapshot().waitlist.statusToken).not.toBeNull()
		expect(store.getSnapshot().mine).not.toBeNull()
		expect(store.getSnapshot().manage).not.toBeNull()

		await expect(store.reset()).resolves.toBe(true)

		const snapshot = store.getSnapshot()
		expect(snapshot.waitlist.statusToken).toBeNull()
		expect(snapshot.waitlist.status).toBeNull()
		expect(snapshot.waitlist.phase).toEqual({ kind: 'idle' })
		expect(snapshot.mine).toBeNull()
		expect(snapshot.manage).toBeNull()
		expect(snapshot.config).toBeNull()
		expect(snapshot.location).toBeNull()
		expect(snapshot.draft.firstName).toBe('')
		expect(snapshot.flow.phase).toEqual({ kind: 'idle' })
		expect(snapshot.loadState).toEqual({ kind: 'idle' })
		expect(tokens.raw).toBeNull()
		await expect(store.manageToken('rsv_1')).resolves.toBeNull()

		// The next customer's refresh has no capability to use.
		const before = transport.recorded.length
		await store.refreshWaitlist()
		await store.leaveWaitlist()
		expect(transport.recorded.length).toBe(before)
	})

	it('drops an answer that arrives after reset', async () => {
		const transport = new StubTransport(() => ({ ...ok('mine'), delayMs: 150 }))
		const { store, tokens } = await makeStore(transport)

		const pending = store.loadMine()
		await sleep(30)
		await store.reset()
		await pending
		await flush()

		expect(store.getSnapshot().mine).toBeNull()
		// The tokens `/mine` re-derives belong to the previous customer.
		expect(tokens.raw).toBeNull()
	})

	it('forgets the manage tokens of bookings that are over, so storage stays small', async () => {
		const upcoming = fixtureJson('mine').upcoming[0]
		const entry = (id: string, status: string) => ({
			...upcoming,
			id,
			status,
			manageToken: `tok_${id}`,
		})
		const transport = router({
			'GET /reservations/mine': {
				json: {
					...fixtureJson('mine'),
					upcoming: [
						entry('rsv_live', 'booked'),
						entry('rsv_off', 'cancelled'),
					],
					past: [entry('rsv_past', 'finished')],
				},
			},
		})
		const { store, tokens } = await makeStore(transport, {
			tokens: {
				manage: {
					rsv_past: 'tok_rsv_past',
					rsv_off: 'tok_rsv_off',
					rsv_unlisted: 'tok_unlisted',
				},
				waitlist: {},
			},
		})

		await store.loadMine()
		await flush()

		expect((await tokens.load()).manage).toEqual({
			rsv_unlisted: 'tok_unlisted',
			rsv_live: 'tok_rsv_live',
		})
		// A past booking still opens: its token comes from the list in memory.
		await expect(store.manageToken('rsv_past')).resolves.toBe('tok_rsv_past')
	})

	it('modify sends the selected party size', async () => {
		const transport = router({
			'POST /reservations/manage/modify': ok('manage'),
		})
		const { store } = await makeStore(transport)

		await expect(
			store.modify('tok_manage_0001', {
				date: '2030-06-25',
				localMin: 1170,
				partySize: 4,
			}),
		).resolves.toBe(true)

		const sent = transport.lastRequest
		expect(sent?.url.pathname).toBe('/reservations/manage/modify')
		expect(sent?.body.partySize).toBe(4)
		expect(sent?.body.localMin).toBe(1170)
		expect(header(sent, 'X-Reservation-Token')).toBe('tok_manage_0001')
	})

	it('lets the stepper reach the large-party range above the online maximum', () => {
		const config = decodeFixture(reservationsConfigSchema, 'config')
		const location = config.locations[0]!
		expect(location.partySize.max).toBe(4)
		expect(location.largeParty.mode).toBe('request')
		expect(partyCeiling(location)).toBe(99)
		expect(needsApproval(location, 4)).toBe(false)
		expect(needsApproval(location, 5)).toBe(true)
	})
})

describe('ReservationsStore snapshot', () => {
	it('publishes a new frozen snapshot per change and keeps it stable in between', async () => {
		const { store } = await makeStore(router({}))
		const listener = jest.fn()
		const unsubscribe = store.subscribe(listener)

		const first = store.getSnapshot()
		expect(store.getSnapshot()).toBe(first)
		expect(Object.isFrozen(first)).toBe(true)

		store.updateDraft({ firstName: 'Ada' })
		const second = store.getSnapshot()
		expect(second).not.toBe(first)
		expect(second.draft.firstName).toBe('Ada')
		expect(first.draft.firstName).toBe('')
		expect(listener).toHaveBeenCalledTimes(1)

		unsubscribe()
		store.updateDraft({ firstName: 'Grace' })
		expect(listener).toHaveBeenCalledTimes(1)
	})

	it('picks the only location and derives the strip, the party range and the request times', async () => {
		const transport = router({ 'GET /reservations/config': ok('config') })
		// The device clock runs five minutes behind the server.
		const clock = new ManualClock(SERVER_NOW - 5 * 60_000)
		const { store } = await makeStore(transport, { clock })

		await store.loadConfig()

		const snapshot = store.getSnapshot()
		expect(snapshot.loadState).toEqual({ kind: 'ready' })
		expect(snapshot.location?.id).toBe('loc_pub_main')
		expect(snapshot.serverOffsetMs).toBe(5 * 60_000)
		expect(snapshot.date).toBe('2030-06-14')
		expect(snapshot.days).toHaveLength(14)
		expect(snapshot.days[0]).toBe('2030-06-14')
		expect(snapshot.partyRange).toEqual({ min: 1, max: 99 })
		expect(snapshot.partySize).toBe(2)
		expect(snapshot.requestMinute).toBe(19 * 60)
		expect(snapshot.requestMinutes[0]).toBe(11 * 60)
		expect(snapshot.requestMinutes.at(-1)).toBe(23 * 60)
		expect(snapshot.requestMinutes).toHaveLength(49)
		const config = transport.recorded.find(
			(entry) => entry.url.pathname === '/reservations/config',
		)
		expect(config?.url.searchParams.get('locale')).toBe('en')
	})

	it('treats a missing booking page as unavailable and an offline device as a failure', async () => {
		const missing = await makeStore(
			router({
				'GET /reservations/config': {
					status: 404,
					json: { error: 'not_found' },
				},
			}),
		)
		await missing.store.loadConfig()
		expect(missing.store.getSnapshot().loadState).toEqual({
			kind: 'unavailable',
		})

		const offline = await makeStore(
			new StubTransport(() => {
				throw new TypeError('Network request failed')
			}),
		)
		await offline.store.loadConfig()
		expect(offline.store.getSnapshot().loadState).toEqual({
			kind: 'failed',
			failure: { kind: 'offline' },
		})
	})

	it('clamps the party to the location range', async () => {
		const { store } = await makeStore(
			router({ 'GET /reservations/config': ok('config') }),
		)
		await store.loadConfig()

		store.setPartySize(0)
		expect(store.getSnapshot().partySize).toBe(1)
		store.setPartySize(150)
		expect(store.getSnapshot().partySize).toBe(99)
	})
})

describe('ReservationsStore booking', () => {
	function bookingRoutes(overrides: Record<string, Route> = {}): StubTransport {
		return router({
			'GET /reservations/config': ok('config'),
			'GET /reservations/availability': ok('availability'),
			'POST /reservations/holds': ok('hold'),
			'POST /reservations/holds/release': { json: { ok: true } },
			'POST /reservations': ok('booking'),
			...overrides,
		})
	}

	async function holdFirstSlot(transport: StubTransport, clock?: ManualClock) {
		const made = await makeStore(transport, { clock })
		await made.store.loadConfig()
		await made.store.enterSearch()
		const slot = made.store.getSnapshot().flow.availability?.slots[0]
		if (!slot) throw new Error('expected a slot')
		await made.store.choose(slot)
		return made
	}

	it('searches, holds a time and counts the hold down on the server clock', async () => {
		const transport = bookingRoutes()
		const clock = new ManualClock(SERVER_NOW - 60_000)
		const { store } = await holdFirstSlot(transport, clock)

		const snapshot = store.getSnapshot()
		expect(snapshot.flow.phase).toEqual({ kind: 'details' })
		expect(snapshot.holdRemainingMs).toBe(7 * 60_000)
		expect(snapshot.holdCountdown).toBe('7:00')
		const hold = transport.recorded.find(
			(entry) => entry.url.pathname === '/reservations/holds',
		)
		expect(hold?.body).toMatchObject({
			locationId: 'loc_pub_main',
			slot: { localMin: 1020, partySize: 2 },
		})

		await clock.advance(1000)
		expect(store.getSnapshot().holdCountdown).toBe('6:59')
	})

	it('expires the hold when the deadline passes on the details form', async () => {
		const transport = bookingRoutes()
		const { store, clock } = await holdFirstSlot(transport)

		clock.jump(7 * 60_000 - 500)
		await clock.advance(1000)

		expect(store.getSnapshot().flow.phase).toEqual({ kind: 'expired' })
		expect(store.getSnapshot().holdRemainingMs).toBeNull()
		// The countdown stops once the hold is gone.
		expect(clock.pendingCount).toBe(0)
	})

	it('shows the alternatives with a notice when the time was just taken', async () => {
		const transport = bookingRoutes({
			'POST /reservations/holds': {
				status: 409,
				raw: fixtureText('error-slot-unavailable'),
			},
		})
		const { store } = await holdFirstSlot(transport)

		const snapshot = store.getSnapshot()
		expect(snapshot.takenNotice).toBe(true)
		expect(snapshot.flow.phase.kind).toBe('failed')
		expect(
			snapshot.flow.alternatives.sameDay.map((slot) => slot.localMin),
		).toContain(1170)

		await store.changeSearch({ date: '2030-06-22' })
		expect(store.getSnapshot().takenNotice).toBe(false)
		expect(store.getSnapshot().flow.phase).toEqual({ kind: 'choosingTime' })
	})

	it('books after review and remembers the manage token', async () => {
		const transport = bookingRoutes()
		const { store, tokens } = await holdFirstSlot(transport)

		await store.continueFromDetails()
		expect(store.getSnapshot().flow.phase).toEqual({ kind: 'details' })

		store.updateDraft(guest)
		expect(store.getSnapshot().canReview).toBe(true)
		await store.continueFromDetails()
		expect(store.getSnapshot().flow.phase).toEqual({ kind: 'reviewing' })

		await store.submit()
		await flush()

		expect(store.getSnapshot().flow.phase).toEqual({ kind: 'confirmed' })
		const booking = transport.recorded.find(
			(entry) =>
				entry.url.pathname === '/reservations' &&
				entry.request.method === 'POST',
		)
		expect(header(booking, 'Idempotency-Key')).toBe('key-1')
		expect(booking?.body).toMatchObject({
			holdToken: 'hold_fixture_token_0001',
			guest: { firstName: 'Ada', lastName: 'Lovelace', phone: '+14155553001' },
		})
		const reservationId = fixtureJson('booking').reservation.id
		expect((await tokens.load()).manage[reservationId]).toBe(
			fixtureJson('booking').manageToken,
		)
	})

	it('releases the held table when the guest leaves the booking', async () => {
		const transport = bookingRoutes()
		const { store, clock } = await holdFirstSlot(transport)

		await store.leaveBookingSteps()

		expect(store.getSnapshot().flow.phase).toEqual({ kind: 'idle' })
		const release = transport.recorded.find(
			(entry) => entry.url.pathname === '/reservations/holds/release',
		)
		expect(release).toBeDefined()
		expect(clock.pendingCount).toBe(0)
	})

	it('releases the held table of a customer who signs out', async () => {
		const transport = bookingRoutes()
		const { store } = await holdFirstSlot(transport)

		await store.reset()
		await flush()

		expect(countOf(transport, '/reservations/holds/release')).toBe(1)
	})

	it('polls the payment status with back-off until it is final', async () => {
		const pending = ok('payment-status-pending')
		const paid = {
			json: {
				paymentStatus: 'paid',
				reservationStatus: 'booked',
				now: '2030-06-14T16:00:00.000Z',
			},
		}
		const transport = bookingRoutes({
			'POST /reservations': ok('booking-pending-payment'),
			'GET /reservations/manage/payment': sequence(pending, pending, paid),
		})
		const openBrowser = jest.fn(async (_url: string) => undefined)
		const made = await makeStore(transport, { openBrowser })
		const { store, clock } = made
		await store.loadConfig()
		await store.enterSearch()
		await store.choose(store.getSnapshot().flow.availability!.slots[0]!)
		store.updateDraft(guest)
		await store.continueFromDetails()
		await store.submit()
		await flush()

		let snapshot = store.getSnapshot()
		expect(snapshot.flow.phase).toEqual({ kind: 'awaitingPayment' })
		expect(snapshot.isPolling).toBe(true)
		expect(snapshot.paymentRemainingMs).toBe(20 * 60_000)
		expect(countOf(transport, '/reservations/manage/payment')).toBe(1)
		const poll = transport.recorded.find(
			(entry) => entry.url.pathname === '/reservations/manage/payment',
		)
		expect(header(poll, 'X-Reservation-Token')).toBe(
			fixtureJson('booking-pending-payment').manageToken,
		)

		await clock.advance(1499)
		expect(countOf(transport, '/reservations/manage/payment')).toBe(1)
		// The payment window counts down while the guest pays.
		expect(store.getSnapshot().paymentRemainingMs).toBeLessThan(20 * 60_000)
		await clock.advance(1)
		expect(countOf(transport, '/reservations/manage/payment')).toBe(2)

		await clock.advance(2500)
		expect(countOf(transport, '/reservations/manage/payment')).toBe(3)
		snapshot = store.getSnapshot()
		expect(snapshot.flow.phase).toEqual({ kind: 'confirmed' })
		expect(snapshot.flow.paymentOutcome).toBe('paid')
		expect(snapshot.isPolling).toBe(false)

		await clock.advance(60_000)
		expect(countOf(transport, '/reservations/manage/payment')).toBe(3)
		expect(openBrowser).not.toHaveBeenCalled()
	})

	it('opens the payment page and checks again when the guest returns', async () => {
		const transport = bookingRoutes({
			'POST /reservations': ok('booking-pending-payment'),
			'GET /reservations/manage/payment': ok('payment-status-pending'),
		})
		const openBrowser = jest.fn(async (_url: string) => undefined)
		const { store } = await makeStore(transport, { openBrowser })
		await store.loadConfig()
		await store.enterSearch()
		await store.choose(store.getSnapshot().flow.availability!.slots[0]!)
		store.updateDraft(guest)
		await store.continueFromDetails()
		await store.submit()
		await flush()
		const before = countOf(transport, '/reservations/manage/payment')

		await store.openPayment()
		await flush()

		expect(openBrowser).toHaveBeenCalledWith(
			fixtureJson('booking-pending-payment').payment.payUrl,
		)
		expect(countOf(transport, '/reservations/manage/payment')).toBeGreaterThan(
			before,
		)
		store.stopPolling()
		expect(store.getSnapshot().isPolling).toBe(false)
	})

	it.each([
		'javascript:alert(1)',
		'http://acme.example/reserve/pay#t=x',
		'https://user:pass@acme.example/reserve/pay',
		'tel:+15550001111',
	])(
		'never opens an unsafe payment URL in the browser (%s)',
		async (payUrl) => {
			const pending = fixtureJson('booking-pending-payment')
			const transport = bookingRoutes({
				'POST /reservations': {
					status: 200,
					raw: JSON.stringify({
						...pending,
						payment: { ...pending.payment, payUrl },
					}),
				},
				'GET /reservations/manage/payment': ok('payment-status-pending'),
			})
			const openBrowser = jest.fn(async (_url: string) => undefined)
			const { store } = await makeStore(transport, { openBrowser })
			await store.loadConfig()
			await store.enterSearch()
			await store.choose(store.getSnapshot().flow.availability!.slots[0]!)
			store.updateDraft(guest)
			await store.continueFromDetails()
			await store.submit()
			await flush()

			await store.openPayment()
			await flush()

			expect(openBrowser).not.toHaveBeenCalled()
			store.stopPolling()
		},
	)

	it('remembers the payment in progress and forgets it once the status is final', async () => {
		const paid = {
			json: {
				paymentStatus: 'paid',
				reservationStatus: 'booked',
				now: '2030-06-14T16:00:00.000Z',
			},
		}
		const transport = bookingRoutes({
			'POST /reservations': ok('booking-pending-payment'),
			'GET /reservations/manage/payment': sequence(
				ok('payment-status-pending'),
				paid,
			),
		})
		const { store, tokens, clock } = await makeStore(transport)
		await store.loadConfig()
		await store.enterSearch()
		await store.choose(store.getSnapshot().flow.availability!.slots[0]!)
		store.updateDraft(guest)
		await store.continueFromDetails()
		await store.submit()
		await flush()

		const booking = fixtureJson('booking-pending-payment')
		expect((await tokens.load()).payment).toBe(booking.reservation.id)
		// The payment page URL carries a payment token: it is never stored.
		expect(tokens.raw).not.toContain(booking.payment.payUrl)

		await clock.advance(1500)
		expect(store.getSnapshot().flow.paymentOutcome).toBe('paid')
		expect((await tokens.load()).payment).toBeUndefined()
	})

	it('resumes the payment poll of a booking after the app was killed', async () => {
		const booking = fixtureJson('booking-pending-payment')
		const id = booking.reservation.id
		const paid = {
			json: {
				paymentStatus: 'paid',
				reservationStatus: 'booked',
				now: '2030-06-14T16:00:00.000Z',
			},
		}
		const transport = router({
			'GET /reservations/manage/payment': sequence(
				ok('payment-status-pending'),
				paid,
			),
			'GET /reservations/mine': ok('mine'),
		})
		const { store, tokens, clock } = await makeStore(transport, {
			tokens: {
				manage: { [id]: booking.manageToken },
				waitlist: {},
				payment: id,
			},
		})

		await store.resumePendingPayment()
		await flush()

		expect(countOf(transport, '/reservations/manage/payment')).toBe(1)
		expect(header(transport.recorded[0], 'X-Reservation-Token')).toBe(
			booking.manageToken,
		)
		expect(store.getSnapshot().pendingPayment).toEqual({
			reservationId: id,
			outcome: 'pending',
			isPolling: true,
		})

		await clock.advance(1500)
		expect(store.getSnapshot().pendingPayment).toEqual({
			reservationId: id,
			outcome: 'paid',
			isPolling: false,
		})
		expect((await tokens.load()).payment).toBeUndefined()
		// The list shows the settled booking.
		expect(countOf(transport, '/reservations/mine')).toBe(1)
		await clock.advance(60_000)
		expect(countOf(transport, '/reservations/manage/payment')).toBe(2)
	})

	it('keeps the payment to resume when the poll times out unsettled', async () => {
		const booking = fixtureJson('booking-pending-payment')
		const id = booking.reservation.id
		const transport = router({
			'GET /reservations/manage/payment': ok('payment-status-pending'),
		})
		const { store, tokens, clock } = await makeStore(transport, {
			tokens: {
				manage: { [id]: booking.manageToken },
				waitlist: {},
				payment: id,
			},
		})

		await store.resumePendingPayment()
		await clock.advance(4 * 60_000)

		expect(store.getSnapshot().pendingPayment?.isPolling).toBe(false)
		expect((await tokens.load()).payment).toBe(id)
	})

	it('forgets a stored payment whose booking has no token', async () => {
		const transport = router({})
		const { store, tokens } = await makeStore(transport, {
			tokens: { manage: {}, waitlist: {}, payment: 'rsv_gone' },
		})

		await store.resumePendingPayment()

		expect(transport.recorded).toHaveLength(0)
		expect((await tokens.load()).payment).toBeUndefined()
		expect(store.getSnapshot().pendingPayment).toBeNull()
	})

	it('stops polling for good when the link is dead', async () => {
		const transport = bookingRoutes({
			'POST /reservations': ok('booking-pending-payment'),
			'GET /reservations/manage/payment': {
				status: 404,
				json: { error: 'not_found' },
			},
		})
		const { store, clock } = await makeStore(transport)
		await store.loadConfig()
		await store.enterSearch()
		await store.choose(store.getSnapshot().flow.availability!.slots[0]!)
		store.updateDraft(guest)
		await store.continueFromDetails()
		await store.submit()
		await flush()

		expect(store.getSnapshot().isPolling).toBe(false)
		await clock.advance(30_000)
		expect(countOf(transport, '/reservations/manage/payment')).toBe(1)
	})

	it('sends a large-party request straight from the details form', async () => {
		const transport = bookingRoutes({
			'GET /reservations/availability': (request) => {
				const party = new URL(request.url).searchParams.get('partySize')
				if (party !== '6') return ok('availability')
				return {
					json: {
						...fixtureJson('availability'),
						partySize: 6,
						status: 'large_party',
						slots: [],
					},
				}
			},
			'POST /reservations/requests': ok('request'),
		})
		const { store } = await makeStore(transport)
		await store.loadConfig()
		await store.changeSearch({ partySize: 6 })
		expect(store.getSnapshot().offersRequest).toBe(true)

		store.setRequestMinute(20 * 60)
		store.startRequest()
		store.updateDraft(guest)
		expect(store.getSnapshot().isRequest).toBe(true)
		expect(store.getSnapshot().isRequestReady).toBe(true)
		await store.continueFromDetails()
		await flush()

		const sent = transport.recorded.find(
			(entry) => entry.url.pathname === '/reservations/requests',
		)
		expect(sent?.body).toMatchObject({
			locationId: 'loc_pub_main',
			slot: { localMin: 1200, partySize: 6 },
			guest: { firstName: 'Ada' },
		})
		expect(store.getSnapshot().flow.phase).toEqual({ kind: 'requested' })
	})
})

describe('ReservationsStore manage', () => {
	it('recovers a manage token through /mine on a new device', async () => {
		const mine = fixtureJson('mine')
		const entry = mine.upcoming[0]!
		const transport = router({
			'GET /reservations/mine': ok('mine'),
			'GET /reservations/manage': ok('manage'),
		})
		const { store } = await makeStore(transport)

		await store.reloadReservation(entry.id)

		expect(transport.paths).toEqual([
			'/reservations/mine',
			'/reservations/manage',
		])
		expect(header(transport.lastRequest, 'X-Reservation-Token')).toBe(
			entry.manageToken,
		)
		expect(store.getSnapshot().manage?.reservation.id).toBe('rsv_fixture_0001')
	})

	it('reports running late with a notice and maps a failure', async () => {
		const transport = router({
			'POST /reservations/manage/running-late': sequence(ok('manage'), {
				status: 409,
				json: { error: 'not_found' },
			}),
		})
		const { store } = await makeStore(transport)

		await expect(store.runningLate('tok_manage_0001', 15)).resolves.toBe(true)
		expect(store.getSnapshot().manageNotice).toBe('rsv.detail.lateSent')
		expect(transport.lastRequest?.body).toEqual({ minutes: 15 })

		await expect(store.runningLate('tok_manage_0001', 15)).resolves.toBe(false)
		expect(store.getSnapshot().manageNotice).toBeNull()
		expect(store.getSnapshot().manageFailure).toEqual({ kind: 'notFound' })
		expect(store.getSnapshot().isBusy).toBe(false)
	})

	it('calls the venue of a live booking only', async () => {
		const openUrl = jest.fn(async (_url: string) => undefined)
		const transport = router({ 'GET /reservations/manage': ok('manage') })
		const { store } = await makeStore(transport, { openUrl })

		await expect(store.callVenue()).resolves.toBe(false)
		await store.loadManage('tok_manage_0001')
		await expect(store.callVenue()).resolves.toBe(true)
		expect(openUrl).toHaveBeenCalledWith('tel:+12125550100')

		const view = decodeFixture(reservationManageViewSchema, 'manage')
		expect(venueTelUrl({ ...view, status: 'cancelled' })).toBeNull()
		expect(
			venueTelUrl({
				...view,
				reservation: {
					...view.reservation,
					location: {
						...view.reservation.location,
						phone: '+1 (212) 555-0100',
					},
				},
			}),
		).toBe('tel:+12125550100')
	})
})

describe('ReservationsStore waitlist', () => {
	it('joins, follows the position every 10 seconds and forgets the entry once seated', async () => {
		const seated = { ...fixtureJson('waitlist-status'), status: 'seated' }
		let isSeated = false
		const transport = router({
			'GET /reservations/config': ok('config'),
			'POST /reservations/waitlist/join': ok('waitlist-join'),
			'GET /reservations/waitlist/status': () =>
				isSeated ? { json: seated } : ok('waitlist-status'),
		})
		const { store, tokens, clock } = await makeStore(transport)
		await store.loadConfig()
		store.startWaitlistUpdates()

		await store.joinWaitlist({
			name: '  Ada ',
			phone: '+14155553001',
			smsOptIn: true,
		})
		await flush()

		const join = transport.recorded.find(
			(entry) => entry.url.pathname === '/reservations/waitlist/join',
		)
		expect(join?.body).toMatchObject({
			locationId: 'loc_pub_main',
			name: 'Ada',
			partySize: 2,
			smsOptIn: true,
			locale: 'en',
		})
		expect(header(join, 'Idempotency-Key')).toBe('key-1')
		const entryId = fixtureJson('waitlist-join').entry.id
		expect((await tokens.load()).waitlist[entryId]).toBe(
			fixtureJson('waitlist-join').statusToken,
		)
		expect(store.getSnapshot().waitlist.phase).toEqual({ kind: 'waiting' })
		const afterJoin = countOf(transport, '/reservations/waitlist/status')

		await clock.advance(10_000)
		expect(countOf(transport, '/reservations/waitlist/status')).toBe(
			afterJoin + 1,
		)

		isSeated = true
		await clock.advance(10_000)
		expect(store.getSnapshot().waitlist.phase).toEqual({ kind: 'seated' })
		expect((await tokens.load()).waitlist).toEqual({})
		expect(clock.pendingCount).toBe(0)
	})

	it('ignores a join without a name', async () => {
		const transport = router({ 'GET /reservations/config': ok('config') })
		const { store } = await makeStore(transport)
		await store.loadConfig()

		await store.joinWaitlist({
			name: '   ',
			phone: '+14155553001',
			smsOptIn: false,
		})

		expect(countOf(transport, '/reservations/waitlist/join')).toBe(0)
	})
	it('keeps the guest on their place in line when a refresh fails for now', async () => {
		const transport = router({
			'GET /reservations/waitlist/status': sequence(ok('waitlist-status'), {
				status: 503,
				json: { error: 'unavailable' },
			}),
		})
		const { store, tokens } = await makeStore(transport, {
			tokens: { manage: {}, waitlist: { entry_1: 'tok_wait_0001' } },
		})
		await store.restoreWaitlist()
		expect(store.getSnapshot().waitlist.phase.kind).toBe('waiting')

		await store.refreshWaitlist()

		const waitlist = store.getSnapshot().waitlist
		expect(waitlist.phase).toEqual({ kind: 'waiting' })
		expect(waitlist.refreshFailure).toEqual({ kind: 'paused' })
		expect(waitlist.status?.position).toBe(1)
		expect(waitlist.statusToken).toBe('tok_wait_0001')
		expect((await tokens.load()).waitlist).toEqual({
			entry_1: 'tok_wait_0001',
		})
	})

	it('backs off while the status keeps failing and returns to 10 seconds after an answer', async () => {
		let failing = false
		const transport = router({
			'GET /reservations/waitlist/status': () =>
				failing
					? { status: 503, json: { error: 'unavailable' } }
					: ok('waitlist-status'),
		})
		const { store, clock } = await makeStore(transport, {
			tokens: { manage: {}, waitlist: { entry_1: 'tok_wait_0001' } },
		})
		await store.restoreWaitlist()
		const calls = () => countOf(transport, '/reservations/waitlist/status')
		failing = true
		store.startWaitlistUpdates()
		await flush()
		const first = calls()

		// 1 failure: 20 s; 2 failures: 40 s.
		await clock.advance(10_000)
		expect(calls()).toBe(first)
		await clock.advance(10_000)
		expect(calls()).toBe(first + 1)
		await clock.advance(20_000)
		expect(calls()).toBe(first + 1)
		await clock.advance(20_000)
		expect(calls()).toBe(first + 2)
		expect(store.getSnapshot().waitlist.phase).toEqual({ kind: 'waiting' })

		// Three failures in a row: the next try is 80 seconds out.
		failing = false
		await clock.advance(79_000)
		expect(calls()).toBe(first + 2)
		await clock.advance(1_000)
		expect(calls()).toBe(first + 3)
		expect(store.getSnapshot().waitlist.refreshFailure).toBeNull()
		await clock.advance(10_000)
		expect(calls()).toBe(first + 4)
		store.stopWaitlistUpdates()
	})

	it('pauses the updates while the app is in the background', async () => {
		const transport = router({
			'GET /reservations/waitlist/status': ok('waitlist-status'),
		})
		const activity = manualActivity()
		const { store, clock } = await makeStore(transport, {
			tokens: { manage: {}, waitlist: { entry_1: 'tok_wait_0001' } },
			appActivity: activity,
		})
		await store.restoreWaitlist()
		const calls = () => countOf(transport, '/reservations/waitlist/status')
		store.startWaitlistUpdates()
		await flush()
		const started = calls()

		activity.set(false)
		await flush()
		expect(clock.pendingCount).toBe(0)
		await clock.advance(60_000)
		expect(calls()).toBe(started)

		activity.set(true)
		await flush()
		// Back in front: refreshed at once, then every 10 seconds again.
		expect(calls()).toBe(started + 1)
		await clock.advance(10_000)
		expect(calls()).toBe(started + 2)

		store.stopWaitlistUpdates()
		expect(activity.listeners).toBe(0)
	})
})

describe('ReservationsStore details form', () => {
	it('splits the profile name at the first space', () => {
		expect(splitProfileName('Ada King Lovelace')).toEqual({
			firstName: 'Ada',
			lastName: 'King Lovelace',
		})
		expect(splitProfileName('  Ada')).toEqual({
			firstName: 'Ada',
			lastName: '',
		})
		expect(splitProfileName('')).toEqual({ firstName: '', lastName: '' })
	})

	it('fills the name once per visit and the phone every time', async () => {
		const { store } = await makeStore(router({}))
		const profile = {
			name: 'Ada Lovelace',
			phone: '+14155553001',
			email: 'ada@example.com',
		}

		store.prefillDraft(profile)
		store.updateDraft({ firstName: 'Augusta' })
		store.prefillDraft({ ...profile, phone: '+14155553002' })

		const { draft } = store.getSnapshot()
		expect(draft.firstName).toBe('Augusta')
		expect(draft.lastName).toBe('Lovelace')
		expect(draft.email).toBe('ada@example.com')
		expect(draft.phone).toBe('+14155553002')
		expect(draft.locale).toBe('en')
	})

	it('offers request times on the location grid', () => {
		expect(requestMinuteOptions(null)).toHaveLength(49)
		const config = decodeFixture(reservationsConfigSchema, 'config')
		const location = config.locations[0]!
		expect(requestMinuteOptions({ ...location, intervalMin: 30 })).toHaveLength(
			25,
		)
		expect(requestMinuteOptions({ ...location, intervalMin: 1 })[1]).toBe(
			11 * 60 + 5,
		)
	})
})
