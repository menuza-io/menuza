// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { renderInventory, sentJson } from '#tests/inventory-render.tsx'
import { CountPlanPanel } from './count-plan-panel.tsx'

// The roster is regional data read in the browser: stood in here.
vi.mock('#app/hooks/use-staff-client.ts', () => ({
	useStaffClient: () => ({ client: {}, ready: true }),
	StaffClientContext: { Provider: ({ children }: any) => children },
}))
vi.mock('#app/components/staff/staff-client-provider.tsx', () => ({
	StaffClientProvider: ({ children }: any) => children,
}))
vi.mock('#app/hooks/use-staff-directory.ts', () => ({
	useStaffDirectory: () => ({
		people: [
			{ id: 'staff_omar', terminatedAt: null },
			{ id: 'staff_gone', terminatedAt: 5 },
		],
		failed: false,
		byId: new Map(),
		nameOf: (id: string) => (id === 'staff_omar' ? 'Omar Test' : id),
	}),
}))

const SCHEDULE = {
	id: 'sch_1',
	locationId: 'main',
	kind: 'quick',
	listId: null,
	listName: null,
	slot: 'close',
	timeLocal: '22:00',
	weekdays: [0, 1, 2, 3, 4, 5, 6],
	assignee: { kind: 'staff', id: 'staff_omar' },
	effectiveFrom: '2026-11-24',
	version: 2,
}

function region(schedules: unknown[] = [SCHEDULE]) {
	return vi.fn<InventoryClient['request']>(async (path, init) => {
		if (path.startsWith('/count-schedules?')) return { schedules }
		if (path.startsWith('/count-lists?')) return { lists: [] }
		if (path === '/count-schedules' && init?.method === 'POST') {
			return { ...SCHEDULE, id: 'sch_new' }
		}
		if (path === '/count-schedules/sch_1/archive') return { id: 'sch_1' }
		if (path === '/count-schedules/sch_1' && init?.method === 'PATCH') {
			return SCHEDULE
		}
		if (path === '/settings/locations/main/count-controls') {
			return { locationId: 'main', secondCountRequired: true, version: 4 }
		}
		throw new Error(`unexpected request ${path}`)
	})
}

function setup(
	request: InventoryClient['request'],
	props: {
		canEdit?: boolean
		canManageSettings?: boolean
		second?: boolean
	} = {},
) {
	const onSettingsChanged = vi.fn()
	renderInventory(
		<CountPlanPanel
			orgSlug="acme"
			locationId="main"
			canEdit={props.canEdit ?? true}
			members={[{ id: 'user_sara', name: 'Sara Manager' }]}
			secondCountRequired={props.second ?? false}
			locationVersion={3}
			canManageSettings={props.canManageSettings ?? true}
			onSettingsChanged={onSettingsChanged}
		/>,
		{ request },
	)
	return { onSettingsChanged }
}

beforeEach(() => {
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
})

describe('CountPlanPanel (#490, #491, #525)', () => {
	it('lists the scheduled counts with their time and who is responsible', async () => {
		setup(region())
		const row = await screen.findByTestId('count-plan-row-sch_1')
		expect(row).toHaveTextContent('Quick count of key items')
		expect(row).toHaveTextContent('At close')
		expect(row).toHaveTextContent('22:00')
		expect(row).toHaveTextContent('Every day')
		expect(within(row).getByTestId('count-plan-assignee')).toHaveTextContent(
			'Responsible: Omar Test',
		)
	})

	it('says so when nothing is scheduled and when nobody is responsible', async () => {
		setup(region([]))
		expect(await screen.findByTestId('count-plan-empty')).toBeInTheDocument()
		cleanup()
		setup(region([{ ...SCHEDULE, assignee: null }]))
		expect(await screen.findByTestId('count-plan-assignee')).toHaveTextContent(
			'Nobody is responsible yet',
		)
	})

	it('adds a quick count at close that applies from tomorrow', async () => {
		const request = region([])
		setup(request)
		await userEvent.click(await screen.findByTestId('count-plan-add'))
		const dialog = await screen.findByTestId('count-plan-dialog')
		expect(dialog).toHaveTextContent('It applies from tomorrow')
		await userEvent.click(within(dialog).getByTestId('count-plan-save'))
		await waitFor(() =>
			expect(
				request.mock.calls.filter(([path]) => path === '/count-schedules'),
			).toHaveLength(1),
		)
		const index = request.mock.calls.findIndex(
			([path]) => path === '/count-schedules',
		)
		expect(sentJson(request, index)).toMatchObject({
			locationId: 'main',
			kind: 'quick',
			listId: null,
			slot: 'close',
			timeLocal: '22:00',
			weekdays: [0, 1, 2, 3, 4, 5, 6],
			assignee: null,
		})
	})

	it('removes a scheduled count with the version it saw', async () => {
		const request = region()
		setup(request)
		await userEvent.click(await screen.findByTestId('count-plan-remove-sch_1'))
		await waitFor(() =>
			expect(
				request.mock.calls.some(
					([path]) => path === '/count-schedules/sch_1/archive',
				),
			).toBe(true),
		)
		const index = request.mock.calls.findIndex(
			([path]) => path === '/count-schedules/sch_1/archive',
		)
		expect(sentJson(request, index)).toEqual({ expectedVersion: 2 })
	})

	it('turns the second-person check on for a manager, and not for anyone else', async () => {
		const request = region()
		const { onSettingsChanged } = setup(request)
		await userEvent.click(await screen.findByTestId('count-plan-second'))
		await waitFor(() => expect(onSettingsChanged).toHaveBeenCalled())
		const index = request.mock.calls.findIndex(
			([path]) => path === '/settings/locations/main/count-controls',
		)
		expect(sentJson(request, index)).toEqual({
			expectedVersion: 3,
			secondCountRequired: true,
		})
		cleanup()
		const other = region()
		setup(other, { canManageSettings: false })
		await userEvent.click(await screen.findByTestId('count-plan-second'))
		expect(
			other.mock.calls.some(
				([path]) => path === '/settings/locations/main/count-controls',
			),
		).toBe(false)
	})

	it('hides the editing controls without the update grant', async () => {
		setup(region(), { canEdit: false })
		await screen.findByTestId('count-plan-row-sch_1')
		expect(screen.queryByTestId('count-plan-add')).toBeNull()
		expect(screen.queryByTestId('count-plan-remove-sch_1')).toBeNull()
	})
})
