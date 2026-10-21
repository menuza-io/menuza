// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReservationsApiError, type ReservationsApi } from './api.ts'
import { WAITLIST_TOKEN_STORAGE_KEY } from './fragment.ts'
import { testLabels } from './test-labels.ts'
import { type ReservationLocation, type WaitlistStatus } from './types.ts'
import {
	buildJoinBody,
	initWaitlistPage,
	isActiveWaitlistState,
	joinResponseToStatus,
	validateJoin,
	waitlistStateCopy,
} from './waitlist-box.ts'

const labels = testLabels()

function status(overrides: Partial<WaitlistStatus> = {}): WaitlistStatus {
	return {
		status: 'waiting',
		position: 3,
		partySize: 4,
		quotedMin: 25,
		quotedReadyAt: '2030-05-01T19:25:00.000Z',
		locationName: 'Acme Downtown',
		notifiedAt: null,
		responseDeadlineAt: null,
		canLeave: true,
		canOnMyWay: true,
		now: '2030-05-01T19:00:00.000Z',
		...overrides,
	}
}

function location(
	overrides: Partial<ReservationLocation> = {},
): ReservationLocation {
	return {
		id: 'loc_1',
		name: 'Acme Downtown',
		address: null,
		timeZone: 'America/New_York',
		phone: null,
		partySize: { min: 2, max: 8 },
		horizonDays: 30,
		intervalMin: 15,
		holdMinutes: 5,
		largeParty: {
			mode: 'disabled',
			maxOnlinePartySize: 8,
			phone: null,
			note: null,
		},
		waitlist: { enabled: true, online: true },
		notifyMe: true,
		publicNote: null,
		...overrides,
	}
}

function memoryStorage() {
	const data = new Map<string, string>()
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
		removeItem: (key: string) => void data.delete(key),
	}
}

type ApiOverrides = {
	locations?: ReservationLocation[]
	join?: ReturnType<typeof vi.fn>
	statusFn?: ReturnType<typeof vi.fn>
	leave?: ReturnType<typeof vi.fn>
	onMyWay?: ReturnType<typeof vi.fn>
}

function setup(
	options: ApiOverrides & {
		hash?: string
		hidden?: () => boolean
		visitorZone?: string | null
	} = {},
) {
	const storage = memoryStorage()
	const join =
		options.join ??
		vi.fn(async () => ({
			entry: {
				id: 'wle_1',
				locationId: 'loc_1',
				locationName: 'Acme Downtown',
				status: 'waiting',
				position: 2,
				partySize: 4,
				quotedMin: 20,
				quotedReadyAt: '2030-05-01T19:20:00.000Z',
			},
			statusToken: 'rsv_w_token',
			now: '2030-05-01T19:00:00.000Z',
		}))
	const statusFn = options.statusFn ?? vi.fn(async () => status())
	const leave =
		options.leave ??
		vi.fn(async () =>
			status({ status: 'left', canLeave: false, canOnMyWay: false }),
		)
	const onMyWay =
		options.onMyWay ??
		vi.fn(async () =>
			status({ status: 'on_the_way', canOnMyWay: false, position: 1 }),
		)
	const api = {
		config: vi.fn(async () => ({
			organization: { name: 'Acme', defaultLocale: 'en' },
			locations: options.locations ?? [location()],
			occasions: [],
			dietary: [],
			now: '2030-05-01T19:00:00.000Z',
		})),
		waitlist: { join, status: statusFn, leave, onMyWay },
	} as unknown as ReservationsApi
	const replaceState = vi.fn()
	const root = document.createElement('div')
	document.body.append(root)
	const pageLocation = {
		hash: options.hash ?? '',
		pathname: '/reserve/waitlist',
		search: '',
	}
	return {
		root,
		api,
		join,
		statusFn,
		leave,
		onMyWay,
		storage,
		replaceState,
		pageLocation,
		start: () =>
			initWaitlistPage(root, {
				api,
				labels,
				locale: 'en',
				smsAllowed: true,
				turnstileSiteKey: '',
				orgName: 'Acme',
				search: '',
				pageLocation,
				history: { replaceState, state: null },
				bookHref: '/reserve',
				visitorZone: options.visitorZone ?? null,
				storage,
				pollMs: 15_000,
				isHidden: options.hidden ?? (() => false),
				newKey: (() => {
					let n = 0
					return () => `key-${++n}`
				})(),
			}),
	}
}

const flush = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve()
}

function q<T extends Element>(root: Element, selector: string) {
	return root.querySelector<T>(selector)!
}

function fillJoin(root: HTMLElement) {
	q<HTMLInputElement>(root, '[name=name]').value = 'Sam Guest'
	q<HTMLInputElement>(root, '[name=phone]').value = '+1 415 555 0123'
}

function submit(root: HTMLElement) {
	q<HTMLFormElement>(root, 'form').dispatchEvent(
		new Event('submit', { cancelable: true }),
	)
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
	document.body.replaceChildren()
})

describe('waitlist pure helpers', () => {
	it('needs a name and a plausible phone; email is optional but checked', () => {
		const base = {
			name: 'Sam',
			phone: '+1 415 555 0123',
			email: '',
			partySize: 2,
			areaId: '',
			smsOptIn: false,
		}
		expect(validateJoin(base)).toEqual({})
		expect(validateJoin({ ...base, name: ' ', phone: '' })).toEqual({
			name: 'required',
			phone: 'required',
		})
		expect(validateJoin({ ...base, phone: 'abc', email: 'x' })).toEqual({
			phone: 'invalid',
			email: 'invalid',
		})
	})

	it('builds a join body with nulls for the empty optional fields', () => {
		expect(
			buildJoinBody({
				name: ' Sam ',
				phone: ' +1 415 555 0123 ',
				email: '',
				partySize: 3,
				areaId: '',
				smsOptIn: true,
				locationId: 'loc_1',
				locale: 'ar',
				honeypot: '',
				turnstileToken: null,
			}),
		).toEqual({
			locationId: 'loc_1',
			name: 'Sam',
			partySize: 3,
			phone: '+1 415 555 0123',
			email: null,
			smsOptIn: true,
			areaId: null,
			locale: 'ar',
			website: '',
		})
	})

	it('sends the challenge token only when there is one', () => {
		const input = {
			name: 'Sam',
			phone: '+14155550123',
			email: '',
			partySize: 2,
			areaId: '',
			smsOptIn: false,
			locationId: 'loc_1',
			locale: 'en',
			honeypot: '',
		}
		expect(
			buildJoinBody({ ...input, turnstileToken: null }),
		).not.toHaveProperty('turnstileToken')
		expect(buildJoinBody({ ...input, turnstileToken: 'tok' })).toHaveProperty(
			'turnstileToken',
			'tok',
		)
	})

	it('names every entry state and treats only live ones as active', () => {
		for (const state of [
			'waiting',
			'notified',
			'on_the_way',
			'seated',
			'left',
			'cancelled',
			'no_response',
		]) {
			expect(waitlistStateCopy(labels, state).title).not.toBe('')
		}
		expect(waitlistStateCopy(labels, 'notified').title).toBe(
			'Your table is ready',
		)
		expect(isActiveWaitlistState('waiting')).toBe(true)
		expect(isActiveWaitlistState('no_response')).toBe(false)
	})

	it('turns a join answer into the status shape', () => {
		const result = joinResponseToStatus({
			entry: {
				id: 'wle_1',
				locationId: 'loc_1',
				locationName: 'A',
				status: 'waiting',
				position: 1,
				partySize: 2,
				quotedMin: 10,
				quotedReadyAt: null,
			},
			statusToken: 't',
			now: 'n',
		})
		expect(result).toMatchObject({
			status: 'waiting',
			position: 1,
			canLeave: true,
			canOnMyWay: true,
			now: 'n',
		})
	})
})

describe('waitlist page: join', () => {
	it('names the restaurant zone only when the visitor is in another one', async () => {
		const away = setup({ visitorZone: 'Asia/Riyadh' })
		await away.start()
		const note = q<HTMLElement>(away.root, '[data-zone-note]')
		expect(note.hidden).toBe(false)
		expect(note.textContent).toContain('America/New_York')

		document.body.replaceChildren()
		const home = setup({ visitorZone: 'America/New_York' })
		await home.start()
		expect(q<HTMLElement>(home.root, '[data-zone-note]').hidden).toBe(true)
	})

	it('refuses with the unavailable card when no location takes online joins', async () => {
		const ctx = setup({
			locations: [location({ waitlist: { enabled: true, online: false } })],
		})
		await ctx.start()
		expect(q(ctx.root, '[data-waitlist=unavailable]')).toBeTruthy()
		expect(ctx.root.querySelector('form')).toBeNull()
	})

	it('blocks an empty submit with inline errors and sends nothing', async () => {
		const ctx = setup()
		await ctx.start()
		submit(ctx.root)
		expect(ctx.join).not.toHaveBeenCalled()
		expect(q(ctx.root, '#rsv-waitlist-name-error').textContent).toBe(
			labels.fieldRequired,
		)
		expect(q(ctx.root, '#rsv-waitlist-phone-error').textContent).toBe(
			labels.fieldRequired,
		)
	})

	it('joins with an Idempotency-Key, shows the status view and puts the token in the fragment', async () => {
		const ctx = setup()
		await ctx.start()
		fillJoin(ctx.root)
		q<HTMLSelectElement>(ctx.root, '[name=partySize]').value = '4'
		submit(ctx.root)
		await flush()

		expect(ctx.join).toHaveBeenCalledTimes(1)
		const [body, key] = ctx.join.mock.calls[0]!
		expect(key).toBe('key-1')
		expect(body).toMatchObject({
			locationId: 'loc_1',
			name: 'Sam Guest',
			partySize: 4,
			phone: '+1 415 555 0123',
			email: null,
			website: '',
		})
		expect(ctx.replaceState).toHaveBeenCalledWith(
			null,
			'',
			'/reserve/waitlist#t=rsv_w_token',
		)
		expect(ctx.storage.getItem(WAITLIST_TOKEN_STORAGE_KEY)).toBe('rsv_w_token')
		const card = q(ctx.root, '[data-waitlist=status]')
		expect(card.getAttribute('data-state')).toBe('waiting')
		expect(q(card, '[data-position]').textContent).toBe('2')
		expect(q(card, '[data-quoted-wait]').textContent).toContain('20')
		expect(card.textContent).not.toContain('Sam')
		expect(card.textContent).not.toContain('415')
	})

	it('passes a filled honeypot through for the server to swallow', async () => {
		const ctx = setup()
		await ctx.start()
		fillJoin(ctx.root)
		q<HTMLInputElement>(ctx.root, '[name=website]').value = 'bot'
		submit(ctx.root)
		await flush()
		expect(ctx.join.mock.calls[0]![0]).toMatchObject({ website: 'bot' })
	})

	it('shows a clear message for a duplicate phone, a full list and rate limiting', async () => {
		const join = vi
			.fn()
			.mockRejectedValueOnce(
				new ReservationsApiError(409, 'already_on_waitlist', {}),
			)
			.mockRejectedValueOnce(new ReservationsApiError(409, 'waitlist_full', {}))
			.mockRejectedValueOnce(new ReservationsApiError(429, 'rate_limited', {}))
		const ctx = setup({ join })
		await ctx.start()
		fillJoin(ctx.root)
		const alert = () => q(ctx.root, '[role=alert]').textContent
		submit(ctx.root)
		await flush()
		expect(alert()).toBe(labels.errorWaitlistDuplicate)
		submit(ctx.root)
		await flush()
		expect(alert()).toBe(labels.errorWaitlistFull)
		submit(ctx.root)
		await flush()
		expect(alert()).toBe(labels.errorRateLimited)
	})

	it('marks the fields the server flagged as invalid', async () => {
		const join = vi.fn().mockRejectedValueOnce(
			new ReservationsApiError(400, 'invalid', {
				issues: [{ path: 'phone', code: 'invalid' }],
			}),
		)
		const ctx = setup({ join })
		await ctx.start()
		fillJoin(ctx.root)
		submit(ctx.root)
		await flush()
		expect(q(ctx.root, '#rsv-waitlist-phone-error').textContent).toBe(
			labels.phoneInvalid.replace('{example}', '\u2066+1 415 555 0123\u2069'),
		)
	})

	it('keeps the same key when the same join is retried after a network failure', async () => {
		const join = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('offline'))
			.mockResolvedValueOnce({
				entry: {
					id: 'w',
					locationId: 'loc_1',
					locationName: null,
					status: 'waiting',
					position: 1,
					partySize: 2,
					quotedMin: 5,
					quotedReadyAt: null,
				},
				statusToken: 'tok',
				now: '2030-05-01T19:00:00.000Z',
			})
		const ctx = setup({ join })
		await ctx.start()
		fillJoin(ctx.root)
		submit(ctx.root)
		await flush()
		submit(ctx.root)
		await flush()
		expect(join.mock.calls.map((call) => call[1])).toEqual(['key-1', 'key-1'])
	})
})

describe('waitlist page: status', () => {
	it('opens the status from the fragment token and sends it only in the header call', async () => {
		const ctx = setup({ hash: '#t=abc' })
		await ctx.start()
		expect(ctx.statusFn).toHaveBeenCalledWith('abc')
		expect(q(ctx.root, '[data-position]').textContent).toBe('3')
		expect(q(ctx.root, '[data-quoted-wait]').textContent).toBe(
			'About \u206625\u2069 min',
		)
		expect(ctx.root.querySelector('form')).toBeNull()
	})

	it('reloads from the token kept for the tab', async () => {
		const ctx = setup()
		ctx.storage.setItem(WAITLIST_TOKEN_STORAGE_KEY, 'kept')
		await ctx.start()
		expect(ctx.statusFn).toHaveBeenCalledWith('kept')
	})

	it('re-polls on the interval and updates the position', async () => {
		const statusFn = vi
			.fn()
			.mockResolvedValueOnce(status({ position: 3 }))
			.mockResolvedValueOnce(status({ position: 2 }))
		const ctx = setup({ hash: '#t=abc', statusFn })
		await ctx.start()
		expect(q(ctx.root, '[data-position]').textContent).toBe('3')
		await vi.advanceTimersByTimeAsync(15_000)
		expect(statusFn).toHaveBeenCalledTimes(2)
		expect(q(ctx.root, '[data-position]').textContent).toBe('2')
	})

	it('skips polling while the page is hidden and resumes when visible', async () => {
		let hidden = true
		const statusFn = vi.fn(async () => status())
		const ctx = setup({ hash: '#t=abc', statusFn, hidden: () => hidden })
		await ctx.start()
		await vi.advanceTimersByTimeAsync(30_000)
		expect(statusFn).toHaveBeenCalledTimes(1)
		hidden = false
		await vi.advanceTimersByTimeAsync(15_000)
		expect(statusFn).toHaveBeenCalledTimes(2)
	})

	it('does not poll once the entry is finished', async () => {
		const statusFn = vi.fn(async () =>
			status({ status: 'seated', canLeave: false, canOnMyWay: false }),
		)
		const ctx = setup({ hash: '#t=abc', statusFn })
		await ctx.start()
		await vi.advanceTimersByTimeAsync(60_000)
		expect(statusFn).toHaveBeenCalledTimes(1)
		expect(q(ctx.root, '[data-waitlist=status]').textContent).toContain(
			labels.waitlistStateSeated,
		)
		expect(ctx.root.querySelector('[data-action=leave]')).toBeNull()
	})

	it('shows "Your table is ready" with an on-my-way action and a deadline countdown', async () => {
		const statusFn = vi.fn(async () =>
			status({
				status: 'notified',
				position: null,
				quotedMin: null,
				notifiedAt: '2030-05-01T19:00:00.000Z',
				responseDeadlineAt: '2030-05-01T19:10:00.000Z',
			}),
		)
		const ctx = setup({ hash: '#t=abc', statusFn })
		vi.setSystemTime(new Date('2030-05-01T19:00:00.000Z'))
		await ctx.start()
		const card = q(ctx.root, '[data-waitlist=status]')
		expect(q(card, 'h2').textContent).toBe('Your table is ready')
		expect(q(card, '[data-state-body]').textContent).toContain('10:00')
		await vi.advanceTimersByTimeAsync(3000)
		expect(q(card, '[data-state-body]').textContent).toContain('9:57')
		expect(card.querySelector('[data-action=on-my-way]')).toBeTruthy()
	})

	it('sends "on my way" and shows the new state', async () => {
		const ctx = setup({ hash: '#t=abc' })
		await ctx.start()
		q<HTMLButtonElement>(ctx.root, '[data-action=on-my-way]').click()
		await flush()
		expect(ctx.onMyWay).toHaveBeenCalledWith('abc')
		expect(
			q(ctx.root, '[data-waitlist=status]').getAttribute('data-state'),
		).toBe('on_the_way')
		expect(ctx.root.querySelector('[data-action=on-my-way]')).toBeNull()
	})

	it('asks before leaving and then shows the left state', async () => {
		const ctx = setup({ hash: '#t=abc' })
		await ctx.start()
		q<HTMLButtonElement>(ctx.root, '[data-action=leave]').click()
		expect(ctx.leave).not.toHaveBeenCalled()
		q<HTMLButtonElement>(ctx.root, '[data-action=leave-keep]').click()
		expect(ctx.root.querySelector('[data-action=leave]')).toBeTruthy()

		q<HTMLButtonElement>(ctx.root, '[data-action=leave]').click()
		q<HTMLButtonElement>(ctx.root, '[data-action=leave-yes]').click()
		await flush()
		expect(ctx.leave).toHaveBeenCalledWith('abc')
		const card = q(ctx.root, '[data-waitlist=status]')
		expect(card.getAttribute('data-state')).toBe('left')
		expect(card.querySelector('[data-action=join-again]')).toBeTruthy()
	})

	it('forgets a token the server no longer knows and offers a fresh join', async () => {
		const statusFn = vi
			.fn()
			.mockRejectedValue(new ReservationsApiError(404, 'not_found', {}))
		const ctx = setup({ hash: '#t=abc', statusFn })
		ctx.storage.setItem(WAITLIST_TOKEN_STORAGE_KEY, 'abc')
		await ctx.start()
		expect(q(ctx.root, '[data-waitlist=link-invalid]').textContent).toContain(
			labels.errorWaitlistLinkInvalid,
		)
		expect(ctx.storage.getItem(WAITLIST_TOKEN_STORAGE_KEY)).toBeNull()
		expect(ctx.replaceState).toHaveBeenCalledWith(null, '', '/reserve/waitlist')
	})

	it('keeps the last status and shows a network error when a poll fails', async () => {
		const statusFn = vi
			.fn()
			.mockResolvedValueOnce(status())
			.mockRejectedValueOnce(new TypeError('offline'))
			.mockResolvedValueOnce(status({ position: 1 }))
		const ctx = setup({ hash: '#t=abc', statusFn })
		await ctx.start()
		await vi.advanceTimersByTimeAsync(15_000)
		expect(q(ctx.root, '[role=alert]').textContent).toBe(labels.errorNetwork)
		expect(q(ctx.root, '[data-position]').textContent).toBe('3')
		await vi.advanceTimersByTimeAsync(15_000)
		expect(q(ctx.root, '[data-position]').textContent).toBe('1')
		expect(ctx.root.querySelector('[role=alert]')).toBeNull()
	})
})
