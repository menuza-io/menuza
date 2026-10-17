import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvHolds,
	rsvGuests,
	rsvIdempotencyKeys,
	rsvLocationSettings,
	rsvMessages,
	rsvOutbox,
	rsvPayments,
	rsvRateCounters,
	rsvReservationEvents,
	rsvReservations,
	rsvTableOccupancies,
	rsvWaitlistEntries,
} from '@repo/tenant-db'
import { type ReservationsContext } from '@repo/reservations'
import { and, eq } from 'drizzle-orm'
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import { resetReservationsContextCache } from '../lib/reservations-context.ts'
import * as reservationsWrite from '../lib/reservations-write.ts'
import {
	dateAhead,
	PUBLIC_LOC,
	publicContext,
	seedPublicOrg,
} from '../routes/reservations-public-fixture.ts'
import * as booking from './rsv-booking-service.ts'
import * as notify from './rsv-notify-service.ts'
import { enqueueManagerAlert, type ManagerAlertEvent } from './rsv-outbox.ts'
import {
	addToReservationsAggregate,
	AUTO_NO_SHOW_LOOKBACK_MS,
	emptyReservationsAggregate,
	FOLLOW_UP_HORIZON_MS,
	HOLD_RETENTION_MS,
	IDEMPOTENCY_RETENTION_MS,
	MESSAGE_RETENTION_MS,
	OUTBOX_RETENTION_MS,
	RATE_COUNTER_RETENTION_MS,
	resetReservationsTickLocks,
	RESERVATIONS_TICK_TASK_NAMES,
	runReservationsTickForOrg,
	TICK_SYSTEM_ACTOR,
	type ReservationsTickDeps,
	type ReservationsTickResult,
} from './rsv-tick-service.ts'

const sendEmail = vi.hoisted(() => vi.fn())

vi.mock('../lib/tenant-email.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/tenant-email.ts')>()),
	sendTenantEmail: sendEmail,
}))

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-tick-svc-'))
process.env.TENANT_DB_DIR = TEST_DIR
process.env.DATA_REGION = 'us'
process.env.AUTH_HMAC_SECRET = 'test-tick-auth-hmac-secret-0123456789'
process.env.JWT_SECRET = 'test-tick-customer-jwt-secret-123456789'

const ORG = 'org_rsv_tick_svc'
const OTHER_LOC = 'loc_tick_other'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
// An hour past the real clock: rows queued with this send time are not yet due
// by the real clock, so a write's after-commit delivery leaves them for the tick.
const NOW = Date.now() + HOUR

let counter = 0
const next = () => ++counter

function ctx(
	over: {
		enabled?: boolean
		waitlist?: boolean
		dataRegion?: 'us' | 'ksa' | null
	} = {},
): ReservationsContext {
	const base = publicContext(ORG)
	return {
		...base,
		dataRegion: (over.dataRegion === undefined
			? 'us'
			: over.dataRegion) as ReservationsContext['dataRegion'],
		features: {
			...base.features,
			enabled: over.enabled ?? true,
			waitlist: over.waitlist ?? true,
		},
	}
}

type TickOverrides = Partial<ReservationsTickDeps> & { at?: number }

function runTick(over: TickOverrides = {}, orgId = ORG) {
	const { at, ...deps } = over
	return runReservationsTickForOrg(orgId, {
		deps: {
			now: () => at ?? NOW,
			getContext: async () => ctx(),
			regionMatches: () => true,
			outboxPost: async () => ({ status: 'delivered' }),
			...deps,
		},
	})
}

const taskOf = (result: ReservationsTickResult, name: string) =>
	result.tasks.find((t) => t.name === name)!

async function db() {
	return getTenantDb(ORG)
}

function dateOf(ms: number) {
	return new Date(ms).toISOString().slice(0, 10)
}

async function addGuest(email: string | null = `guest${next()}@example.com`) {
	const id = `guest_${next()}`
	await (await db()).insert(rsvGuests).values({
		id,
		firstName: 'Gia',
		lastName: 'Guest',
		emailNorm: email,
	})
	return id
}

async function addReservation(
	over: Partial<typeof rsvReservations.$inferInsert> & { startAt: number },
) {
	const n = next()
	const id = over.id ?? `res_${n}`
	const guestId = over.guestId ?? (await addGuest())
	const startAt = over.startAt
	await (await db()).insert(rsvReservations).values({
		locationId: PUBLIC_LOC,
		confirmationCode: `TICK${n}`,
		businessDate: dateOf(startAt),
		localStartMin: 19 * 60,
		timeZone: 'UTC',
		endAt: startAt + 90 * MINUTE,
		durationMin: 90,
		partySize: 2,
		status: 'booked',
		...over,
		id,
		guestId,
	})
	return id
}

async function reservation(id: string) {
	return (await db())
		.select()
		.from(rsvReservations)
		.where(eq(rsvReservations.id, id))
		.get()
}

async function addHold(
	over: Partial<typeof rsvHolds.$inferInsert> & { expiresAt: number },
) {
	const n = next()
	const startAt = NOW + 3 * DAY
	const id = over.id ?? `hold_${n}`
	await (await db()).insert(rsvHolds).values({
		locationId: PUBLIC_LOC,
		tokenHash: `token_hash_${n}`,
		businessDate: dateOf(startAt),
		localStartMin: 19 * 60,
		startAt,
		endAt: startAt + 90 * MINUTE,
		partySize: 2,
		status: 'active',
		...over,
		id,
	})
	return id
}

async function hold(id: string) {
	return (await db()).select().from(rsvHolds).where(eq(rsvHolds.id, id)).get()
}

async function addMessage(
	over: Partial<typeof rsvMessages.$inferInsert> = {},
): Promise<string> {
	const n = next()
	const id = over.id ?? `msg_${n}`
	await (await db()).insert(rsvMessages).values({
		locationId: PUBLIC_LOC,
		kind: 'confirmation',
		channel: 'email',
		sendAt: NOW - MINUTE,
		nextAttemptAt: NOW - MINUTE,
		dedupeKey: `tick-test:${n}`,
		status: 'pending',
		createdAt: NOW - MINUTE,
		...over,
		id,
	})
	return id
}

async function message(id: string) {
	return (await db())
		.select()
		.from(rsvMessages)
		.where(eq(rsvMessages.id, id))
		.get()
}

async function addOutbox(
	over: Partial<typeof rsvOutbox.$inferInsert> = {},
): Promise<string> {
	const n = next()
	const id = over.id ?? `out_${n}`
	await (await db()).insert(rsvOutbox).values({
		kind: 'manager_alert',
		dedupeKey: `outbox-test:${n}`,
		payload: {
			orgId: ORG,
			eventId: `evt_${n}abcdefgh`,
			kind: 'large_party_request',
			locationId: PUBLIC_LOC,
			count: 1,
		},
		status: 'pending',
		nextAttemptAt: NOW - MINUTE,
		createdAt: NOW - MINUTE,
		...over,
		id,
	})
	return id
}

async function outbox(id: string) {
	return (await db()).select().from(rsvOutbox).where(eq(rsvOutbox.id, id)).get()
}

async function setAutoNoShow(minutes: number | null, locationId = PUBLIC_LOC) {
	await (
		await db()
	)
		.update(rsvLocationSettings)
		.set({ autoNoShowAfterMin: minutes })
		.where(eq(rsvLocationSettings.locationId, locationId))
}

async function addSecondLocation(autoNoShowAfterMin: number | null) {
	await (await db()).insert(rsvLocationSettings).values({
		locationId: OTHER_LOC,
		enabled: true,
		timeZone: 'UTC',
		autoNoShowAfterMin,
	})
}

beforeEach(async () => {
	sendEmail.mockReset()
	sendEmail.mockResolvedValue({
		status: 'success',
		data: { messageId: 'provider-1' },
	})
	await destroyTenantDb(ORG).catch(() => undefined)
	resetReservationsContextCache()
	reservationsWrite.clearReservationDayCacheForTest()
	resetReservationsTickLocks()
	await seedPublicOrg(ORG, {
		settings: { waitlistEnabled: true, notifyMeEnabled: true },
	})
})

afterEach(() => {
	vi.restoreAllMocks()
})

afterAll(() => {
	fs.rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('skipping an organization', () => {
	it('skips an organization this node has no database for', async () => {
		const result = await runTick({}, 'org_rsv_tick_missing')
		expect(result).toMatchObject({
			orgId: 'org_rsv_tick_missing',
			status: 'skipped',
			reason: 'no_database',
			tasks: [],
			needsFollowUp: false,
			nextDueAt: null,
		})
	})

	it('skips an organization with no reservations setup and asks nobody for flags', async () => {
		await provisionTenantDb('org_rsv_tick_empty')
		const getContext = vi.fn(async () => ctx())
		const result = await runTick({ getContext }, 'org_rsv_tick_empty')
		expect(result).toMatchObject({
			status: 'skipped',
			reason: 'no_reservations',
			tasks: [],
		})
		expect(getContext).not.toHaveBeenCalled()
		await destroyTenantDb('org_rsv_tick_empty')
	})

	it('still runs for an organization that has messages but no settings row left', async () => {
		await provisionTenantDb('org_rsv_tick_msgonly')
		const other = await getTenantDb('org_rsv_tick_msgonly')
		await other.insert(rsvMessages).values({
			locationId: PUBLIC_LOC,
			kind: 'confirmation',
			channel: 'email',
			sendAt: NOW - MINUTE,
			nextAttemptAt: NOW - MINUTE,
			dedupeKey: 'msg-only:1',
			status: 'sent',
			createdAt: NOW - MINUTE,
		})
		const result = await runTick({}, 'org_rsv_tick_msgonly')
		expect(result.status).toBe('ran')
		await destroyTenantDb('org_rsv_tick_msgonly')
	})

	it('skips when the control plane gives no flags', async () => {
		const lapsed = await addHold({ expiresAt: NOW - MINUTE })
		const result = await runTick({ getContext: async () => null })
		expect(result).toMatchObject({
			status: 'skipped',
			reason: 'flags_unknown',
			tasks: [],
		})
		expect((await hold(lapsed))?.status).toBe('active')
	})

	it('hands the context lookup the organization and the tick time', async () => {
		const getContext = vi.fn(async () => ctx())
		await runTick({ getContext, at: NOW + 5 })
		expect(getContext).toHaveBeenCalledWith(ORG, NOW + 5)
	})

	it('skips an organization that belongs to another region, whatever the flags', async () => {
		await addHold({ expiresAt: NOW - MINUTE })
		const regionMatches = vi.fn(() => false)
		const result = await runTick({
			regionMatches,
			getContext: async () => ctx({ dataRegion: 'ksa' }),
		})
		expect(result).toMatchObject({
			status: 'skipped',
			reason: 'region_mismatch',
			tasks: [],
		})
		expect(regionMatches).toHaveBeenCalledWith('ksa')
		expect((await (await db()).select().from(rsvHolds))[0]!.status).toBe(
			'active',
		)
	})

	it('treats an unset region as a match and passes null to the check', async () => {
		const regionMatches = vi.fn(() => true)
		const result = await runTick({
			regionMatches,
			getContext: async () => ctx({ dataRegion: null }),
		})
		expect(regionMatches).toHaveBeenCalledWith(null)
		expect(result.status).toBe('ran')
	})

	it('uses the node region by default: a ksa organization on a us node is skipped', async () => {
		const result = await runReservationsTickForOrg(ORG, {
			deps: {
				now: () => NOW,
				getContext: async () => ctx({ dataRegion: 'ksa' }),
			},
		})
		expect(result).toMatchObject({
			status: 'skipped',
			reason: 'region_mismatch',
		})
		const matching = await runReservationsTickForOrg(ORG, {
			deps: { now: () => NOW, getContext: async () => ctx() },
		})
		expect(matching.status).toBe('ran')
	})

	it('runs against an injected database', async () => {
		const injected = await db()
		const result = await runReservationsTickForOrg(ORG, {
			db: injected,
			deps: {
				now: () => NOW,
				getContext: async () => ctx(),
				regionMatches: () => true,
				outboxPost: async () => ({ status: 'delivered' }),
			},
		})
		expect(result.status).toBe('ran')
	})
})

describe('one pass at a time per organization', () => {
	it('answers busy while a pass is in flight and runs again once it ends', async () => {
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const first = runTick({
			getContext: async () => {
				await gate
				return ctx()
			},
		})
		const second = await runTick()
		expect(second).toMatchObject({
			status: 'skipped',
			reason: 'busy',
			tasks: [],
			needsFollowUp: false,
		})
		// Another organization is not blocked by it.
		expect((await runTick({}, 'org_rsv_tick_other')).reason).toBe('no_database')
		release()
		expect((await first).status).toBe('ran')
		expect((await runTick()).status).toBe('ran')
	})

	it('frees the organization when a pass throws', async () => {
		await expect(
			runTick({
				getContext: async () => {
					throw new Error('control plane down')
				},
			}),
		).rejects.toThrow('control plane down')
		expect((await runTick()).status).toBe('ran')
	})
})

describe('the shape of a pass', () => {
	it('runs every task in order and reports counts only', async () => {
		const result = await runTick()
		expect(result).toMatchObject({
			orgId: ORG,
			status: 'ran',
			at: NOW,
			needsFollowUp: false,
			nextDueAt: null,
		})
		expect(result.tasks.map((t) => t.name)).toEqual([
			...RESERVATIONS_TICK_TASK_NAMES,
		])
		expect(result.tasks.every((t) => t.status === 'ok')).toBe(true)
		expect(result.messages).toEqual({
			sent: 0,
			failed: 0,
			retried: 0,
			suppressed: 0,
			dropped: 0,
			cancelled: 0,
			held: 0,
		})
		expect(result.outbox).toEqual({
			groups: 0,
			delivered: 0,
			retried: 0,
			failed: 0,
		})
	})

	it('reports the injected time as `at`', async () => {
		expect((await runTick({ at: NOW + 7 })).at).toBe(NOW + 7)
	})
})

describe('expire_holds', () => {
	it('expires lapsed holds, frees their tables, and leaves live ones', async () => {
		const lapsed = await addHold({ expiresAt: NOW - MINUTE })
		const edge = await addHold({ expiresAt: NOW })
		const live = await addHold({ expiresAt: NOW + 5 * MINUTE })
		const startAt = NOW + 3 * DAY
		await (await db()).insert(rsvTableOccupancies).values({
			id: 'occ_lapsed',
			locationId: PUBLIC_LOC,
			tableId: 'tbl_pub_2',
			kind: 'hold',
			holdId: lapsed,
			startAt,
			endAt: startAt + 90 * MINUTE,
			active: true,
		})
		const result = await runTick()
		expect(taskOf(result, 'expire_holds')).toMatchObject({
			status: 'ok',
			count: 2,
			detail: { holds: 2, pendingPayments: 0 },
		})
		expect((await hold(lapsed))?.status).toBe('expired')
		expect((await hold(edge))?.status).toBe('expired')
		expect((await hold(live))?.status).toBe('active')
		const occupancy = await (
			await db()
		)
			.select()
			.from(rsvTableOccupancies)
			.where(eq(rsvTableOccupancies.id, 'occ_lapsed'))
			.get()
		expect(occupancy?.active).toBe(false)
	})

	it('expires a pending-payment booking past its payment deadline and counts it here', async () => {
		const lapsed = await addReservation({
			startAt: NOW + 2 * DAY,
			status: 'pending_payment',
			paymentExpiresAt: NOW - MINUTE,
		})
		const live = await addReservation({
			startAt: NOW + 2 * DAY,
			status: 'pending_payment',
			paymentExpiresAt: NOW + 10 * MINUTE,
		})
		const result = await runTick()
		expect(taskOf(result, 'expire_holds')).toMatchObject({
			count: 1,
			detail: { holds: 0, pendingPayments: 1 },
		})
		expect((await reservation(lapsed))?.status).toBe('expired')
		expect((await reservation(live))?.status).toBe('pending_payment')
	})

	it('is idempotent: a second pass finds nothing left', async () => {
		await addHold({ expiresAt: NOW - MINUTE })
		await runTick()
		const again = await runTick()
		expect(taskOf(again, 'expire_holds').count).toBe(0)
	})
})

describe('expire_requests', () => {
	it('expires a request past its deadline and queues request_declined for it', async () => {
		const lapsed = await addReservation({
			startAt: NOW + 2 * DAY,
			status: 'pending_approval',
			requestDeadlineAt: NOW - MINUTE,
		})
		const live = await addReservation({
			startAt: NOW + 2 * DAY,
			status: 'pending_approval',
			requestDeadlineAt: NOW + 30 * MINUTE,
		})
		const result = await runTick()
		expect(taskOf(result, 'expire_requests')).toMatchObject({
			status: 'ok',
			count: 1,
		})
		expect((await reservation(lapsed))?.status).toBe('expired')
		expect((await reservation(live))?.status).toBe('pending_approval')

		const declined = await (
			await db()
		)
			.select()
			.from(rsvMessages)
			.where(eq(rsvMessages.kind, 'request_declined'))
		expect(declined).toHaveLength(1)
		expect(declined[0]).toMatchObject({
			reservationId: lapsed,
			channel: 'email',
		})
		// Queued with the tick time, so the same pass delivers it.
		expect(declined[0]!.sendAt).toBe(NOW)
		expect(declined[0]!.status).toBe('sent')
		expect(sendEmail).toHaveBeenCalledTimes(1)
		expect(result.messages.sent).toBe(1)

		const events = await (
			await db()
		)
			.select()
			.from(rsvReservationEvents)
			.where(eq(rsvReservationEvents.reservationId, lapsed))
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			actorKind: 'system',
			type: 'expired',
			fromStatus: 'pending_approval',
			toStatus: 'expired',
		})
	})

	it('queues one message per lapsed request and never again on a later pass', async () => {
		for (let i = 0; i < 3; i++) {
			await addReservation({
				startAt: NOW + 2 * DAY,
				status: 'pending_approval',
				requestDeadlineAt: NOW - (i + 1) * MINUTE,
			})
		}
		const first = await runTick()
		expect(taskOf(first, 'expire_requests').count).toBe(3)
		const second = await runTick({ at: NOW + MINUTE })
		expect(taskOf(second, 'expire_requests').count).toBe(0)
		const declined = await (
			await db()
		)
			.select()
			.from(rsvMessages)
			.where(eq(rsvMessages.kind, 'request_declined'))
		expect(declined).toHaveLength(3)
	})

	it('does not queue anything for a guest who was erased', async () => {
		const guestId = await addGuest('gone@example.com')
		await (
			await db()
		)
			.update(rsvGuests)
			.set({ erasedAt: NOW - DAY })
			.where(eq(rsvGuests.id, guestId))
		await addReservation({
			startAt: NOW + 2 * DAY,
			guestId,
			status: 'pending_approval',
			requestDeadlineAt: NOW - MINUTE,
		})
		await runTick()
		const declined = await (
			await db()
		)
			.select()
			.from(rsvMessages)
			.where(eq(rsvMessages.kind, 'request_declined'))
		expect(declined).toHaveLength(0)
	})
})

describe('auto_no_show', () => {
	it('marks nothing when no location sets a grace period', async () => {
		const id = await addReservation({ startAt: NOW - 3 * HOUR })
		const result = await runTick()
		expect(taskOf(result, 'auto_no_show')).toMatchObject({
			status: 'ok',
			count: 0,
		})
		expect((await reservation(id))?.status).toBe('booked')
	})

	it('marks a late booked or confirmed reservation as no-show by the system actor', async () => {
		await setAutoNoShow(30)
		const booked = await addReservation({ startAt: NOW - 40 * MINUTE })
		const confirmed = await addReservation({
			startAt: NOW - 90 * MINUTE,
			status: 'confirmed',
		})
		const result = await runTick()
		expect(taskOf(result, 'auto_no_show')).toMatchObject({
			status: 'ok',
			count: 2,
		})
		for (const id of [booked, confirmed]) {
			const row = (await reservation(id))!
			expect(row.status).toBe('no_show')
			expect(row.noShowAt).toBe(NOW)
		}
		const events = await (
			await db()
		)
			.select()
			.from(rsvReservationEvents)
			.where(
				and(
					eq(rsvReservationEvents.reservationId, booked),
					eq(rsvReservationEvents.type, 'no_show'),
				),
			)
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			actorKind: 'system',
			actorId: null,
			fromStatus: 'booked',
			toStatus: 'no_show',
			data: expect.objectContaining({ reason: 'auto_no_show' }),
		})
		expect(TICK_SYSTEM_ACTOR).toBe('reservations-tick')
	})

	it('counts the no-show against the guest and frees the table', async () => {
		await setAutoNoShow(15)
		const guestId = await addGuest()
		const id = await addReservation({ startAt: NOW - HOUR, guestId })
		await (await db()).insert(rsvTableOccupancies).values({
			id: 'occ_noshow',
			locationId: PUBLIC_LOC,
			tableId: 'tbl_pub_2',
			kind: 'reservation',
			reservationId: id,
			startAt: NOW - HOUR,
			endAt: NOW + 30 * MINUTE,
			active: true,
		})
		await runTick()
		const guest = await (
			await db()
		)
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, guestId))
			.get()
		expect(guest?.noShows).toBe(1)
		const occupancy = await (
			await db()
		)
			.select()
			.from(rsvTableOccupancies)
			.where(eq(rsvTableOccupancies.id, 'occ_noshow'))
			.get()
		expect(occupancy?.active).toBe(false)
	})

	it('waits out the grace period and marks it from the minute it ends', async () => {
		await setAutoNoShow(30)
		const inside = await addReservation({ startAt: NOW - 29 * MINUTE })
		const boundary = await addReservation({ startAt: NOW - 30 * MINUTE })
		const result = await runTick()
		expect(taskOf(result, 'auto_no_show').count).toBe(1)
		expect((await reservation(inside))?.status).toBe('booked')
		expect((await reservation(boundary))?.status).toBe('no_show')
		const later = await runTick({ at: NOW + MINUTE })
		expect(taskOf(later, 'auto_no_show').count).toBe(1)
		expect((await reservation(inside))?.status).toBe('no_show')
	})

	it('pushes the deadline out by the minutes a running-late guest gave', async () => {
		await setAutoNoShow(30)
		const late = await addReservation({
			startAt: NOW - 40 * MINUTE,
			runningLateMin: 15,
		})
		const barely = await addReservation({
			startAt: NOW - 40 * MINUTE,
			runningLateMin: 10,
		})
		const result = await runTick()
		// 40 min in with 30 min grace: 15 late minutes reach to +5 min, 10 to now.
		expect(taskOf(result, 'auto_no_show').count).toBe(1)
		expect((await reservation(late))?.status).toBe('booked')
		expect((await reservation(barely))?.status).toBe('no_show')
	})

	it('leaves reservations that have arrived, are seated, finished or cancelled', async () => {
		await setAutoNoShow(10)
		const ids: Record<string, string> = {}
		for (const status of [
			'arrived',
			'seated',
			'finished',
			'cancelled',
			'pending_approval',
			'pending_payment',
			'declined',
		] as const) {
			ids[status] = await addReservation({
				startAt: NOW - 2 * HOUR,
				status,
				requestDeadlineAt: status === 'pending_approval' ? NOW + DAY : null,
				paymentExpiresAt: status === 'pending_payment' ? NOW + DAY : null,
			})
		}
		const result = await runTick()
		expect(taskOf(result, 'auto_no_show').count).toBe(0)
		for (const [status, id] of Object.entries(ids)) {
			expect((await reservation(id))?.status).toBe(status)
		}
	})

	it('only acts for locations that set a grace period', async () => {
		await addSecondLocation(null)
		await setAutoNoShow(30)
		const configured = await addReservation({ startAt: NOW - HOUR })
		const unconfigured = await addReservation({
			startAt: NOW - HOUR,
			locationId: OTHER_LOC,
		})
		const result = await runTick()
		expect(taskOf(result, 'auto_no_show').count).toBe(1)
		expect((await reservation(configured))?.status).toBe('no_show')
		expect((await reservation(unconfigured))?.status).toBe('booked')
	})

	it("uses each location's own grace period", async () => {
		await addSecondLocation(120)
		await setAutoNoShow(20)
		const quick = await addReservation({ startAt: NOW - HOUR })
		const slow = await addReservation({
			startAt: NOW - HOUR,
			locationId: OTHER_LOC,
		})
		await runTick()
		expect((await reservation(quick))?.status).toBe('no_show')
		expect((await reservation(slow))?.status).toBe('booked')
	})

	it('leaves history alone: nothing older than the lookback is marked', async () => {
		await setAutoNoShow(30)
		const ancient = await addReservation({
			startAt: NOW - AUTO_NO_SHOW_LOOKBACK_MS - HOUR,
		})
		const recent = await addReservation({
			startAt: NOW - AUTO_NO_SHOW_LOOKBACK_MS + HOUR,
		})
		await runTick()
		expect((await reservation(ancient))?.status).toBe('booked')
		expect((await reservation(recent))?.status).toBe('no_show')
	})

	it('never charges a fee, queues a payment command, or messages the guest', async () => {
		await setAutoNoShow(10)
		const id = await addReservation({
			startAt: NOW - 2 * HOUR,
			paymentStatus: 'guaranteed',
			policySnapshot: { noShowFeeMinor: 2500, currency: 'USD' },
		})
		await runTick()
		const row = (await reservation(id))!
		expect(row.status).toBe('no_show')
		// The card guarantee is untouched: no fee pending, charged or failed.
		expect(row.paymentStatus).toBe('guaranteed')
		expect(await (await db()).select().from(rsvPayments)).toEqual([])
		expect(await (await db()).select().from(rsvOutbox)).toEqual([])
		expect(await (await db()).select().from(rsvMessages)).toEqual([])
		expect(sendEmail).not.toHaveBeenCalled()
	})

	it('does not mark a reservation twice on a repeat pass', async () => {
		await setAutoNoShow(10)
		await addReservation({ startAt: NOW - HOUR })
		expect(taskOf(await runTick(), 'auto_no_show').count).toBe(1)
		expect(taskOf(await runTick(), 'auto_no_show').count).toBe(0)
	})

	it('skips a reservation that moved on in the meantime without failing the task', async () => {
		await setAutoNoShow(10)
		const id = await addReservation({ startAt: NOW - HOUR })
		const other = await addReservation({ startAt: NOW - 2 * HOUR })
		const real = booking.transitionReservationStatus
		vi.spyOn(booking, 'transitionReservationStatus').mockImplementation(
			async (params) => {
				if (params.reservationId === id) {
					const { HttpError } = await import('../lib/http.ts')
					throw new HttpError(409, 'invalid_status_transition')
				}
				return real(params)
			},
		)
		const result = await runTick()
		expect(taskOf(result, 'auto_no_show')).toMatchObject({
			status: 'ok',
			count: 1,
		})
		expect((await reservation(other))?.status).toBe('no_show')
	})
})

describe('waitlist_offers', () => {
	it('expires an offer past its response deadline', async () => {
		const entryId = 'wl_lapsed'
		await (await db()).insert(rsvWaitlistEntries).values({
			id: entryId,
			locationId: PUBLIC_LOC,
			businessDate: dateOf(NOW),
			displayName: 'Walt',
			partySize: 2,
			status: 'notified',
			notifiedAt: NOW - 20 * MINUTE,
			responseDeadlineAt: NOW - MINUTE,
		})
		await (await db()).insert(rsvWaitlistEntries).values({
			id: 'wl_live',
			locationId: PUBLIC_LOC,
			businessDate: dateOf(NOW),
			displayName: 'Wendy',
			partySize: 2,
			status: 'notified',
			notifiedAt: NOW - MINUTE,
			responseDeadlineAt: NOW + 9 * MINUTE,
		})
		const result = await runTick()
		expect(taskOf(result, 'waitlist_offers')).toMatchObject({
			status: 'ok',
			count: 1,
		})
		const rows = await (await db()).select().from(rsvWaitlistEntries)
		expect(rows.find((r) => r.id === entryId)?.status).toBe('no_response')
		expect(rows.find((r) => r.id === 'wl_live')?.status).toBe('notified')
	})

	it('skips both waitlist tasks when the waitlist flag is off', async () => {
		const matching = vi.spyOn(notify, 'runNotifyMeMatching')
		const result = await runTick({
			getContext: async () => ctx({ waitlist: false }),
		})
		for (const name of ['waitlist_offers', 'notify_me_match']) {
			expect(taskOf(result, name)).toEqual({
				name,
				status: 'skipped',
				count: 0,
				reason: 'waitlist_disabled',
			})
		}
		expect(matching).not.toHaveBeenCalled()
		// Everything else still ran.
		for (const name of [
			'expire_holds',
			'expire_requests',
			'auto_no_show',
			'deliver_messages',
			'deliver_outbox',
			'purge',
		]) {
			expect(taskOf(result, name).status).toBe('ok')
		}
	})
})

describe('notify_me_match', () => {
	let notifyCounter = 0
	async function notifyRequest(extra: { email?: string } = {}) {
		const created = await notify.createNotifyRequest({
			orgId: ORG,
			idempotencyKey: `tick-notify-${++notifyCounter}-${Math.random().toString(36).slice(2, 8)}`,
			input: {
				locationId: PUBLIC_LOC,
				businessDate: dateAhead(5),
				partySize: 2,
				fromLocalMin: 17 * 60,
				toLocalMin: 19 * 60,
				email: extra.email ?? `waiting${notifyCounter}@example.com`,
			},
		})
		await new Promise((resolve) => setTimeout(resolve, 3))
		return created.requestId
	}

	it('offers an opening to a waiting guest and queues the message', async () => {
		await notifyRequest()
		const result = await runTick()
		expect(taskOf(result, 'notify_me_match')).toMatchObject({
			status: 'ok',
			count: 1,
			detail: { notified: 1, expired: 0 },
		})
		const queued = await (
			await db()
		)
			.select()
			.from(rsvMessages)
			.where(eq(rsvMessages.kind, 'notify_available'))
		expect(queued).toHaveLength(1)
	})

	it('reports expired requests and no follow-up when nobody waits', async () => {
		await notifyRequest()
		const afterRange = Date.parse(`${dateAhead(5)}T19:00:00Z`) + MINUTE
		const result = await runTick({ at: afterRange })
		expect(taskOf(result, 'notify_me_match')).toMatchObject({
			count: 0,
			detail: { notified: 0, expired: 1 },
		})
		expect(result.needsFollowUp).toBe(false)
	})

	it('asks for a follow-up when a batch left guests waiting', async () => {
		for (let i = 0; i < 5; i++) await notifyRequest()
		const result = await runTick()
		expect(taskOf(result, 'notify_me_match').count).toBe(3)
		expect(result.needsFollowUp).toBe(true)
		expect(result.nextDueAt).toBe(NOW + notify.NOTIFY_BATCH_WINDOW_MS)
		const later = await runTick({
			at: NOW + notify.NOTIFY_BATCH_WINDOW_MS + MINUTE,
		})
		expect(taskOf(later, 'notify_me_match').count).toBe(2)
	})
})

describe('deliver_messages', () => {
	it('sends a due message and counts it', async () => {
		const guestId = await addGuest('due@example.com')
		const reservationId = await addReservation({
			startAt: NOW + 2 * DAY,
			guestId,
		})
		const id = await addMessage({ reservationId })
		const result = await runTick()
		expect(taskOf(result, 'deliver_messages')).toMatchObject({
			status: 'ok',
			count: 1,
		})
		expect(result.messages.sent).toBe(1)
		expect(sendEmail).toHaveBeenCalledTimes(1)
		expect(sendEmail.mock.calls[0]![0]).toMatchObject({ to: 'due@example.com' })
		const row = (await message(id))!
		expect(row.status).toBe('sent')
		expect(row.sentAt).toBe(NOW)
		expect(row.attempts).toBe(1)
	})

	it('leaves a message that is not due yet', async () => {
		const reservationId = await addReservation({ startAt: NOW + 2 * DAY })
		const id = await addMessage({
			reservationId,
			sendAt: NOW + 10 * MINUTE,
			nextAttemptAt: NOW + 10 * MINUTE,
		})
		const result = await runTick()
		expect(result.messages.sent).toBe(0)
		expect(sendEmail).not.toHaveBeenCalled()
		expect((await message(id))?.status).toBe('pending')
	})

	it('retries a failed send after a minute and says when', async () => {
		sendEmail.mockResolvedValue({
			status: 'error',
			error: { message: 'smtp down' },
		})
		const reservationId = await addReservation({ startAt: NOW + 2 * DAY })
		const id = await addMessage({ reservationId })
		const result = await runTick()
		expect(result.messages).toMatchObject({ sent: 0, retried: 1 })
		const row = (await message(id))!
		expect(row).toMatchObject({ status: 'pending', attempts: 1 })
		expect(row.nextAttemptAt).toBe(NOW + MINUTE)
		expect(result.needsFollowUp).toBe(true)
		expect(result.nextDueAt).toBe(NOW + MINUTE)
	})
})

describe('deliver_outbox', () => {
	const posted: ManagerAlertEvent[] = []
	beforeEach(() => {
		posted.length = 0
	})
	const post = async (event: ManagerAlertEvent) => {
		posted.push(event)
		return { status: 'delivered' as const }
	}

	it('posts due alerts as one event per kind and location with the summed count', async () => {
		const ids = [
			await addOutbox(),
			await addOutbox(),
			await addOutbox({
				payload: {
					orgId: ORG,
					eventId: 'evt_other_kind_1',
					kind: 'waitlist_remote_join',
					locationId: PUBLIC_LOC,
					count: 1,
				},
			}),
		]
		const result = await runTick({ outboxPost: post })
		expect(taskOf(result, 'deliver_outbox')).toMatchObject({
			status: 'ok',
			count: 3,
			detail: { groups: 2, delivered: 3, retried: 0, failed: 0 },
		})
		expect(result.outbox).toEqual({
			groups: 2,
			delivered: 3,
			retried: 0,
			failed: 0,
		})
		expect(posted).toHaveLength(2)
		expect(
			posted.find((event) => event.kind === 'large_party_request'),
		).toMatchObject({ count: 2, orgId: ORG, locationId: PUBLIC_LOC })
		for (const id of ids) {
			expect((await outbox(id))?.status).toBe('sent')
		}
	})

	it('leaves alerts that are not due and posts nothing', async () => {
		const id = await addOutbox({ nextAttemptAt: NOW + 10 * MINUTE })
		const post = vi.fn(async () => ({ status: 'delivered' as const }))
		const result = await runTick({ outboxPost: post })
		expect(post).not.toHaveBeenCalled()
		expect(result.outbox.groups).toBe(0)
		expect((await outbox(id))?.status).toBe('pending')
	})

	it('backs off a retryable failure and follows up when it is due', async () => {
		const id = await addOutbox()
		const result = await runTick({
			outboxPost: async () => ({ status: 'retry', code: 'http_503' }),
		})
		expect(result.outbox).toMatchObject({ retried: 1, delivered: 0 })
		const row = (await outbox(id))!
		expect(row).toMatchObject({
			status: 'pending',
			attempts: 1,
			lastError: 'http_503',
		})
		expect(row.nextAttemptAt).toBe(NOW + MINUTE)
		expect(result.needsFollowUp).toBe(true)
		expect(result.nextDueAt).toBe(NOW + MINUTE)
	})

	it('fails a rejected alert for good and does not follow up on it', async () => {
		const id = await addOutbox()
		const result = await runTick({
			outboxPost: async () => ({ status: 'rejected', code: 'http_400' }),
		})
		expect(result.outbox).toMatchObject({ failed: 1 })
		expect((await outbox(id))?.status).toBe('failed')
		expect(result.needsFollowUp).toBe(false)
	})

	it('carries only the event contract across: no guest, no time', async () => {
		await addOutbox()
		await runTick({ outboxPost: post })
		expect(Object.keys(posted[0]!).sort()).toEqual([
			'count',
			'eventId',
			'kind',
			'locationId',
			'orgId',
		])
	})
})

describe('purge', () => {
	async function seedRetention() {
		const database = await db()
		const keyRow = (key: string, createdAt: number) => ({
			scope: 'tick-test',
			key,
			requestHash: 'h',
			statusCode: 200,
			responseJson: '{}',
			createdAt,
			// Not yet expired, so only retention (not the write gate's sweep) removes it.
			expiresAt: NOW + DAY,
		})
		await database
			.insert(rsvIdempotencyKeys)
			.values([
				keyRow('old', NOW - IDEMPOTENCY_RETENTION_MS - MINUTE),
				keyRow('edge', NOW - IDEMPOTENCY_RETENTION_MS),
				keyRow('fresh', NOW - IDEMPOTENCY_RETENTION_MS + MINUTE),
			])
		await database.insert(rsvRateCounters).values([
			{
				bucket: 'b',
				subjectHash: 'old',
				windowStart: NOW - RATE_COUNTER_RETENTION_MS - MINUTE,
			},
			{
				bucket: 'b',
				subjectHash: 'edge',
				windowStart: NOW - RATE_COUNTER_RETENTION_MS,
			},
			{
				bucket: 'b',
				subjectHash: 'fresh',
				windowStart: NOW - RATE_COUNTER_RETENTION_MS + MINUTE,
			},
		])
		const holds = {
			oldExpired: await addHold({
				status: 'expired',
				expiresAt: NOW - HOLD_RETENTION_MS - MINUTE,
			}),
			oldReleased: await addHold({
				status: 'released',
				expiresAt: NOW - HOLD_RETENTION_MS - MINUTE,
			}),
			freshExpired: await addHold({
				status: 'expired',
				expiresAt: NOW - HOLD_RETENTION_MS + MINUTE,
			}),
			oldConverted: await addHold({
				status: 'converted',
				expiresAt: NOW - HOLD_RETENTION_MS - DAY,
			}),
		}
		const messages: Record<string, string> = {}
		for (const status of [
			'sent',
			'failed',
			'cancelled',
			'suppressed',
			'dropped',
		] as const) {
			messages[`old_${status}`] = await addMessage({
				status,
				createdAt: NOW - MESSAGE_RETENTION_MS - MINUTE,
			})
		}
		messages.fresh_sent = await addMessage({
			status: 'sent',
			createdAt: NOW - MESSAGE_RETENTION_MS + MINUTE,
		})
		messages.old_pending = await addMessage({
			status: 'pending',
			createdAt: NOW - MESSAGE_RETENTION_MS - DAY,
			sendAt: NOW + 2 * HOUR,
			nextAttemptAt: NOW + 2 * HOUR,
		})
		const outboxIds = {
			oldSent: await addOutbox({
				status: 'sent',
				createdAt: NOW - OUTBOX_RETENTION_MS - MINUTE,
			}),
			oldFailed: await addOutbox({
				status: 'failed',
				createdAt: NOW - OUTBOX_RETENTION_MS - MINUTE,
			}),
			freshSent: await addOutbox({
				status: 'sent',
				createdAt: NOW - OUTBOX_RETENTION_MS + MINUTE,
			}),
			oldPending: await addOutbox({
				status: 'pending',
				createdAt: NOW - OUTBOX_RETENTION_MS - DAY,
				nextAttemptAt: NOW + 2 * HOUR,
			}),
		}
		return { holds, messages, outboxIds }
	}

	it('removes rows past their retention period and keeps the rest', async () => {
		const { holds, messages, outboxIds } = await seedRetention()
		const result = await runTick()
		// 1 key + 1 counter + 2 holds + 5 messages + 2 outbox rows.
		expect(taskOf(result, 'purge')).toMatchObject({ status: 'ok', count: 11 })

		const database = await db()
		const keys = (await database.select().from(rsvIdempotencyKeys)).map(
			(k) => k.key,
		)
		expect(keys.sort()).toEqual(['edge', 'fresh'])
		const counters = (await database.select().from(rsvRateCounters)).map(
			(c) => c.subjectHash,
		)
		expect(counters.sort()).toEqual(['edge', 'fresh'])

		expect(await hold(holds.oldExpired)).toBeUndefined()
		expect(await hold(holds.oldReleased)).toBeUndefined()
		expect(await hold(holds.freshExpired)).toBeDefined()
		// A converted hold backs a reservation and is never purged.
		expect(await hold(holds.oldConverted)).toBeDefined()

		for (const key of [
			'old_sent',
			'old_failed',
			'old_cancelled',
			'old_suppressed',
			'old_dropped',
		]) {
			expect(await message(messages[key]!)).toBeUndefined()
		}
		expect(await message(messages.fresh_sent!)).toBeDefined()
		expect(await message(messages.old_pending!)).toBeDefined()

		expect(await outbox(outboxIds.oldSent)).toBeUndefined()
		expect(await outbox(outboxIds.oldFailed)).toBeUndefined()
		expect(await outbox(outboxIds.freshSent)).toBeDefined()
		expect(await outbox(outboxIds.oldPending)).toBeDefined()
	})

	it('is idempotent', async () => {
		await seedRetention()
		await runTick()
		expect(taskOf(await runTick(), 'purge').count).toBe(0)
	})

	it('uses the documented retention periods', () => {
		expect(IDEMPOTENCY_RETENTION_MS).toBe(48 * HOUR)
		expect(RATE_COUNTER_RETENTION_MS).toBe(2 * DAY)
		expect(HOLD_RETENTION_MS).toBe(7 * DAY)
		expect(MESSAGE_RETENTION_MS).toBe(180 * DAY)
		expect(OUTBOX_RETENTION_MS).toBe(30 * DAY)
	})
})

describe('when reservations is switched off', () => {
	it('runs retention only and reports the organization as disabled', async () => {
		await setAutoNoShow(10)
		const lapsedHold = await addHold({ expiresAt: NOW - MINUTE })
		const lateGuest = await addReservation({ startAt: NOW - 2 * HOUR })
		const lapsedRequest = await addReservation({
			startAt: NOW + 2 * DAY,
			status: 'pending_approval',
			requestDeadlineAt: NOW - MINUTE,
		})
		const dueMessage = await addMessage()
		const dueAlert = await addOutbox()
		const oldMessage = await addMessage({
			status: 'sent',
			createdAt: NOW - MESSAGE_RETENTION_MS - DAY,
		})
		const post = vi.fn(async () => ({ status: 'delivered' as const }))

		const result = await runTick({
			getContext: async () => ctx({ enabled: false }),
			outboxPost: post,
		})

		expect(result).toMatchObject({
			orgId: ORG,
			status: 'skipped',
			reason: 'reservations_disabled',
			needsFollowUp: false,
			nextDueAt: null,
		})
		expect(result.tasks).toEqual([{ name: 'purge', status: 'ok', count: 1 }])
		expect(await message(oldMessage)).toBeUndefined()

		// Nothing else moved.
		expect((await hold(lapsedHold))?.status).toBe('active')
		expect((await reservation(lateGuest))?.status).toBe('booked')
		expect((await reservation(lapsedRequest))?.status).toBe('pending_approval')
		expect((await message(dueMessage))?.status).toBe('pending')
		expect((await outbox(dueAlert))?.status).toBe('pending')
		expect(sendEmail).not.toHaveBeenCalled()
		expect(post).not.toHaveBeenCalled()
	})

	it('reports a failed purge without throwing', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
		const failing = await getTenantDb(ORG)
		vi.spyOn(failing, 'delete').mockImplementation(() => {
			throw new Error('disk I/O error near row 17')
		})
		const result = await runTick({
			getContext: async () => ctx({ enabled: false }),
		})
		expect(result.status).toBe('skipped')
		expect(result.tasks).toEqual([
			{ name: 'purge', status: 'error', count: 0, reason: 'task_failed' },
		])
		expect(JSON.stringify(spy.mock.calls)).not.toContain('row 17')
	})
})

describe('a failing task does not stop the others', () => {
	let errorSpy: ReturnType<typeof vi.spyOn>
	beforeEach(() => {
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
	})

	it('records the failed outbox delivery and still purges and reports a follow-up', async () => {
		await addOutbox()
		const old = await addMessage({
			status: 'sent',
			createdAt: NOW - MESSAGE_RETENTION_MS - DAY,
		})
		const result = await runTick({
			outboxPost: async () => {
				throw new Error('socket hang up for guest Gia')
			},
		})
		expect(taskOf(result, 'deliver_outbox')).toEqual({
			name: 'deliver_outbox',
			status: 'error',
			count: 0,
			reason: 'task_failed',
		})
		expect(taskOf(result, 'purge').status).toBe('ok')
		expect(await message(old)).toBeUndefined()
		expect(result.status).toBe('ran')
		// Only the error name is logged: a message can quote bound values.
		expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('Gia')
	})

	it('records a failed notify-me pass and still delivers messages', async () => {
		vi.spyOn(notify, 'runNotifyMeMatching').mockRejectedValue(
			new Error('locked'),
		)
		const reservationId = await addReservation({ startAt: NOW + 2 * DAY })
		await addMessage({ reservationId })
		const result = await runTick()
		expect(taskOf(result, 'notify_me_match')).toMatchObject({
			status: 'error',
			reason: 'task_failed',
		})
		expect(taskOf(result, 'deliver_messages')).toMatchObject({
			status: 'ok',
			count: 1,
		})
	})

	it('records a failed auto no-show and still runs delivery and purge', async () => {
		await setAutoNoShow(10)
		await addReservation({ startAt: NOW - HOUR })
		vi.spyOn(booking, 'transitionReservationStatus').mockRejectedValue(
			new Error('disk full'),
		)
		const reservationId = await addReservation({ startAt: NOW + 2 * DAY })
		await addMessage({ reservationId })
		const result = await runTick()
		expect(taskOf(result, 'auto_no_show')).toMatchObject({
			status: 'error',
			reason: 'task_failed',
		})
		for (const name of ['deliver_messages', 'deliver_outbox', 'purge']) {
			expect(taskOf(result, name).status).toBe('ok')
		}
		expect(taskOf(result, 'deliver_messages').count).toBe(1)
	})

	it('marks the sweep-backed tasks failed together and carries on', async () => {
		const spy = vi
			.spyOn(reservationsWrite, 'withReservationWrite')
			.mockRejectedValueOnce(new Error('sqlite busy'))
		const result = await runTick()
		expect(spy).toHaveBeenCalled()
		for (const name of ['expire_holds', 'expire_requests', 'waitlist_offers']) {
			expect(taskOf(result, name)).toMatchObject({
				status: 'error',
				count: 0,
				reason: 'task_failed',
			})
		}
		for (const name of [
			'auto_no_show',
			'deliver_messages',
			'deliver_outbox',
			'purge',
		]) {
			expect(taskOf(result, name).status).toBe('ok')
		}
	})
})

describe('when the next piece of work is due', () => {
	it('needs no follow-up when nothing is waiting', async () => {
		const result = await runTick()
		expect(result.needsFollowUp).toBe(false)
		expect(result.nextDueAt).toBeNull()
	})

	it('follows up on a message due inside the hour', async () => {
		await addMessage({
			sendAt: NOW + 10 * MINUTE,
			nextAttemptAt: NOW + 10 * MINUTE,
		})
		const result = await runTick()
		expect(result.needsFollowUp).toBe(true)
		expect(result.nextDueAt).toBe(NOW + 10 * MINUTE)
	})

	it("uses the later of a message's send and retry times", async () => {
		await addMessage({
			sendAt: NOW + 5 * MINUTE,
			nextAttemptAt: NOW + 20 * MINUTE,
		})
		expect((await runTick()).nextDueAt).toBe(NOW + 20 * MINUTE)
	})

	it('picks the soonest message even when an older one is backing off', async () => {
		await addMessage({
			sendAt: NOW - 2 * HOUR,
			nextAttemptAt: NOW + 30 * MINUTE,
		})
		await addMessage({
			sendAt: NOW + 5 * MINUTE,
			nextAttemptAt: NOW + 5 * MINUTE,
		})
		expect((await runTick()).nextDueAt).toBe(NOW + 5 * MINUTE)
	})

	it('leaves work beyond the horizon to the hourly cron', async () => {
		await addMessage({
			sendAt: NOW + 2 * HOUR,
			nextAttemptAt: NOW + 2 * HOUR,
		})
		const result = await runTick()
		expect(result.needsFollowUp).toBe(false)
		expect(result.nextDueAt).toBeNull()
	})

	it('includes work due exactly at the horizon and excludes a minute past it', async () => {
		await addHold({ expiresAt: NOW + FOLLOW_UP_HORIZON_MS })
		const at = await runTick()
		expect(at).toMatchObject({
			needsFollowUp: true,
			nextDueAt: NOW + FOLLOW_UP_HORIZON_MS,
		})
		await (await db()).delete(rsvHolds)
		await addHold({ expiresAt: NOW + FOLLOW_UP_HORIZON_MS + MINUTE })
		const past = await runTick()
		expect(past).toMatchObject({ needsFollowUp: false, nextDueAt: null })
		expect(FOLLOW_UP_HORIZON_MS).toBe(HOUR)
	})

	it('follows up on a hold about to lapse', async () => {
		await addHold({ expiresAt: NOW + 3 * MINUTE })
		const result = await runTick()
		expect(result).toMatchObject({
			needsFollowUp: true,
			nextDueAt: NOW + 3 * MINUTE,
		})
	})

	it('ignores holds that are no longer active', async () => {
		await addHold({ status: 'released', expiresAt: NOW + 3 * MINUTE })
		await addHold({ status: 'converted', expiresAt: NOW + 3 * MINUTE })
		expect((await runTick()).needsFollowUp).toBe(false)
	})

	it('follows up on a request deadline', async () => {
		await addReservation({
			startAt: NOW + 2 * DAY,
			status: 'pending_approval',
			requestDeadlineAt: NOW + 20 * MINUTE,
		})
		expect((await runTick()).nextDueAt).toBe(NOW + 20 * MINUTE)
	})

	it('follows up on a payment expiry', async () => {
		await addReservation({
			startAt: NOW + 2 * DAY,
			status: 'pending_payment',
			paymentExpiresAt: NOW + 15 * MINUTE,
		})
		expect((await runTick()).nextDueAt).toBe(NOW + 15 * MINUTE)
	})

	it('follows up on a waitlist offer deadline', async () => {
		await (await db()).insert(rsvWaitlistEntries).values({
			locationId: PUBLIC_LOC,
			businessDate: dateOf(NOW),
			displayName: 'Walt',
			partySize: 2,
			status: 'notified',
			notifiedAt: NOW,
			responseDeadlineAt: NOW + 7 * MINUTE,
		})
		expect((await runTick()).nextDueAt).toBe(NOW + 7 * MINUTE)
	})

	it('follows up on an alert that is backing off', async () => {
		await addOutbox({ nextAttemptAt: NOW + 4 * MINUTE })
		expect((await runTick()).nextDueAt).toBe(NOW + 4 * MINUTE)
	})

	it('ignores payment commands, which this tick never delivers', async () => {
		await addOutbox({
			kind: 'payment_command',
			nextAttemptAt: NOW - HOUR,
		})
		const result = await runTick()
		expect(result.needsFollowUp).toBe(false)
		expect(result.nextDueAt).toBeNull()
	})

	it('reports the earliest of several deadlines', async () => {
		await addMessage({
			sendAt: NOW + 30 * MINUTE,
			nextAttemptAt: NOW + 30 * MINUTE,
		})
		await addHold({ expiresAt: NOW + 12 * MINUTE })
		await addOutbox({ nextAttemptAt: NOW + 25 * MINUTE })
		await addReservation({
			startAt: NOW + 2 * DAY,
			status: 'pending_approval',
			requestDeadlineAt: NOW + 18 * MINUTE,
		})
		const result = await runTick()
		expect(result).toMatchObject({
			needsFollowUp: true,
			nextDueAt: NOW + 12 * MINUTE,
		})
	})

	it('never reports a time in the past', async () => {
		// A held message was pushed ten minutes out; a still-pending one with an
		// older time would otherwise point backwards.
		await addMessage({
			sendAt: NOW - 3 * HOUR,
			nextAttemptAt: NOW + 10 * MINUTE,
		})
		const result = await runTick()
		expect(result.nextDueAt).toBeGreaterThanOrEqual(NOW)
	})
})

describe('folding results into counts', () => {
	function ran(over: Partial<ReservationsTickResult> = {}) {
		return {
			orgId: 'o',
			status: 'ran',
			at: 0,
			tasks: [],
			messages: {
				sent: 0,
				failed: 0,
				retried: 0,
				suppressed: 0,
				dropped: 0,
				cancelled: 0,
				held: 0,
			},
			outbox: { groups: 0, delivered: 0, retried: 0, failed: 0 },
			needsFollowUp: false,
			nextDueAt: null,
			...over,
		} as ReservationsTickResult
	}

	it('starts from zero', () => {
		expect(emptyReservationsAggregate()).toEqual({
			orgsRan: 0,
			orgsSkipped: 0,
			orgsDeferred: 0,
			holdsExpired: 0,
			requestsExpired: 0,
			noShowsMarked: 0,
			messagesSent: 0,
			alertsDelivered: 0,
			errors: 0,
		})
	})

	it('counts skipped organizations and nothing else', () => {
		const total = emptyReservationsAggregate()
		addToReservationsAggregate(
			total,
			ran({
				status: 'skipped',
				reason: 'reservations_disabled',
				tasks: [{ name: 'purge', status: 'ok', count: 9 }],
			}),
		)
		expect(total).toEqual({ ...emptyReservationsAggregate(), orgsSkipped: 1 })
	})

	it('adds task counts, sent messages and delivered alerts and counts task errors', () => {
		const total = emptyReservationsAggregate()
		addToReservationsAggregate(
			total,
			ran({
				tasks: [
					{ name: 'expire_holds', status: 'ok', count: 2 },
					{ name: 'expire_requests', status: 'ok', count: 1 },
					{ name: 'auto_no_show', status: 'ok', count: 4 },
					{ name: 'deliver_outbox', status: 'error', count: 0 },
					{ name: 'purge', status: 'ok', count: 50 },
				],
				messages: {
					sent: 3,
					failed: 0,
					retried: 0,
					suppressed: 0,
					dropped: 0,
					cancelled: 0,
					held: 0,
				},
				outbox: { groups: 1, delivered: 5, retried: 0, failed: 0 },
			}),
		)
		addToReservationsAggregate(total, ran())
		expect(total).toEqual({
			orgsRan: 2,
			orgsSkipped: 0,
			orgsDeferred: 0,
			holdsExpired: 2,
			requestsExpired: 1,
			noShowsMarked: 4,
			messagesSent: 3,
			alertsDelivered: 5,
			errors: 1,
		})
	})
})
