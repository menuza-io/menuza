// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { DeliveriesPanel } from './deliveries-panel.tsx'

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

const board = {
	locationId: 'loc1',
	unassigned: [
		{
			id: 'o1',
			number: 'D-1',
			firstName: 'Layla',
			address: '233 South Wacker Drive',
			unit: 'Suite 4',
			zoneName: null,
			promisedAt: null,
			readyAt: null,
			cashDueCents: 2500,
			tipCents: 0,
			currency: 'USD',
		},
		{
			id: 'o2',
			number: 'D-2',
			firstName: 'Omar',
			address: '1 Other Street',
			unit: null,
			zoneName: null,
			promisedAt: null,
			readyAt: null,
			cashDueCents: 0,
			tipCents: 0,
			currency: 'USD',
		},
	],
	runs: [
		{
			id: 'r1',
			status: 'on_the_road',
			locationId: 'loc1',
			driver: { staffId: 's-ben', name: 'Ben D.' },
			createdByKind: 'manager',
			createdAt: 1,
			pickedUpAt: 2,
			position: { lat: 41.9, lng: -87.6, updatedAt: 3 },
			stops: [
				{
					id: 'st1',
					orderId: 'o9',
					number: 'D-9',
					stopNo: 1,
					status: 'picked_up',
					problemKind: null,
					firstName: 'Noor',
					address: '5 Road',
					unit: null,
					notes: null,
					mapUrl: '',
					cashDueCents: 0,
					cashCollectedCents: 0,
					tipCents: 0,
					currency: 'USD',
					canCall: false,
				},
			],
		},
	],
	drivers: [
		{ staffId: 's-ana', name: 'Ana D.', unavailable: false, openRuns: 0 },
		{ staffId: 's-ben', name: 'Ben D.', unavailable: false, openRuns: 1 },
	],
}

function stub() {
	const posts: Array<{ url: string; body: unknown }> = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
			const url = typeof input === 'string' ? input : input.toString()
			if (url.includes('/orders-token')) {
				return Response.json({ jwt: 't', tenantApiUrl: 'https://api.example.com' })
			}
			if (url.includes('/operator/deliveries/board')) return Response.json(board)
			if (init.method === 'POST') {
				posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null })
				return Response.json({ runId: 'r2' })
			}
			return new Response('no', { status: 404 })
		}),
	)
	return posts
}

describe('Deliveries board on the Orders page (#287)', () => {
	const render = (canWrite = true) =>
		renderStaff(
			<DeliveriesPanel orgSlug="acme" locations={[{ id: 'loc1', name: 'Main' }]} canWrite={canWrite} />,
		)

	it('lists ready orders waiting for a driver, runs and drivers', async () => {
		stub()
		render()
		const panel = await screen.findByTestId('deliveries-panel')
		await waitFor(() => expect(within(panel).getByText(/D-1 · Layla/)).toBeInTheDocument())
		expect(within(panel).getByText(/D-2 · Omar/)).toBeInTheDocument()
		expect(within(panel).getByText(/233 South Wacker Drive · Suite 4/)).toBeInTheDocument()
		expect(within(panel).getByText(/Cash to collect/)).toBeInTheDocument()
		const run = within(panel).getByTestId('delivery-run')
		expect(within(run).getByText('Ben D.')).toBeInTheDocument()
		expect(within(run).getByText('On the road')).toBeInTheDocument()
		expect(within(run).getByRole('link', { name: 'Where they are' })).toHaveAttribute('href', expect.stringContaining('41.9,-87.6'))
	})

	it('assigns the picked orders to a driver as one run', async () => {
		const posts = stub()
		const user = userEvent.setup()
		render()
		await screen.findByText(/D-1 · Layla/)
		await user.click(screen.getByRole('checkbox', { name: 'Select order D-1' }))
		await user.click(screen.getByRole('checkbox', { name: 'Select order D-2' }))
		const assign = screen.getByRole('button', { name: 'Assign as one run' })
		expect(assign).toBeDisabled() // no driver yet
		await user.click(screen.getByRole('combobox', { name: 'Driver' }))
		await user.click(await screen.findByRole('option', { name: 'Ana D.' }))
		await user.click(assign)
		await waitFor(() => expect(posts).toHaveLength(1))
		expect(posts[0]!.url).toContain('/operator/deliveries/runs')
		expect(posts[0]!.body).toEqual({
			locationId: 'loc1',
			driverStaffId: 's-ana',
			orderIds: ['o1', 'o2'],
		})
	})

	it('marks a stop delivered on the driver\'s behalf and takes one back', async () => {
		const posts = stub()
		const user = userEvent.setup()
		render()
		await screen.findByTestId('delivery-run')
		await user.click(screen.getByRole('button', { name: 'Mark delivered' }))
		await waitFor(() => expect(posts.at(-1)!.url).toContain('/stops/st1/delivered'))
		await user.click(screen.getByRole('button', { name: 'Take back' }))
		await waitFor(() => expect(posts.at(-1)!.url).toContain('/stops/st1/release'))
	})

	it('sets a driver unavailable', async () => {
		const posts = stub()
		const user = userEvent.setup()
		render()
		await screen.findByTestId('delivery-run')
		const buttons = screen.getAllByRole('button', { name: 'Set unavailable' })
		await user.click(buttons[0]!)
		await waitFor(() => expect(posts.at(-1)!.url).toContain('/drivers/s-ana/availability'))
		expect(posts.at(-1)!.body).toEqual({ locationId: 'loc1', unavailable: true })
	})

	it('shows the board but no controls to a member who cannot write orders', async () => {
		stub()
		render(false)
		await screen.findByText(/D-1 · Layla/)
		expect(screen.queryByRole('button', { name: 'Assign as one run' })).toBeNull()
		expect(screen.queryByRole('button', { name: 'Mark delivered' })).toBeNull()
		expect(screen.queryByRole('checkbox')).toBeNull()
	})

	it('renders nothing without a location', () => {
		stub()
		const { container } = renderStaff(<DeliveriesPanel orgSlug="acme" locations={[]} canWrite />)
		expect(container.querySelector('[data-testid="deliveries-panel"]')).toBeNull()
	})
})
