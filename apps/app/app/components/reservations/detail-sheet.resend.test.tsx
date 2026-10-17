// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DetailSheet } from '#app/components/reservations/detail-sheet.tsx'
import { type DayReservationView } from '#app/utils/reservations/book-api.ts'
import {
	ReservationsApiError,
	type ReservationsScopedClient,
} from '#app/utils/reservations/reservations-client.ts'
import { renderStaff } from '#tests/staff-render.tsx'

const api = vi.hoisted(() => ({
	fetchReservationDetail: vi.fn(),
	resend: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}))

vi.mock('sonner', () => ({
	toast: { success: api.toastSuccess, error: api.toastError },
}))

vi.mock('#app/utils/reservations/book-api.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#app/utils/reservations/book-api.ts')>()
	return {
		...actual,
		fetchReservationDetail: api.fetchReservationDetail,
		resendReservationConfirmation: api.resend,
	}
})

function makeReservation(
	overrides: Partial<DayReservationView> = {},
): DayReservationView {
	return {
		id: 'rsv_1',
		version: 1,
		confirmationCode: 'ABC123',
		guestName: 'Ada Lovelace',
		guestPhone: '+15555550100',
		guestEmail: null,
		partySize: 2,
		businessDate: '2026-10-16',
		localStartMin: 19 * 60,
		hhmm: '19:00',
		endHhmm: '20:30',
		durationMin: 90,
		status: 'booked',
		channel: 'online',
		client: 'web',
		locked: false,
		assignedTableIds: [],
		assignedTableLabels: [],
		dietaryCodes: [],
		...overrides,
	} as unknown as DayReservationView
}

function renderSheet(
	reservation: DayReservationView,
	options: { canManage?: boolean; onUpdated?: () => void } = {},
) {
	renderStaff(
		<DetailSheet
			reservationId={reservation.id}
			fallbackReservation={reservation}
			onClose={vi.fn()}
			client={{} as ReservationsScopedClient}
			tables={[]}
			canManage={options.canManage ?? true}
			onUpdated={options.onUpdated ?? vi.fn()}
		/>,
	)
}

describe('DetailSheet resend', () => {
	beforeEach(() => {
		for (const fn of Object.values(api)) fn.mockReset()
		api.fetchReservationDetail.mockRejectedValue(new Error('offline'))
	})

	it('resends the confirmation without rotating the link', async () => {
		const updated = makeReservation({ version: 2 })
		api.resend.mockResolvedValue({
			queued: 1,
			rotated: false,
			reservation: updated,
		})
		const onUpdated = vi.fn()
		renderSheet(makeReservation(), { onUpdated })

		fireEvent.click(await screen.findByTestId('detail-resend-confirmation'))

		await waitFor(() =>
			expect(api.toastSuccess).toHaveBeenCalledWith('Confirmation sent'),
		)
		expect(api.resend).toHaveBeenCalledWith(expect.anything(), 'rsv_1', {
			rotate: false,
		})
		expect(onUpdated).toHaveBeenCalledWith(updated, [])
	})

	it('asks before rotating the manage link and then sends rotate: true', async () => {
		api.resend.mockResolvedValue({
			queued: 1,
			rotated: true,
			reservation: makeReservation({ version: 2 }),
		})
		renderSheet(makeReservation({ status: 'confirmed' }))

		fireEvent.click(await screen.findByTestId('detail-rotate-link'))
		const dialog = await screen.findByTestId('detail-rotate-dialog')
		expect(dialog.textContent).toMatch(/earlier message stops working/)
		expect(api.resend).not.toHaveBeenCalled()

		fireEvent.click(screen.getByTestId('detail-rotate-confirm'))

		await waitFor(() =>
			expect(api.toastSuccess).toHaveBeenCalledWith(
				'Confirmation sent with a new manage link',
			),
		)
		expect(api.resend).toHaveBeenCalledWith(expect.anything(), 'rsv_1', {
			rotate: true,
		})
	})

	it('does not rotate when the dialog is cancelled', async () => {
		renderSheet(makeReservation())
		fireEvent.click(await screen.findByTestId('detail-rotate-link'))
		await screen.findByTestId('detail-rotate-dialog')
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
		await waitFor(() =>
			expect(screen.queryByTestId('detail-rotate-dialog')).toBeNull(),
		)
		expect(api.resend).not.toHaveBeenCalled()
	})

	it('explains a refused resend and leaves the sheet usable', async () => {
		api.resend.mockRejectedValue(
			new ReservationsApiError('no_destination', 409, {
				error: 'no_destination',
			}),
		)
		renderSheet(makeReservation())
		const button = await screen.findByTestId('detail-resend-confirmation')
		fireEvent.click(button)

		await waitFor(() =>
			expect(api.toastError).toHaveBeenCalledWith(
				'The guest has no email address or opted-in phone number to send to.',
			),
		)
		expect(api.toastSuccess).not.toHaveBeenCalled()
		await waitFor(() =>
			expect((button as HTMLButtonElement).disabled).toBe(false),
		)
	})

	it('is disabled while a resend is in flight', async () => {
		let finish: (value: unknown) => void = () => {}
		api.resend.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve
			}),
		)
		renderSheet(makeReservation())
		const button = (await screen.findByTestId(
			'detail-resend-confirmation',
		)) as HTMLButtonElement
		fireEvent.click(button)
		await waitFor(() => expect(button.disabled).toBe(true))
		expect(
			(screen.getByTestId('detail-rotate-link') as HTMLButtonElement).disabled,
		).toBe(true)
		finish({ queued: 1, rotated: false, reservation: null })
		await waitFor(() => expect(button.disabled).toBe(false))
	})

	it.each([
		['a seated booking', { status: 'seated' }, true],
		['a cancelled booking', { status: 'cancelled' }, true],
		['a guest without contact details', { guestPhone: '' }, true],
		['an operator who cannot update', {}, false],
	])('offers no resend for %s', async (_name, overrides, canManage) => {
		renderSheet(makeReservation(overrides), { canManage })
		await screen.findByTestId('detail-facts')
		expect(screen.queryByTestId('detail-resend-confirmation')).toBeNull()
		expect(screen.queryByTestId('detail-rotate-link')).toBeNull()
	})

	it('offers resend for an email-only guest', async () => {
		renderSheet(
			makeReservation({ guestPhone: '', guestEmail: 'ada@example.com' }),
		)
		expect(await screen.findByTestId('detail-resend-confirmation')).toBeTruthy()
	})
})

describe('DetailSheet recorded client', () => {
	beforeEach(() => {
		api.fetchReservationDetail.mockReset()
		api.fetchReservationDetail.mockRejectedValue(new Error('offline'))
	})

	it.each([
		['web', 'Web'],
		['ios', 'iOS app'],
		['android', 'Android app'],
	])('shows %s next to the channel', async (client, label) => {
		renderSheet(makeReservation({ client, channel: 'native' }))
		expect((await screen.findByTestId('detail-client')).textContent).toBe(label)
		expect(screen.getByTestId('detail-channel').textContent).toBe('Mobile app')
	})

	it('shows an unknown client as received, as text', async () => {
		renderSheet(makeReservation({ client: '<b>kiosk</b>' }))
		const badge = await screen.findByTestId('detail-client')
		expect(badge.textContent).toBe('<b>kiosk</b>')
		expect(badge.querySelector('b')).toBeNull()
	})

	it('shows no client badge for host entries or when none was recorded', async () => {
		renderSheet(makeReservation({ client: 'operator', channel: 'host' }))
		await screen.findByTestId('detail-facts')
		expect(screen.queryByTestId('detail-client')).toBeNull()
	})
})
