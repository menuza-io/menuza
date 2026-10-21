// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReservationsApiError, type ReservationsApi } from './api.ts'
import {
	buildNotifyMeBody,
	createNotifyMeForm,
	defaultNotifyWindow,
	offersNotifyMe,
	offersWaitlist,
	validateNotifyMe,
} from './notify-me-form.ts'
import { testLabels } from './test-labels.ts'

const labels = testLabels()

afterEach(() => {
	document.body.replaceChildren()
})

describe('notify-me window', () => {
	it('defaults to dinner time without a searched time', () => {
		expect(defaultNotifyWindow(null)).toEqual({
			fromLocalMin: 1140,
			toLocalMin: 1260,
		})
	})

	it('centres on the searched time and stays within the day', () => {
		expect(defaultNotifyWindow(19 * 60 + 30)).toEqual({
			fromLocalMin: 1110,
			toLocalMin: 1230 + 60,
		})
		expect(defaultNotifyWindow(10)).toEqual({
			fromLocalMin: 0,
			toLocalMin: 130,
		})
		expect(defaultNotifyWindow(23 * 60).toLocalMin).toBe(23 * 60 + 59)
	})
})

describe('notify-me validation and body', () => {
	const base = {
		partySize: 2,
		date: '2030-05-01',
		from: '19:00',
		to: '21:00',
		phone: '',
		email: 'a@b.co',
	}

	it('needs a phone or an email', () => {
		expect(validateNotifyMe({ ...base, email: '' })).toEqual({
			contact: 'required',
		})
		expect(validateNotifyMe(base)).toEqual({})
		expect(
			validateNotifyMe({ ...base, email: '', phone: '+1 415 555 0123' }),
		).toEqual({})
	})

	it('flags malformed contacts and an inverted or empty window', () => {
		expect(validateNotifyMe({ ...base, phone: 'abc' }).phone).toBe('invalid')
		expect(validateNotifyMe({ ...base, email: 'nope' }).email).toBe('invalid')
		expect(validateNotifyMe({ ...base, to: '19:00' }).to).toBe('invalid')
		expect(validateNotifyMe({ ...base, from: '' }).from).toBe('required')
	})

	it('builds the request in restaurant-local minutes with nulls for empty contacts', () => {
		expect(
			buildNotifyMeBody({
				...base,
				locationId: 'loc_1',
				locale: 'ar',
				honeypot: '',
				turnstileToken: null,
			}),
		).toEqual({
			locationId: 'loc_1',
			date: '2030-05-01',
			partySize: 2,
			fromLocalMin: 1140,
			toLocalMin: 1260,
			phone: null,
			email: 'a@b.co',
			locale: 'ar',
			website: '',
		})
	})
})

function setup(
	overrides: Partial<ReservationsApi['notifyMe']> = {},
	zones: { timeZone?: string; visitorZone?: string | null } = {},
) {
	const create = vi.fn(async (..._args: unknown[]) => ({
		request: {},
		cancelToken: 'cancel-token',
		now: '',
	}))
	const cancel = vi.fn(async (_token: string) => ({ cancelled: true, now: '' }))
	const api = {
		notifyMe: { create, cancel, ...overrides },
	} as unknown as ReservationsApi
	const form = createNotifyMeForm({
		api,
		labels,
		locale: 'en',
		orgName: 'Acme',
		phoneExample: '+1 415 555 0123',
		turnstileSiteKey: '',
		locationId: 'loc_1',
		...zones,
		partySize: { min: 1, max: 8 },
		search: { partySize: 4, date: '2030-05-01', preferredMin: null },
		dateRange: { min: '2030-04-01', max: '2030-07-01' },
		newKey: (() => {
			let n = 0
			return () => `key-${++n}`
		})(),
	})
	document.body.append(form.element)
	const q = <T extends Element>(selector: string) =>
		form.element.querySelector<T>(selector)!
	return { create, cancel, form, q }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('notify-me form', () => {
	it('names the restaurant zone when the visitor is elsewhere', () => {
		const { q } = setup(
			{},
			{ timeZone: 'America/New_York', visitorZone: 'Asia/Riyadh' },
		)
		const note = q<HTMLElement>('[data-zone-note]')
		expect(note.hidden).toBe(false)
		expect(note.textContent).toContain('America/New_York')
	})

	it('hides the zone note when the zones match', () => {
		const { q } = setup(
			{},
			{ timeZone: 'America/New_York', visitorZone: 'America/New_York' },
		)
		expect(q<HTMLElement>('[data-zone-note]').hidden).toBe(true)
	})

	it('prefills the search and the default window', () => {
		const { q } = setup()
		expect(q<HTMLSelectElement>('[name=partySize]').value).toBe('4')
		expect(q<HTMLInputElement>('[name=date]').value).toBe('2030-05-01')
		expect(q<HTMLInputElement>('[name=from]').value).toBe('19:00')
		expect(q<HTMLInputElement>('[name=to]').value).toBe('21:00')
	})

	it('shows an inline error and sends nothing without a contact', async () => {
		const { create, q } = setup()
		q<HTMLFormElement>('form').dispatchEvent(
			new Event('submit', { cancelable: true }),
		)
		await flush()
		expect(create).not.toHaveBeenCalled()
		expect(q('#rsv-notify-contact-error').hasAttribute('hidden')).toBe(false)
		expect(q('#rsv-notify-contact-error').textContent).toBe(
			labels.notifyContactRequired,
		)
	})

	it('posts the request with an Idempotency-Key and confirms with a cancel button', async () => {
		const { create, cancel, q, form } = setup()
		q<HTMLInputElement>('[name=email]').value = 'guest@example.com'
		q<HTMLFormElement>('form').dispatchEvent(
			new Event('submit', { cancelable: true }),
		)
		await flush()
		expect(create).toHaveBeenCalledTimes(1)
		const [body, key] = create.mock.calls[0]!
		expect(key).toBe('key-1')
		expect(body).toMatchObject({
			locationId: 'loc_1',
			partySize: 4,
			fromLocalMin: 1140,
			toLocalMin: 1260,
			email: 'guest@example.com',
			phone: null,
			website: '',
		})
		expect(form.element.textContent).toContain(labels.notifyDoneTitle)

		const button = [...form.element.querySelectorAll('button')].find(
			(b) => b.textContent === labels.notifyCancel,
		)!
		button.click()
		await flush()
		expect(cancel).toHaveBeenCalledWith('cancel-token')
		expect(form.element.textContent).toContain(labels.notifyCancelled)
	})

	it('sends a filled honeypot so the server can drop it', async () => {
		const { create, q } = setup()
		q<HTMLInputElement>('[name=email]').value = 'guest@example.com'
		q<HTMLInputElement>('[name=website]').value = 'spam'
		q<HTMLFormElement>('form').dispatchEvent(
			new Event('submit', { cancelable: true }),
		)
		await flush()
		expect(create.mock.calls[0]![0]).toMatchObject({ website: 'spam' })
	})

	it('reuses the key when the same request is retried after a failure', async () => {
		const create = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('offline'))
			.mockResolvedValueOnce({ request: {}, cancelToken: 't', now: '' })
		const { q } = setup({ create })
		q<HTMLInputElement>('[name=email]').value = 'guest@example.com'
		const submit = () =>
			q<HTMLFormElement>('form').dispatchEvent(
				new Event('submit', { cancelable: true }),
			)
		submit()
		await flush()
		expect(q('[role=alert]').textContent).toBe(labels.errorNetwork)
		submit()
		await flush()
		expect(create.mock.calls.map((call) => call[1])).toEqual(['key-1', 'key-1'])
	})

	it('explains the per-contact limit and a closed feature', async () => {
		const create = vi
			.fn()
			.mockRejectedValueOnce(
				new ReservationsApiError(409, 'too_many_active_requests', {}),
			)
			.mockRejectedValueOnce(new ReservationsApiError(404, 'not_found', {}))
		const { q } = setup({ create })
		q<HTMLInputElement>('[name=email]').value = 'guest@example.com'
		const submit = () =>
			q<HTMLFormElement>('form').dispatchEvent(
				new Event('submit', { cancelable: true }),
			)
		submit()
		await flush()
		expect(q('[role=alert]').textContent).toBe(labels.errorNotifyLimit)
		submit()
		await flush()
		expect(q('[role=alert]').textContent).toBe(labels.errorNotifyClosed)
	})

	it('keeps the cancel token out of the page address', async () => {
		const { q } = setup()
		q<HTMLInputElement>('[name=email]').value = 'guest@example.com'
		q<HTMLFormElement>('form').dispatchEvent(
			new Event('submit', { cancelable: true }),
		)
		await flush()
		expect(document.body.innerHTML).not.toContain('cancel-token')
	})
})

describe('when the empty-state offers appear', () => {
	const base = {
		now: '2030-05-01T20:00:00.000Z',
		timeZone: 'America/New_York',
		locationId: 'loc_1',
		date: '2030-05-01',
		partySize: 2,
		status: 'full',
		slots: [],
		alternatives: { sameDay: [], otherDates: [] },
		notifyMe: true,
		waitlist: true,
	}

	it('offers notify-me when nothing fits and the flag is on', () => {
		expect(offersNotifyMe(base)).toBe(true)
		expect(offersNotifyMe({ ...base, notifyMe: false })).toBe(false)
		expect(
			offersNotifyMe({
				...base,
				slots: [
					{ localMin: 1140, time: '19:00', serviceId: 's', serviceName: '' },
				],
			}),
		).toBe(false)
	})

	it('never offers either when the day is closed, beyond the horizon or a large party', () => {
		for (const status of [
			'closed',
			'online_closed',
			'beyond_horizon',
			'large_party',
		]) {
			expect(offersNotifyMe({ ...base, status })).toBe(false)
			expect(offersWaitlist({ ...base, status })).toBe(false)
		}
	})

	it('offers the waitlist only for the restaurant-local today', () => {
		expect(offersWaitlist(base)).toBe(true)
		expect(offersWaitlist({ ...base, date: '2030-05-02' })).toBe(false)
		expect(offersWaitlist({ ...base, waitlist: false })).toBe(false)
		// 03:00 UTC on the 2nd is still the 1st in New York.
		expect(offersWaitlist({ ...base, now: '2030-05-02T03:00:00.000Z' })).toBe(
			true,
		)
	})
})
