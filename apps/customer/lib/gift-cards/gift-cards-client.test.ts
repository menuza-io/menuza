import {
	giftCardClaimResponseSchema,
	giftCardMineResponseSchema,
	giftCardShowTokenResponseSchema,
} from '@repo/common/gift-card-contract'
import {
	GiftCardsClient,
	GiftCardsClientError,
	giftCardsErrorCodeFrom,
	isRetryableGiftCardsError,
	isSessionEndCode,
} from './gift-cards-client'
import { makeSignedInSession } from '@/test/loyalty/session'
import { failingTransport, header, StubTransport } from '@/test/stub-transport'
import { makeConfiguration } from '@/test/support'

const ORIGIN = 'https://acme.epic-startup.com'

/** What the region sends: even a success carries `error: 'ok'` and `code: 'ok'`. */
function ok(body: Record<string, unknown>) {
	return JSON.stringify({ error: 'ok', code: 'ok', ...body })
}

const CARD = {
	id: 'gc_1',
	last4: '7K2M',
	status: 'active',
	balanceMinor: 5000,
	currency: 'USD',
	expiresAt: null,
	note: null,
}

const SAVED = {
	...CARD,
	savedAt: 1_700_000_000_000,
	recent: [
		{
			id: 'e1',
			kind: 'redeem',
			amountMinor: -1500,
			channel: 'pos',
			at: 1_700_000_100_000,
		},
	],
}

async function setup(transport: StubTransport) {
	const session = await makeSignedInSession(
		transport.send,
		makeConfiguration({ slug: 'acme', origin: ORIGIN }),
	)
	return new GiftCardsClient(session, { platform: 'ios' })
}

describe('contract', () => {
	it('decodes the saved cards, with and without recent activity', async () => {
		const transport = new StubTransport([
			{ raw: ok({ cards: [SAVED, { ...SAVED, id: 'gc_2', recent: [] }] }) },
		])
		const client = await setup(transport)
		const cards = await client.mine()
		expect(cards).toEqual(
			giftCardMineResponseSchema.parse({
				cards: [SAVED, { ...SAVED, id: 'gc_2', recent: [] }],
			}).cards,
		)
		expect(cards).toHaveLength(2)
	})

	it('decodes a claim and a till token', async () => {
		const transport = new StubTransport([
			{ raw: ok({ card: CARD, alreadyMine: false }) },
			{ raw: ok({ token: 'gcs1.abc', expiresAt: 1_700_000_300_000 }) },
		])
		const client = await setup(transport)
		await expect(client.claim('ABCD2345EFGH6789')).resolves.toEqual(
			giftCardClaimResponseSchema.parse({ card: CARD, alreadyMine: false }),
		)
		await expect(client.showToken('gc_1')).resolves.toEqual(
			giftCardShowTokenResponseSchema.parse({
				token: 'gcs1.abc',
				expiresAt: 1_700_000_300_000,
			}),
		)
	})

	it('refuses an answer that does not match the contract', async () => {
		const transport = new StubTransport([{ raw: ok({ cards: [{ id: 'x' }] }) }])
		const client = await setup(transport)
		await expect(client.mine()).rejects.toMatchObject({
			code: 'invalid_response',
		})
	})
})

describe('availability', () => {
	it('asks without a token and reads the flag', async () => {
		const transport = new StubTransport([
			{
				raw: ok({
					enabled: true,
					currency: 'USD',
					presetsMinor: [],
					minAmountMinor: 1000,
					maxAmountMinor: 50000,
					allowCustomAmount: true,
					designs: [],
					defaultDesign: 'classic',
					locations: [],
					maxDeliverAheadDays: 365,
				}),
			},
		])
		const client = await setup(transport)
		await expect(client.available()).resolves.toBe(true)
		const request = transport.lastRequest
		expect(request?.url.pathname).toBe('/gift-cards/options')
		expect(header(request, 'Authorization')).toBeUndefined()
		expect(header(request, 'Origin')).toBe(ORIGIN)
		expect(header(request, 'X-Client')).toBe('ios')
		expect(request?.url.searchParams.get('slug')).toBe('acme')
	})

	it('is null while gift cards are off (the uniform 404)', async () => {
		const transport = new StubTransport([
			{ status: 404, json: { error: 'not_found', code: 'not_found' } },
		])
		const client = await setup(transport)
		await expect(client.available()).resolves.toBeNull()
	})

	it('reports other failures instead of hiding the tab on them', async () => {
		const transport = new StubTransport([
			{ status: 503, json: { error: 'gift_cards_unavailable' } },
		])
		const client = await setup(transport)
		await expect(client.available()).rejects.toMatchObject({
			code: 'gift_cards_unavailable',
		})
	})
})

describe('requests', () => {
	it('reads the saved cards with the token and the binding in the query', async () => {
		const transport = new StubTransport([{ raw: ok({ cards: [] }) }])
		const client = await setup(transport)
		await client.mine()
		const request = transport.lastRequest
		expect(request?.request.method).toBe('GET')
		expect(request?.url.pathname).toBe('/gift-cards/mine')
		expect(request?.url.searchParams.get('slug')).toBe('acme')
		expect(header(request, 'Authorization')).toMatch(/^Bearer /)
	})

	it('sends the binding in the body of a claim, never the code in the URL', async () => {
		const transport = new StubTransport([
			{ raw: ok({ card: CARD, alreadyMine: true }) },
		])
		const client = await setup(transport)
		await client.claim('ABCD2345EFGH6789')
		const request = transport.lastRequest
		expect(request?.request.method).toBe('POST')
		expect(request?.url.pathname).toBe('/gift-cards/claim')
		expect(request?.url.search).toBe('')
		expect(request?.body).toEqual({ code: 'ABCD2345EFGH6789', slug: 'acme' })
	})

	it('encodes the card id in the path of a till token', async () => {
		const transport = new StubTransport([
			{ raw: ok({ token: 'gcs1.abc', expiresAt: 2 }) },
		])
		const client = await setup(transport)
		await client.showToken('gc/1 x')
		expect(transport.lastRequest?.url.pathname).toBe(
			'/gift-cards/gc%2F1%20x/show-token',
		)
		expect(transport.lastRequest?.body).toEqual({ slug: 'acme' })
	})
})

describe('failures', () => {
	it('maps the region codes, with the rate limit hint', async () => {
		const transport = new StubTransport([
			{
				status: 429,
				json: {
					error: 'rate_limited',
					code: 'rate_limited',
					retryAfterSeconds: 30,
				},
			},
			{ status: 404, json: { error: 'code_invalid', code: 'code_invalid' } },
		])
		const client = await setup(transport)
		await expect(client.claim('AAAAAAAA')).rejects.toMatchObject({
			code: 'rate_limited',
			retryAfterSeconds: 30,
			status: 429,
		})
		await expect(client.claim('BBBBBBBB')).rejects.toMatchObject({
			code: 'code_invalid',
		})
	})

	it('reports an offline device as a network failure', async () => {
		const session = await makeSignedInSession(
			failingTransport,
			makeConfiguration({ slug: 'acme', origin: ORIGIN }),
		)
		const client = new GiftCardsClient(session, { platform: 'android' })
		await expect(client.mine()).rejects.toMatchObject({ code: 'network' })
	})

	it('falls back to the status when the body has no code', () => {
		expect(giftCardsErrorCodeFrom(401, {})).toBe('signed_out')
		expect(giftCardsErrorCodeFrom(404, 'Not Found')).toBe(
			'organization_not_found',
		)
		expect(giftCardsErrorCodeFrom(429, null)).toBe('rate_limited')
		expect(giftCardsErrorCodeFrom(503, {})).toBe('gift_cards_unavailable')
		expect(giftCardsErrorCodeFrom(413, {})).toBe('invalid_request')
		expect(giftCardsErrorCodeFrom(500, {})).toBe('unknown')
		expect(
			giftCardsErrorCodeFrom(400, { error: 'organization_mismatch' }),
		).toBe('organization_mismatch')
		// The body's own code wins over the status.
		expect(giftCardsErrorCodeFrom(404, { code: 'code_invalid' })).toBe(
			'code_invalid',
		)
	})

	it('knows what ends a session and what may be retried', () => {
		expect(isSessionEndCode('signed_out')).toBe(true)
		expect(isSessionEndCode('organization_mismatch')).toBe(true)
		expect(isSessionEndCode('code_invalid')).toBe(false)
		expect(
			isRetryableGiftCardsError(new GiftCardsClientError('network', 0)),
		).toBe(true)
		expect(
			isRetryableGiftCardsError(new GiftCardsClientError('rate_limited', 429)),
		).toBe(true)
		expect(
			isRetryableGiftCardsError(new GiftCardsClientError('code_invalid', 404)),
		).toBe(false)
	})
})
