import { GIFT_CARD_SHOW_TOKEN_TTL_MS } from '@repo/common/gift-cards'
import {
	GiftCardsClientError,
	type SavedGiftCardDto,
} from './gift-cards-client'
import {
	GiftCardsStore,
	giftCardTokenDeadline,
	normalizeGiftCardCode,
} from './gift-cards-store'
import { makeSignedInSession } from '@/test/loyalty/session'
import { StubTransport } from '@/test/stub-transport'

function card(id: string, balanceMinor = 5000): SavedGiftCardDto {
	return {
		id,
		last4: id.slice(-4).toUpperCase().padStart(4, 'X'),
		status: 'active',
		balanceMinor,
		currency: 'USD',
		expiresAt: null,
		note: null,
		savedAt: 1,
		recent: [],
	}
}

type Deferred<T> = {
	promise: Promise<T>
	resolve: (value: T) => void
	reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

function makeClient(overrides: Partial<ReturnType<typeof baseClient>> = {}) {
	return { ...baseClient(), ...overrides }
}

function baseClient() {
	return {
		available: jest.fn(async (): Promise<boolean | null> => true),
		mine: jest.fn(async (): Promise<SavedGiftCardDto[]> => [card('gc_aaaa')]),
		claim: jest.fn(async (code: string) => ({
			card: { ...card('gc_new'), last4: code.slice(-4) },
			alreadyMine: false,
		})),
		showToken: jest.fn(async (cardId: string) => ({
			token: `gcs1.${cardId}`,
			expiresAt: 10_000 + GIFT_CARD_SHOW_TOKEN_TTL_MS,
		})),
	}
}

async function store(
	client: ReturnType<typeof makeClient>,
	options: { now?: () => number; onSessionEnded?: () => void } = {},
) {
	const session = await makeSignedInSession(new StubTransport().send)
	return new GiftCardsStore({
		session,
		client,
		now: options.now ?? (() => 10_000),
		onSessionEnded: options.onSessionEnded,
	})
}

/** Lets pending promise callbacks run. */
const flush = async () => {
	for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

describe('pure helpers', () => {
	it('never lets a token outlive one TTL on this device, or arrive expired', () => {
		const ttl = GIFT_CARD_SHOW_TOKEN_TTL_MS
		expect(giftCardTokenDeadline(1_000 + 60_000, 1_000)).toBe(61_000)
		// A clock running slow would stretch the server's deadline: capped at one TTL.
		expect(giftCardTokenDeadline(1_000 + 10 * ttl, 1_000)).toBe(1_000 + ttl)
		// Already past on arrival: one TTL from now instead of a dead code.
		expect(giftCardTokenDeadline(500, 1_000)).toBe(1_000 + ttl)
		expect(giftCardTokenDeadline(Number.NaN, 1_000)).toBe(1_000 + ttl)
	})

	it('ignores spaces, dashes and case in a typed code', () => {
		expect(normalizeGiftCardCode(' abcd-2345 efgh\n6789 ')).toBe(
			'ABCD2345EFGH6789',
		)
		expect(normalizeGiftCardCode('  - ')).toBe('')
	})
})

describe('loading', () => {
	it('checks availability, then loads the cards', async () => {
		const client = makeClient()
		const wallet = await store(client)
		expect(wallet.getSnapshot().status).toBe('idle')
		wallet.start()
		expect(wallet.getSnapshot().status).toBe('loading')
		await flush()
		const snapshot = wallet.getSnapshot()
		expect(snapshot.availability).toBe('available')
		expect(snapshot.status).toBe('ready')
		expect(snapshot.cards.map((c) => c.id)).toEqual(['gc_aaaa'])
		expect(client.available).toHaveBeenCalledTimes(1)
	})

	it('shares the first load and does not ask again for availability on a refresh', async () => {
		const client = makeClient()
		const wallet = await store(client)
		wallet.start()
		wallet.start()
		await flush()
		await wallet.refresh()
		expect(client.available).toHaveBeenCalledTimes(1)
		expect(client.mine).toHaveBeenCalledTimes(2)
	})

	it.each([null, false])(
		'is unavailable, and asks for no cards, when the answer is %s',
		async (answer) => {
			const client = makeClient({ available: jest.fn(async () => answer) })
			const wallet = await store(client)
			wallet.start()
			await flush()
			expect(wallet.getSnapshot().availability).toBe('unavailable')
			expect(client.mine).not.toHaveBeenCalled()
		},
	)

	it('fails with a reason, then recovers on a refresh', async () => {
		const mine = jest
			.fn<Promise<SavedGiftCardDto[]>, []>()
			.mockRejectedValueOnce(new GiftCardsClientError('network', 0))
			.mockResolvedValue([card('gc_bbbb')])
		const wallet = await store(makeClient({ mine }))
		wallet.start()
		await flush()
		expect(wallet.getSnapshot()).toMatchObject({
			status: 'failed',
			error: { code: 'network' },
			availability: 'available',
		})
		await wallet.refresh()
		expect(wallet.getSnapshot()).toMatchObject({ status: 'ready', error: null })
	})

	it('keeps the cards on screen when a refresh fails, and says why', async () => {
		const mine = jest
			.fn<Promise<SavedGiftCardDto[]>, []>()
			.mockResolvedValueOnce([card('gc_aaaa')])
			.mockRejectedValueOnce(new GiftCardsClientError('rate_limited', 429, 12))
		const wallet = await store(makeClient({ mine }))
		wallet.start()
		await flush()
		await wallet.refresh()
		const snapshot = wallet.getSnapshot()
		expect(snapshot.status).toBe('ready')
		expect(snapshot.cards).toHaveLength(1)
		expect(snapshot.error).toEqual({
			code: 'rate_limited',
			retryAfterSeconds: 12,
		})
	})

	it('drops an answer that arrives after a newer load', async () => {
		const slow = deferred<SavedGiftCardDto[]>()
		const mine = jest
			.fn<Promise<SavedGiftCardDto[]>, []>()
			.mockReturnValueOnce(slow.promise)
			.mockResolvedValue([card('gc_new1')])
		const wallet = await store(makeClient({ mine }))
		wallet.start()
		await flush()
		await wallet.refresh()
		slow.resolve([card('gc_old1')])
		await flush()
		expect(wallet.getSnapshot().cards.map((c) => c.id)).toEqual(['gc_new1'])
	})

	it('signs the app out when the session turns out to be dead', async () => {
		const onSessionEnded = jest.fn()
		const mine = jest.fn(async () => {
			throw new GiftCardsClientError('signed_out', 401)
		})
		const wallet = await store(makeClient({ mine }), { onSessionEnded })
		wallet.start()
		await flush()
		expect(onSessionEnded).toHaveBeenCalledTimes(1)
		expect(wallet.getSnapshot()).toMatchObject({
			status: 'signedOut',
			cards: [],
		})
	})
})

describe('adding a card', () => {
	it('sends the normalized code, confirms the last four and reloads', async () => {
		const client = makeClient()
		const wallet = await store(client)
		wallet.start()
		await flush()
		await expect(wallet.claim('abcd-2345 efgh-6789')).resolves.toBe(true)
		expect(client.claim).toHaveBeenCalledWith('ABCD2345EFGH6789')
		expect(wallet.getSnapshot().claim).toMatchObject({
			status: 'idle',
			savedLast4: '6789',
			alreadyMine: false,
			error: null,
		})
		await flush()
		expect(client.mine).toHaveBeenCalledTimes(2)
	})

	it('says which way a refusal went and keeps nothing of the code', async () => {
		const claim = jest.fn(async (ignoredCode: string) => {
			throw new GiftCardsClientError('code_invalid', 404)
		})
		const wallet = await store(makeClient({ claim }))
		wallet.start()
		await flush()
		await expect(wallet.claim('ZZZZZZZZ')).resolves.toBe(false)
		const { claim: state } = wallet.getSnapshot()
		expect(state.error).toEqual({
			code: 'code_invalid',
			retryAfterSeconds: null,
		})
		expect(state.savedLast4).toBeNull()
		expect(JSON.stringify(wallet.getSnapshot())).not.toContain('ZZZZZZZZ')
	})

	it('refuses an empty code without asking the region', async () => {
		const client = makeClient()
		const wallet = await store(client)
		wallet.start()
		await flush()
		await expect(wallet.claim('  - ')).resolves.toBe(false)
		expect(client.claim).not.toHaveBeenCalled()
		expect(wallet.getSnapshot().claim.error?.code).toBe('invalid_request')
	})

	it('ignores a second press while one is in flight', async () => {
		const pending = deferred<{ card: SavedGiftCardDto; alreadyMine: boolean }>()
		const claim = jest.fn((ignoredCode: string) => pending.promise)
		const wallet = await store(makeClient({ claim }))
		wallet.start()
		await flush()
		const first = wallet.claim('AAAAAAAA')
		await expect(wallet.claim('BBBBBBBB')).resolves.toBe(false)
		expect(claim).toHaveBeenCalledTimes(1)
		pending.resolve({ card: card('gc_xxxx'), alreadyMine: true })
		await expect(first).resolves.toBe(true)
		expect(wallet.getSnapshot().claim.alreadyMine).toBe(true)
	})

	it('is not lost when a refresh finishes while the claim is in flight', async () => {
		const pending = deferred<{ card: SavedGiftCardDto; alreadyMine: boolean }>()
		const wallet = await store(
			makeClient({ claim: jest.fn((ignoredCode: string) => pending.promise) }),
		)
		wallet.start()
		await flush()
		const claiming = wallet.claim('AAAAAAAA')
		await wallet.refresh()
		pending.resolve({ card: card('gc_xxxx'), alreadyMine: false })
		await expect(claiming).resolves.toBe(true)
		expect(wallet.getSnapshot().claim.status).toBe('idle')
		expect(wallet.getSnapshot().claim.savedLast4).toBe('XXXX')
	})

	it('can be dismissed, but not while it is working', async () => {
		const wallet = await store(makeClient())
		wallet.start()
		await flush()
		await wallet.claim('AAAAAAAA')
		wallet.dismissClaim()
		expect(wallet.getSnapshot().claim.savedLast4).toBeNull()
	})
})

describe('showing a card at the till', () => {
	beforeEach(() => jest.useFakeTimers())
	afterEach(() => jest.useRealTimers())

	it('holds a token for one card until its deadline, then shows it as expired', async () => {
		const client = makeClient()
		const wallet = await store(client)
		wallet.start()
		await flush()
		await wallet.showAtTill('gc_aaaa')
		let token = wallet.getSnapshot().token
		expect(token).toMatchObject({
			status: 'idle',
			cardId: 'gc_aaaa',
			token: 'gcs1.gc_aaaa',
			deadlineMs: 10_000 + GIFT_CARD_SHOW_TOKEN_TTL_MS,
			expired: false,
		})
		jest.advanceTimersByTime(GIFT_CARD_SHOW_TOKEN_TTL_MS - 1)
		expect(wallet.getSnapshot().token.token).not.toBeNull()
		jest.advanceTimersByTime(2)
		token = wallet.getSnapshot().token
		expect(token).toMatchObject({
			token: null,
			deadlineMs: null,
			expired: true,
			cardId: 'gc_aaaa',
		})
	})

	it('replaces the token on a new request and clears it when hidden', async () => {
		const client = makeClient()
		const wallet = await store(client)
		wallet.start()
		await flush()
		await wallet.showAtTill('gc_aaaa')
		await wallet.showAtTill('gc_bbbb')
		expect(wallet.getSnapshot().token.cardId).toBe('gc_bbbb')
		wallet.hideToken()
		expect(wallet.getSnapshot().token).toMatchObject({
			token: null,
			cardId: null,
		})
		// The old timer must not bring an "expired" note back.
		jest.advanceTimersByTime(GIFT_CARD_SHOW_TOKEN_TTL_MS * 2)
		expect(wallet.getSnapshot().token.expired).toBe(false)
	})

	it('reports why a token could not be issued, without a token', async () => {
		const showToken = jest.fn(async (ignoredCardId: string) => {
			throw new GiftCardsClientError('gift_card_held', 409)
		})
		const wallet = await store(makeClient({ showToken }))
		wallet.start()
		await flush()
		await wallet.showAtTill('gc_aaaa')
		expect(wallet.getSnapshot().token).toMatchObject({
			status: 'idle',
			token: null,
			error: { code: 'gift_card_held' },
		})
	})

	it('drops a token that arrives after the person hid the screen', async () => {
		const pending = deferred<{ token: string; expiresAt: number }>()
		const wallet = await store(
			makeClient({
				showToken: jest.fn((ignoredCardId: string) => pending.promise),
			}),
		)
		wallet.start()
		await flush()
		const showing = wallet.showAtTill('gc_aaaa')
		wallet.hideToken()
		pending.resolve({
			token: 'gcs1.late',
			expiresAt: 10_000 + GIFT_CARD_SHOW_TOKEN_TTL_MS,
		})
		await showing
		expect(wallet.getSnapshot().token.token).toBeNull()
	})
})

describe('lifecycle', () => {
	it('forgets everything on reset and ignores late answers', async () => {
		const slow = deferred<SavedGiftCardDto[]>()
		const wallet = await store(
			makeClient({ mine: jest.fn(() => slow.promise) }),
		)
		wallet.start()
		await flush()
		wallet.reset()
		slow.resolve([card('gc_late')])
		await flush()
		expect(wallet.getSnapshot()).toMatchObject({
			status: 'idle',
			cards: [],
			availability: 'unknown',
		})
		// A reset store can start again.
		wallet.start()
		expect(wallet.getSnapshot().status).toBe('loading')
	})

	it('stops notifying after dispose', async () => {
		const wallet = await store(makeClient())
		const listener = jest.fn()
		wallet.subscribe(listener)
		wallet.dispose()
		wallet.start()
		await flush()
		expect(listener).not.toHaveBeenCalled()
	})
})
