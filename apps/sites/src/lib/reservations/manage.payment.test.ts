// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ReservationsApi } from './api.ts'
import { initManagePage } from './manage.ts'
import { testLabels } from './test-labels.ts'
import { type ManageView } from './types.ts'

const labels = testLabels()
afterEach(() => document.body.replaceChildren())

function view(extra: Partial<ManageView> = {}): ManageView {
	return {
		now: '2026-10-18T12:00:00.000Z',
		reservation: {
			id: 'rsv_1',
			confirmationCode: 'ABCD1234',
			status: 'booked',
			channel: 'web',
			locationId: 'loc_1',
			locationName: 'Main',
			date: '2026-11-07',
			localMin: 1200,
			time: '20:00',
			startAt: '2026-11-07T20:00:00.000Z',
			endAt: '2026-11-07T22:00:00.000Z',
			partySize: 2,
			timeZone: 'UTC',
			experience: {
				id: 'exp_1',
				slug: 'chefs-counter',
				name: "Chef's Counter",
			},
			firstName: 'Ada',
			occasion: null,
			requests: null,
			dietary: null,
			runningLateMin: null,
			location: {
				id: 'loc_1',
				name: 'Main',
				address: null,
				phone: null,
				timeZone: 'UTC',
			},
		},
		status: 'booked',
		firstName: 'Ada',
		contact: { phone: null, email: null },
		policy: {
			kind: 'prepay',
			terms: 'Prepaid tickets are refunded in full before the deadline.',
			freeCancelUntilMin: 2880,
			currency: 'USD',
		},
		paymentStatus: 'paid',
		canModify: false,
		canCancel: true,
		cancelDeadline: '2026-11-05T20:00:00.000Z',
		...extra,
	}
}

async function mount(api: Partial<ReservationsApi['manage']>) {
	const root = document.createElement('div')
	document.body.append(root)
	await initManagePage(root, {
		api: { manage: api, config: vi.fn() } as unknown as ReservationsApi,
		labels,
		locale: 'en',
		token: 'manage-token',
		bookHref: '/reserve',
	})
	return root
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('manage view for a prepaid experience booking', () => {
	it('shows the experience, payment status, terms and cancel deadline', async () => {
		const root = await mount({ view: vi.fn(async () => view()) })
		const text = root.textContent ?? ''
		expect(text).toContain("Chef's Counter")
		expect(
			root.querySelector('[data-payment-status="paid"]')?.textContent,
		).toContain(labels.payStatusPaid)
		expect(root.querySelector('[data-policy-terms]')?.textContent).toContain(
			'Prepaid tickets are refunded in full',
		)
		expect(text).toContain('Free cancellation up to 2 days')
		expect(text).toContain('Nov')
		expect(root.querySelector('[data-action="modify"]')).toBeNull()
	})

	it('explains the refund after a cancellation inside the free window', async () => {
		const cancel = vi.fn(async () =>
			view({
				status: 'cancelled',
				reservation: { ...view().reservation, status: 'cancelled' },
				paymentStatus: 'refund_pending',
				canCancel: false,
			}),
		)
		const root = await mount({ view: vi.fn(async () => view()), cancel })
		root.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.click()
		root
			.querySelector<HTMLButtonElement>('[data-action="cancel-confirm"]')!
			.click()
		await tick()
		expect(cancel).toHaveBeenCalledTimes(1)
		expect(
			root.querySelector('[data-refund-note="refund_pending"]')?.textContent,
		).toBe(labels.manageRefundPending)
	})

	it('shows nothing about payment for an unpaid regular booking', async () => {
		const base = view()
		const root = await mount({
			view: vi.fn(async () =>
				view({
					paymentStatus: 'none',
					policy: null,
					reservation: { ...base.reservation, experience: null },
				}),
			),
		})
		expect(root.querySelector('[data-payment-status]')).toBeNull()
		expect(root.querySelector('[data-policy-terms]')).toBeNull()
	})
})
