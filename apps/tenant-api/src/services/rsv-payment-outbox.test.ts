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
import { seedPublicOrg } from '../routes/reservations-public-fixture.ts'
import { MINUTE, NOW } from './rsv-message-fixture.ts'
import {
	deliverPaymentOutbox,
	OUTBOX_MAX_ATTEMPTS,
	postPaymentCommand,
	RESERVATIONS_PAYMENTS_PATH,
	type AlertOutcome,
} from './rsv-outbox.ts'
import { enqueuePaymentOutbox } from './rsv-payment-refunds.ts'

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-pay-outbox-'))
process.env.TENANT_DB_DIR = TEST_DIR
const ORG = 'org_pay_outbox'
const TOKEN = 'internal-command-token-0123456789'
let db: TenantDatabase

const refund = (id: string) => ({
	kind: 'refund_request' as const,
	orgId: ORG,
	refundRequestId: id,
})

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

async function enqueueRefund(id: string) {
	await enqueuePaymentOutbox(db, {
		kind: 'refund_request',
		dedupeKey: `refund_request:${id}`,
		payload: refund(id),
		now: NOW,
	})
}

describe('payment outbox delivery', () => {
	it('delivers each command once and marks it sent', async () => {
		await enqueueRefund('pay_1')
		await enqueueRefund('pay_1')
		const post = vi.fn(async (): Promise<AlertOutcome> => ({
			status: 'delivered',
		}))
		const totals = await deliverPaymentOutbox(db, { now: NOW, post })
		expect(totals).toMatchObject({ groups: 1, delivered: 1 })
		expect(post).toHaveBeenCalledWith(refund('pay_1'))
		const again = await deliverPaymentOutbox(db, { now: NOW + MINUTE, post })
		expect(again.groups).toBe(0)
	})

	it('retries a transient failure with backoff and gives up after the attempt cap', async () => {
		await enqueueRefund('pay_2')
		const retry = async (): Promise<AlertOutcome> => ({
			status: 'retry',
			code: 'http_503',
		})
		let now = NOW
		for (let i = 1; i < OUTBOX_MAX_ATTEMPTS; i++) {
			const totals = await deliverPaymentOutbox(db, { now, post: retry })
			expect(totals.retried).toBe(1)
			const row = await db.select().from(rsvOutbox).get()
			expect(row).toMatchObject({ status: 'pending', attempts: i })
			expect(row!.nextAttemptAt).toBeGreaterThan(now)
			now = row!.nextAttemptAt
		}
		const last = await deliverPaymentOutbox(db, { now, post: retry })
		expect(last.failed).toBe(1)
		expect((await db.select().from(rsvOutbox).get())!.status).toBe('failed')
	})

	it('does not retry a rejected command', async () => {
		await enqueueRefund('pay_3')
		const totals = await deliverPaymentOutbox(db, {
			now: NOW,
			post: async () => ({ status: 'rejected', code: 'http_400' }),
		})
		expect(totals.failed).toBe(1)
	})

	it('leaves manager alerts to the alert delivery', async () => {
		await db.insert(rsvOutbox).values({
			kind: 'manager_alert',
			dedupeKey: 'alert:1',
			payload: { kind: 'payment_review' },
			status: 'pending',
			nextAttemptAt: NOW,
			createdAt: NOW,
		})
		const post = vi.fn()
		const totals = await deliverPaymentOutbox(db, { now: NOW, post })
		expect(totals.groups).toBe(0)
		expect(post).not.toHaveBeenCalled()
		const row = await db
			.select()
			.from(rsvOutbox)
			.where(eq(rsvOutbox.dedupeKey, 'alert:1'))
			.get()
		expect(row!.status).toBe('pending')
	})

	it('posts to the App with the internal token and nothing but ids', async () => {
		const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
		vi.stubGlobal('fetch', fetchMock)
		const outcome = await postPaymentCommand(refund('pay_4'))
		expect(outcome).toEqual({ status: 'delivered' })
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		]
		expect(url).toBe(`https://app.menuza.test${RESERVATIONS_PAYMENTS_PATH}`)
		expect((init.headers as Record<string, string>).Authorization).toBe(
			`Bearer ${TOKEN}`,
		)
		expect(JSON.parse(init.body as string)).toEqual(refund('pay_4'))
	})

	it('maps HTTP statuses: 503 retries, 400 is final, a network error retries', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{}', { status: 503 })),
		)
		expect(await postPaymentCommand(refund('a'))).toMatchObject({
			status: 'retry',
		})
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{}', { status: 400 })),
		)
		expect(await postPaymentCommand(refund('a'))).toMatchObject({
			status: 'rejected',
		})
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('boom')
			}),
		)
		expect(await postPaymentCommand(refund('a'))).toMatchObject({
			status: 'retry',
			code: 'network_error',
		})
		expect(await postPaymentCommand({ kind: 'nope' })).toMatchObject({
			status: 'rejected',
		})
	})
})
