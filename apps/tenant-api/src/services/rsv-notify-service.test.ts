import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	rsvDayVersions,
	rsvGuests,
	rsvLocationSettings,
	rsvMessages,
	rsvNotifyRequests,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { resetReservationsContextCache } from '../lib/reservations-context.ts'
import { deriveNotifyToken } from '../lib/reservations-public-auth.ts'
import {
	clearReservationDayCacheForTest,
	withReservationWrite,
} from '../lib/reservations-write.ts'
import {
	dateAhead,
	PUBLIC_LOC,
	seedPublicOrg,
} from '../routes/reservations-public-fixture.ts'
import {
	cancelNotifyRequest,
	createNotifyRequest,
	markNotifyRequestsBooked,
	NOTIFY_BATCH_WINDOW_MS,
	runNotifyMeMatching,
} from './rsv-notify-service.ts'

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-notify-svc-'))
process.env.TENANT_DB_DIR = TEST_DIR
process.env.DATA_REGION = 'us'
process.env.AUTH_HMAC_SECRET = 'test-notify-auth-hmac-secret-0123456789'
process.env.JWT_SECRET = 'test-notify-customer-jwt-secret-123456'

const ORG = 'org_notify_svc'
const OTHER_ORG = 'org_notify_other'
const DATE = dateAhead(5)
const MINUTE = 60_000

let counter = 0
const key = () =>
	`nfy-key-${++counter}-${Math.random().toString(36).slice(2, 8)}`
const tick = () => new Promise((resolve) => setTimeout(resolve, 3))

async function request(
	n: number,
	extra: Partial<Parameters<typeof createNotifyRequest>[0]['input']> = {},
) {
	const created = await createNotifyRequest({
		orgId: ORG,
		idempotencyKey: key(),
		input: {
			locationId: PUBLIC_LOC,
			businessDate: DATE,
			partySize: 2,
			fromLocalMin: 17 * 60,
			toLocalMin: 19 * 60,
			email: `guest${n}@example.com`,
			...extra,
		},
	})
	await tick()
	return created
}

async function statusOf(id: string) {
	const db = await getTenantDb(ORG)
	return db
		.select()
		.from(rsvNotifyRequests)
		.where(eq(rsvNotifyRequests.id, id))
		.get()
}

async function dayFlag() {
	const db = await getTenantDb(ORG)
	const row = await db
		.select()
		.from(rsvDayVersions)
		.where(
			and(
				eq(rsvDayVersions.locationId, PUBLIC_LOC),
				eq(rsvDayVersions.businessDate, DATE),
			),
		)
		.get()
	return row?.availabilityIncreasedAt ?? null
}

async function notifyMessages(id: string) {
	const db = await getTenantDb(ORG)
	const rows = await db
		.select()
		.from(rsvMessages)
		.where(eq(rsvMessages.notifyRequestId, id))
		.all()
	return rows.filter((r) => r.kind === 'notify_available')
}

beforeEach(async () => {
	await destroyTenantDb(ORG).catch(() => undefined)
	resetReservationsContextCache()
	clearReservationDayCacheForTest()
	await seedPublicOrg(ORG, {
		settings: { waitlistEnabled: true, notifyMeEnabled: true },
	})
})

afterAll(() => {
	fs.rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('createNotifyRequest', () => {
	it('stores an active request that expires at the end of its range', async () => {
		const created = await request(1, { phone: '+1 (415) 555-0142' })
		const row = (await statusOf(created.requestId))!
		expect(row.status).toBe('active')
		expect(row.contactPhoneE164).toBe('+14155550142')
		expect(row.expiresAt).toBe(Date.parse(`${DATE}T19:00:00Z`))
		expect(created.cancelToken).toBe(
			deriveNotifyToken(ORG, created.requestId, row.tokenVersion),
		)
	})

	it('answers a repeated key with the same request and a changed body with a conflict', async () => {
		const k = key()
		const make = (toLocalMin: number) =>
			createNotifyRequest({
				orgId: ORG,
				idempotencyKey: k,
				input: {
					locationId: PUBLIC_LOC,
					businessDate: DATE,
					partySize: 2,
					fromLocalMin: 17 * 60,
					toLocalMin,
					email: 'same@example.com',
				},
			})
		const first = await make(19 * 60)
		expect((await make(19 * 60)).requestId).toBe(first.requestId)
		await expect(make(20 * 60)).rejects.toMatchObject({
			status: 409,
			code: 'idempotency_conflict',
		})
	})

	it('allows at most five active requests per contact (VAL-WAIT-015)', async () => {
		for (let i = 0; i < 5; i++) await request(1)
		await expect(request(1)).rejects.toMatchObject({
			status: 409,
			code: 'too_many_active_requests',
		})
		await expect(request(2)).resolves.toBeTruthy()
	})

	it('refuses a range in the past, a date beyond the horizon, and no contact', async () => {
		await expect(
			request(1, { businessDate: dateAhead(-2) }),
		).rejects.toMatchObject({ status: 400 })
		await expect(
			request(1, { businessDate: dateAhead(400) }),
		).rejects.toMatchObject({ status: 400 })
		await expect(
			request(1, { fromLocalMin: 19 * 60, toLocalMin: 18 * 60 }),
		).rejects.toMatchObject({ status: 400 })
		await expect(
			createNotifyRequest({
				orgId: ORG,
				idempotencyKey: key(),
				input: {
					locationId: PUBLIC_LOC,
					businessDate: DATE,
					partySize: 2,
					fromLocalMin: 17 * 60,
					toLocalMin: 19 * 60,
				},
			}),
		).rejects.toMatchObject({ status: 400 })
	})
})

describe('cancelNotifyRequest', () => {
	it('cancels once and answers null on reuse or a forged token', async () => {
		const created = await request(1)
		const cancelled = await cancelNotifyRequest({
			orgId: ORG,
			token: created.cancelToken,
		})
		expect(cancelled?.requestId).toBe(created.requestId)
		expect((await statusOf(created.requestId))?.status).toBe('cancelled')
		expect(
			await cancelNotifyRequest({ orgId: ORG, token: created.cancelToken }),
		).toBeNull()
		expect(
			await cancelNotifyRequest({ orgId: ORG, token: 'rsv_n_x.y' }),
		).toBeNull()
		const other = await request(2)
		await seedPublicOrg(OTHER_ORG)
		expect(
			await cancelNotifyRequest({
				orgId: OTHER_ORG,
				token: other.cancelToken,
			}),
		).toBeNull()
		await destroyTenantDb(OTHER_ORG)
		expect((await statusOf(other.requestId))?.status).toBe('active')
	})
})

describe('runNotifyMeMatching', () => {
	it('notifies the first three in FIFO order, the rest after the batch window (VAL-WAIT-016/017)', async () => {
		const ids: string[] = []
		for (let i = 1; i <= 5; i++) ids.push((await request(i)).requestId)
		expect(await dayFlag()).not.toBeNull()

		const t0 = Date.now()
		const first = await runNotifyMeMatching(ORG, { now: t0 })
		expect(first.notified).toBe(3)
		expect(first.needsFollowUp).toBe(true)
		expect(first.nextDueAt).toBe(t0 + NOTIFY_BATCH_WINDOW_MS)
		const rows = await Promise.all(ids.map(statusOf))
		expect(rows.map((r) => r?.status)).toEqual([
			'notified',
			'notified',
			'notified',
			'active',
			'active',
		])
		expect(rows.slice(0, 3).map((r) => r?.notifiedCount)).toEqual([1, 1, 1])
		expect(rows[0]?.lastNotifiedAt).toBe(t0)
		for (const id of ids.slice(0, 3)) {
			expect(await notifyMessages(id)).toHaveLength(1)
		}
		expect(await dayFlag()).not.toBeNull()

		const sooner = await runNotifyMeMatching(ORG, { now: t0 + 5 * MINUTE })
		expect(sooner.notified).toBe(0)
		expect(sooner.needsFollowUp).toBe(true)

		const later = await runNotifyMeMatching(ORG, {
			now: t0 + NOTIFY_BATCH_WINDOW_MS + MINUTE,
		})
		expect(later.notified).toBe(2)
		expect(later.needsFollowUp).toBe(false)
		expect((await statusOf(ids[3]!))?.status).toBe('notified')
		expect((await statusOf(ids[4]!))?.status).toBe('notified')
		expect(await dayFlag()).toBeNull()

		const idle = await runNotifyMeMatching(ORG, {
			now: t0 + 2 * NOTIFY_BATCH_WINDOW_MS,
		})
		expect(idle.notified).toBe(0)
		for (const id of ids) expect(await notifyMessages(id)).toHaveLength(1)
	})

	it('moves a request whose range has passed to expired and never notifies it', async () => {
		const created = await request(1)
		const afterRange = Date.parse(`${DATE}T19:00:00Z`) + MINUTE
		const out = await runNotifyMeMatching(ORG, { now: afterRange })
		expect(out.expired).toBe(1)
		expect(out.notified).toBe(0)
		expect((await statusOf(created.requestId))?.status).toBe('expired')
		expect(await notifyMessages(created.requestId)).toHaveLength(0)
	})

	it('leaves a request active when nothing in its range is open, and clears the day flag', async () => {
		const created = await request(1, {
			fromLocalMin: 6 * 60,
			toLocalMin: 7 * 60,
		})
		const out = await runNotifyMeMatching(ORG, { now: Date.now() })
		expect(out.notified).toBe(0)
		expect((await statusOf(created.requestId))?.status).toBe('active')
		expect(await dayFlag()).toBeNull()
	})

	it('matches a party of four against the tables that seat four', async () => {
		const created = await request(1, { partySize: 4 })
		const ok = await runNotifyMeMatching(ORG, { now: Date.now() })
		expect(ok.notified).toBe(1)
		expect((await statusOf(created.requestId))?.status).toBe('notified')
	})

	it('does nothing for a location with notify-me switched off', async () => {
		const created = await request(1)
		const db = await getTenantDb(ORG)
		await db
			.update(rsvLocationSettings)
			.set({ notifyMeEnabled: false })
			.where(eq(rsvLocationSettings.locationId, PUBLIC_LOC))
		const out = await runNotifyMeMatching(ORG, { now: Date.now() })
		expect(out.notified).toBe(0)
		expect((await statusOf(created.requestId))?.status).toBe('active')
	})

	it('does not renotify inside the repeat window, then offers the next opening; never a cancelled request', async () => {
		const a = await request(1)
		const b = await request(2)
		await cancelNotifyRequest({ orgId: ORG, token: b.cancelToken })
		const t0 = Date.now()
		await runNotifyMeMatching(ORG, { now: t0 })
		expect((await statusOf(a.requestId))?.notifiedCount).toBe(1)
		expect((await statusOf(b.requestId))?.status).toBe('cancelled')
		expect(await notifyMessages(b.requestId)).toHaveLength(0)

		const touchDay = () =>
			withReservationWrite(
				{ orgId: ORG, locationId: PUBLIC_LOC, dates: DATE },
				async () => undefined,
			)
		await touchDay()
		expect(await dayFlag()).not.toBeNull()
		await runNotifyMeMatching(ORG, { now: t0 + 30 * MINUTE })
		expect((await statusOf(a.requestId))?.notifiedCount).toBe(1)
		expect(await dayFlag()).toBeNull()

		await touchDay()
		await runNotifyMeMatching(ORG, { now: t0 + 121 * MINUTE })
		const again = await statusOf(a.requestId)
		expect(again?.notifiedCount).toBe(2)
		expect(await notifyMessages(a.requestId)).toHaveLength(2)
	})
})

describe('markNotifyRequestsBooked', () => {
	it('closes only the open requests of the booking guest for that day', async () => {
		const db = await getTenantDb(ORG)
		await db.insert(rsvGuests).values({
			id: 'guest_booker',
			firstName: 'Bo',
			lastName: 'Oker',
			phoneE164: '+14155550142',
			emailNorm: 'booker@example.com',
		})
		const mine = await request(1, { phone: '+14155550142' })
		const byEmail = await request(2, { email: 'booker@example.com' })
		const someoneElse = await request(3)
		const otherDay = await request(4, {
			phone: '+14155550142',
			businessDate: dateAhead(6),
		})
		const count = await markNotifyRequestsBooked(db, {
			locationId: PUBLIC_LOC,
			businessDate: DATE,
			guestId: 'guest_booker',
			now: Date.now(),
		})
		expect(count).toBe(2)
		expect((await statusOf(mine.requestId))?.status).toBe('booked')
		expect((await statusOf(byEmail.requestId))?.status).toBe('booked')
		expect((await statusOf(someoneElse.requestId))?.status).toBe('active')
		expect((await statusOf(otherDay.requestId))?.status).toBe('active')
	})
})
