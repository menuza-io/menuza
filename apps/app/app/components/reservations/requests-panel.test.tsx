// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	RequestsNotice,
	RequestsPanel,
} from '#app/components/reservations/requests-panel.tsx'
import { useReservationRequests } from '#app/components/reservations/use-reservation-requests.ts'
import { type DayReservationView } from '#app/utils/reservations/book-api.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import { renderStaff } from '#tests/staff-render.tsx'

const api = vi.hoisted(() => ({
	approve: vi.fn(),
	decline: vi.fn(),
}))

vi.mock('#app/utils/reservations/book-api.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#app/utils/reservations/book-api.ts')>()
	return {
		...actual,
		approveReservationRequest: api.approve,
		declineReservationRequest: api.decline,
	}
})

function makeRequest(id: string, status = 'pending_approval') {
	return {
		id,
		status,
		confirmationCode: `C${id}`,
		guestName: `Guest ${id}`,
		guestPhone: '+15555550100',
		partySize: 12,
		hhmm: '19:00',
		channel: 'online',
		guestNotes: 'Birthday dinner',
		internalNotes: null,
	} as unknown as DayReservationView
}

function Harness({ rows }: { rows: DayReservationView[] }) {
	const requests = useReservationRequests({
		client: {} as ReservationsScopedClient,
		locationId: 'loc_1',
		reservations: rows,
		onMutated: vi.fn(),
	})
	return (
		<RequestsPanel
			requests={requests.pending}
			decided={requests.decided}
			canManage
			busyId={requests.busyId}
			onApprove={requests.approve}
			onDecline={requests.decline}
			onOpenDetail={vi.fn()}
		/>
	)
}

describe('RequestsPanel', () => {
	beforeEach(() => {
		api.approve.mockReset()
		api.decline.mockReset()
	})

	it('lists pending requests and tracks an approval locally', async () => {
		api.approve.mockResolvedValue({ reservation: makeRequest('a', 'booked') })
		renderStaff(<Harness rows={[makeRequest('a'), makeRequest('b')]} />)

		expect(screen.getByTestId('request-row-a')).toBeTruthy()
		expect(screen.getByTestId('request-note-a').textContent).toBe(
			'Birthday dinner',
		)

		fireEvent.click(screen.getByTestId('request-approve-a'))
		expect(await screen.findByTestId('request-decided-a')).toBeTruthy()
		expect(api.approve).toHaveBeenCalledWith(expect.anything(), 'a', {
			locationId: 'loc_1',
		})
		expect(screen.queryByTestId('request-row-a')).toBeNull()
		expect(screen.getByTestId('request-row-b')).toBeTruthy()
	})

	it('declines with an optional reason', async () => {
		api.decline.mockResolvedValue({ reservation: makeRequest('a', 'declined') })
		renderStaff(<Harness rows={[makeRequest('a')]} />)

		fireEvent.click(screen.getByTestId('request-decline-a'))
		fireEvent.change(screen.getByTestId('request-decline-reason-a'), {
			target: { value: 'Fully booked' },
		})
		fireEvent.click(screen.getByTestId('request-decline-confirm-a'))

		expect(await screen.findByTestId('request-decided-a')).toBeTruthy()
		expect(api.decline).toHaveBeenCalledWith(expect.anything(), 'a', {
			locationId: 'loc_1',
			reason: 'Fully booked',
		})
		expect(screen.queryByTestId('request-row-a')).toBeNull()
	})

	it('keeps the request listed when the decision fails', async () => {
		api.approve.mockRejectedValue(new Error('invalid_status_transition'))
		renderStaff(<Harness rows={[makeRequest('a')]} />)

		fireEvent.click(screen.getByTestId('request-approve-a'))
		await waitFor(() => expect(api.approve).toHaveBeenCalled())
		expect(screen.getByTestId('request-row-a')).toBeTruthy()
		expect(screen.queryByTestId('request-decided-a')).toBeNull()
	})
})

describe('RequestsNotice', () => {
	it('shows only when something is pending and opens the requests view', () => {
		const onValueChange = vi.fn()
		const none = renderStaff(
			<RequestsNotice
				value="reservations"
				onValueChange={onValueChange}
				pendingCount={0}
			/>,
		)
		expect(screen.queryByTestId('requests-notice')).toBeNull()
		none.unmount()
		renderStaff(
			<RequestsNotice
				value="reservations"
				onValueChange={onValueChange}
				pendingCount={2}
			/>,
		)
		expect(screen.getByTestId('requests-pending-count').textContent).toBe(
			'2 requests need approval',
		)
		fireEvent.click(screen.getByTestId('requests-review-btn'))
		expect(onValueChange).toHaveBeenCalledWith('requests')
	})

	it('offers a way back from the requests view', () => {
		const onValueChange = vi.fn()
		renderStaff(
			<RequestsNotice
				value="requests"
				onValueChange={onValueChange}
				pendingCount={0}
			/>,
		)
		fireEvent.click(screen.getByTestId('requests-back-btn'))
		expect(onValueChange).toHaveBeenCalledWith('reservations')
	})
})
