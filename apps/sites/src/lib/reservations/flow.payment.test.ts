// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReservationsApiError, type ReservationsApi } from './api.ts'
import { initReserveFlow, type FlowDeps } from './flow.ts'
import { type PayApi } from './pay.ts'
import { testLabels } from './test-labels.ts'
import {
	type Availability,
	type BookingResponse,
	type HoldPolicy,
	type PublicExperience,
	type ReservationsConfig,
} from './types.ts'

const labels = testLabels()

afterEach(() => {
	document.body.replaceChildren()
})

const config: ReservationsConfig = {
	organization: { name: 'Cafe', defaultLocale: 'en' },
	now: '2026-10-18T12:00:00.000Z',
	occasions: [],
	dietary: [],
	locations: [
		{
			id: 'loc_1',
			name: 'Main',
			address: null,
			timeZone: 'UTC',
			phone: null,
			partySize: { min: 1, max: 8 },
			horizonDays: 60,
			intervalMin: 15,
			holdMinutes: 7,
			largeParty: {
				mode: 'disabled',
				maxOnlinePartySize: 8,
				phone: null,
				note: null,
			},
			waitlist: { enabled: false, online: false },
			notifyMe: false,
			publicNote: null,
		},
	],
}

const availability = (extra: Partial<Availability> = {}): Availability => ({
	now: config.now,
	timeZone: 'UTC',
	locationId: 'loc_1',
	date: '2026-10-20',
	partySize: 2,
	status: 'available',
	slots: [
		{ localMin: 1140, time: '19:00', serviceId: 's1', serviceName: 'Dinner' },
	],
	alternatives: { sameDay: [], otherDates: [] },
	notifyMe: false,
	waitlist: false,
	...extra,
})

const policy: HoldPolicy = {
	kind: 'deposit',
	purpose: 'deposit',
	termsVersion: 4,
	terms: 'Terms text',
	amountMinor: 2500,
	totalAmountMinor: 5000,
	perCover: true,
	currency: 'USD',
	freeCancelUntilMin: 1440,
	lateCancelFeeMinor: 0,
	noShowFeeMinor: 0,
}

const booking = (status: string, withPayment: boolean): BookingResponse => ({
	reservation: {
		id: 'rsv_1',
		confirmationCode: 'ABCD1234',
		status,
		channel: 'web',
		locationId: 'loc_1',
		locationName: 'Main',
		date: '2026-10-20',
		localMin: 1140,
		time: '19:00',
		startAt: '',
		endAt: '',
		partySize: 2,
		timeZone: 'UTC',
	},
	manageToken: 'manage-1',
	...(withPayment
		? {
				payment: {
					paymentToken: 'pay-token-12345',
					purpose: 'deposit',
					amountMinor: 5000,
					currency: 'USD',
					expiresAt: new Date(Date.now() + 600_000).toISOString(),
					payUrl: null,
				},
			}
		: {}),
})

function fakeApi(overrides: Partial<Record<string, unknown>> = {}) {
	const api = {
		config: vi.fn(async () => config),
		availability: vi.fn(async () => availability()),
		createHold: vi.fn(async () => ({
			holdToken: 'hold-token-1',
			expiresAt: new Date(Date.now() + 420_000).toISOString(),
			now: new Date().toISOString(),
			locationId: 'loc_1',
			slot: {
				date: '2026-10-20',
				localMin: 1140,
				partySize: 2,
				serviceId: 's1',
			},
			requiresPayment: true,
			policy,
		})),
		book: vi.fn(async () => booking('pending_payment', true)),
		releaseHold: vi.fn(async () => ({ released: true })),
		currentHold: vi.fn(),
		experiences: vi.fn(),
		manage: { ics: vi.fn() },
		...overrides,
	}
	return api
}

async function start(
	api: ReturnType<typeof fakeApi>,
	extra: Partial<FlowDeps> = {},
) {
	const root = document.createElement('div')
	document.body.append(root)
	const payApi = {
		checkout: vi.fn(async () => ({ checkoutUrl: 'https://pay.example/c' })),
		status: vi.fn(),
	}
	const redirect = vi.fn()
	await initReserveFlow(root, {
		api: api as unknown as ReservationsApi,
		labels,
		locale: 'en',
		smsAllowed: false,
		turnstileSiteKey: '',
		orgName: 'Cafe',
		search: '?party=2&date=2026-10-20',
		hash: '',
		manageHref: (t) => `/reserve/manage#t=${t}`,
		loadPrefill: async () => null,
		signedIn: () => false,
		payApi: payApi as unknown as PayApi,
		redirect,
		bookHref: '/reserve',
		...extra,
	})
	return { root, payApi, redirect }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function reachDetails(root: HTMLElement) {
	root.querySelector<HTMLButtonElement>('[data-time="19:00"]')!.click()
	await tick()
}
function fillAndSubmit(root: HTMLElement) {
	root.querySelector<HTMLInputElement>('input[name="firstName"]')!.value = 'Ada'
	root.querySelector<HTMLInputElement>('input[name="phone"]')!.value =
		'+14155550123'
	root.querySelector('form#rsv-search')
	const forms = root.querySelectorAll('form')
	forms[forms.length - 1]!.dispatchEvent(
		new Event('submit', { cancelable: true }),
	)
}

describe('payment in the booking flow', () => {
	it('shows the policy panel and blocks submit until the terms are accepted', async () => {
		const api = fakeApi()
		const { root } = await start(api)
		await reachDetails(root)
		expect(root.querySelector('[data-policy-panel="deposit"]')).not.toBeNull()
		expect(root.textContent).toContain('$50.00')
		expect(root.textContent).toContain(labels.payContinue)
		fillAndSubmit(root)
		await tick()
		expect(api.book).not.toHaveBeenCalled()
		expect(root.textContent).toContain(labels.policyConsentRequired)
	})

	it('books with the policy terms version and shows the payment step, not a confirmation', async () => {
		const api = fakeApi()
		const { root, payApi, redirect } = await start(api)
		await reachDetails(root)
		root
			.querySelector<HTMLInputElement>('input[name="policyAccepted"]')!
			.click()
		fillAndSubmit(root)
		await tick()
		expect(api.book).toHaveBeenCalledTimes(1)
		const [body] = api.book.mock.calls[0] as unknown as [
			Record<string, unknown>,
		]
		expect(body.policyAccepted).toEqual({ termsVersion: '4' })
		expect(root.querySelector('[data-payment-step="deposit"]')).not.toBeNull()
		expect(root.querySelector('[data-confirmation-code]')).toBeNull()
		root.querySelector<HTMLButtonElement>('[data-action="pay"]')!.click()
		await tick()
		expect(payApi.checkout).toHaveBeenCalledTimes(1)
		expect(redirect).toHaveBeenCalledWith('https://pay.example/c')
	})

	it('keeps the idempotency key when a retry follows a network or 5xx error, even with a fresh human-check token', async () => {
		const book = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('Failed to fetch'))
			.mockRejectedValueOnce(new ReservationsApiError(503, 'unavailable', {}))
			.mockResolvedValueOnce(booking('booked', false))
		const api = fakeApi({ book })
		const { root } = await start(api)
		await reachDetails(root)
		root
			.querySelector<HTMLInputElement>('input[name="policyAccepted"]')!
			.click()
		for (let i = 0; i < 3; i++) {
			fillAndSubmit(root)
			await tick()
		}
		const keys = book.mock.calls.map((call) => call[1] as string)
		expect(keys).toHaveLength(3)
		expect(new Set(keys).size).toBe(1)
		expect(root.querySelector('[data-confirmation-code]')).not.toBeNull()
	})

	it('shows no policy panel and a normal confirmation when no payment is needed', async () => {
		const api = fakeApi({
			createHold: vi.fn(async () => ({
				holdToken: 'hold-token-1',
				expiresAt: new Date(Date.now() + 420_000).toISOString(),
				now: new Date().toISOString(),
				locationId: 'loc_1',
				slot: {
					date: '2026-10-20',
					localMin: 1140,
					partySize: 2,
					serviceId: 's1',
				},
			})),
			book: vi.fn(async () => booking('booked', false)),
		})
		const { root } = await start(api)
		await reachDetails(root)
		expect(root.querySelector('[data-policy-panel]')).toBeNull()
		fillAndSubmit(root)
		await tick()
		const [body] = api.book.mock.calls[0] as unknown as [
			Record<string, unknown>,
		]
		expect(body.policyAccepted).toBeUndefined()
		expect(root.querySelector('[data-confirmation-code]')).not.toBeNull()
	})
})

const experience: PublicExperience = {
	id: 'exp_1',
	slug: 'chefs-counter',
	locationId: 'loc_1',
	locationName: 'Main',
	kind: 'ticketed',
	name: "Chef's Counter",
	description: null,
	imageUrl: null,
	price: { priceMinor: 7500, perCover: true, currency: 'USD' },
	partyMin: 2,
	partyMax: 4,
	timeZone: 'UTC',
	seatings: [],
	policy: null,
}

describe('experience booking in the flow', () => {
	it('searches the experience, limits the party range and holds with the experience id', async () => {
		const api = fakeApi({
			experiences: vi.fn(async () => ({
				now: config.now,
				experiences: [experience],
			})),
			availability: vi.fn(async () =>
				availability({
					soldOut: [{ localMin: 1200, time: '20:00' }],
					experienceId: 'exp_1',
				}),
			),
			createHold: vi.fn(async () => ({
				holdToken: 'hold-token-1',
				expiresAt: new Date(Date.now() + 420_000).toISOString(),
				now: new Date().toISOString(),
				locationId: 'loc_1',
				slot: {
					date: '2026-10-20',
					localMin: 1140,
					partySize: 2,
					serviceId: 's1',
				},
				experienceId: 'exp_1',
			})),
		})
		const { root } = await start(api, {
			search: '?experience=exp_1&party=2&date=2026-10-20',
		})
		expect(root.textContent).toContain("Experience: Chef's Counter")
		expect((api.availability.mock.calls as unknown[][])[0]![0]).toMatchObject({
			experienceId: 'exp_1',
		})
		const options = [
			...root.querySelectorAll<HTMLOptionElement>('#rsv-party option'),
		].map((o) => o.value)
		expect(options).toEqual(['2', '3', '4'])
		const sold = root.querySelector(
			'[data-sold-out] button',
		) as HTMLButtonElement
		expect(sold.disabled).toBe(true)
		expect(sold.getAttribute('aria-label')).toContain('sold out')
		await reachDetails(root)
		expect((api.createHold.mock.calls as unknown[][])[0]![0]).toMatchObject({
			experienceId: 'exp_1',
		})
	})

	it('shows an unavailable card for an unknown experience', async () => {
		const api = fakeApi({
			experiences: vi.fn(async () => ({ now: config.now, experiences: [] })),
		})
		const { root } = await start(api, { search: '?experience=nope' })
		expect(root.querySelector('[data-unavailable="experience"]')).not.toBeNull()
		expect(api.availability).not.toHaveBeenCalled()
	})
})
