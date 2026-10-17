// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { makeWaitlistEntry } from '#app/utils/reservations/waitlist-fixtures.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import {
	FloorWaitlistPanel,
	WAITLIST_DRAG_TYPE,
	WaitlistOverbookPrompt,
} from './floor-waitlist-panel.tsx'
import { type FloorTableRef, useFloorWaitlist } from './use-floor-waitlist.ts'
import { createFakeWaitlistClient } from './waitlist-test-client.ts'

const T1: FloorTableRef = { id: 't1', label: 'T1' }
const T2: FloorTableRef = { id: 't2', label: 'T2' }

function Harness({
	client,
	selected = null,
}: {
	client: Parameters<typeof useFloorWaitlist>[0]['client']
	selected?: FloorTableRef | null
}) {
	const floor = useFloorWaitlist({ client, locationId: 'loc_1', enabled: true })
	const [outcome, setOutcome] = useState('')
	const drop = async (table: FloorTableRef, occupied: boolean, id: string) => {
		const result = await floor.dropOnTable(id, table, occupied)
		if (result) setOutcome(result.ok ? `seated:${table.label}` : result.message)
	}
	return (
		<div>
			<FloorWaitlistPanel
				entries={floor.waitlist.active}
				loading={floor.waitlist.loading}
				error={floor.waitlist.loadError}
				dragging={floor.draggingId !== null}
				busyId={floor.waitlist.busyId}
				selectedTable={selected}
				clockOffsetMs={floor.waitlist.clockOffsetMs}
				announcement={floor.waitlist.announcement}
				onDragStart={(entry) => floor.setDraggingId(entry.id)}
				onDragEnd={() => floor.setDraggingId(null)}
				onSeatAtSelected={(entry, table) => {
					void floor.seatAt(entry, table).then((result) => {
						setOutcome(result.ok ? `seated:${table.label}` : result.message)
					})
				}}
				onChooseTable={() => undefined}
			/>
			{[
				{ table: T1, occupied: false },
				{ table: T2, occupied: true },
			].map(({ table, occupied }) => (
				<div
					key={table.id}
					data-testid={`table-${table.id}`}
					onDragOver={(event) => event.preventDefault()}
					onDrop={(event) => {
						const id = event.dataTransfer.getData(WAITLIST_DRAG_TYPE)
						floor.setDraggingId(null)
						if (id) void drop(table, occupied, id)
					}}
				/>
			))}
			{floor.prompt ? (
				<WaitlistOverbookPrompt
					prompt={floor.prompt}
					busy={floor.waitlist.busyId !== null}
					onOverbook={(reason) =>
						void floor.resolveOverbook(reason).then((result) => {
							if (result?.ok) setOutcome(`seated:${result.table.label}`)
						})
					}
					onCancel={floor.cancelPrompt}
				/>
			) : null}
			<output data-testid="outcome">{outcome}</output>
		</div>
	)
}

const queue = () => [
	makeWaitlistEntry({ id: 'w1', displayName: 'Rana', partySize: 2 }),
	makeWaitlistEntry({
		id: 'w2',
		displayName: 'Omar',
		partySize: 4,
		position: 2,
		sortKey: 2,
	}),
]

const dropData = (id: string) => ({
	dataTransfer: {
		getData: (type: string) => (type === WAITLIST_DRAG_TYPE ? id : ''),
	},
})

describe('floor waitlist panel', () => {
	it('lists the queue, collapses, and carries the party id when dragged', async () => {
		const fake = createFakeWaitlistClient(queue())
		renderStaff(<Harness client={fake.client} />)
		const card = await screen.findByTestId('floor-waitlist-card-w1')
		expect(screen.getByTestId('floor-waitlist-count')).toHaveTextContent('2')
		expect(card).toHaveTextContent('#1 Rana (2)')

		const setData = vi.fn()
		fireEvent.dragStart(card, { dataTransfer: { setData, effectAllowed: '' } })
		expect(setData).toHaveBeenCalledWith(WAITLIST_DRAG_TYPE, 'w1')

		fireEvent.click(screen.getByTestId('floor-waitlist-toggle'))
		expect(screen.queryByTestId('floor-waitlist-card-w1')).toBeNull()
		expect(screen.getByTestId('floor-waitlist-toggle')).toHaveAttribute(
			'aria-expanded',
			'false',
		)
	})

	it('seats a party dropped on a free table', async () => {
		const fake = createFakeWaitlistClient(queue())
		renderStaff(<Harness client={fake.client} />)
		await screen.findByTestId('floor-waitlist-card-w1')
		fireEvent.drop(screen.getByTestId('table-t1'), dropData('w1'))

		await waitFor(() =>
			expect(screen.getByTestId('outcome')).toHaveTextContent('seated:T1'),
		)
		const [call] = fake.callsTo('/w1/seat')
		expect(call?.body).toEqual({ tableIds: ['t1'], expectedVersion: 1 })
		await waitFor(() =>
			expect(screen.queryByTestId('floor-waitlist-card-w1')).toBeNull(),
		)
	})

	it('seats at the selected table without dragging', async () => {
		const fake = createFakeWaitlistClient(queue())
		renderStaff(<Harness client={fake.client} selected={T1} />)
		fireEvent.click(
			await screen.findByTestId('floor-waitlist-seat-selected-w2'),
		)

		await waitFor(() =>
			expect(screen.getByTestId('outcome')).toHaveTextContent('seated:T1'),
		)
		expect(fake.callsTo('/w2/seat')[0]?.body).toMatchObject({
			tableIds: ['t1'],
		})
	})

	it('asks before seating over a table the floor shows as taken', async () => {
		const fake = createFakeWaitlistClient(queue())
		renderStaff(<Harness client={fake.client} />)
		await screen.findByTestId('floor-waitlist-card-w1')
		fireEvent.drop(screen.getByTestId('table-t2'), dropData('w1'))

		expect(
			await screen.findByTestId('floor-waitlist-overbook-prompt'),
		).toHaveTextContent('Table T2 is not free for this party')
		expect(fake.callsTo('/w1/seat')).toHaveLength(0)

		fireEvent.change(screen.getByTestId('floor-waitlist-overbook-reason'), {
			target: { value: 'VIP' },
		})
		fireEvent.click(screen.getByTestId('floor-waitlist-overbook-confirm'))

		await waitFor(() =>
			expect(screen.getByTestId('outcome')).toHaveTextContent('seated:T2'),
		)
		expect(fake.callsTo('/w1/seat')[0]?.body).toEqual({
			tableIds: ['t2'],
			expectedVersion: 1,
			overbook: true,
			overbookReason: 'VIP',
		})
		expect(screen.queryByTestId('floor-waitlist-overbook-prompt')).toBeNull()
	})

	it('opens the same prompt when the server refuses a table that looked free', async () => {
		const fake = createFakeWaitlistClient(queue(), { occupiedTableIds: ['t1'] })
		renderStaff(<Harness client={fake.client} />)
		await screen.findByTestId('floor-waitlist-card-w1')
		fireEvent.drop(screen.getByTestId('table-t1'), dropData('w1'))

		expect(
			await screen.findByTestId('floor-waitlist-overbook-prompt'),
		).toBeTruthy()
		expect(fake.callsTo('/w1/seat')).toHaveLength(1)

		fireEvent.click(screen.getByTestId('floor-waitlist-overbook-confirm'))
		await waitFor(() => expect(fake.callsTo('/w1/seat')).toHaveLength(2))
		expect(fake.callsTo('/w1/seat')[1]?.body).toMatchObject({
			overbook: true,
			overbookReason: 'Waitlist overbook',
		})
	})

	it('cancelling the prompt sends nothing', async () => {
		const fake = createFakeWaitlistClient(queue())
		renderStaff(<Harness client={fake.client} />)
		await screen.findByTestId('floor-waitlist-card-w1')
		fireEvent.drop(screen.getByTestId('table-t2'), dropData('w1'))
		fireEvent.click(await screen.findByTestId('floor-waitlist-overbook-cancel'))
		expect(screen.queryByTestId('floor-waitlist-overbook-prompt')).toBeNull()
		expect(fake.callsTo('/w1/seat')).toHaveLength(0)
	})

	it('shows an empty message when nobody is waiting', async () => {
		const fake = createFakeWaitlistClient([])
		renderStaff(<Harness client={fake.client} />)
		expect(await screen.findByTestId('floor-waitlist-empty')).toBeTruthy()
	})
})
