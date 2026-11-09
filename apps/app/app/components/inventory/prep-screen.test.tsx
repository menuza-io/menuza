// @vitest-environment jsdom
import { type PrepPlan, type PrepTask } from '@repo/inventory'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { renderInventory, sentJson } from '#tests/inventory-render.tsx'
import { PrepScreen } from './prep-screen.tsx'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

beforeEach(() => {
	vi.clearAllMocks()
})

const sauce = (over: Partial<PrepTask> = {}): PrepTask => ({
	id: 't1',
	itemId: 'i1',
	itemName: 'Garlic sauce',
	baseUnit: 'ml',
	countUnit: 'l',
	units: [],
	stationId: null,
	businessDate: '2026-11-09',
	plannedQuantity: 8_000_000,
	batchSize: 4_000_000,
	batches: 2,
	explain: {
		fillUpTo: 6_000_000,
		target: 7_200_000,
		onHand: 2_000_000,
		demandBp: 12_000,
	},
	status: 'todo',
	startedAt: null,
	doneAt: null,
	madeQuantity: null,
	version: 1,
	...over,
})

const plan = (over: Partial<PrepPlan> = {}): PrepPlan => ({
	locationId: 'main',
	date: '2026-11-09',
	stations: [{ id: 'kitchen', name: 'Kitchen' }],
	demand: { bp: 12_000, known: true, ramadan: false, samples: 4 },
	generated: true,
	canGenerate: true,
	tasks: [sauce()],
	...over,
})

function region(answer: PrepPlan | (() => PrepPlan)) {
	return vi.fn<InventoryClient['request']>(async (path) => {
		if (path.startsWith('/prep?')) {
			return typeof answer === 'function' ? answer() : answer
		}
		if (path.startsWith('/prep/tasks/') && path.endsWith('/start')) {
			return sauce({ status: 'in_progress', version: 2 })
		}
		if (path.startsWith('/prep/tasks/') && path.endsWith('/done')) {
			return sauce({
				status: 'done',
				madeQuantity: 8_000_000,
				doneAt: 1,
				version: 3,
			})
		}
		if (path.startsWith('/prep/tasks/') && path.endsWith('/skip')) {
			return sauce({ status: 'skipped', version: 2 })
		}
		return {}
	})
}

const draw = (
	request: InventoryClient['request'],
	props: Partial<React.ComponentProps<typeof PrepScreen>> = {},
) =>
	renderInventory(
		<PrepScreen
			locationId="main"
			canEdit
			view="list"
			onViewChange={() => {}}
			{...props}
		/>,
		{ request },
	)

describe('PrepScreen', () => {
	it('lists what to make with the numbers behind it', async () => {
		draw(region(plan()))
		const row = await screen.findByTestId('prep-task-t1')
		expect(row).toHaveTextContent('Garlic sauce')
		expect(within(row).getByTestId('prep-amount')).toHaveTextContent(
			'8 L · 2 batches',
		)
		expect(within(row).getByTestId('prep-explain')).toHaveTextContent(
			'Fill up to 7.2 L · have 2 L · sells 20% more today',
		)
		expect(screen.getByTestId('prep-demand')).toHaveTextContent(
			'This day usually sells 20% more, so the plan makes a little extra.',
		)
	})

	it('starts a task and sends the version it read', async () => {
		const request = region(plan())
		draw(request)
		fireEvent.click(await screen.findByTestId('prep-start-t1'))
		await waitFor(() =>
			expect(request).toHaveBeenCalledWith('/prep/tasks/t1/start', {
				method: 'POST',
				body: JSON.stringify({ expectedVersion: 1 }),
			}),
		)
	})

	it('closes a task with the plan filled in, as a batch count', async () => {
		const request = region(plan())
		draw(request)
		fireEvent.click(await screen.findByTestId('prep-done-t1'))
		const dialog = await screen.findByTestId('record-batch-dialog')
		expect(dialog).toHaveTextContent('How much did you make?')
		// Two batches are already filled in.
		expect(within(dialog).getByTestId('record-batch-count')).toHaveValue('2')
		fireEvent.click(within(dialog).getByTestId('record-batch-submit'))
		await waitFor(() =>
			expect(
				request.mock.calls.some(([path]) => path === '/prep/tasks/t1/done'),
			).toBe(true),
		)
		const index = request.mock.calls.findIndex(
			([path]) => path === '/prep/tasks/t1/done',
		)
		expect(sentJson(request, index)).toMatchObject({
			expectedVersion: 1,
			made: { kind: 'batches', count: 2 },
		})
	})

	it('skips a task', async () => {
		const request = region(plan())
		draw(request)
		fireEvent.click(await screen.findByTestId('prep-skip-t1'))
		await waitFor(() =>
			expect(request).toHaveBeenCalledWith('/prep/tasks/t1/skip', {
				method: 'POST',
				body: JSON.stringify({ expectedVersion: 1 }),
			}),
		)
	})

	it('shows the board with a lane for each state', async () => {
		draw(
			region(
				plan({
					tasks: [
						sauce(),
						sauce({ id: 't2', itemName: 'Dough', status: 'in_progress' }),
						sauce({ id: 't3', itemName: 'Pickles', status: 'done' }),
					],
				}),
			),
			{ view: 'board' },
		)
		const board = await screen.findByTestId('prep-board')
		expect(
			within(within(board).getByTestId('prep-lane-todo')).getByText(
				'Garlic sauce',
			),
		).toBeInTheDocument()
		expect(
			within(within(board).getByTestId('prep-lane-in-progress')).getByText(
				'Dough',
			),
		).toBeInTheDocument()
		expect(
			within(within(board).getByTestId('prep-lane-done')).getByText('Pickles'),
		).toBeInTheDocument()
	})

	it('offers nothing to change to someone who can only read', async () => {
		draw(region(plan()), { canEdit: false })
		await screen.findByTestId('prep-task-t1')
		expect(screen.queryByTestId('prep-start-t1')).toBeNull()
		expect(screen.queryByTestId('prep-done-t1')).toBeNull()
		expect(screen.queryByTestId('prep-refresh')).toBeNull()
	})

	it('plans the day on opening when nobody has, once', async () => {
		let planned = false
		const request = vi.fn<InventoryClient['request']>(async (path) => {
			if (path === '/prep/generate') {
				planned = true
				return {}
			}
			return planned ? plan() : plan({ generated: false, tasks: [] })
		})
		draw(request)
		await screen.findByTestId('prep-task-t1')
		expect(
			request.mock.calls.filter(([path]) => path === '/prep/generate'),
		).toHaveLength(1)
	})

	it('says what to do first when no made item has a level', async () => {
		draw(region(plan({ canGenerate: false, generated: false, tasks: [] })))
		expect(
			await screen.findByText('Say how much of each made item to keep.'),
		).toBeInTheDocument()
	})

	it('says so when nothing needs making', async () => {
		draw(region(plan({ tasks: [] })))
		expect(await screen.findByText('Nothing to make.')).toBeInTheDocument()
	})

	it('shows an error with a way to try again', async () => {
		const request = vi.fn<InventoryClient['request']>(async () => {
			throw new OperatorRequestError('boom', 'internal_error', 500)
		})
		draw(request)
		expect(await screen.findByTestId('prep-error')).toBeInTheDocument()
	})
})
