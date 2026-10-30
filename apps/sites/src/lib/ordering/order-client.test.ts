import { describe, expect, it, vi } from 'vitest'
import {
	acceptCheckoutUrl,
	checkoutAttemptKey,
	clearCheckoutAttempt,
	fetchOrderingOptions,
	orderLines,
	submitRegionalOrder,
} from './order-client.ts'
import { type CartItem } from './types.ts'

function setup() {
	const values = new Map<string, string>()
	vi.stubGlobal('sessionStorage', {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
		removeItem: (key: string) => values.delete(key),
	})
	vi.stubGlobal('document', {
		documentElement: {
			dataset: { tenantApiUrl: 'https://regional.example', orgSlug: 'cafe' },
		},
	})
	return { [Symbol.dispose]: () => vi.unstubAllGlobals() }
}

describe('regional order client', () => {
	it('discards every browser price and display field', () => {
		const line: CartItem = {
			id: 'line',
			itemId: 'dish',
			name: 'Untrusted name',
			basePrice: 1,
			unitPrice: 1,
			quantity: 2,
			instructions: '',
			options: [],
		}
		expect(orderLines([line])).toEqual([
			{
				itemId: 'dish',
				variantId: undefined,
				quantity: 2,
				instructions: '',
				options: [],
			},
		])
	})
	it('keeps the variant id but drops display-only variation options', () => {
		const line: CartItem = {
			id: 'line',
			itemId: 'loaf',
			variantId: 'size-half',
			name: 'Country Sourdough',
			basePrice: 8,
			unitPrice: 8,
			quantity: 1,
			instructions: '',
			options: [
				{
					groupId: 'size',
					groupName: 'Size',
					optionId: 'half',
					optionName: 'Half loaf',
					priceDelta: 0,
					variation: true,
				},
				{
					groupId: 'extras',
					groupName: 'Extras',
					optionId: 'seeds',
					optionName: 'Toasted seeds',
					priceDelta: 150,
				},
			],
		}
		expect(orderLines([line])).toEqual([
			{
				itemId: 'loaf',
				variantId: 'size-half',
				quantity: 1,
				instructions: '',
				options: [
					{
						groupId: 'extras',
						optionId: 'seeds',
						half: undefined,
						quantity: undefined,
					},
				],
			},
		])
	})
	it('reuses an attempt only for an unchanged checkout', async () => {
		using ignoredSetup = setup()
		const first = await checkoutAttemptKey('org', {
			contact: { name: 'Test guest' },
			lines: [],
		})
		expect(
			await checkoutAttemptKey('org', {
				contact: { name: 'Test guest' },
				lines: [],
			}),
		).toBe(first)
		expect(
			await checkoutAttemptKey('org', {
				contact: { name: 'Other guest' },
				lines: [],
			}),
		).not.toBe(first)
		expect(sessionStorage.getItem('menuza_order_attempt_org')).not.toContain(
			'guest',
		)
	})
	it('fails closed rather than falling back to the US API', async () => {
		using ignoredSetup = setup()
		vi.stubGlobal('document', { documentElement: { dataset: {} } })
		const fetch = vi.fn()
		vi.stubGlobal('fetch', fetch)
		await expect(submitRegionalOrder({})).rejects.toMatchObject({
			code: 'region_unavailable',
		})
		expect(fetch).not.toHaveBeenCalled()
	})
	it('clears the attempt so a later order mints a fresh key', async () => {
		using ignoredSetup = setup()
		const payload = { contact: { name: 'Test guest' }, lines: [] }
		const first = await checkoutAttemptKey('org', payload)
		clearCheckoutAttempt('org')
		expect(sessionStorage.getItem('menuza_order_attempt_org')).toBeNull()
		expect(await checkoutAttemptKey('org', payload)).not.toBe(first)
	})
	it('requests ordering options scoped to the org and location', async () => {
		using ignoredSetup = setup()
		const fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				onlinePayment: { enabled: true, processor: 'connect' },
				ordering: { open: true, status: 'open', reason: null, nextOpen: null },
			}),
		})
		vi.stubGlobal('fetch', fetch)
		const options = await fetchOrderingOptions({
			locationId: 'loc-1',
			dropSlug: 'ramadan-box',
		})
		expect(options.onlinePayment.enabled).toBe(true)
		const [url] = fetch.mock.calls[0] as [string]
		expect(url).toBe(
			'https://regional.example/orders/options?slug=cafe&locationId=loc-1&dropSlug=ramadan-box',
		)
	})
	it('rejects malformed ordering options responses', async () => {
		using ignoredSetup = setup()
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ unexpected: true }),
			}),
		)
		await expect(
			fetchOrderingOptions({ locationId: 'loc-1' }),
		).rejects.toMatchObject({ code: 'options_unavailable' })
	})
})

describe('signed-in checkout', () => {
	const memberToken = (n: number) =>
		`head.${btoa(JSON.stringify({ sub: 'cus-1', orgId: 'org-1', n }))}.sig`
	const created = () =>
		Response.json(
			{
				order: {
					id: 'o1',
					number: '1',
					status: 'accepted',
					paymentStatus: 'unpaid',
					currency: 'USD',
					subtotalCents: 800,
					taxCents: 0,
					deliveryFeeCents: 0,
					tipCents: 0,
					totalCents: 800,
					holdExpiresAt: null,
				},
				receiptToken: 'r'.repeat(64),
			},
			{ status: 201 },
		)
	// The region's sign-in refusal carries text, not a code.
	const expired = () =>
		Response.json({ error: 'Invalid or expired token' }, { status: 401 })

	function signIn(options: { refreshToken?: boolean } = {}) {
		const disposable = setup()
		const values = new Map<string, string>()
		values.set('tenant_access_token', memberToken(1))
		if (options.refreshToken !== false) {
			values.set('tenant_refresh_token', 'refresh-1')
		}
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => void values.set(key, value),
			removeItem: (key: string) => void values.delete(key),
		})
		return disposable
	}

	/** Answers in turn, noting each call's token as it was sent. */
	function region(...answers: Array<() => Response>) {
		const sent: Array<{ url: string; authorization: string | null }> = []
		const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
			sent.push({
				url,
				authorization: new Headers(init.headers).get('Authorization'),
			})
			const next = answers.shift()
			if (!next) throw new Error('unexpected request')
			return next()
		})
		vi.stubGlobal('fetch', fetchMock)
		return { sent, fetchMock }
	}

	it('places a guest order without a token', async () => {
		using ignoredSetup = setup()
		vi.stubGlobal('localStorage', {
			getItem: () => null,
			setItem: () => undefined,
			removeItem: () => undefined,
		})
		const { sent, fetchMock } = region(created)
		const order = await submitRegionalOrder({ fulfillment: 'pickup' })
		expect(order.order.id).toBe('o1')
		expect(sent).toEqual([
			{ url: 'https://regional.example/orders', authorization: null },
		])
		const [, init] = fetchMock.mock.calls[0]!
		expect(JSON.parse(String(init.body))).toEqual({
			fulfillment: 'pickup',
			slug: 'cafe',
		})
	})

	it('refreshes an expired sign-in once and places the order as the member', async () => {
		using ignoredSetup = signIn()
		const { sent } = region(
			expired,
			() =>
				Response.json({
					accessToken: memberToken(2),
					refreshToken: 'refresh-2',
				}),
			created,
		)
		const order = await submitRegionalOrder({ fulfillment: 'pickup' })
		expect(order.order.id).toBe('o1')
		expect(sent).toEqual([
			{
				url: 'https://regional.example/orders',
				authorization: `Bearer ${memberToken(1)}`,
			},
			{ url: 'https://regional.example/auth/refresh', authorization: null },
			{
				url: 'https://regional.example/orders',
				authorization: `Bearer ${memberToken(2)}`,
			},
		])
	})

	it('answers unauthorized for a sign-in the region refused, and the next try goes as a guest', async () => {
		using ignoredSetup = signIn()
		region(expired, () =>
			Response.json({ error: 'invalid_grant' }, { status: 401 }),
		)
		await expect(
			submitRegionalOrder({ fulfillment: 'pickup' }),
		).rejects.toMatchObject({ code: 'unauthorized', status: 401 })
		expect(localStorage.getItem('tenant_access_token')).toBeNull()

		const retry = region(created)
		await submitRegionalOrder({ fulfillment: 'pickup' })
		expect(retry.sent).toEqual([
			{ url: 'https://regional.example/orders', authorization: null },
		])
	})

	it('forgets a sign-in that cannot be refreshed', async () => {
		using ignoredSetup = signIn({ refreshToken: false })
		const { fetchMock } = region(expired)
		await expect(
			submitRegionalOrder({ fulfillment: 'pickup' }),
		).rejects.toMatchObject({ code: 'unauthorized', status: 401 })
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(localStorage.getItem('tenant_access_token')).toBeNull()
	})

	it('keeps the sign-in when the refresh failed for now', async () => {
		using ignoredSetup = signIn()
		region(expired, () => Response.json({}, { status: 503 }))
		// Not `unauthorized`: a reward on the order stays picked for the retry.
		await expect(
			submitRegionalOrder({ fulfillment: 'pickup' }),
		).rejects.toMatchObject({ code: 'order_failed', status: 401 })
		expect(localStorage.getItem('tenant_access_token')).toBe(memberToken(1))
		expect(localStorage.getItem('tenant_refresh_token')).toBe('refresh-1')
	})

	it('forgets a sign-in whose organization is no longer active', async () => {
		using ignoredSetup = signIn()
		region(expired, () =>
			Response.json(
				{
					error: 'Organization is no longer active',
					code: 'organization_inactive',
				},
				{ status: 403 },
			),
		)
		await expect(
			submitRegionalOrder({ fulfillment: 'pickup' }),
		).rejects.toMatchObject({ code: 'unauthorized', status: 401 })
		expect(localStorage.getItem('tenant_access_token')).toBeNull()
		expect(localStorage.getItem('tenant_refresh_token')).toBeNull()
	})

	it.each([
		['a refresh refused with a plain 403', [expired, () => Response.json({ error: 'Forbidden' }, { status: 403 })]],
		[
			'the region unable to check the session',
			[
				() =>
					Response.json(
						{
							error: 'Service temporarily unavailable. Please try again.',
							code: 'temporarily_unavailable',
						},
						{ status: 503 },
					),
			],
		],
	] as Array<[string, Array<() => Response>]>)(
		'keeps the sign-in through %s',
		async (_label, answers) => {
			using ignoredSetup = signIn()
			region(...answers)
			await expect(
				submitRegionalOrder({ fulfillment: 'pickup' }),
			).rejects.toMatchObject({ code: 'order_failed' })
			expect(localStorage.getItem('tenant_access_token')).toBe(memberToken(1))
			expect(localStorage.getItem('tenant_refresh_token')).toBe('refresh-1')
		},
	)
})

describe('checkout url (VAL-PMOCK-038)', () => {
	it('always accepts https', () => {
		for (const production of [false, true]) {
			expect(
				acceptCheckoutUrl('https://checkout.stripe.com/c/pay/cs_1', {
					production,
				}),
			).toBe('https://checkout.stripe.com/c/pay/cs_1')
		}
	})

	it('accepts loopback http outside production (the local payment mock)', () => {
		for (const url of [
			'http://localhost:3001/mock-payments/stripe/checkout/cs_test_1',
			'http://127.0.0.1:3001/mock-payments/checkout-com/hpp/hpp_1',
			'http://app.localhost:3001/mock-payments/stripe/checkout/cs_test_1',
		]) {
			expect(acceptCheckoutUrl(url, { production: false })).toBe(url)
		}
	})

	it('refuses any other http address with payment_unavailable', () => {
		for (const url of [
			'http://example.com/pay',
			'http://localhost.evil.com/pay',
			'http://evil-localhost/pay',
			'http://10.0.0.5/pay',
			'http://[::1]:3001/pay',
		]) {
			expect(() => acceptCheckoutUrl(url, { production: false })).toThrow(
				expect.objectContaining({ code: 'payment_unavailable', status: 502 }),
			)
		}
	})

	it('refuses even loopback http in production', () => {
		expect(() =>
			acceptCheckoutUrl(
				'http://localhost:3001/mock-payments/stripe/checkout/cs_1',
				{
					production: true,
				},
			),
		).toThrow(expect.objectContaining({ code: 'payment_unavailable' }))
	})

	it('refuses other schemes and malformed values', () => {
		for (const url of [
			'javascript:alert(1)',
			'ftp://localhost/x',
			'not a url',
			'',
		]) {
			expect(() => acceptCheckoutUrl(url, { production: false })).toThrow(
				expect.objectContaining({ code: 'payment_unavailable' }),
			)
		}
	})

	it('the default follows the build: this test run is not a production build', () => {
		expect(acceptCheckoutUrl('http://localhost:3001/x')).toBe(
			'http://localhost:3001/x',
		)
	})
})
