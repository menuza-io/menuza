// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { queueStorageKey } from '#app/utils/inventory/count-queue.ts'
import { renderInventory, sentJson } from '#tests/inventory-render.tsx'
import { CountingScreen } from './counting-screen.tsx'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

beforeEach(() => {
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	window.localStorage.clear()
	toast.success.mockReset()
	toast.error.mockReset()
})

afterEach(() => {
	vi.unstubAllGlobals()
})

const COUNT = {
	id: 'cnt_1',
	locationId: 'main',
	listId: null,
	listName: 'Weekly count',
	status: 'counting',
	businessDate: '2026-11-08',
	startedBy: { kind: 'operator', id: 'u1' },
	itemTotal: 2,
	itemsCounted: 0,
	counters: [],
	sentForReviewAt: null,
	approvedAt: null,
	approvedBy: null,
	cancelledAt: null,
	createdAt: 1,
	version: 3,
}

function sheetItem(
	itemId: string,
	name: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		itemId,
		name,
		baseUnit: 'g',
		countUnit: 'kg',
		units: [],
		quantity: null,
		mine: null,
		...overrides,
	}
}

function sheet(
	overrides: {
		status?: string
		areas?: unknown
	} = {},
) {
	return {
		count: { ...COUNT, status: overrides.status ?? 'counting' },
		areas: overrides.areas ?? [
			{
				areaId: 'a1',
				name: 'Walk-in',
				items: [
					sheetItem('i1', 'Chicken thighs'),
					sheetItem('i2', 'Garlic sauce'),
				],
			},
		],
	}
}

type Handlers = {
	sheet?: () => unknown
	entries?: (body: { entries: Array<{ clientId: string }> }) => unknown
	send?: () => unknown
}

function region(handlers: Handlers = {}) {
	return vi.fn<InventoryClient['request']>(async (path, init) => {
		if (path === '/counts/cnt_1') return handlers.sheet?.() ?? sheet()
		if (path === '/counts/cnt_1/entries') {
			const body = JSON.parse(String(init?.body)) as {
				entries: Array<{ clientId: string }>
			}
			if (handlers.entries) return handlers.entries(body)
			return {
				accepted: body.entries.map((entry) => ({
					clientId: entry.clientId,
					quantity: 1,
				})),
				duplicates: [],
				refused: [],
			}
		}
		if (path === '/counts/cnt_1/send') {
			return handlers.send?.() ?? { ...COUNT, status: 'in_review', version: 4 }
		}
		throw new Error(`unexpected request ${path}`)
	})
}

function setup(
	request: InventoryClient['request'],
	props: { canEdit?: boolean; canSeeCost?: boolean } = {},
) {
	renderInventory(
		<CountingScreen
			orgSlug="acme"
			countId="cnt_1"
			canEdit={props.canEdit ?? true}
			canSeeCost={props.canSeeCost ?? false}
			search=""
		/>,
		{ request },
	)
}

const entryCalls = (request: ReturnType<typeof region>) =>
	request.mock.calls
		.map(([path], index) => ({ path, index }))
		.filter((call) => call.path === '/counts/cnt_1/entries')

async function typeAndLeave(testId: string, text: string) {
	await userEvent.type(screen.getByTestId(testId), text)
	// Click on plain text: focus leaves the field, which saves the entry.
	await userEvent.click(screen.getByRole('heading', { level: 1 }))
}

describe('CountingScreen', () => {
	it('starts blank and says how far along it is', async () => {
		setup(region())
		await screen.findByTestId('counting-screen')
		expect(screen.getByTestId('count-input-i1|a1')).toHaveValue('')
		expect(screen.getByTestId('count-input-i2|a1')).toHaveValue('')
		expect(screen.getByTestId('count-progress')).toHaveTextContent(
			'0 of 2 counted',
		)
		expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
			'Weekly count',
		)
	})

	it('saves an entry when the field loses focus, then shows it saved', async () => {
		const request = region()
		setup(request)
		await screen.findByTestId('counting-screen')
		await typeAndLeave('count-input-i1|a1', '2.5')

		await waitFor(() => expect(entryCalls(request)).toHaveLength(1))
		const body = sentJson(request, entryCalls(request)[0]!.index) as {
			entries: Array<Record<string, unknown>>
		}
		expect(body.entries).toHaveLength(1)
		expect(body.entries[0]).toMatchObject({
			itemId: 'i1',
			areaId: 'a1',
			amount: 2.5,
			unit: 'kg',
		})
		expect(typeof body.entries[0]!.clientId).toBe('string')

		const row = screen.getByTestId('count-row-i1|a1')
		await waitFor(() =>
			expect(within(row).getByTestId('count-row-status')).toHaveAttribute(
				'data-state',
				'saved',
			),
		)
		expect(screen.getByTestId('count-progress')).toHaveTextContent(
			'1 of 2 counted',
		)
		// Nothing is left on the device once the region has it.
		expect(
			window.localStorage.getItem(queueStorageKey('acme', 'cnt_1')),
		).toBeNull()
	})

	it('keeps a failed entry on screen with Retry and a banner, and sends the same entry again', async () => {
		let attempts = 0
		const request = region({
			entries: (body) => {
				attempts += 1
				if (attempts === 1) {
					throw new TypeError('Failed to fetch')
				}
				return {
					accepted: body.entries.map((entry) => ({
						clientId: entry.clientId,
						quantity: 1,
					})),
					duplicates: [],
					refused: [],
				}
			},
		})
		setup(request)
		await screen.findByTestId('counting-screen')
		await typeAndLeave('count-input-i1|a1', '4')

		const row = screen.getByTestId('count-row-i1|a1')
		await waitFor(() =>
			expect(within(row).getByTestId('count-row-status')).toHaveAttribute(
				'data-state',
				'failed',
			),
		)
		// Never looks saved: the entry is on the device and the banner says so.
		expect(screen.getByTestId('count-queue-banner')).toHaveTextContent(
			'1 entry waiting to send',
		)
		expect(
			JSON.parse(
				window.localStorage.getItem(queueStorageKey('acme', 'cnt_1'))!,
			),
		).toHaveLength(1)

		await userEvent.click(within(row).getByTestId('count-row-retry'))
		await waitFor(() =>
			expect(within(row).getByTestId('count-row-status')).toHaveAttribute(
				'data-state',
				'saved',
			),
		)
		const calls = entryCalls(request)
		expect(calls).toHaveLength(2)
		const first = sentJson(request, calls[0]!.index) as {
			entries: Array<{ clientId: string }>
		}
		const second = sentJson(request, calls[1]!.index) as {
			entries: Array<{ clientId: string }>
		}
		// The same entry is sent again, so the region can de-duplicate it.
		expect(second.entries[0]!.clientId).toBe(first.entries[0]!.clientId)
		expect(screen.queryByTestId('count-queue-banner')).toBeNull()
	})

	it('sends what a closed tab left behind, and shows the count waiting until it lands', async () => {
		window.localStorage.setItem(
			queueStorageKey('acme', 'cnt_1'),
			JSON.stringify([
				{
					clientId: 'left-behind-1',
					itemId: 'i2',
					areaId: 'a1',
					amount: 6,
					unit: 'kg',
					queuedAt: 1,
				},
			]),
		)
		const request = region({
			entries: (body) => ({
				accepted: body.entries.map((entry) => ({
					clientId: entry.clientId,
					quantity: 6_000_000,
				})),
				duplicates: [],
				refused: [],
			}),
		})
		setup(request)
		await screen.findByTestId('counting-screen')
		// The field shows what was typed before the reload.
		expect(screen.getByTestId('count-input-i2|a1')).toHaveValue('6')
		await waitFor(() => expect(entryCalls(request)).toHaveLength(1))
		const body = sentJson(request, entryCalls(request)[0]!.index) as {
			entries: Array<Record<string, unknown>>
		}
		expect(body.entries[0]).toMatchObject({
			clientId: 'left-behind-1',
			itemId: 'i2',
			amount: 6,
		})
		await waitFor(() =>
			expect(
				window.localStorage.getItem(queueStorageKey('acme', 'cnt_1')),
			).toBeNull(),
		)
	})

	it('shows how many entries wait when several are queued', async () => {
		window.localStorage.setItem(
			queueStorageKey('acme', 'cnt_1'),
			JSON.stringify(
				['i1', 'i2'].map((itemId, index) => ({
					clientId: `q-${index}-12345678`,
					itemId,
					areaId: 'a1',
					amount: index + 1,
					unit: 'kg',
					queuedAt: 1,
				})),
			),
		)
		setup(
			region({
				entries: () => {
					throw new TypeError('offline')
				},
			}),
		)
		await screen.findByTestId('counting-screen')
		await waitFor(() =>
			expect(screen.getByTestId('count-queue-banner')).toHaveTextContent(
				'2 entries waiting to send',
			),
		)
	})

	it('clearing a field sends a clear (null), never a zero', async () => {
		const request = region({
			sheet: () =>
				sheet({
					areas: [
						{
							areaId: 'a1',
							name: 'Walk-in',
							items: [
								sheetItem('i1', 'Chicken thighs', {
									quantity: 2_000_000,
									mine: { amount: 2, unit: 'kg' },
								}),
							],
						},
					],
				}),
		})
		setup(request)
		await screen.findByTestId('counting-screen')
		const field = screen.getByTestId('count-input-i1|a1')
		expect(field).toHaveValue('2')
		await userEvent.clear(field)
		await userEvent.click(screen.getByRole('heading', { level: 1 }))
		await waitFor(() => expect(entryCalls(request)).toHaveLength(1))
		const body = sentJson(request, entryCalls(request)[0]!.index) as {
			entries: Array<{ amount: number | null }>
		}
		expect(body.entries[0]!.amount).toBeNull()
	})

	it('counts an item in two units as two entries in one row', async () => {
		const request = region({
			sheet: () =>
				sheet({
					areas: [
						{
							areaId: 'a1',
							name: 'Walk-in',
							items: [
								sheetItem('i1', 'Chicken thighs', {
									units: [
										{
											id: 'box',
											name: 'Box',
											baseQuantity: 10_000_000,
											used: false,
											archived: false,
										},
									],
									countUnit: 'unit:box',
								}),
							],
						},
					],
				}),
		})
		setup(request)
		await screen.findByTestId('counting-screen')
		await typeAndLeave('count-input-i1|a1', '2')
		await userEvent.click(screen.getByTestId('count-unit-i1|a1-kg'))
		await typeAndLeave('count-input-i1|a1', '3')
		await waitFor(() => expect(entryCalls(request)).toHaveLength(2))
		const units = entryCalls(request).map(
			(call) =>
				(
					sentJson(request, call.index) as {
						entries: Array<{ unit: string; amount: number }>
					}
				).entries[0],
		)
		expect(units).toEqual([
			expect.objectContaining({ unit: 'unit:box', amount: 2 }),
			expect.objectContaining({ unit: 'kg', amount: 3 }),
		])
		expect(screen.getByTestId('count-row-other-units')).toHaveTextContent(
			'2 Box',
		)
	})

	it('shows the area tabs in order with their progress, and one area at a time', async () => {
		setup(
			region({
				sheet: () =>
					sheet({
						areas: [
							{
								areaId: 'a1',
								name: 'Walk-in',
								items: [sheetItem('i1', 'Chicken thighs')],
							},
							{
								areaId: 'a2',
								name: 'Dry store',
								items: [sheetItem('i2', 'Rice')],
							},
						],
					}),
			}),
		)
		await screen.findByTestId('counting-screen')
		expect(screen.getByTestId('count-tab-a1')).toHaveTextContent('Walk-in')
		expect(screen.getByTestId('count-tab-a2')).toHaveTextContent('0/1')
		expect(screen.getByTestId('count-row-i1|a1')).toBeInTheDocument()
		expect(screen.queryByTestId('count-row-i2|a2')).toBeNull()
		await userEvent.click(screen.getByTestId('count-tab-a2'))
		expect(await screen.findByTestId('count-row-i2|a2')).toBeInTheDocument()
	})

	it('refuses to send while entries are still waiting, and loses nothing', async () => {
		const request = region({
			entries: () => {
				throw new TypeError('offline')
			},
		})
		setup(request)
		await screen.findByTestId('counting-screen')
		await typeAndLeave('count-input-i1|a1', '1')
		await userEvent.click(screen.getByTestId('count-finish'))
		expect(await screen.findByTestId('count-finish-error')).toHaveTextContent(
			'have not reached the server',
		)
		expect(
			request.mock.calls.some(([path]) => path === '/counts/cnt_1/send'),
		).toBe(false)
		expect(
			JSON.parse(
				window.localStorage.getItem(queueStorageKey('acme', 'cnt_1'))!,
			),
		).toHaveLength(1)
	})

	it('asks before sending a count with items left, then sends the version it saw', async () => {
		const request = region()
		setup(request)
		await screen.findByTestId('counting-screen')
		await typeAndLeave('count-input-i1|a1', '1')
		await waitFor(() => expect(entryCalls(request)).toHaveLength(1))
		await userEvent.click(screen.getByTestId('count-finish'))
		await userEvent.click(await screen.findByTestId('count-confirm-send'))
		await waitFor(() =>
			expect(
				request.mock.calls.some(([path]) => path === '/counts/cnt_1/send'),
			).toBe(true),
		)
		const index = request.mock.calls.findIndex(
			([path]) => path === '/counts/cnt_1/send',
		)
		expect(sentJson(request, index)).toEqual({ expectedVersion: 3 })
		// Without the cost grant the count waits for a manager.
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith('Sent for approval.'),
		)
	})

	it('is read-only once the count is in review', async () => {
		setup(region({ sheet: () => sheet({ status: 'in_review' }) }))
		await screen.findByTestId('counting-screen')
		expect(screen.queryByTestId('count-input-i1|a1')).toBeNull()
		expect(screen.queryByTestId('count-finish')).toBeNull()
		expect(screen.getByTestId('count-in-review')).toBeInTheDocument()
		expect(screen.getByTestId('count-open-review')).toBeInTheDocument()
	})

	it('cannot be edited without the update grant', async () => {
		setup(region(), { canEdit: false })
		await screen.findByTestId('counting-screen')
		expect(screen.queryByTestId('count-input-i1|a1')).toBeNull()
		expect(screen.getByTestId('count-read-only')).toBeInTheDocument()
	})

	it('shows the error with Try again when the sheet does not load', async () => {
		const request = vi.fn<InventoryClient['request']>(async () => {
			throw new OperatorRequestError('down', 'inventory_unavailable', 503)
		})
		setup(request)
		expect(await screen.findByTestId('count-error')).toHaveTextContent(
			'Inventory is paused right now',
		)
	})

	it('tells the person when the count stopped taking entries', async () => {
		const request = region({
			entries: (body) => ({
				accepted: [],
				duplicates: [],
				refused: body.entries.map((entry) => ({
					clientId: entry.clientId,
					code: 'count_closed',
				})),
			}),
		})
		setup(request)
		await screen.findByTestId('counting-screen')
		await typeAndLeave('count-input-i1|a1', '1')
		expect(await screen.findByTestId('count-closed')).toBeInTheDocument()
		expect(
			window.localStorage.getItem(queueStorageKey('acme', 'cnt_1')),
		).toBeNull()
	})
})
