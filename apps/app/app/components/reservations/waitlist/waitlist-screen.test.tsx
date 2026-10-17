// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type LiveTableState } from '#app/utils/reservations/book-api.ts'
import { makeWaitlistEntry } from '#app/utils/reservations/waitlist-fixtures.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { WaitlistScreen } from './waitlist-screen.tsx'
import { createFakeWaitlistClient } from './waitlist-test-client.ts'

const venue = vi.hoisted(() => ({
	tableStates: [] as unknown[],
	areas: [] as unknown[],
}))

vi.mock('#app/utils/reservations/book-api.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#app/utils/reservations/book-api.ts')>()
	return {
		...actual,
		fetchBookDayConditional: vi.fn(async () => ({
			status: 200,
			etag: null,
			data: { areas: venue.areas, tableStates: venue.tableStates },
		})),
	}
})

const table = (
	tableId: string,
	label: string,
	status: LiveTableState['status'] = 'open',
) =>
	({
		tableId,
		label,
		status,
		minCovers: 2,
		maxCovers: 4,
	}) as LiveTableState

function threeParties() {
	return [
		makeWaitlistEntry({ id: 'w1', displayName: 'Rana', partySize: 2 }),
		makeWaitlistEntry({
			id: 'w2',
			displayName: 'Omar',
			partySize: 4,
			quotedMin: 40,
			position: 2,
			sortKey: 2,
		}),
		makeWaitlistEntry({
			id: 'w3',
			displayName: 'Lina',
			partySize: 3,
			status: 'on_the_way',
			position: 3,
			sortKey: 3,
		}),
	]
}

function setup(
	options: {
		canManage?: boolean
		entries?: ReturnType<typeof threeParties>
		occupiedTableIds?: string[]
	} = {},
) {
	const fake = createFakeWaitlistClient(options.entries ?? threeParties(), {
		occupiedTableIds: options.occupiedTableIds,
	})
	renderStaff(
		<WaitlistScreen
			client={fake.client}
			locationId="loc_1"
			canManage={options.canManage ?? true}
		/>,
	)
	return fake
}

function queueOrder() {
	return within(screen.getByTestId('waitlist-queue'))
		.getAllByTestId(/^waitlist-card-/)
		.map((node) =>
			node.getAttribute('data-testid')!.replace('waitlist-card-', ''),
		)
}

describe('WaitlistScreen', () => {
	beforeEach(() => {
		venue.tableStates = [table('t1', 'T1'), table('t2', 'T2', 'seated')]
		venue.areas = [{ id: 'area_1', name: 'Patio' }]
	})

	it('shows the queue with position, quote, and wait so far', async () => {
		setup()
		await screen.findByTestId('waitlist-card-w1')
		expect(queueOrder()).toEqual(['w1', 'w2', 'w3'])
		await waitFor(() =>
			expect(screen.getByTestId('waitlist-quote-w2')).toHaveTextContent(
				'Quoted 40 min',
			),
		)
		expect(screen.getByTestId('waitlist-position-w2')).toHaveTextContent('#2')
		await waitFor(() =>
			expect(screen.getByTestId('waitlist-waited-w1')).toHaveTextContent(
				'Waiting 5 min',
			),
		)
		expect(screen.getByTestId('waitlist-status-w3')).toHaveTextContent(
			'On the way',
		)
		expect(screen.getByTestId('waitlist-count-active')).toHaveTextContent('3')
	})

	it('shows an empty state when nobody is waiting', async () => {
		setup({ entries: [] })
		expect(await screen.findByTestId('waitlist-empty')).toBeTruthy()
	})

	it('notifies with the entry version and counts down the answer window', async () => {
		const fake = setup()
		await screen.findByTestId('waitlist-card-w1')
		fireEvent.click(screen.getByTestId('waitlist-notify-w1'))

		const countdown = await screen.findByTestId('waitlist-countdown-w1')
		expect(countdown.textContent).toMatch(/Answer within (9:5\d|10:00)/)
		const [call] = fake.callsTo('/w1/notify')
		expect(call?.body).toEqual({ expectedVersion: 1 })
		expect(screen.getByTestId('waitlist-status-w1')).toHaveTextContent(
			'Notified',
		)
		await waitFor(() =>
			expect(
				screen
					.getAllByRole('status')
					.some((node) => /Notified Rana/.test(node.textContent ?? '')),
			).toBe(true),
		)
		expect(screen.queryByTestId('waitlist-notify-w1')).toBeNull()
	})

	it('seats a party at the chosen table', async () => {
		const fake = setup()
		await screen.findByTestId('waitlist-card-w2')
		fireEvent.click(screen.getByTestId('waitlist-seat-w2'))

		const select = await screen.findByTestId('waitlist-seat-table')
		await waitFor(() =>
			expect(within(select).getAllByRole('option').length).toBeGreaterThan(1),
		)
		fireEvent.change(select, { target: { value: 't1' } })
		fireEvent.click(screen.getByTestId('waitlist-seat-submit'))

		await waitFor(() => expect(fake.callsTo('/w2/seat')).toHaveLength(1))
		const [call] = fake.callsTo('/w2/seat')
		expect(call?.body).toEqual({ tableIds: ['t1'], expectedVersion: 1 })
		expect(call?.headers?.['Idempotency-Key']).toBeTruthy()
		await waitFor(() =>
			expect(screen.queryByTestId('waitlist-card-w2')).toBeNull(),
		)
		expect(screen.queryByTestId('waitlist-seat-dialog')).toBeNull()
	})

	it('offers to seat over a booking only after the table is refused', async () => {
		const fake = setup({ occupiedTableIds: ['t1'] })
		await screen.findByTestId('waitlist-card-w1')
		fireEvent.click(screen.getByTestId('waitlist-seat-w1'))
		const select = await screen.findByTestId('waitlist-seat-table')
		await waitFor(() =>
			expect(within(select).getAllByRole('option').length).toBeGreaterThan(1),
		)
		fireEvent.change(select, { target: { value: 't1' } })
		fireEvent.click(screen.getByTestId('waitlist-seat-submit'))

		expect(await screen.findByTestId('waitlist-seat-error')).toHaveTextContent(
			/taken/,
		)
		fireEvent.click(await screen.findByTestId('waitlist-seat-overbook-toggle'))
		fireEvent.change(screen.getByTestId('waitlist-seat-reason'), {
			target: { value: 'Regular guest' },
		})
		fireEvent.click(screen.getByTestId('waitlist-seat-submit'))

		await waitFor(() => expect(fake.callsTo('/w1/seat')).toHaveLength(2))
		expect(fake.callsTo('/w1/seat')[1]?.body).toMatchObject({
			tableIds: ['t1'],
			overbook: true,
			overbookReason: 'Regular guest',
		})
	})

	it('reorders with the Move buttons and keeps the order after a refresh', async () => {
		const fake = setup()
		await screen.findByTestId('waitlist-card-w1')
		fireEvent.click(screen.getByTestId('waitlist-move-down-w1'))

		await waitFor(() => expect(fake.callsTo('/reorder')).toHaveLength(1))
		expect(fake.callsTo('/reorder')[0]?.body).toEqual({
			locationId: 'loc_1',
			ids: ['w2', 'w1', 'w3'],
		})
		await waitFor(() => expect(queueOrder()).toEqual(['w2', 'w1', 'w3']))
		expect(
			screen
				.getAllByRole('status')
				.some((node) =>
					/Rana moved to position 2 of 3/.test(node.textContent ?? ''),
				),
		).toBe(true)

		fireEvent.click(screen.getByTestId('waitlist-refresh'))
		await waitFor(() =>
			expect(fake.client.requestConditional).toHaveBeenCalled(),
		)
		expect(queueOrder()).toEqual(['w2', 'w1', 'w3'])
		expect(screen.getByTestId('waitlist-position-w1')).toHaveTextContent('#2')
	})

	it('disables the edge Move buttons', async () => {
		setup()
		await screen.findByTestId('waitlist-card-w1')
		expect(screen.getByTestId('waitlist-move-up-w1')).toBeDisabled()
		expect(screen.getByTestId('waitlist-move-down-w3')).toBeDisabled()
		expect(screen.getByTestId('waitlist-move-up-w2')).toBeEnabled()
	})

	it('reloads and explains when another host changed the party first', async () => {
		const fake = setup()
		await screen.findByTestId('waitlist-card-w1')
		fake.mutate('w1', { status: 'on_the_way' })
		fireEvent.click(screen.getByTestId('waitlist-notify-w1'))

		const banner = await screen.findByTestId('waitlist-action-error')
		expect(banner).toHaveTextContent(/changed this party first/)
		await waitFor(() =>
			expect(screen.getByTestId('waitlist-status-w1')).toHaveTextContent(
				'On the way',
			),
		)
		expect(screen.queryByTestId('waitlist-countdown-w1')).toBeNull()
	})

	it('adds a party with a live quote and an Idempotency-Key', async () => {
		const fake = setup({ entries: [] })
		await screen.findByTestId('waitlist-empty')
		fireEvent.click(screen.getByTestId('waitlist-add-button'))

		fireEvent.change(await screen.findByTestId('waitlist-add-name'), {
			target: { value: 'Huda' },
		})
		fireEvent.click(screen.getByTestId('waitlist-add-size-4'))
		await waitFor(() =>
			expect(
				screen.getByTestId('waitlist-add-quote-minutes'),
			).toHaveTextContent('Quote this party 35 min'),
		)
		fireEvent.change(screen.getByTestId('waitlist-add-phone'), {
			target: { value: '+12125550123' },
		})
		fireEvent.click(screen.getByTestId('waitlist-add-sms-opt-in'))
		fireEvent.click(screen.getByTestId('waitlist-add-submit'))

		await waitFor(() => expect(fake.callsTo('waitlist')).toHaveLength(1))
		const [call] = fake.callsTo('waitlist')
		expect(call?.headers?.['Idempotency-Key']).toBeTruthy()
		expect(call?.body).toMatchObject({
			locationId: 'loc_1',
			displayName: 'Huda',
			partySize: 4,
			phone: '+12125550123',
			smsOptIn: true,
		})
		expect(await screen.findByTestId('waitlist-card-new_1')).toHaveTextContent(
			'Huda',
		)
		expect(screen.queryByTestId('waitlist-add-dialog')).toBeNull()
	})

	it('keeps the dialog open and explains a duplicate guest', async () => {
		const fake = setup({ entries: [] })
		await screen.findByTestId('waitlist-empty')
		fireEvent.click(screen.getByTestId('waitlist-add-button'))
		fireEvent.change(await screen.findByTestId('waitlist-add-name'), {
			target: { value: 'Huda' },
		})
		fake.failNext('waitlist', 409, { error: 'duplicate_active_entry' })
		fireEvent.click(screen.getByTestId('waitlist-add-submit'))

		expect(await screen.findByTestId('waitlist-add-error')).toHaveTextContent(
			/already on the waitlist/,
		)
		expect(screen.getByTestId('waitlist-add-dialog')).toBeTruthy()
		expect(
			(screen.getByTestId('waitlist-add-name') as HTMLInputElement).value,
		).toBe('Huda')
	})

	it('edits a party with its version', async () => {
		const fake = setup()
		await screen.findByTestId('waitlist-card-w1')
		fireEvent.click(screen.getByTestId('waitlist-edit-w1'))
		fireEvent.click(await screen.findByTestId('waitlist-edit-size-6'))
		fireEvent.click(screen.getByTestId('waitlist-edit-submit'))

		await waitFor(() => expect(fake.callsTo('/w1')).toHaveLength(1))
		expect(fake.callsTo('/w1')[0]?.body).toMatchObject({
			expectedVersion: 1,
			partySize: 6,
			displayName: 'Rana',
		})
		await waitFor(() =>
			expect(screen.getByTestId('waitlist-card-w1')).toHaveTextContent('(6)'),
		)
	})

	it('asks before removing a party and changes status on confirm', async () => {
		const fake = setup()
		await screen.findByTestId('waitlist-card-w1')
		fireEvent.click(screen.getByTestId('waitlist-action-cancelled-w1'))
		expect(fake.callsTo('/w1/status')).toHaveLength(0)
		fireEvent.click(screen.getByTestId('waitlist-confirm-yes-w1'))

		await waitFor(() => expect(fake.callsTo('/w1/status')).toHaveLength(1))
		expect(fake.callsTo('/w1/status')[0]?.body).toEqual({
			status: 'cancelled',
			expectedVersion: 1,
		})
		await waitFor(() =>
			expect(
				within(screen.getByTestId('waitlist-queue')).queryByTestId(
					'waitlist-card-w1',
				),
			).toBeNull(),
		)
		expect(screen.getByTestId('waitlist-settled-w1')).toBeTruthy()
	})

	it('puts a no-response party back in the queue', async () => {
		const fake = setup({
			entries: [
				makeWaitlistEntry({ id: 'w1', status: 'no_response', position: null }),
			],
		})
		fireEvent.click(await screen.findByTestId('waitlist-action-waiting-w1'))
		await waitFor(() => expect(fake.callsTo('/w1/status')).toHaveLength(1))
		expect(fake.callsTo('/w1/status')[0]?.body).toMatchObject({
			status: 'waiting',
		})
	})

	it('is read only without permission to edit', async () => {
		setup({ canManage: false })
		await screen.findByTestId('waitlist-card-w1')
		expect(screen.getByTestId('waitlist-read-only')).toBeTruthy()
		expect(screen.queryByTestId('waitlist-add-button')).toBeNull()
		expect(screen.queryByTestId('waitlist-notify-w1')).toBeNull()
		expect(screen.queryByTestId('waitlist-seat-w1')).toBeNull()
		expect(screen.queryByTestId('waitlist-move-down-w1')).toBeNull()
		expect(screen.queryByTestId('waitlist-drag-handle-w1')).toBeNull()
	})

	it('shows a retry when the first load fails', async () => {
		const fake = createFakeWaitlistClient([])
		fake.failNext('waitlist', 500, { error: 'boom' }, 'GET')
		renderStaff(
			<WaitlistScreen client={fake.client} locationId="loc_1" canManage />,
		)
		expect(await screen.findByTestId('waitlist-load-error')).toBeTruthy()
		fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
		expect(await screen.findByTestId('waitlist-empty')).toBeTruthy()
	})
})
