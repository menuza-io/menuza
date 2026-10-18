// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReservationsApiError, type ReservationsApi } from './api.ts'
import {
	initExperienceBooking,
	reserveHrefFor,
	type ExperienceBookingData,
} from './experience-booking.ts'
import { testLabels } from './test-labels.ts'
import { type Availability } from './types.ts'

const labels = testLabels()
const data: ExperienceBookingData = {
	id: 'exp_1',
	locationId: 'loc_1',
	partyMin: 2,
	partyMax: 4,
	dates: ['2026-11-07', '2026-11-14'],
}

afterEach(() => document.body.replaceChildren())

const availability = (extra: Partial<Availability> = {}): Availability => ({
	now: '2026-10-18T12:00:00.000Z',
	timeZone: 'UTC',
	locationId: 'loc_1',
	date: '2026-11-07',
	partySize: 2,
	status: 'available',
	slots: [
		{ localMin: 1200, time: '20:00', serviceId: 's', serviceName: 'Dinner' },
	],
	alternatives: { sameDay: [], otherDates: [] },
	notifyMe: false,
	waitlist: false,
	...extra,
})

async function mount(api: Partial<ReservationsApi>) {
	const root = document.createElement('div')
	document.body.append(root)
	const navigate = vi.fn()
	await initExperienceBooking(root, {
		api: api as ReservationsApi,
		labels,
		locale: 'en',
		data,
		reserveHref: '/reserve',
		navigate,
	})
	return { root, navigate }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('experience booking control', () => {
	it('offers the party range and the seating dates and loads times for the experience', async () => {
		const availabilityFn = vi.fn(async () =>
			availability({ soldOut: [{ localMin: 1290, time: '21:30' }] }),
		)
		const { root, navigate } = await mount({ availability: availabilityFn })
		expect(
			[...root.querySelectorAll<HTMLOptionElement>('#exp-party option')].map(
				(o) => o.value,
			),
		).toEqual(['2', '3', '4'])
		expect(
			[...root.querySelectorAll<HTMLOptionElement>('#exp-date option')].map(
				(o) => o.value,
			),
		).toEqual(data.dates)
		expect(availabilityFn).toHaveBeenCalledWith(
			expect.objectContaining({
				experienceId: 'exp_1',
				partySize: 2,
				date: '2026-11-07',
			}),
		)
		const sold = root.querySelector<HTMLButtonElement>('[data-sold-out]')!
		expect(sold.disabled).toBe(true)
		expect(sold.getAttribute('aria-label')).toBe('9:30 PM, sold out')
		root.querySelector<HTMLButtonElement>('[data-time="20:00"]')!.click()
		expect(navigate).toHaveBeenCalledWith(
			'/reserve?location=loc_1&experience=exp_1&party=2&date=2026-11-07&time=20%3A00',
		)
	})

	it('reloads for a new party size and ignores a stale answer', async () => {
		const resolvers: Array<(value: Availability) => void> = []
		const availabilityFn = vi.fn(
			() => new Promise<Availability>((resolve) => resolvers.push(resolve)),
		)
		const { root } = await (async () => {
			const root = document.createElement('div')
			document.body.append(root)
			void initExperienceBooking(root, {
				api: { availability: availabilityFn } as unknown as ReservationsApi,
				labels,
				locale: 'en',
				data,
				reserveHref: '/reserve',
				navigate: vi.fn(),
			})
			return { root }
		})()
		const party = root.querySelector<HTMLSelectElement>('#exp-party')!
		party.value = '3'
		party.dispatchEvent(new Event('change'))
		resolvers[1]!(
			availability({
				slots: [
					{ localMin: 1260, time: '21:00', serviceId: 's', serviceName: 'D' },
				],
			}),
		)
		await tick()
		resolvers[0]!(availability())
		await tick()
		expect(root.querySelector('[data-time="21:00"]')).not.toBeNull()
		expect(root.querySelector('[data-time="20:00"]')).toBeNull()
	})

	it('explains a fully empty day and API errors', async () => {
		const empty = await mount({
			availability: vi.fn(async () => availability({ slots: [] })),
		})
		expect(empty.root.textContent).toContain(labels.expNoTimes)
		const failing = await mount({
			availability: vi.fn(async () => {
				throw new ReservationsApiError(404, 'not_found', {})
			}),
		})
		expect(failing.root.querySelector('[role="alert"]')?.textContent).toBe(
			labels.errorNotFound,
		)
	})

	it('shows a message when there are no dates to book', async () => {
		const root = document.createElement('div')
		document.body.append(root)
		void initExperienceBooking(root, {
			api: {} as ReservationsApi,
			labels,
			locale: 'en',
			data: { ...data, dates: [] },
			reserveHref: '/reserve',
			navigate: vi.fn(),
		})
		expect(root.textContent).toContain(labels.expNoDates)
	})

	it('builds the reserve link with the experience, party, date and time', () => {
		expect(
			reserveHrefFor('/ar/reserve', data, {
				partySize: 4,
				date: '2026-11-14',
				localMin: 1230,
			}),
		).toBe(
			'/ar/reserve?location=loc_1&experience=exp_1&party=4&date=2026-11-14&time=20%3A30',
		)
	})
})
