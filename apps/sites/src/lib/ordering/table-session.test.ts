import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	checkTabPayment,
	clearTableSession,
	fetchTab,
	fetchTableContext,
	loadTableSession,
	readTableContext,
	readTableFragment,
	saveTableSession,
	startTabPayment,
	stripTableFragment,
	submitTableRound,
	TABLE_REQUEST_TIMEOUT_MS,
	tableHeaders,
	takeStashedTableScan,
	TableRequestError,
	type TableSession,
} from './table-session.ts'

const token = `tbl-1.2.${'a'.repeat(64)}`
const tabToken = `tab-1.1.${'b'.repeat(64)}`

function storage() {
	const values = new Map<string, string>()
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
		removeItem: (key: string) => void values.delete(key),
		values,
	}
}

function session(overrides: Partial<TableSession> = {}): TableSession {
	return {
		orgId: 'org-1',
		locationId: 'loc-1',
		tableToken: token,
		tableLabel: 'T4',
		tabId: null,
		tabToken: null,
		tabNumber: null,
		policy: {
			requireGuestName: false,
			requireGuestPhone: false,
			onlineTabPayAvailable: false,
		},
		savedAt: Date.now(),
		...overrides,
	}
}

describe('table codes in the fragment', () => {
	it('reads a well-formed code and ignores anything else', () => {
		expect(
			readTableFragment(`https://x.example/menu?location=l#table=${token}`),
		).toBe(token)
		expect(readTableFragment('https://x.example/menu#table=nope')).toBeNull()
		expect(
			readTableFragment('https://x.example/menu?table=' + token),
		).toBeNull()
	})

	it('takes a code the head script stashed, once and only while fresh', () => {
		const store = storage()
		store.setItem('menuza_qr_scan', JSON.stringify({ code: token, at: 1000 }))
		expect(takeStashedTableScan(store, 2000)).toBe(token)
		expect(takeStashedTableScan(store, 2000)).toBeNull()
		store.setItem('menuza_qr_scan', JSON.stringify({ code: token, at: 1000 }))
		expect(takeStashedTableScan(store, 1000 + 6 * 60_000)).toBeNull()
		store.setItem('menuza_qr_scan', JSON.stringify({ code: 'nope', at: 1000 }))
		expect(takeStashedTableScan(store, 2000)).toBeNull()
	})

	it('strips only the table code from the address', () => {
		expect(
			stripTableFragment(`https://x.example/menu?location=l#table=${token}`),
		).toBe('https://x.example/menu?location=l')
		expect(
			stripTableFragment(`https://x.example/menu#table=${token}&item=abc`),
		).toBe('https://x.example/menu#item=abc')
	})
})

describe('table sessions', () => {
	it('round-trips, expires and refuses tampered data', () => {
		const store = storage()
		vi.stubGlobal('localStorage', store)
		saveTableSession(session({ tabToken, tabId: 'tab-1', tabNumber: '007' }))
		expect(loadTableSession('org-1')?.tabNumber).toBe('007')
		expect(loadTableSession('org-2')).toBeNull()
		expect(loadTableSession('org-1', Date.now() + 13 * 3_600_000)).toBeNull()
		store.setItem(
			'menuza_qr_tab_org-1',
			JSON.stringify({ ...session(), tableToken: 'x' }),
		)
		expect(loadTableSession('org-1')).toBeNull()
		clearTableSession('org-1')
		vi.unstubAllGlobals()
	})

	it('sends the tab token once there is a tab, else the table token', () => {
		expect(tableHeaders(session())).toEqual({ 'X-Table-Token': token })
		expect(tableHeaders(session({ tabToken }))).toEqual({
			'X-Tab-Token': tabToken,
		})
	})

	it('validates the table context', () => {
		expect(readTableContext({ table: {}, dineIn: {} })).toBeNull()
		expect(
			readTableContext({
				table: { label: 'T4', locationId: 'loc-1' },
				dineIn: {
					enabled: true,
					requireGuestName: true,
					requireGuestPhone: false,
					onlineTabPayAvailable: false,
				},
				openTab: null,
			})?.dineIn.requireGuestName,
		).toBe(true)
	})

	it('posts rounds with the capability header and never a price', async () => {
		vi.stubGlobal('document', {
			documentElement: {
				dataset: { tenantApiUrl: 'https://regional.example/', orgSlug: 'cafe' },
			},
		})
		vi.stubGlobal('localStorage', storage())
		const fetchMock = vi.fn(async () =>
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
					tab: { id: 'tab-1', tabNumber: '001', tabToken },
				},
				{ status: 201 },
			),
		)
		vi.stubGlobal('fetch', fetchMock)
		const created = await submitTableRound(session(), {
			fulfillment: 'dine_in',
		})
		expect(created.tab.tabNumber).toBe('001')
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		]
		expect(url).toBe('https://regional.example/orders')
		expect((init.headers as Record<string, string>)['X-Table-Token']).toBe(
			token,
		)
		expect(JSON.parse(String(init.body))).toEqual({
			fulfillment: 'dine_in',
			slug: 'cafe',
		})
		expect(new Headers(init.headers).has('Authorization')).toBe(false)
		vi.unstubAllGlobals()
	})
})

describe('signed-in members at the table', () => {
	const createdRound = () =>
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
				tab: { id: 'tab-1', tabNumber: '001', tabToken },
			},
			{ status: 201 },
		)
	const refused = () =>
		Response.json({ error: 'Invalid or expired token' }, { status: 401 })
	const reward = {
		rewardId: 'rwd_coffee',
		rewardVersion: 1,
		expectedDiscountMinor: 500,
		targetLineId: null,
	}

	const refreshableToken = `head.${btoa(JSON.stringify({ sub: 'cus-1', orgId: 'org-1' }))}.sig`

	/** `refreshable`: a real session, which an expired token refreshes. */
	function signIn(options: { refreshable?: boolean } = {}) {
		vi.stubGlobal('document', {
			documentElement: {
				dataset: { tenantApiUrl: 'https://regional.example', orgSlug: 'cafe' },
			},
		})
		const store = storage()
		if (options.refreshable) {
			store.setItem('tenant_access_token', refreshableToken)
			store.setItem('tenant_refresh_token', 'refresh-1')
		} else {
			store.setItem('tenant_access_token', 'member-token')
		}
		vi.stubGlobal('localStorage', store)
	}

	/** The token expired and the region cannot refresh it right now. */
	function refreshDown() {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(refused())
			.mockResolvedValueOnce(Response.json({}, { status: 503 }))
		vi.stubGlobal('fetch', fetchMock)
		return fetchMock
	}

	function calls(fetchMock: ReturnType<typeof vi.fn>) {
		return fetchMock.mock.calls.map((call) => {
			const [url, init] = call as unknown as [string, RequestInit]
			return {
				url,
				authorization: new Headers(init.headers).get('Authorization'),
				body: JSON.parse(String(init.body)) as Record<string, unknown>,
			}
		})
	}

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("sends the member's token with a round, so the round claims the tab", async () => {
		signIn()
		const fetchMock = vi.fn(async () => createdRound())
		vi.stubGlobal('fetch', fetchMock)
		await submitTableRound(session(), { fulfillment: 'dine_in' })
		expect(calls(fetchMock)).toEqual([
			{
				url: 'https://regional.example/orders',
				authorization: 'Bearer member-token',
				body: { fulfillment: 'dine_in', slug: 'cafe' },
			},
		])
	})

	it('still sends the round as a guest when the region refuses the token', async () => {
		signIn()
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(refused())
			.mockResolvedValueOnce(createdRound())
		vi.stubGlobal('fetch', fetchMock)
		const created = await submitTableRound(session(), {
			fulfillment: 'dine_in',
		})
		expect(created.tab.id).toBe('tab-1')
		expect(calls(fetchMock).map((call) => call.authorization)).toEqual([
			'Bearer member-token',
			null,
		])
	})

	it('forgets a token the region refused, so the next round goes as a guest at once', async () => {
		signIn()
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(refused())
			.mockResolvedValueOnce(createdRound())
			.mockResolvedValueOnce(createdRound())
		vi.stubGlobal('fetch', fetchMock)
		await submitTableRound(session(), { fulfillment: 'dine_in' })
		expect(localStorage.getItem('tenant_access_token')).toBeNull()
		await submitTableRound(session(), { fulfillment: 'dine_in' })
		expect(calls(fetchMock).map((call) => call.authorization)).toEqual([
			'Bearer member-token',
			null,
			null,
		])
	})

	it('forgets a refused token when a payment with a reward needed the member', async () => {
		signIn()
		const fetchMock = vi.fn(async () => refused())
		vi.stubGlobal('fetch', fetchMock)
		await expect(
			startTabPayment('org-1', session({ tabToken }), {
				tipPercent: 0,
				contact: { name: 'Sam', phone: '+15555550100' },
				locale: 'en',
				loyalty: reward,
			}),
		).rejects.toMatchObject({ status: 401 })
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(localStorage.getItem('tenant_access_token')).toBeNull()
	})

	it('keeps a round for the member while the session cannot be refreshed', async () => {
		signIn({ refreshable: true })
		const fetchMock = refreshDown()
		// Not as a guest: the round would lose the member's claim on the tab.
		await expect(
			submitTableRound(session(), { fulfillment: 'dine_in' }),
		).rejects.toMatchObject({ code: 'network', status: 0 })
		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
			'https://regional.example/orders',
			'https://regional.example/auth/refresh',
		])
		expect(localStorage.getItem('tenant_access_token')).toBe(refreshableToken)
		expect(localStorage.getItem('tenant_refresh_token')).toBe('refresh-1')
	})

	it.each([
		['without a reward', null],
		['with a reward', reward],
	])(
		'keeps a payment %s for the member while the session cannot be refreshed',
		async (_label, loyalty) => {
			signIn({ refreshable: true })
			const fetchMock = refreshDown()
			// A network failure, not a refusal: a picked reward stays picked.
			await expect(
				startTabPayment('org-1', session({ tabToken }), {
					tipPercent: 0,
					contact: { name: 'Sam', phone: '+15555550100' },
					locale: 'en',
					loyalty,
				}),
			).rejects.toMatchObject({ code: 'network', status: 0 })
			expect(fetchMock).toHaveBeenCalledTimes(2)
		},
	)

	it('goes on as a guest once the organization is no longer active', async () => {
		signIn({ refreshable: true })
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(refused())
			.mockResolvedValueOnce(
				Response.json(
					{
						error: 'Organization is no longer active',
						code: 'organization_inactive',
					},
					{ status: 403 },
				),
			)
			.mockResolvedValueOnce(createdRound())
		vi.stubGlobal('fetch', fetchMock)
		await submitTableRound(session(), { fulfillment: 'dine_in' })
		expect(calls(fetchMock).map((call) => call.authorization)).toEqual([
			`Bearer ${refreshableToken}`,
			null,
			null,
		])
		expect(localStorage.getItem('tenant_access_token')).toBeNull()
		expect(localStorage.getItem('tenant_refresh_token')).toBeNull()
	})

	it('keeps a round for the member while the region cannot check the session', async () => {
		signIn({ refreshable: true })
		const fetchMock = vi.fn().mockResolvedValueOnce(
			Response.json(
				{
					error: 'Service temporarily unavailable. Please try again.',
					code: 'temporarily_unavailable',
				},
				{ status: 503 },
			),
		)
		vi.stubGlobal('fetch', fetchMock)
		await expect(
			submitTableRound(session(), { fulfillment: 'dine_in' }),
		).rejects.toMatchObject({ code: 'network', status: 0 })
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(localStorage.getItem('tenant_refresh_token')).toBe('refresh-1')
	})

	describe('a region that never answers', () => {
		afterEach(() => {
			vi.useRealTimers()
		})

		it.each([
			['as the member', true],
			['as a guest', false],
		])(
			'fails a tab payment started %s as a network error',
			async (_label, member) => {
				vi.useFakeTimers()
				if (member) signIn()
				else {
					vi.stubGlobal('document', {
						documentElement: {
							dataset: {
								tenantApiUrl: 'https://regional.example',
								orgSlug: 'cafe',
							},
						},
					})
					vi.stubGlobal('localStorage', storage())
				}
				let signal: AbortSignal | null | undefined
				vi.stubGlobal(
					'fetch',
					vi.fn((_url: string, init: RequestInit) => {
						signal = init.signal
						return new Promise<Response>(() => {})
					}),
				)
				const payment = startTabPayment('org-1', session({ tabToken }), {
					tipPercent: 0,
					contact: { name: 'Sam', phone: '+15555550100' },
					locale: 'en',
				})
				const outcome = payment.catch((caught: unknown) => caught)
				await vi.advanceTimersByTimeAsync(TABLE_REQUEST_TIMEOUT_MS)
				await expect(outcome).resolves.toMatchObject({
					code: 'network',
					status: 0,
				})
				expect(signal?.aborted).toBe(true)
			},
		)

		it('fails a round that never answers as a network error', async () => {
			vi.useFakeTimers()
			signIn()
			vi.stubGlobal(
				'fetch',
				vi.fn(() => new Promise<Response>(() => {})),
			)
			const round = submitTableRound(session(), {
				fulfillment: 'dine_in',
			}).catch((caught: unknown) => caught)
			await vi.advanceTimersByTimeAsync(TABLE_REQUEST_TIMEOUT_MS)
			await expect(round).resolves.toBeInstanceOf(TableRequestError)
			await expect(round).resolves.toMatchObject({ code: 'network' })
		})

		it.each([
			[
				'the table context',
				() => fetchTableContext({ locationId: 'loc-1', tableToken: token }),
			],
			['the tab', () => fetchTab(tabToken)],
			['the payment status', () => checkTabPayment('org-1')],
		])(
			'fails a read of %s that never answers as a network error',
			async (_l, read) => {
				vi.useFakeTimers()
				signIn()
				vi.stubGlobal('sessionStorage', {
					getItem: () =>
						JSON.stringify({ orderRef: 'tab:tab-1', paymentToken: 'pay-1' }),
					setItem: () => {},
					removeItem: () => {},
				})
				let signal: AbortSignal | null | undefined
				vi.stubGlobal(
					'fetch',
					vi.fn((_url: string, init: RequestInit) => {
						signal = init.signal
						return new Promise<Response>(() => {})
					}),
				)
				const outcome = read().catch((caught: unknown) => caught)
				await vi.advanceTimersByTimeAsync(TABLE_REQUEST_TIMEOUT_MS)
				await expect(outcome).resolves.toMatchObject({ code: 'network' })
				expect(signal?.aborted).toBe(true)
			},
		)

		it('fails a payment hand-off that never answers as a network error', async () => {
			vi.useFakeTimers()
			signIn()
			vi.stubGlobal(
				'fetch',
				vi
					.fn()
					.mockResolvedValueOnce(
						Response.json({
							orderRef: 'tab:tab-1',
							tabPaymentToken: 'pay-1',
							amountCents: 2_450,
							tipCents: 200,
							loyaltyDiscountCents: 0,
							currency: 'USD',
						}),
					)
					.mockImplementationOnce(() => new Promise<Response>(() => {})),
			)
			const payment = startTabPayment('org-1', session({ tabToken }), {
				tipPercent: 0,
				contact: { name: 'Sam', phone: '+15555550100' },
				locale: 'en',
			}).catch((caught: unknown) => caught)
			await vi.advanceTimersByTimeAsync(TABLE_REQUEST_TIMEOUT_MS)
			await expect(payment).resolves.toMatchObject({ code: 'network' })
		})
	})
	it('pays with a reward only as the member', async () => {
		signIn()
		const fetchMock = vi.fn(async () =>
			Response.json({ error: 'unauthorized' }, { status: 401 }),
		)
		vi.stubGlobal('fetch', fetchMock)
		const error = await startTabPayment('org-1', session({ tabToken }), {
			tipPercent: 10,
			contact: { name: 'Sam', phone: '+15555550100' },
			locale: 'en',
			loyalty: reward,
		}).catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(TableRequestError)
		expect((error as TableRequestError).code).toBe('unauthorized')
		expect(calls(fetchMock)).toEqual([
			{
				url: 'https://regional.example/orders/tab/pay',
				authorization: 'Bearer member-token',
				body: {
					slug: 'cafe',
					tipPercent: 10,
					contact: { name: 'Sam', phone: '+15555550100' },
					loyalty: reward,
				},
			},
		])
	})

	it('pays without a reward as a guest when the token is refused', async () => {
		signIn()
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(refused())
			.mockResolvedValueOnce(
				Response.json({
					orderRef: 'tab:tab-1',
					tabPaymentToken: 'pay-1',
					amountCents: 2_450,
					tipCents: 200,
					loyaltyDiscountCents: 0,
					currency: 'USD',
				}),
			)
			.mockResolvedValueOnce(
				Response.json({ checkoutUrl: 'https://pay.example/c/1' }),
			)
		vi.stubGlobal('fetch', fetchMock)
		const started = await startTabPayment('org-1', session({ tabToken }), {
			tipPercent: 0,
			contact: { name: 'Sam', phone: '+15555550100' },
			locale: 'en',
		})
		expect(started).toEqual({
			url: 'https://pay.example/c/1',
			amountCents: 2_450,
			tipCents: 200,
			loyaltyDiscountCents: 0,
			currency: 'USD',
		})
		const sent = calls(fetchMock)
		expect(sent.map((call) => [call.url, call.authorization])).toEqual([
			['https://regional.example/orders/tab/pay', 'Bearer member-token'],
			['https://regional.example/orders/tab/pay', null],
			['/api/orders/payment', null],
		])
		expect(sent[1]!.body).not.toHaveProperty('loyalty')
	})

	it.each([
		['the amount', { amountCents: undefined }],
		['the tip', { tipCents: undefined }],
		['the reward saving', { loyaltyDiscountCents: undefined }],
		['the currency', { currency: undefined }],
	])(
		'fails as payment_unavailable when the answer lacks %s',
		async (_label, missing) => {
			signIn()
			const fetchMock = vi.fn().mockResolvedValueOnce(
				Response.json({
					orderRef: 'tab:tab-1',
					tabPaymentToken: 'pay-1',
					amountCents: 2_450,
					tipCents: 200,
					loyaltyDiscountCents: 0,
					currency: 'USD',
					...missing,
				}),
			)
			vi.stubGlobal('fetch', fetchMock)
			await expect(
				startTabPayment('org-1', session({ tabToken }), {
					tipPercent: 15,
					contact: { name: 'Sam', phone: '+15555550100' },
					locale: 'en',
				}),
			).rejects.toMatchObject({ code: 'payment_unavailable', status: 502 })
			// No hosted page was asked for.
			expect(fetchMock).toHaveBeenCalledTimes(1)
		},
	)

	describe('a refused table or tab code', () => {
		it.each([
			['a 401 for the tab', 401, { error: 'tab_not_found' }, 'tab_not_found'],
			[
				'a 403 for the table',
				403,
				{ error: 'table_not_found' },
				'table_not_found',
			],
			[
				'a 401 for an archived table',
				401,
				{ error: 'table_archived' },
				'table_archived',
			],
		])(
			'is not the customer signing out (%s)',
			async (_label, status, body, code) => {
				signIn({ refreshable: true })
				const fetchMock = vi.fn(async () => Response.json(body, { status }))
				vi.stubGlobal('fetch', fetchMock)
				await expect(
					submitTableRound(session({ tabToken }), { fulfillment: 'dine_in' }),
				).rejects.toMatchObject({ code, status })
				// No token refresh and no second try as a guest.
				expect(fetchMock).toHaveBeenCalledTimes(1)
				expect(localStorage.getItem('tenant_access_token')).toBe(
					refreshableToken,
				)
				expect(localStorage.getItem('tenant_refresh_token')).toBe('refresh-1')
			},
		)

		it('still signs the customer out when the token itself is refused', async () => {
			signIn()
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(
					Response.json({ error: 'Invalid or expired token' }, { status: 401 }),
				)
				.mockResolvedValueOnce(createdRound())
			vi.stubGlobal('fetch', fetchMock)
			await submitTableRound(session(), { fulfillment: 'dine_in' })
			expect(localStorage.getItem('tenant_access_token')).toBeNull()
			expect(fetchMock).toHaveBeenCalledTimes(2)
		})
	})
})
