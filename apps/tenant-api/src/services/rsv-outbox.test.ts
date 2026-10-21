import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	rsvOutbox,
	type TenantDatabase,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
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
import {
	PUBLIC_LOC,
	seedPublicOrg,
} from '../routes/reservations-public-fixture.ts'
import {
	deliverOutbox,
	enqueueManagerAlert,
	MANAGER_ALERT_KINDS,
	managerAlertEventSchema,
	OUTBOX_BATCH_GROUPS,
	OUTBOX_MAX_ATTEMPTS,
	postManagerAlert,
	RESERVATIONS_NOTIFY_PATH,
	type AlertOutcome,
	type ManagerAlertEvent,
} from './rsv-outbox.ts'
import { MINUTE, NOW } from './rsv-message-fixture.ts'

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-outbox-'))
process.env.TENANT_DB_DIR = TEST_DIR

const ORG = 'org_outbox'
const TOKEN = 'internal-command-token-0123456789'

let db: TenantDatabase

beforeEach(async () => {
	vi.stubEnv('APP_URL', 'https://app.menuza.test')
	vi.stubEnv('INTERNAL_COMMAND_TOKEN', TOKEN)
	await destroyTenantDb(ORG).catch(() => undefined)
	resetReservationsContextCache()
	db = await seedPublicOrg(ORG)
})
afterEach(() => {
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})
afterAll(() => {
	fs.rmSync(TEST_DIR, { recursive: true, force: true })
})

const event = (patch: Partial<ManagerAlertEvent> = {}): ManagerAlertEvent => ({
	orgId: ORG,
	eventId: 'evt_0123456789abcdef',
	kind: 'large_party_request',
	locationId: PUBLIC_LOC,
	count: 1,
	...patch,
})

function queue(
	kind: (typeof MANAGER_ALERT_KINDS)[number],
	dedupeKey: string,
	extra: { locationId?: string; count?: number; now?: number } = {},
) {
	return enqueueManagerAlert(db, {
		orgId: ORG,
		kind,
		locationId: extra.locationId ?? PUBLIC_LOC,
		count: extra.count,
		dedupeKey,
		now: extra.now ?? NOW,
	})
}

const rows = () => db.select().from(rsvOutbox).all()

describe('managerAlertEventSchema', () => {
	it('accepts a kind, a location id and a count only', () => {
		expect(managerAlertEventSchema.safeParse(event()).success).toBe(true)
	})

	it('accepts every declared alert kind', () => {
		for (const kind of MANAGER_ALERT_KINDS) {
			expect(managerAlertEventSchema.safeParse(event({ kind })).success).toBe(
				true,
			)
		}
	})

	it('refuses extra keys so a guest name, party or time can never ride along', () => {
		for (const extra of [
			{ guestName: 'Rana' },
			{ email: 'rana@example.com' },
			{ partySize: 12 },
			{ startAt: NOW },
		]) {
			expect(
				managerAlertEventSchema.safeParse({ ...event(), ...extra }).success,
			).toBe(false)
		}
	})

	it.each([
		['unknown kind', { kind: 'guest_complained' }],
		['empty org id', { orgId: '' }],
		['org id with a slash', { orgId: 'org/../x' }],
		['org id over 64 chars', { orgId: 'o'.repeat(65) }],
		['location id with spaces', { locationId: 'loc 1' }],
		['short event id', { eventId: 'evt_1' }],
		['event id with punctuation', { eventId: 'evt_0123456789!' }],
		['zero count', { count: 0 }],
		['negative count', { count: -1 }],
		['fractional count', { count: 1.5 }],
		['count over 10000', { count: 10_001 }],
	])('refuses %s', (_name, patch) => {
		expect(
			managerAlertEventSchema.safeParse({ ...event(), ...patch }).success,
		).toBe(false)
	})

	it('accepts the count bounds', () => {
		expect(managerAlertEventSchema.safeParse(event({ count: 1 })).success).toBe(
			true,
		)
		expect(
			managerAlertEventSchema.safeParse(event({ count: 10_000 })).success,
		).toBe(true)
	})
})

describe('enqueueManagerAlert', () => {
	it('queues a pending manager_alert row due now with an opaque payload', async () => {
		expect(await queue('large_party_request', 'k1', { count: 3 })).toBe(true)
		const [row] = await rows()
		expect(row).toMatchObject({
			kind: 'manager_alert',
			dedupeKey: 'k1',
			status: 'pending',
			attempts: 0,
			nextAttemptAt: NOW,
			createdAt: NOW,
			deliveredAt: null,
		})
		expect(row!.payload).toEqual({
			orgId: ORG,
			eventId: expect.stringMatching(/^evt_[a-f0-9]{32}$/),
			kind: 'large_party_request',
			locationId: PUBLIC_LOC,
			count: 3,
		})
		expect(managerAlertEventSchema.safeParse(row!.payload).success).toBe(true)
	})

	it('defaults the count to 1', async () => {
		await queue('waitlist_remote_join', 'k1')
		expect((await rows())[0]!.payload).toMatchObject({ count: 1 })
	})

	it('treats a repeat of the same dedupe key as a no-op', async () => {
		expect(await queue('large_party_request', 'same')).toBe(true)
		expect(await queue('large_party_request', 'same', { count: 5 })).toBe(false)
		const all = await rows()
		expect(all).toHaveLength(1)
		expect((all[0]!.payload as { count: number }).count).toBe(1)
	})

	it('keeps different dedupe keys as separate rows with distinct event ids', async () => {
		await queue('large_party_request', 'a')
		await queue('large_party_request', 'b')
		const ids = (await rows()).map(
			(r) => (r.payload as { eventId: string }).eventId,
		)
		expect(new Set(ids).size).toBe(2)
	})

	it('works inside a transaction and rolls back with it', async () => {
		await expect(
			db.transaction(async (tx) => {
				await enqueueManagerAlert(tx, {
					orgId: ORG,
					kind: 'large_party_request',
					locationId: PUBLIC_LOC,
					dedupeKey: 'rolled-back',
					now: NOW,
				})
				throw new Error('boom')
			}),
		).rejects.toThrow('boom')
		expect(await rows()).toHaveLength(0)
	})
})

describe('postManagerAlert', () => {
	function fetchMock(response: Response | (() => Promise<Response>)) {
		const fn = vi.fn(async (_url?: string, _init?: RequestInit) =>
			typeof response === 'function' ? response() : response,
		)
		vi.stubGlobal('fetch', fn)
		return fn
	}

	it('posts the event with a bearer token to the App notify path', async () => {
		const fn = fetchMock(new Response('{}', { status: 200 }))
		const outcome = await postManagerAlert(event({ count: 4 }))
		expect(outcome).toEqual({ status: 'delivered' })
		expect(fn).toHaveBeenCalledTimes(1)
		const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe(`https://app.menuza.test${RESERVATIONS_NOTIFY_PATH}`)
		expect(init.method).toBe('POST')
		expect(init.headers).toMatchObject({
			Authorization: `Bearer ${TOKEN}`,
			'Content-Type': 'application/json',
		})
		expect(init.redirect).toBe('error')
		expect(init.signal).toBeInstanceOf(AbortSignal)
	})

	it('sends only the five opaque fields in the body', async () => {
		const fn = fetchMock(new Response('{}', { status: 200 }))
		await postManagerAlert(event({ count: 4 }))
		const init = fn.mock.calls[0]![1] as unknown as RequestInit
		expect(JSON.parse(init.body as string)).toEqual({
			orgId: ORG,
			eventId: 'evt_0123456789abcdef',
			kind: 'large_party_request',
			locationId: PUBLIC_LOC,
			count: 4,
		})
	})

	it('strips a trailing slash from APP_URL', async () => {
		vi.stubEnv('APP_URL', 'https://app.menuza.test/')
		const fn = fetchMock(new Response('{}', { status: 200 }))
		await postManagerAlert(event())
		expect(fn.mock.calls[0]![0]).toBe(
			`https://app.menuza.test${RESERVATIONS_NOTIFY_PATH}`,
		)
	})

	it('falls back to BASE_URL when APP_URL is empty', async () => {
		vi.stubEnv('APP_URL', '')
		vi.stubEnv('BASE_URL', 'https://base.menuza.test')
		const fn = fetchMock(new Response('{}', { status: 200 }))
		await postManagerAlert(event())
		expect(fn.mock.calls[0]![0]).toBe(
			`https://base.menuza.test${RESERVATIONS_NOTIFY_PATH}`,
		)
	})

	it.each([401, 408, 425, 429, 500, 502, 503, 504])(
		'retries on HTTP %i',
		async (status) => {
			fetchMock(new Response('no', { status }))
			expect(await postManagerAlert(event())).toEqual({
				status: 'retry',
				code: `http_${status}`,
			})
		},
	)

	it.each([400, 403, 404, 405, 409, 410, 413, 422])(
		'rejects on HTTP %i without retrying',
		async (status) => {
			fetchMock(new Response('no', { status }))
			expect(await postManagerAlert(event())).toEqual({
				status: 'rejected',
				code: `http_${status}`,
			})
		},
	)

	it('retries on a network error', async () => {
		fetchMock(async () => {
			throw new TypeError('fetch failed')
		})
		expect(await postManagerAlert(event())).toEqual({
			status: 'retry',
			code: 'network_error',
		})
	})

	it('retries on a timeout or a refused redirect', async () => {
		fetchMock(async () => {
			throw new DOMException('timed out', 'TimeoutError')
		})
		expect((await postManagerAlert(event())).status).toBe('retry')
	})

	it('rejects an invalid event without calling the App', async () => {
		const fn = fetchMock(new Response('{}', { status: 200 }))
		const bad = {
			...event(),
			guestName: 'Rana',
		} as unknown as ManagerAlertEvent
		expect(await postManagerAlert(bad)).toEqual({
			status: 'rejected',
			code: 'invalid_event',
		})
		expect(fn).not.toHaveBeenCalled()
	})

	it('retries as not_configured when no App origin is set', async () => {
		vi.stubEnv('APP_URL', '')
		vi.stubEnv('BASE_URL', '')
		const fn = fetchMock(new Response('{}', { status: 200 }))
		expect(await postManagerAlert(event())).toEqual({
			status: 'retry',
			code: 'not_configured',
		})
		expect(fn).not.toHaveBeenCalled()
	})

	it('retries as not_configured when the internal token is too short', async () => {
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', 'short')
		const fn = fetchMock(new Response('{}', { status: 200 }))
		expect(await postManagerAlert(event())).toEqual({
			status: 'retry',
			code: 'not_configured',
		})
		expect(fn).not.toHaveBeenCalled()
	})
})

describe('deliverOutbox', () => {
	const delivered = (_event?: ManagerAlertEvent): Promise<AlertOutcome> =>
		Promise.resolve({ status: 'delivered' })

	it('does nothing when the outbox is empty', async () => {
		const post = vi.fn(delivered)
		expect(await deliverOutbox(db, { now: NOW, post })).toEqual({
			groups: 0,
			delivered: 0,
			retried: 0,
			failed: 0,
		})
		expect(post).not.toHaveBeenCalled()
	})

	it('marks a delivered row sent with a timestamp and clears the error', async () => {
		await queue('large_party_request', 'a')
		const [row] = await rows()
		await db
			.update(rsvOutbox)
			.set({ lastError: 'http_503' })
			.where(eq(rsvOutbox.id, row!.id))
		const post = vi.fn(delivered)
		const totals = await deliverOutbox(db, { now: NOW + 5, post })
		expect(totals).toEqual({ groups: 1, delivered: 1, retried: 0, failed: 0 })
		const after = (await rows())[0]!
		expect(after).toMatchObject({
			status: 'sent',
			deliveredAt: NOW + 5,
			lastError: null,
		})
	})

	it('posts the stored event for a single row unchanged', async () => {
		await queue('unassigned_conflict', 'a', { count: 2 })
		const stored = (await rows())[0]!.payload as ManagerAlertEvent
		const post = vi.fn(delivered)
		await deliverOutbox(db, { now: NOW, post })
		expect(post).toHaveBeenCalledWith(stored)
	})

	it('does not send a row that is not yet due', async () => {
		await queue('large_party_request', 'a', { now: NOW + MINUTE })
		const post = vi.fn(delivered)
		const totals = await deliverOutbox(db, { now: NOW, post })
		expect(totals.groups).toBe(0)
		expect(post).not.toHaveBeenCalled()
		expect((await rows())[0]!.status).toBe('pending')
	})

	it('leaves sent and failed rows alone', async () => {
		await queue('large_party_request', 'a')
		await queue('payment_failed', 'b')
		await db
			.update(rsvOutbox)
			.set({ status: 'sent' })
			.where(eq(rsvOutbox.dedupeKey, 'a'))
		await db
			.update(rsvOutbox)
			.set({ status: 'failed' })
			.where(eq(rsvOutbox.dedupeKey, 'b'))
		const post = vi.fn(delivered)
		expect((await deliverOutbox(db, { now: NOW, post })).groups).toBe(0)
		expect(post).not.toHaveBeenCalled()
	})

	it('groups rows of the same kind and location into one event with the summed count', async () => {
		await queue('large_party_request', 'a', { count: 1 })
		await queue('large_party_request', 'b', { count: 2 })
		await queue('large_party_request', 'c', { count: 4 })
		const post = vi.fn(delivered)
		const totals = await deliverOutbox(db, { now: NOW, post })
		expect(totals).toEqual({ groups: 1, delivered: 3, retried: 0, failed: 0 })
		expect(post).toHaveBeenCalledTimes(1)
		expect(post.mock.calls[0]![0]).toMatchObject({
			kind: 'large_party_request',
			locationId: PUBLIC_LOC,
			count: 7,
		})
		expect((await rows()).every((r) => r.status === 'sent')).toBe(true)
	})

	it('keeps different kinds and different locations in separate events', async () => {
		await queue('large_party_request', 'a')
		await queue('waitlist_remote_join', 'b')
		await queue('large_party_request', 'c', { locationId: 'loc_other' })
		const post = vi.fn(delivered)
		const totals = await deliverOutbox(db, { now: NOW, post })
		expect(totals.groups).toBe(3)
		const seen = post.mock.calls.map(
			([e]) =>
				`${(e as ManagerAlertEvent).kind}:${(e as ManagerAlertEvent).locationId}`,
		)
		expect(seen.sort()).toEqual(
			[
				`large_party_request:${PUBLIC_LOC}`,
				'large_party_request:loc_other',
				`waitlist_remote_join:${PUBLIC_LOC}`,
			].sort(),
		)
	})

	it('caps a grouped count at 10000', async () => {
		await queue('large_party_request', 'a', { count: 9_000 })
		await queue('large_party_request', 'b', { count: 9_000 })
		const post = vi.fn(delivered)
		await deliverOutbox(db, { now: NOW, post })
		expect(post.mock.calls[0]![0]).toMatchObject({ count: 10_000 })
	})

	it('processes at most 50 groups per tick and leaves the rest pending', async () => {
		for (let i = 0; i < OUTBOX_BATCH_GROUPS + 5; i++) {
			await queue('large_party_request', `k${i}`, { locationId: `loc_${i}` })
		}
		const post = vi.fn(delivered)
		const totals = await deliverOutbox(db, { now: NOW, post })
		expect(totals.groups).toBe(OUTBOX_BATCH_GROUPS)
		expect(post).toHaveBeenCalledTimes(OUTBOX_BATCH_GROUPS)
		const all = await rows()
		expect(all.filter((r) => r.status === 'sent')).toHaveLength(
			OUTBOX_BATCH_GROUPS,
		)
		expect(all.filter((r) => r.status === 'pending')).toHaveLength(5)
		const next = await deliverOutbox(db, { now: NOW, post })
		expect(next).toMatchObject({ groups: 5, delivered: 5 })
	})

	it('honors limitGroups', async () => {
		for (let i = 0; i < 4; i++) {
			await queue('large_party_request', `k${i}`, { locationId: `loc_${i}` })
		}
		const post = vi.fn(delivered)
		expect(
			(await deliverOutbox(db, { now: NOW, post, limitGroups: 2 })).groups,
		).toBe(2)
		expect(post).toHaveBeenCalledTimes(2)
	})

	it('serves the oldest due rows first', async () => {
		await queue('payment_failed', 'late', { now: NOW - 1 * MINUTE })
		await queue('large_party_request', 'early', { now: NOW - 10 * MINUTE })
		const post = vi.fn(delivered)
		await deliverOutbox(db, { now: NOW, post, limitGroups: 1 })
		expect((post.mock.calls[0]![0] as ManagerAlertEvent).kind).toBe(
			'large_party_request',
		)
	})

	it('retries a failed attempt with growing backoff', async () => {
		await queue('large_party_request', 'a')
		const post = vi.fn((_event?: ManagerAlertEvent): Promise<AlertOutcome> =>
			Promise.resolve({ status: 'retry', code: 'http_503' }),
		)
		const expected = [1, 5, 30, 60, 120, 240, 480]
		let now = NOW
		for (let i = 0; i < expected.length; i++) {
			const totals = await deliverOutbox(db, { now, post })
			expect(totals).toMatchObject({ retried: 1, failed: 0 })
			const row = (await rows())[0]!
			expect(row).toMatchObject({
				status: 'pending',
				attempts: i + 1,
				lastError: 'http_503',
				nextAttemptAt: now + expected[i]! * MINUTE,
			})
			now = row.nextAttemptAt
		}
	})

	it('does not retry before the backoff elapses', async () => {
		await queue('large_party_request', 'a')
		const post = vi.fn((_event?: ManagerAlertEvent): Promise<AlertOutcome> =>
			Promise.resolve({ status: 'retry', code: 'network_error' }),
		)
		await deliverOutbox(db, { now: NOW, post })
		await deliverOutbox(db, { now: NOW + 30_000, post })
		expect(post).toHaveBeenCalledTimes(1)
		await deliverOutbox(db, { now: NOW + MINUTE, post })
		expect(post).toHaveBeenCalledTimes(2)
	})

	it(`gives up as failed after ${OUTBOX_MAX_ATTEMPTS} attempts`, async () => {
		await queue('large_party_request', 'a')
		await db.update(rsvOutbox).set({ attempts: OUTBOX_MAX_ATTEMPTS - 1 })
		const post = vi.fn((_event?: ManagerAlertEvent): Promise<AlertOutcome> =>
			Promise.resolve({ status: 'retry', code: 'http_500' }),
		)
		const totals = await deliverOutbox(db, { now: NOW, post })
		expect(totals).toEqual({ groups: 1, delivered: 0, retried: 0, failed: 1 })
		expect((await rows())[0]).toMatchObject({
			status: 'failed',
			attempts: OUTBOX_MAX_ATTEMPTS,
			lastError: 'http_500',
		})
		const after = vi.fn(delivered)
		await deliverOutbox(db, { now: NOW + 24 * 60 * MINUTE, post: after })
		expect(after).not.toHaveBeenCalled()
	})

	it('fails a rejected row immediately', async () => {
		await queue('large_party_request', 'a')
		const post = vi.fn((_event?: ManagerAlertEvent): Promise<AlertOutcome> =>
			Promise.resolve({ status: 'rejected', code: 'http_400' }),
		)
		const totals = await deliverOutbox(db, { now: NOW, post })
		expect(totals).toEqual({ groups: 1, delivered: 0, retried: 0, failed: 1 })
		expect((await rows())[0]).toMatchObject({
			status: 'failed',
			attempts: 1,
			lastError: 'http_400',
		})
	})

	it('shares one outcome across every row of a group, each with its own attempt count', async () => {
		await queue('large_party_request', 'a')
		await queue('large_party_request', 'b')
		await db
			.update(rsvOutbox)
			.set({ attempts: OUTBOX_MAX_ATTEMPTS - 1 })
			.where(eq(rsvOutbox.dedupeKey, 'a'))
		const post = vi.fn((_event?: ManagerAlertEvent): Promise<AlertOutcome> =>
			Promise.resolve({ status: 'retry', code: 'http_502' }),
		)
		const totals = await deliverOutbox(db, { now: NOW, post })
		expect(post).toHaveBeenCalledTimes(1)
		expect(totals).toMatchObject({ groups: 1, retried: 1, failed: 1 })
		const byKey = Object.fromEntries(
			(await rows()).map((r) => [r.dedupeKey, r]),
		)
		expect(byKey.a).toMatchObject({
			status: 'failed',
			attempts: OUTBOX_MAX_ATTEMPTS,
		})
		expect(byKey.b).toMatchObject({ status: 'pending', attempts: 1 })
	})

	it('one failing group does not stop the others', async () => {
		await queue('large_party_request', 'a')
		await queue('payment_failed', 'b')
		const post = vi.fn(async (e: ManagerAlertEvent): Promise<AlertOutcome> =>
			e.kind === 'large_party_request'
				? { status: 'retry', code: 'http_503' }
				: { status: 'delivered' },
		)
		const totals = await deliverOutbox(db, { now: NOW, post })
		expect(totals).toEqual({ groups: 2, delivered: 1, retried: 1, failed: 0 })
	})

	it('ignores outbox rows of other kinds', async () => {
		await db.insert(rsvOutbox).values({
			kind: 'payment_command',
			dedupeKey: 'other',
			payload: {},
			nextAttemptAt: NOW,
			createdAt: NOW,
		})
		const post = vi.fn(delivered)
		await deliverOutbox(db, { now: NOW, post })
		expect(post).not.toHaveBeenCalled()
		expect((await rows())[0]!.status).toBe('pending')
	})

	it('uses the real App transport by default and delivers end to end', async () => {
		await queue('large_party_request', 'a', { count: 2 })
		await queue('large_party_request', 'b', { count: 3 })
		const fn = vi.fn(
			async (_url?: string, _init?: RequestInit) =>
				new Response('{}', { status: 200 }),
		)
		vi.stubGlobal('fetch', fn)
		const totals = await deliverOutbox(db, { now: NOW })
		expect(totals).toMatchObject({ groups: 1, delivered: 2 })
		const body = JSON.parse(
			(fn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
		)
		expect(body).toMatchObject({ kind: 'large_party_request', count: 5 })
		expect(Object.keys(body).sort()).toEqual(
			['count', 'eventId', 'kind', 'locationId', 'orgId'].sort(),
		)
	})

	it('keeps the row pending with not_configured when the App is not configured', async () => {
		vi.stubEnv('APP_URL', '')
		vi.stubEnv('BASE_URL', '')
		await queue('large_party_request', 'a')
		const fn = vi.fn(
			async (_url?: string, _init?: RequestInit) => new Response('{}'),
		)
		vi.stubGlobal('fetch', fn)
		const totals = await deliverOutbox(db, { now: NOW })
		expect(totals).toMatchObject({ retried: 1, delivered: 0 })
		expect((await rows())[0]).toMatchObject({
			status: 'pending',
			lastError: 'not_configured',
		})
		expect(fn).not.toHaveBeenCalled()
	})
})
