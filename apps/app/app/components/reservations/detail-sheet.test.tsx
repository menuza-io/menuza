// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DetailSheet } from '#app/components/reservations/detail-sheet.tsx'
import { type DayReservationView } from '#app/utils/reservations/book-api.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import { renderStaff } from '#tests/staff-render.tsx'

const fetchReservationDetail = vi.hoisted(() => vi.fn())

vi.mock('#app/utils/reservations/book-api.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#app/utils/reservations/book-api.ts')>()
	return { ...actual, fetchReservationDetail }
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
		locked: false,
		assignedTableIds: [],
		assignedTableLabels: [],
		serverLabel: null,
		courseStage: null,
		dietaryCodes: [],
		guestNotes: null,
		internalNotes: null,
		runningLateMin: null,
		contactStatus: null,
		...overrides,
	} as unknown as DayReservationView
}

function renderSheet(initial: DayReservationView) {
	let push: (next: DayReservationView) => void = () => {}
	function Harness() {
		const [reservation, setReservation] = useState(initial)
		push = setReservation
		return (
			<DetailSheet
				reservationId={reservation.id}
				fallbackReservation={reservation}
				onClose={vi.fn()}
				client={{} as ReservationsScopedClient}
				tables={[]}
				onUpdated={vi.fn()}
			/>
		)
	}
	renderStaff(<Harness />)
	return {
		rerenderWith(next: DayReservationView) {
			act(() => push(next))
		},
	}
}

describe('DetailSheet unsaved edits', () => {
	beforeEach(() => {
		fetchReservationDetail.mockReset()
		fetchReservationDetail.mockRejectedValue(new Error('offline'))
	})

	it('keeps edited notes, party size and time when the reservation prop refreshes', async () => {
		const view = renderSheet(makeReservation())

		const notes = await screen.findByTestId('detail-guest-notes-input')
		fireEvent.change(notes, { target: { value: 'Window seat please' } })
		fireEvent.change(screen.getByTestId('detail-party-size-input'), {
			target: { value: '6' },
		})
		fireEvent.change(screen.getByTestId('detail-time-input'), {
			target: { value: '20:15' },
		})

		view.rerenderWith(
			makeReservation({
				version: 2,
				guestNotes: 'Server-side note',
				partySize: 3,
				hhmm: '19:30',
				localStartMin: 19 * 60 + 30,
			}),
		)

		await waitFor(() =>
			expect(
				(screen.getByTestId('detail-guest-notes-input') as HTMLTextAreaElement)
					.value,
			).toBe('Window seat please'),
		)
		expect(
			(screen.getByTestId('detail-party-size-input') as HTMLInputElement).value,
		).toBe('6')
		expect(
			(screen.getByTestId('detail-time-input') as HTMLInputElement).value,
		).toBe('20:15')
	})

	it('applies refreshed values to fields the operator did not edit', async () => {
		const view = renderSheet(makeReservation())
		await screen.findByTestId('detail-guest-notes-input')

		view.rerenderWith(makeReservation({ version: 2, internalNotes: 'VIP' }))

		await waitFor(() =>
			expect(
				(
					screen.getByTestId(
						'detail-internal-notes-input',
					) as HTMLTextAreaElement
				).value,
			).toBe('VIP'),
		)
	})
})

describe('DetailSheet reminder status', () => {
	beforeEach(() => {
		fetchReservationDetail.mockReset()
		fetchReservationDetail.mockRejectedValue(new Error('offline'))
	})

	it('shows the stored contact status on the select', async () => {
		renderSheet(makeReservation({ contactStatus: 'left_message' }))

		const select = await screen.findByTestId('detail-contact-select')
		expect(select).toHaveTextContent('Left a message')
	})

	it('treats not_contacted as the unset option', async () => {
		renderSheet(makeReservation({ contactStatus: 'not_contacted' }))

		const select = await screen.findByTestId('detail-contact-select')
		expect(select).toHaveTextContent('Not reached yet')
	})
})

describe('DetailSheet late responses', () => {
	beforeEach(() => {
		fetchReservationDetail.mockReset()
	})

	it('ignores a detail response for a booking that is no longer open', async () => {
		let resolveFirst: (value: unknown) => void = () => {}
		fetchReservationDetail.mockImplementation((_client, id: string) =>
			id === 'rsv_1'
				? new Promise((resolve) => {
						resolveFirst = resolve
					})
				: Promise.resolve({
						reservation: makeReservation({
							id: 'rsv_2',
							guestName: 'Grace Hopper',
						}),
						guest: null,
						history: [],
						audit: [],
					}),
		)
		let setId: (id: string) => void = () => {}
		function Harness() {
			const [id, set] = useState('rsv_1')
			setId = set
			return (
				<DetailSheet
					reservationId={id}
					fallbackReservation={null}
					onClose={vi.fn()}
					client={{} as ReservationsScopedClient}
					tables={[]}
					onUpdated={vi.fn()}
				/>
			)
		}
		renderStaff(<Harness />)
		act(() => setId('rsv_2'))
		expect(await screen.findByText('Grace Hopper')).toBeTruthy()
		await act(async () => {
			resolveFirst({
				reservation: makeReservation({ guestName: 'Ada Lovelace' }),
				guest: null,
				history: [],
				audit: [],
			})
		})
		expect(screen.getByTestId('detail-guest-name')).toHaveTextContent(
			'Grace Hopper',
		)
	})
})

describe('DetailSheet above the fold', () => {
	beforeEach(() => {
		fetchReservationDetail.mockReset()
		fetchReservationDetail.mockRejectedValue(new Error('offline'))
	})

	it('puts allergies and notes first, in full, with one VIP chip and the next step beside the table', async () => {
		renderSheet(
			makeReservation({
				dietaryCodes: ['nut_allergy', 'shellfish_allergy', 'dairy_free'],
				dietaryNotes: 'No sesame at all',
				guest: { vipTier: 'vip' } as never,
			}),
		)
		const block = await screen.findByTestId('detail-allergy-block')
		expect(block).toHaveTextContent('Nut Allergy')
		expect(block).toHaveTextContent('Shellfish Allergy')
		expect(block).toHaveTextContent('Dairy-Free')
		expect(block).toHaveTextContent('No sesame at all')
		expect(screen.getAllByTestId('detail-vip-badge')).toHaveLength(1)
		expect(screen.getByTestId('detail-primary-action')).toHaveTextContent(
			'Mark arrived',
		)
	})

	it('omits the allergy block when there is nothing to flag', async () => {
		renderSheet(makeReservation())
		await screen.findByTestId('detail-primary-action')
		expect(screen.queryByTestId('detail-allergy-block')).toBeNull()
	})

	it('keeps overrides in Advanced and asks before allowing a double-booking', async () => {
		renderSheet(makeReservation())
		const toggle = await screen.findByTestId('detail-advanced-toggle')
		expect(toggle).toHaveAttribute('aria-expanded', 'false')
		fireEvent.click(screen.getByTestId('detail-force-overbook'))
		expect(await screen.findByTestId('detail-overbook-dialog')).toBeTruthy()
		expect(screen.getByTestId('detail-force-overbook')).not.toBeChecked()
		fireEvent.click(screen.getByTestId('detail-overbook-confirm'))
		await waitFor(() =>
			expect(screen.getByTestId('detail-force-overbook')).toBeChecked(),
		)
	})
})
