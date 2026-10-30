import {
	LOYALTY_APPROVAL_TTL_MS,
	LOYALTY_MEMBER_CODE_TTL_MS,
	type LoyaltyWallet,
} from '@repo/loyalty'
import { LoyaltyStore } from './loyalty-store'
import {
	fixtureJson,
	testApproval,
	testEntry,
	testErasedWallet,
	testWallet,
} from '@/test/loyalty/fixtures'
import { makeLoyaltyClient } from '@/test/loyalty/session'
import { flush, ManualClock } from '@/test/reservations/manual-clock'
import { header, StubTransport, type StubReply } from '@/test/stub-transport'

/**
 * The wallet store against the shared contract fixtures, with a manual clock
 * for the poll and expiry timers. The Sites wallet page
 * (`apps/sites/src/lib/loyalty/wallet-page.ts`) runs the same scenarios
 * against the same fixtures.
 */

/** Aligns with the contract fixtures' approval and member-code timestamps. */
const APPROVAL_FIXTURE = fixtureJson('approvals').approvals[0]!
const T0 = APPROVAL_FIXTURE.createdAt
const POLL_MS = 5_000

const WALLET = 'GET /loyalty/wallet'
const PROGRAM = 'GET /loyalty/program'
const HISTORY = 'GET /loyalty/history'
const APPROVALS = 'GET /loyalty/approvals'
const MEMBER_CODE = 'POST /loyalty/member-code'
const APPROVAL_ID = '00000000-0000-4000-8000-000000000008'
const DECIDE = `POST /loyalty/approvals/${APPROVAL_ID}/decide`

const MEMBER_CODE_EXPIRES_AT = fixtureJson('member-code').expiresAt
const RATE_LIMIT_RETRY_MS =
	fixtureJson('error-rate-limited').retryAfterSeconds * 1000

function walletReply(wallet: LoyaltyWallet | null = testWallet()): StubReply {
	return { json: { wallet } }
}

function errorReply(
	status: number,
	code: string,
	extra: Record<string, unknown> = {},
): StubReply {
	return { status, json: { error: code, code, ...extra } }
}

/** Routes with canned queues; safe defaults keep background polls harmless. */
function makeRouter(defaults: Record<string, StubReply> = {}) {
	const queues = new Map<string, StubReply[]>()
	const transport = new StubTransport((request) => {
		const url = new URL(request.url)
		const key = `${request.method} ${url.pathname}`
		const queued = queues.get(key)?.shift()
		if (queued) return queued
		const fallback = defaults[key]
		if (fallback) return fallback
		return { status: 500, json: { error: 'unexpected_request', path: key } }
	})
	return {
		transport,
		add(key: string, ...replies: StubReply[]) {
			const queue = queues.get(key) ?? []
			queue.push(...replies)
			queues.set(key, queue)
		},
	}
}

async function makeStore(
	transport: StubTransport,
	options: { signedIn?: boolean; onSessionEnded?: () => void } = {},
) {
	const clock = new ManualClock(T0)
	const { session, client } = await makeLoyaltyClient(transport.send, {
		signedIn: options.signedIn,
	})
	const store = new LoyaltyStore({
		session,
		client,
		now: clock.now,
		scheduler: {
			setTimeout: (callback, ms) => clock.timers.setTimeout(callback, ms),
			clearTimeout: (handle) => clock.timers.clearTimeout(handle as number),
		},
		pollMs: POLL_MS,
		onSessionEnded: options.onSessionEnded,
	})
	return { store, clock }
}

function requestsTo(transport: StubTransport, key: string) {
	const [method, path] = key.split(' ')
	return transport.recorded.filter(
		(entry) => entry.request.method === method && entry.url.pathname === path,
	)
}

describe('loading', () => {
	it('shows the member wallet with rewards, till requests and history', async () => {
		const router = makeRouter()
		router.add(WALLET, walletReply())
		router.add(APPROVALS, { json: fixtureJson('approvals') })
		router.add(HISTORY, { json: fixtureJson('history') })
		const { store } = await makeStore(router.transport)

		store.start()
		await flush()

		const snapshot = store.getSnapshot()
		expect(snapshot.status).toBe('member')
		expect(snapshot.program?.name).toBe('Acme Rewards')
		expect(snapshot.member?.balance.available).toBe(332)
		expect(snapshot.error).toBeNull()
		expect(snapshot.active).toBe(true)
		expect(snapshot.abilities).toEqual({
			paused: false,
			suspended: false,
			owes: false,
			canShowCode: true,
			canApprove: true,
		})
		expect(snapshot.nextReward).toMatchObject({
			kind: 'next',
			pointsNeeded: 68,
			percent: 83,
			reward: { name: '20% off pastries' },
		})
		expect(snapshot.rewards.map((view) => view.affordable)).toEqual([
			true,
			true,
			false,
		])
		expect(snapshot.memberCode).toEqual({
			status: 'idle',
			code: null,
			deadlineMs: null,
			expired: false,
			error: null,
		})
		expect(snapshot.approvals?.status).toBe('ready')
		expect(snapshot.approvals?.items).toHaveLength(1)
		expect(snapshot.approvals?.items[0]?.deadlineMs).toBe(
			APPROVAL_FIXTURE.expiresAt,
		)
		expect(snapshot.approvals?.items[0]?.deciding).toBe(false)
		expect(snapshot.history?.status).toBe('ready')
		expect(snapshot.history?.entries).toHaveLength(2)
		expect(snapshot.history?.hasMore).toBe(true)
		expect(requestsTo(router.transport, WALLET)).toHaveLength(1)
	})

	it('starts only once', async () => {
		const router = makeRouter({
			[APPROVALS]: { json: fixtureJson('approvals-empty') },
			[HISTORY]: { json: fixtureJson('history') },
		})
		router.add(WALLET, walletReply())
		const { store } = await makeStore(router.transport)

		store.start()
		store.start()
		await flush()

		expect(store.getSnapshot().status).toBe('member')
		expect(requestsTo(router.transport, WALLET)).toHaveLength(1)
	})

	it('offers the program to a signed-out customer', async () => {
		const router = makeRouter()
		router.add(PROGRAM, { json: fixtureJson('program') })
		const { store } = await makeStore(router.transport, { signedIn: false })

		store.start()
		await flush()

		const snapshot = store.getSnapshot()
		expect(snapshot.status).toBe('signedOut')
		expect(snapshot.program?.name).toBe('Acme Rewards')
		expect(snapshot.member).toBeNull()
		expect(snapshot.memberCode).toBeNull()
	})

	it('still signs out when the program cannot be read', async () => {
		const router = makeRouter()
		router.add(PROGRAM, { status: 500, json: {} })
		const { store } = await makeStore(router.transport, { signedIn: false })

		store.start()
		await flush()

		expect(store.getSnapshot().status).toBe('signedOut')
		expect(store.getSnapshot().program).toBeNull()
	})

	it('opens straight to the wallet: no join step, no enroll request', async () => {
		const router = makeRouter({
			[APPROVALS]: { json: fixtureJson('approvals-empty') },
			[HISTORY]: { json: fixtureJson('history') },
		})
		router.add(WALLET, walletReply())
		const { store } = await makeStore(router.transport)

		store.start()
		await flush()

		expect(store.getSnapshot().status).toBe('member')
		expect(store.getSnapshot()).not.toHaveProperty('enrollment')
		expect(
			router.transport.recorded.map((entry) => entry.url.pathname),
		).not.toContain('/loyalty/enroll')
	})

	it('shows a paused program as a member wallet that cannot earn or redeem', async () => {
		const router = makeRouter({
			[APPROVALS]: { json: fixtureJson('approvals-empty') },
			[HISTORY]: { json: fixtureJson('history') },
		})
		router.add(WALLET, { json: fixtureJson('wallet-paused') })
		const { store } = await makeStore(router.transport)

		store.start()
		await flush()

		expect(store.getSnapshot().status).toBe('member')
		expect(store.getSnapshot().abilities).toMatchObject({
			paused: true,
			canShowCode: false,
			canApprove: false,
		})
	})

	it('is unavailable for an erased account, with no program shown', async () => {
		const router = makeRouter()
		router.add(WALLET, walletReply(testErasedWallet()))
		const { store } = await makeStore(router.transport)

		store.start()
		await flush()

		const snapshot = store.getSnapshot()
		expect(snapshot.status).toBe('unavailable')
		expect(snapshot.program).toBeNull()
		expect(snapshot.memberCode).toBeNull()
		expect(snapshot.history).toBeNull()
	})

	it('is unavailable while loyalty is off for the site', async () => {
		const router = makeRouter()
		router.add(WALLET, { json: fixtureJson('wallet-none') })
		const { store } = await makeStore(router.transport)

		store.start()
		await flush()

		expect(store.getSnapshot().status).toBe('unavailable')
		expect(store.getSnapshot().program).toBeNull()
	})

	it('maps a disabled answer to unavailable', async () => {
		const router = makeRouter()
		router.add(WALLET, {
			status: 403,
			json: fixtureJson('error-loyalty-disabled'),
		})
		const { store } = await makeStore(router.transport)

		store.start()
		await flush()

		expect(store.getSnapshot().status).toBe('unavailable')
	})

	it('fails with a retryable error and recovers on retry', async () => {
		const router = makeRouter({
			[APPROVALS]: { json: fixtureJson('approvals-empty') },
			[HISTORY]: { json: fixtureJson('history') },
		})
		router.add(WALLET, { status: 500, json: {} })
		const { store } = await makeStore(router.transport)

		store.start()
		await flush()

		expect(store.getSnapshot().status).toBe('failed')
		expect(store.getSnapshot().error).toEqual({
			code: 'unknown',
			retryable: true,
			retryAfterSeconds: null,
		})

		router.add(WALLET, walletReply())
		await store.retry()
		await flush()

		expect(store.getSnapshot().status).toBe('member')
		expect(store.getSnapshot().error).toBeNull()
	})

	it('ends the session when the token belongs to another site', async () => {
		const onSessionEnded = jest.fn()
		const router = makeRouter()
		router.add(WALLET, {
			status: 403,
			json: fixtureJson('error-organization-mismatch'),
		})
		const { store } = await makeStore(router.transport, { onSessionEnded })

		store.start()
		await flush()

		expect(store.getSnapshot().status).toBe('signedOut')
		expect(store.getSnapshot().notice).toEqual({
			kind: 'error',
			code: 'organization_mismatch',
		})
		expect(onSessionEnded).toHaveBeenCalledTimes(1)
	})

	it('keeps the screen up during a refresh and applies the new balance', async () => {
		const router = makeRouter({
			[APPROVALS]: { json: fixtureJson('approvals-empty') },
			[HISTORY]: { json: fixtureJson('history') },
		})
		router.add(WALLET, walletReply(testWallet({ pendingApprovals: 0 })))
		const { store } = await makeStore(router.transport)
		store.start()
		await flush()

		router.add(WALLET, { json: fixtureJson('wallet-after-approval') })
		const pending = store.refresh()
		expect(store.getSnapshot().status).toBe('member')
		await pending
		await flush()

		expect(store.getSnapshot().status).toBe('member')
		expect(store.getSnapshot().member?.balance.available).toBe(232)
		expect(store.getSnapshot().notice).toBeNull()
	})

	it('turns a failed background refresh into a dismissible notice', async () => {
		const router = makeRouter({
			[APPROVALS]: { json: fixtureJson('approvals-empty') },
			[HISTORY]: { json: fixtureJson('history') },
		})
		router.add(WALLET, walletReply(testWallet({ pendingApprovals: 0 })))
		const { store } = await makeStore(router.transport)
		store.start()
		await flush()

		router.add(WALLET, { status: 500, json: {} })
		await store.refresh()
		await flush()

		expect(store.getSnapshot().status).toBe('member')
		expect(store.getSnapshot().notice).toEqual({
			kind: 'error',
			code: 'unknown',
		})
		store.dismissNotice()
		expect(store.getSnapshot().notice).toBeNull()
	})
})

describe('member code', () => {
	async function memberStore(router: ReturnType<typeof makeRouter>) {
		router.add(WALLET, walletReply(testWallet({ pendingApprovals: 0 })))
		const { store, clock } = await makeStore(router.transport)
		store.start()
		await flush()
		return { store, clock }
	}

	it('issues a code with a device-safe deadline', async () => {
		const router = makeRouter({
			[APPROVALS]: { json: fixtureJson('approvals-empty') },
			[HISTORY]: { json: fixtureJson('history') },
		})
		router.add(MEMBER_CODE, { json: fixtureJson('member-code') })
		const { store } = await memberStore(router)

		await store.issueMemberCode()
		await flush()

		expect(store.getSnapshot().memberCode).toEqual({
			status: 'idle',
			code: 'K7QM-4XPR',
			deadlineMs: MEMBER_CODE_EXPIRES_AT,
			expired: false,
			error: null,
		})
	})

	it('expires the code on the device clock and offers a new one', async () => {
		const router = makeRouter({
			[APPROVALS]: { json: fixtureJson('approvals-empty') },
			[HISTORY]: { json: fixtureJson('history') },
		})
		router.add(MEMBER_CODE, { json: fixtureJson('member-code') })
		const { store, clock } = await memberStore(router)
		await store.issueMemberCode()
		await flush()

		await clock.advance(MEMBER_CODE_EXPIRES_AT - T0)

		expect(store.getSnapshot().memberCode?.code).toBeNull()
		expect(store.getSnapshot().memberCode?.expired).toBe(true)

		router.add(MEMBER_CODE, {
			json: {
				code: 'ZZZZ-YYYY',
				expiresAt: clock.now() + LOYALTY_MEMBER_CODE_TTL_MS + 60_000,
			},
		})
		await store.issueMemberCode()
		await flush()

		const memberCode = store.getSnapshot().memberCode
		expect(memberCode?.code).toBe('ZZZZ-YYYY')
		expect(memberCode?.expired).toBe(false)
		// The answer's expiry is beyond one TTL from arrival: the device caps it.
		expect(memberCode?.deadlineMs).toBe(
			clock.now() + LOYALTY_MEMBER_CODE_TTL_MS,
		)
	})

	it('keeps the old state when issuing fails', async () => {
		const router = makeRouter({
			[APPROVALS]: { json: fixtureJson('approvals-empty') },
			[HISTORY]: { json: fixtureJson('history') },
		})
		router.add(MEMBER_CODE, { status: 500, json: {} })
		const { store } = await memberStore(router)

		await store.issueMemberCode()
		await flush()

		const memberCode = store.getSnapshot().memberCode
		expect(memberCode?.code).toBeNull()
		expect(memberCode?.expired).toBe(false)
		expect(memberCode?.error?.retryable).toBe(true)
	})

	it('reloads the wallet when the account turns out to be gone', async () => {
		const router = makeRouter({
			[APPROVALS]: { json: fixtureJson('approvals-empty') },
			[HISTORY]: { json: fixtureJson('history') },
		})
		router.add(MEMBER_CODE, errorReply(404, 'member_not_found'))
		const { store } = await memberStore(router)
		router.add(WALLET, walletReply(testErasedWallet()))

		await store.issueMemberCode()
		await flush()

		expect(store.getSnapshot().status).toBe('unavailable')
		expect(store.getSnapshot().memberCode).toBeNull()
	})

	it('has no code section for a suspended member', async () => {
		const router = makeRouter({
			[HISTORY]: { json: fixtureJson('history') },
		})
		router.add(WALLET, { json: fixtureJson('wallet-suspended') })
		const { store } = await makeStore(router.transport)
		store.start()
		await flush()

		const snapshot = store.getSnapshot()
		expect(snapshot.status).toBe('member')
		expect(snapshot.abilities?.suspended).toBe(true)
		expect(snapshot.memberCode).toBeNull()
		expect(snapshot.approvals).toBeNull()
	})
})

describe('till requests', () => {
	it('polls while a member code is live', async () => {
		const router = makeRouter({
			[APPROVALS]: { json: fixtureJson('approvals-empty') },
			[HISTORY]: { json: fixtureJson('history') },
		})
		router.add(WALLET, walletReply(testWallet({ pendingApprovals: 0 })))
		router.add(MEMBER_CODE, { json: fixtureJson('member-code') })
		const { store, clock } = await makeStore(router.transport)
		store.start()
		await flush()
		await store.issueMemberCode()
		await flush()

		expect(requestsTo(router.transport, APPROVALS)).toHaveLength(1)
		await clock.advance(POLL_MS)
		expect(requestsTo(router.transport, APPROVALS)).toHaveLength(2)
		await clock.advance(POLL_MS)
		expect(requestsTo(router.transport, APPROVALS)).toHaveLength(3)
	})

	it('doubles the wait after failures and honors the rate-limit hint', async () => {
		// An already-past request has no device deadline, so the expiry timer
		// never interferes with the backoff measurement.
		const stale = testApproval({
			id: '00000000-0000-4000-8000-000000000009',
			createdAt: T0 - 600_000,
			expiresAt: T0 - 600_000 + LOYALTY_APPROVAL_TTL_MS,
		})
		const router = makeRouter({
			[APPROVALS]: { json: { approvals: [stale] } },
			[HISTORY]: { json: fixtureJson('history') },
		})
		router.add(
			APPROVALS,
			{ json: { approvals: [stale] } },
			{ status: 500, json: {} },
			{ status: 429, json: fixtureJson('error-rate-limited') },
		)
		router.add(WALLET, walletReply())
		const { store, clock } = await makeStore(router.transport)
		store.start()
		await flush()
		expect(requestsTo(router.transport, APPROVALS)).toHaveLength(1)

		await clock.advance(POLL_MS)
		expect(requestsTo(router.transport, APPROVALS)).toHaveLength(2)

		// First failure: the next check waits 2 × pollMs.
		await clock.advance(POLL_MS * 2 - 1)
		expect(requestsTo(router.transport, APPROVALS)).toHaveLength(2)
		await clock.advance(1)
		expect(requestsTo(router.transport, APPROVALS)).toHaveLength(3)

		// The rate limit hint from the contract fixture beats the 4 × pollMs backoff.
		await clock.advance(RATE_LIMIT_RETRY_MS - 1)
		expect(requestsTo(router.transport, APPROVALS)).toHaveLength(3)
		await clock.advance(1)
		expect(requestsTo(router.transport, APPROVALS)).toHaveLength(4)
	})

	it('approves a request, announces it and reloads the balance', async () => {
		const router = makeRouter({
			[HISTORY]: { json: fixtureJson('history') },
		})
		router.add(WALLET, walletReply())
		router.add(APPROVALS, { json: fixtureJson('approvals') })
		router.add(DECIDE, { json: fixtureJson('approval-approved') })
		router.add(WALLET, { json: fixtureJson('wallet-after-approval') })
		const { store } = await makeStore(router.transport)
		store.start()
		await flush()

		await store.decide(APPROVAL_ID, 'approve')
		await flush()

		const request = requestsTo(router.transport, DECIDE)[0]
		expect(request?.body).toMatchObject({ decision: 'approve' })
		expect(header(request, 'Idempotency-Key')).toBeTruthy()
		expect(store.getSnapshot().approvals?.items).toEqual([])
		expect(store.getSnapshot().notice).toEqual({
			kind: 'success',
			reason: 'approved',
			rewardName: 'Five off your order',
		})
		expect(store.getSnapshot().member?.balance.available).toBe(232)
	})

	it('declines a request without touching the balance', async () => {
		const router = makeRouter({
			[HISTORY]: { json: fixtureJson('history') },
		})
		router.add(WALLET, walletReply())
		router.add(APPROVALS, { json: fixtureJson('approvals') })
		router.add(DECIDE, { json: fixtureJson('approval-declined') })
		const { store } = await makeStore(router.transport)
		store.start()
		await flush()

		await store.decide(APPROVAL_ID, 'decline')
		await flush()

		expect(store.getSnapshot().notice).toEqual({
			kind: 'success',
			reason: 'declined',
			rewardName: 'Five off your order',
		})
		expect(store.getSnapshot().approvals?.items).toEqual([])
		expect(requestsTo(router.transport, WALLET)).toHaveLength(1)
	})

	it('drops a request the region already closed', async () => {
		const router = makeRouter({
			[APPROVALS]: { json: fixtureJson('approvals-empty') },
			[HISTORY]: { json: fixtureJson('history') },
		})
		router.add(WALLET, walletReply())
		router.add(APPROVALS, { json: fixtureJson('approvals') })
		router.add(DECIDE, {
			status: 409,
			json: fixtureJson('error-approval-closed'),
		})
		const { store } = await makeStore(router.transport)
		store.start()
		await flush()

		await store.decide(APPROVAL_ID, 'approve')
		await flush()

		expect(store.getSnapshot().approvals?.items).toEqual([])
		expect(store.getSnapshot().notice).toEqual({
			kind: 'error',
			code: 'approval_closed',
		})
	})

	it('never lets a stale check bring back a decided request', async () => {
		const router = makeRouter({
			[HISTORY]: { json: fixtureJson('history') },
		})
		router.add(WALLET, walletReply())
		router.add(APPROVALS, { json: fixtureJson('approvals') })
		router.add(DECIDE, { json: fixtureJson('approval-declined') })
		const { store } = await makeStore(router.transport)
		store.start()
		await flush()
		await store.decide(APPROVAL_ID, 'decline')
		await flush()

		// The region wrongly lists the same request as pending again.
		router.add(APPROVALS, { json: fixtureJson('approvals') })
		await store.checkApprovals()
		await flush()

		expect(store.getSnapshot().approvals?.items).toEqual([])
	})

	it('expires a waiting request on the device clock and checks again', async () => {
		const router = makeRouter({
			[APPROVALS]: { status: 500, json: {} },
			[HISTORY]: { json: fixtureJson('history') },
		})
		router.add(WALLET, walletReply())
		router.add(APPROVALS, { json: fixtureJson('approvals') })
		const { store, clock } = await makeStore(router.transport)
		store.start()
		await flush()
		expect(store.getSnapshot().approvals?.items).toHaveLength(1)
		const checks = requestsTo(router.transport, APPROVALS).length

		await clock.advance(LOYALTY_APPROVAL_TTL_MS)

		expect(store.getSnapshot().approvals?.items).toEqual([])
		expect(requestsTo(router.transport, APPROVALS).length).toBeGreaterThan(
			checks,
		)
	})
})

describe('history', () => {
	it('pages without duplicating entries and stops at the last page', async () => {
		const router = makeRouter({
			[APPROVALS]: { json: fixtureJson('approvals-empty') },
		})
		router.add(WALLET, walletReply(testWallet({ pendingApprovals: 0 })))
		router.add(
			HISTORY,
			{ json: fixtureJson('history') },
			{
				json: {
					entries: [
						testEntry({ id: '00000000-0000-4000-8000-000000000006' }),
						testEntry({
							id: '00000000-0000-4000-8000-000000000007',
							at: 1_907_683_214_000,
							delta: 12,
						}),
					],
					nextCursor: null,
				},
			},
		)
		const { store } = await makeStore(router.transport)
		store.start()
		await flush()

		await store.loadMoreHistory()
		await flush()

		const history = store.getSnapshot().history
		expect(history?.entries.map((entry) => entry.id)).toEqual([
			'00000000-0000-4000-8000-000000000005',
			'00000000-0000-4000-8000-000000000006',
			'00000000-0000-4000-8000-000000000007',
		])
		expect(history?.hasMore).toBe(false)
		const requests = requestsTo(router.transport, HISTORY)
		expect(requests[0]?.url.searchParams.get('cursor')).toBeNull()
		expect(requests[1]?.url.searchParams.get('cursor')).toBe(
			fixtureJson('history').nextCursor,
		)

		await store.loadMoreHistory()
		await flush()
		expect(requestsTo(router.transport, HISTORY)).toHaveLength(2)
	})

	it('keeps a failed first page retryable', async () => {
		const router = makeRouter({
			[APPROVALS]: { json: fixtureJson('approvals-empty') },
		})
		router.add(WALLET, walletReply(testWallet({ pendingApprovals: 0 })))
		router.add(
			HISTORY,
			{ status: 500, json: {} },
			{ json: fixtureJson('history') },
		)
		const { store } = await makeStore(router.transport)
		store.start()
		await flush()

		expect(store.getSnapshot().history?.status).toBe('error')
		expect(store.getSnapshot().history?.error?.retryable).toBe(true)

		await store.loadHistory()
		await flush()

		expect(store.getSnapshot().history?.status).toBe('ready')
		expect(store.getSnapshot().history?.entries).toHaveLength(2)
	})
})

describe('activity', () => {
	it('stops polling while inactive and checks again when active', async () => {
		const router = makeRouter({
			[APPROVALS]: { json: fixtureJson('approvals-empty') },
			[HISTORY]: { json: fixtureJson('history') },
		})
		router.add(WALLET, walletReply(testWallet({ pendingApprovals: 0 })))
		router.add(MEMBER_CODE, { json: fixtureJson('member-code') })
		const { store, clock } = await makeStore(router.transport)
		store.start()
		await flush()
		await store.issueMemberCode()
		await flush()
		const checks = requestsTo(router.transport, APPROVALS).length

		store.setActive(false)
		await clock.advance(120_000)
		expect(requestsTo(router.transport, APPROVALS)).toHaveLength(checks)

		store.setActive(true)
		await flush()
		expect(requestsTo(router.transport, APPROVALS).length).toBeGreaterThan(
			checks,
		)
	})
})

describe('reset', () => {
	it('drops a late answer and starts over clean', async () => {
		const router = makeRouter({
			[APPROVALS]: { json: fixtureJson('approvals-empty') },
			[HISTORY]: { json: fixtureJson('history') },
		})
		router.add(WALLET, { json: { wallet: testWallet() }, delayMs: 50 })
		const { store } = await makeStore(router.transport)

		store.start()
		store.reset()
		expect(store.getSnapshot().status).toBe('loading')

		await flush(300)
		expect(store.getSnapshot().status).toBe('loading')
		expect(store.getSnapshot().member).toBeNull()

		router.add(WALLET, walletReply(testWallet({ pendingApprovals: 0 })))
		store.start()
		await flush()
		expect(store.getSnapshot().status).toBe('member')
	})

	it('clears member state so the next membership starts from nothing', async () => {
		const router = makeRouter({
			[APPROVALS]: { json: fixtureJson('approvals-empty') },
			[HISTORY]: { json: fixtureJson('history') },
		})
		router.add(WALLET, walletReply())
		router.add(APPROVALS, { json: fixtureJson('approvals') })
		router.add(MEMBER_CODE, { json: fixtureJson('member-code') })
		const { store } = await makeStore(router.transport)
		store.start()
		await flush()
		await store.issueMemberCode()
		await flush()

		store.reset()
		const cleared = store.getSnapshot()
		expect(cleared.status).toBe('loading')
		expect(cleared.memberCode).toBeNull()
		expect(cleared.approvals).toBeNull()
		expect(cleared.history).toBeNull()
		expect(cleared.notice).toBeNull()
	})

	it('starts a different member on the same session from nothing', async () => {
		const router = makeRouter({
			[HISTORY]: { json: fixtureJson('history') },
		})
		router.add(WALLET, walletReply())
		router.add(APPROVALS, { json: fixtureJson('approvals') })
		router.add(MEMBER_CODE, { json: fixtureJson('member-code') })
		const { store } = await makeStore(router.transport)
		store.start()
		await flush()
		await store.issueMemberCode()
		await flush()
		expect(store.getSnapshot().memberCode?.code).toBe('K7QM-4XPR')

		router.add(
			WALLET,
			walletReply(
				testWallet({
					member: { id: '00000000-0000-4000-8000-0000000000ff' },
					pendingApprovals: 1,
				}),
			),
		)
		router.add(APPROVALS, { json: fixtureJson('approvals-empty') })
		await store.refresh()
		await flush()

		const snapshot = store.getSnapshot()
		expect(snapshot.status).toBe('member')
		expect(snapshot.member?.member.id).toBe(
			'00000000-0000-4000-8000-0000000000ff',
		)
		expect(snapshot.memberCode?.code).toBeNull()
		expect(snapshot.approvals?.items).toEqual([])
		expect(snapshot.history?.entries).toEqual([])
	})
})
