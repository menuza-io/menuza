// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	checkoutErrorView,
	createPaymentApi,
	createPoller,
	initPayPage,
	interpretPay,
	parsePayLocation,
	PayApiError,
	type PayApi,
	type PayPageDeps,
	purposeCandidates,
	readPay,
	storePay,
} from './pay.ts'
import { testLabels } from './test-labels.ts'

const labels = testLabels()

function memoryStorage() {
	const map = new Map<string, string>()
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
		map,
	}
}

afterEach(() => {
	document.body.replaceChildren()
})

describe('pay link parsing', () => {
	it('reads reservation and fee links from the fragment', () => {
		expect(parsePayLocation('#r=rsv_1&t=tok-123456', '')).toEqual({
			ref: { kind: 'reservation', id: 'rsv_1' },
			token: 'tok-123456',
			purpose: null,
		})
		expect(parsePayLocation('#f=pay_2&t=abcdefgh', '').ref).toEqual({
			kind: 'fee',
			id: 'pay_2',
		})
	})
	it('reads the return page query but never takes a token from the query', () => {
		const parsed = parsePayLocation('', '?r=rsv_1&purpose=prepay&t=leak')
		expect(parsed.ref?.id).toBe('rsv_1')
		expect(parsed.purpose).toBe('prepay')
		expect(parsed.token).toBeNull()
	})
	it('rejects malformed ids and unknown purposes', () => {
		expect(parsePayLocation('#r=a b&t=x', '').ref).toBeNull()
		expect(parsePayLocation('', '?r=rsv_1&purpose=nope').purpose).toBeNull()
	})
})

describe('status interpretation', () => {
	it('only settled payment states count as paid', () => {
		for (const paymentStatus of ['paid', 'guaranteed', 'fee_charged']) {
			expect(
				interpretPay({ paymentStatus, reservationStatus: 'booked' }, 'deposit'),
			).toBe('paid')
		}
		expect(
			interpretPay(
				{ paymentStatus: 'pending', reservationStatus: 'pending_payment' },
				'deposit',
			),
		).toBe('pending')
	})
	it('maps failures, expiry and review', () => {
		expect(
			interpretPay(
				{ paymentStatus: 'fee_failed', reservationStatus: 'no_show' },
				'fee',
			),
		).toBe('failed')
		expect(
			interpretPay(
				{ paymentStatus: 'none', reservationStatus: 'expired' },
				'deposit',
			),
		).toBe('expired')
		expect(
			interpretPay(
				{ paymentStatus: 'fee_pending', reservationStatus: 'cancelled' },
				'fee',
			),
		).toBe('pending')
		expect(
			interpretPay(
				{ paymentStatus: 'disputed', reservationStatus: 'booked' },
				'deposit',
			),
		).toBe('review')
	})
	it('tries the known purpose first and fees only as fee', () => {
		expect(
			purposeCandidates({ kind: 'reservation', id: 'x' }, 'prepay')[0],
		).toBe('prepay')
		expect(purposeCandidates({ kind: 'fee', id: 'x' }, null)).toEqual(['fee'])
	})
	it('maps checkout errors to views', () => {
		expect(checkoutErrorView(new PayApiError(409, 'already_paid', false))).toBe(
			'paid',
		)
		expect(checkoutErrorView(new PayApiError(409, 'hold_expired', false))).toBe(
			'expired',
		)
		expect(
			checkoutErrorView(new PayApiError(404, 'payment_not_found', false)),
		).toBe('invalid')
		expect(
			checkoutErrorView(
				new PayApiError(409, 'online_payment_unavailable', false),
			),
		).toBe('unavailable')
		expect(checkoutErrorView(new PayApiError(429, 'x', false))).toBe('rate')
		expect(checkoutErrorView(new TypeError('Failed to fetch'))).toBe('network')
	})
})

describe('payment api', () => {
	it('posts opaque references only', async () => {
		const fetchImpl = vi.fn(async () =>
			Response.json({ checkoutUrl: 'https://x' }),
		)
		const api = createPaymentApi({
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		await api.checkout(
			{ kind: 'reservation', id: 'rsv_1' },
			{ token: 'tok-123456', purpose: 'deposit', locale: 'ar' },
		)
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		]
		expect(url).toBe('/api/reservations/payment')
		expect(JSON.parse(String(init.body))).toEqual({
			reservationId: 'rsv_1',
			paymentToken: 'tok-123456',
			purpose: 'deposit',
			locale: 'ar',
		})
	})
	it('throws with status, code and retryable on errors', async () => {
		const api = createPaymentApi({
			fetchImpl: (async () =>
				Response.json(
					{ error: 'hold_expired', retryable: false },
					{ status: 409 },
				)) as typeof fetch,
		})
		await expect(
			api.status(
				{ kind: 'fee', id: 'p' },
				{ token: 'tok-123456', purpose: 'fee' },
			),
		).rejects.toMatchObject({ status: 409, code: 'hold_expired' })
	})
})

describe('poller', () => {
	function timers() {
		const queue: Array<() => void> = []
		return {
			schedule: (fn: () => void) => {
				queue.push(fn)
				return queue.length
			},
			cancel: () => undefined,
			async tick() {
				const fn = queue.shift()
				fn?.()
				await Promise.resolve()
				await Promise.resolve()
			},
			size: () => queue.length,
		}
	}
	const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

	it('stops on 401, 403 and 404', async () => {
		for (const status of [401, 403, 404]) {
			const t = timers()
			const onError = vi.fn()
			const poller = createPoller({
				fetch: async () => {
					throw new PayApiError(status, 'x', false)
				},
				onResult: () => false,
				onError,
				schedule: t.schedule,
				cancel: t.cancel,
			})
			poller.start()
			await flush()
			expect(onError).toHaveBeenCalledWith(expect.anything(), true)
			expect(t.size()).toBe(0)
		}
	})

	it('backs off on transient errors and keeps trying', async () => {
		const t = timers()
		const delays: number[] = []
		let calls = 0
		const poller = createPoller({
			fetch: async () => {
				calls += 1
				throw new PayApiError(503, 'x', true)
			},
			onResult: () => false,
			delays: [10, 20, 40],
			schedule: (fn, ms) => {
				delays.push(ms)
				return t.schedule(fn)
			},
			cancel: t.cancel,
		})
		poller.start()
		await flush()
		await t.tick()
		await flush()
		expect(calls).toBe(2)
		expect(delays).toEqual([20, 40])
	})

	it('ignores an older answer that arrives after a newer request', async () => {
		const t = timers()
		const resolvers: Array<(value: string) => void> = []
		const seen: string[] = []
		const poller = createPoller<string>({
			fetch: () =>
				new Promise<string>((resolve) => {
					resolvers.push(resolve)
				}),
			onResult: (value) => {
				seen.push(value)
				return false
			},
			schedule: t.schedule,
			cancel: t.cancel,
		})
		poller.start()
		poller.pollNow()
		resolvers[1]!('new')
		await flush()
		resolvers[0]!('old')
		await flush()
		expect(seen).toEqual(['new'])
	})

	it('times out and reports it', async () => {
		let clock = 0
		const t = timers()
		const onTimeout = vi.fn()
		const poller = createPoller({
			fetch: async () => 'pending',
			onResult: () => false,
			onTimeout,
			maxMs: 1000,
			now: () => clock,
			schedule: t.schedule,
			cancel: t.cancel,
		})
		poller.start()
		await flush()
		clock = 2000
		await t.tick()
		await flush()
		expect(onTimeout).toHaveBeenCalledTimes(1)
	})
})

function page(
	overrides: Omit<Partial<PayPageDeps>, 'api'> & { api: Partial<PayApi> },
) {
	const root = document.createElement('div')
	document.body.append(root)
	const storage = memoryStorage()
	const replaceState = vi.fn()
	const redirect = vi.fn()
	const deps: PayPageDeps = {
		labels,
		locale: 'en',
		hash: '#r=rsv_1&t=tok-123456',
		search: '',
		done: false,
		pageLocation: {
			hash: '#r=rsv_1&t=tok-123456',
			pathname: '/reserve/pay',
			search: '',
		},
		history: { replaceState, state: null },
		storage,
		redirect,
		bookHref: '/reserve',
		manageHref: '/reserve/manage',
		pollDelays: [5],
		pollMaxMs: 60,
		...overrides,
		api: overrides.api as PayApi,
	}
	return { root, deps, storage, replaceState, redirect }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('pay page', () => {
	it('stores the token, strips the fragment and shows the pay button with the stored amount', async () => {
		const status = vi.fn(async () => ({
			paymentStatus: 'pending',
			reservationStatus: 'pending_payment',
			expiresAt: new Date(Date.now() + 600_000).toISOString(),
		}))
		const { root, deps, storage, replaceState } = page({ api: { status } })
		storePay(
			{ kind: 'reservation', id: 'rsv_1' },
			{
				token: 'old',
				amountMinor: 2500,
				currency: 'USD',
				purpose: 'deposit',
			},
			storage,
		)
		await initPayPage(root, deps)
		expect(readPay({ kind: 'reservation', id: 'rsv_1' }, storage)?.token).toBe(
			'tok-123456',
		)
		expect(replaceState).toHaveBeenCalledWith(null, '', '/reserve/pay')
		expect(root.querySelector('[data-action="pay"]')).not.toBeNull()
		expect(root.textContent).toContain('$25.00')
		expect(JSON.stringify(location.href)).not.toContain('tok-123456')
	})

	it('tries the next purpose after a purpose mismatch', async () => {
		const status = vi.fn(async (_ref, input: { purpose: string }) => {
			if (input.purpose !== 'prepay') {
				throw new PayApiError(409, 'purpose_mismatch', false)
			}
			return { paymentStatus: 'pending', reservationStatus: 'pending_payment' }
		})
		const { root, deps, storage } = page({
			api: { status: status as PayApi['status'] },
		})
		await initPayPage(root, deps)
		expect(
			status.mock.calls.map((c) => (c[1] as { purpose: string }).purpose),
		).toEqual(['deposit', 'prepay'])
		expect(
			readPay({ kind: 'reservation', id: 'rsv_1' }, storage)?.purpose,
		).toBe('prepay')
	})

	it('redirects to the hosted page on continue', async () => {
		const checkout = vi.fn(async () => ({
			checkoutUrl: 'https://pay.example/s/1',
		}))
		const { root, deps, redirect } = page({
			api: {
				status: async () => ({
					paymentStatus: 'pending',
					reservationStatus: 'pending_payment',
				}),
				checkout,
			},
		})
		await initPayPage(root, deps)
		root.querySelector<HTMLButtonElement>('[data-action="pay"]')!.click()
		await settle()
		expect(checkout).toHaveBeenCalledWith(
			{ kind: 'reservation', id: 'rsv_1' },
			expect.objectContaining({ token: 'tok-123456', purpose: 'deposit' }),
		)
		expect(redirect).toHaveBeenCalledWith('https://pay.example/s/1')
	})

	it('shows an unavailable message and re-enables the button when checkout is refused', async () => {
		const { root, deps, redirect } = page({
			api: {
				status: async () => ({
					paymentStatus: 'pending',
					reservationStatus: 'pending_payment',
				}),
				checkout: async () => {
					throw new PayApiError(409, 'online_payment_unavailable', false)
				},
			},
		})
		await initPayPage(root, deps)
		const button = root.querySelector<HTMLButtonElement>('[data-action="pay"]')!
		button.click()
		await settle()
		expect(redirect).not.toHaveBeenCalled()
		expect(root.textContent).toContain(labels.errorPaymentUnavailable)
		expect(button.disabled).toBe(false)
	})

	it('does not treat the provider return as paid until the status says so', async () => {
		let paid = false
		const status = vi.fn(async () => ({
			paymentStatus: paid ? 'paid' : 'pending',
			reservationStatus: paid ? 'booked' : 'pending_payment',
		}))
		const { root, deps } = page({
			api: { status },
			done: true,
			hash: '',
			search: '?r=rsv_1&purpose=deposit',
			pageLocation: {
				hash: '',
				pathname: '/reserve/pay/done',
				search: '?r=rsv_1&purpose=deposit',
			},
		})
		storePay(
			{ kind: 'reservation', id: 'rsv_1' },
			{ token: 'tok-123456', purpose: 'deposit' },
			deps.storage as never,
		)
		await initPayPage(root, deps)
		expect(root.querySelector('[data-state="paid"]')).toBeNull()
		expect(root.querySelector('[data-state="processing"]')).not.toBeNull()
		paid = true
		await new Promise((resolve) => setTimeout(resolve, 40))
		expect(root.querySelector('[data-state="paid"]')).not.toBeNull()
		expect(root.textContent).toContain(labels.paySuccessTitle)
	})

	it('shows the retry path for a failed fee and expiry for a dead booking', async () => {
		const failed = page({
			hash: '#f=pay_1&t=tok-123456',
			api: {
				status: async () => ({
					paymentStatus: 'fee_failed',
					reservationStatus: 'no_show',
				}),
			},
		} as never)
		await initPayPage(failed.root, failed.deps)
		expect(failed.root.textContent).toContain(labels.payFailedTitle)
		expect(failed.root.querySelector('[data-action="pay"]')?.textContent).toBe(
			labels.payTryAgain,
		)

		const dead = page({
			api: {
				status: async () => ({
					paymentStatus: 'none',
					reservationStatus: 'expired',
				}),
			},
		})
		await initPayPage(dead.root, dead.deps)
		expect(dead.root.querySelector('[data-state="expired"]')).not.toBeNull()
	})

	it('shows an invalid-link view without a token and on a 404', async () => {
		const noToken = page({ hash: '', api: { status: vi.fn() } })
		await initPayPage(noToken.root, noToken.deps)
		expect(noToken.root.textContent).toContain(labels.payInvalidTitle)
		const missing = page({
			api: {
				status: async () => {
					throw new PayApiError(404, 'payment_not_found', false)
				},
			},
		})
		await initPayPage(missing.root, missing.deps)
		expect(missing.root.textContent).toContain(labels.payInvalidTitle)
	})
})
