// @vitest-environment jsdom
import { screen } from '@testing-library/react'
import { Outlet, Route, Routes } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { DetailSheet } from '#app/components/reservations/detail-sheet.tsx'
import { ReservationsClientContext } from '#app/components/reservations/reservations-client-provider.tsx'
import { createScriptedClient } from '#app/components/reservations/scripted-test-client.ts'
import { type DayReservationView } from '#app/utils/reservations/book-api.ts'
import {
	type ReservationsClientPool,
	type ReservationsScopedClient,
} from '#app/utils/reservations/reservations-client.ts'
import { renderStaff } from '#tests/staff-render.tsx'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const reservation = {
	id: 'rsv_1',
	version: 2,
	locationId: 'loc_1',
	confirmationCode: 'ABC123',
	guestName: 'Ada Lovelace',
	partySize: 2,
	businessDate: '2026-10-16',
	localStartMin: 1140,
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
	paymentStatus: 'guaranteed',
	experienceId: null,
} as unknown as DayReservationView

const paymentList = {
	reservation: {
		id: 'rsv_1',
		version: 2,
		status: 'booked',
		paymentStatus: 'guaranteed',
		lateCancel: false,
	},
	policy: null,
	payments: [
		{
			id: 'pay_1',
			reservationId: 'rsv_1',
			kind: 'card_setup',
			status: 'succeeded',
			amountMinor: 0,
			currency: 'USD',
			cardBrand: 'visa',
			cardLast4: '4242',
			createdAt: 1,
			updatedAt: 1,
		},
	],
}

function harness(
	payments: { enabled: boolean; canAct: boolean } | undefined,
	paymentsStatus = 'guaranteed',
) {
	const scoped: string[] = []
	const detailClient = createScriptedClient(() => {
		throw new Error('offline')
	}).client
	const paymentsClient = createScriptedClient(() => paymentList).client
	const pool = {
		orgSlug: 'acme',
		forScope: (scope: string) => {
			scoped.push(scope)
			return paymentsClient
		},
		invalidateAll: vi.fn(),
	} as unknown as ReservationsClientPool
	renderStaff(
		<ReservationsClientContext.Provider value={pool}>
			<Routes>
				<Route
					element={<Outlet context={{ orgSlug: 'acme', nav: {}, payments }} />}
				>
					<Route
						index
						element={
							<DetailSheet
								reservationId="rsv_1"
								fallbackReservation={{
									...reservation,
									paymentStatus: paymentsStatus,
								}}
								onClose={vi.fn()}
								client={detailClient as ReservationsScopedClient}
								tables={[]}
								canManage
								onUpdated={vi.fn()}
							/>
						}
					/>
				</Route>
			</Routes>
		</ReservationsClientContext.Provider>,
	)
	return { scoped }
}

describe('DetailSheet payment panel', () => {
	it('reads the rows with a payments-scope client when payments are on', async () => {
		const { scoped } = harness({ enabled: true, canAct: false })
		expect(await screen.findAllByTestId('payment-row')).toHaveLength(1)
		expect(scoped).toContain('payments')
		expect(screen.queryByTestId('payment-refund')).toBeNull()
	})

	it('leaves the panel out when payments are off or the booking has no payment', async () => {
		const off = harness({ enabled: false, canAct: false })
		await screen.findByTestId('detail-guest-name')
		expect(screen.queryByTestId('payment-panel')).toBeNull()
		expect(off.scoped).toEqual([])
	})

	it('leaves the panel out for a booking with payment status none', async () => {
		harness({ enabled: true, canAct: true }, 'none')
		await screen.findByTestId('detail-guest-name')
		expect(screen.queryByTestId('payment-panel')).toBeNull()
		expect(screen.queryByTestId('payment-badge')).toBeNull()
	})
})
