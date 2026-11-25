// @vitest-environment jsdom
import { type DeliveryZone } from '@repo/common/location-types'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'

// The map needs a browser maps SDK; the list does not.
vi.mock('./delivery-zone-map', () => ({ DeliveryZoneMap: () => null }))
const drag = vi.hoisted(() => ({ onDragEnd: null as null | ((event: unknown) => void) }))
vi.mock('@dnd-kit/core', async (importOriginal) => {
	const original = await importOriginal<Record<string, unknown>>()
	return {
		...original,
		DndContext: ({
			children,
			onDragEnd,
		}: {
			children: React.ReactNode
			onDragEnd: (event: unknown) => void
		}) => {
			drag.onDragEnd = onDragEnd
			return <>{children}</>
		},
	}
})

const { DeliveryZonesManager } = await import('./delivery-zones-manager.tsx')

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

function zone(overrides: Partial<DeliveryZone>): DeliveryZone {
	return {
		id: 'z',
		name: 'Zone',
		provider: 'in_house',
		restriction: 'allowed',
		type: 'radius',
		radius: { value: 5, unit: 'km' },
		zipCodes: [],
		polygon: [],
		minimumOrder: 10,
		deliveryFee: 3,
		enabled: true,
		...overrides,
	}
}

const ring = zone({ id: 'ring', name: 'Free ring', radius: { value: 1, unit: 'km' }, deliveryFee: 0 })
const wide = zone({ id: 'wide', name: 'Wide area', radius: { value: 9, unit: 'km' }, deliveryFee: 6 })
const STORE = { centerLat: 41.8853, centerLng: -87.6229 }

describe('Delivery zones list (#266)', () => {
	it('explains the cheapest rule for a location nobody has reordered', () => {
		renderStaff(
			<DeliveryZonesManager zones={[wide, ring]} onChange={() => {}} {...STORE} />,
		)
		expect(screen.getByTestId('zone-priority-note')).toHaveTextContent(
			'the cheapest zone applies',
		)
		// No numbered priority until the list decides.
		expect(screen.queryByLabelText(/Priority/)).toBeNull()
		const notes = screen.getAllByTestId('zone-overlap-note').map((n) => n.textContent)
		expect(notes).toContain('Overlaps Free ring; that one wins because it is cheaper.')
		expect(notes).toContain('Overlaps Wide area; this one wins.')
	})

	it('numbers the zones and says the higher one wins once the list is ordered', () => {
		renderStaff(
			<DeliveryZonesManager
				zones={[wide, ring]}
				onChange={() => {}}
				priority="order"
				onPriorityChange={() => {}}
				{...STORE}
			/>,
		)
		expect(screen.getByTestId('zone-priority-note')).toHaveTextContent(
			'the first zone in the list that covers the address applies',
		)
		expect(screen.getByLabelText('Priority 1')).toHaveTextContent('1')
		expect(screen.getByLabelText('Priority 2')).toHaveTextContent('2')
		const notes = screen.getAllByTestId('zone-overlap-note').map((n) => n.textContent)
		// "Wide area" is listed first, so it wins over the ring below it.
		expect(notes).toContain('Overlaps Free ring; this one wins.')
		expect(notes).toContain('Overlaps Wide area; that one wins because it is higher.')
	})

	it('reorders on drag and switches the location to ordered mode', () => {
		const onChange = vi.fn()
		const onPriorityChange = vi.fn()
		renderStaff(
			<DeliveryZonesManager
				zones={[wide, ring]}
				onChange={onChange}
				onPriorityChange={onPriorityChange}
				{...STORE}
			/>,
		)
		drag.onDragEnd?.({ active: { id: 'ring' }, over: { id: 'wide' } })
		expect(onChange).toHaveBeenCalledWith([ring, wide])
		expect(onPriorityChange).toHaveBeenCalledWith('order')
		// Dropping a zone on itself changes nothing.
		onChange.mockClear()
		onPriorityChange.mockClear()
		drag.onDragEnd?.({ active: { id: 'ring' }, over: { id: 'ring' } })
		expect(onChange).not.toHaveBeenCalled()
		expect(onPriorityChange).not.toHaveBeenCalled()
	})

	it('lets the operator go back to the cheapest zone', async () => {
		const onPriorityChange = vi.fn()
		const user = userEvent.setup()
		renderStaff(
			<DeliveryZonesManager
				zones={[wide, ring]}
				onChange={() => {}}
				priority="order"
				onPriorityChange={onPriorityChange}
				{...STORE}
			/>,
		)
		await user.click(screen.getByRole('button', { name: 'Use the cheapest zone instead' }))
		expect(onPriorityChange).toHaveBeenCalledWith('cheapest')
	})

	it('shows a fee table in place of the single fee', () => {
		renderStaff(
			<DeliveryZonesManager
				zones={[
					zone({ id: 'a', name: 'By size', feeSteps: [{ from: 10, fee: 3 }, { from: 20, fee: 0 }] }),
					zone({
						id: 'b',
						name: 'By road',
						radius: { value: 30, unit: 'km' },
						distanceFees: { mode: 'driving', unit: 'km', bands: [{ from: 0, fee: 3 }, { from: 5, fee: 5 }] },
					}),
				]}
				onChange={() => {}}
				{...STORE}
			/>,
		)
		expect(screen.getByText('Fee by order size (2 steps)')).toBeInTheDocument()
		expect(screen.getByText('Fee by distance (2 bands)')).toBeInTheDocument()
	})
})

describe('Address check (#266)', () => {
	function stub(response: unknown, calls: Array<{ url: string; body: unknown }> = []) {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/orders-token')) {
					return Response.json({ jwt: 't', tenantApiUrl: 'https://api.example.com' })
				}
				if (url.endsWith('/operator/orders/delivery-check')) {
					calls.push({ url, body: JSON.parse(String(init.body)) })
					return Response.json(response)
				}
				return new Response('no', { status: 404 })
			}),
		)
		return calls
	}

	const renderCheck = () =>
		renderStaff(
			<DeliveryZonesManager
				zones={[wide]}
				onChange={() => {}}
				orgSlug="acme"
				locationId="loc1"
				{...STORE}
			/>,
		)

	it('names the zone that applies with its fee and minimum', async () => {
		const calls = stub({
			status: 'deliverable',
			quote: { zoneName: 'Wide area', deliveryFee: 6, minimumOrder: 10 },
		})
		const user = userEvent.setup()
		renderCheck()
		const box = screen.getByTestId('address-check')
		await user.type(within(box).getByLabelText('Address'), '233 South Wacker Drive')
		await user.click(within(box).getByRole('button', { name: 'Check' }))
		await waitFor(() =>
			expect(screen.getByTestId('check-deliverable')).toHaveTextContent(
				'Zone “Wide area” applies. Fee $6.00. Minimum order $10.00.',
			),
		)
		expect(calls[0]!.body).toEqual({ locationId: 'loc1', address: '233 South Wacker Drive' })
	})

	it('sends an order amount when one is typed', async () => {
		const calls = stub({
			status: 'deliverable',
			quote: { zoneName: 'Wide area', deliveryFee: 0, minimumOrder: 10 },
		})
		const user = userEvent.setup()
		renderCheck()
		const box = screen.getByTestId('address-check')
		await user.type(within(box).getByLabelText('Address'), '233 South Wacker Drive')
		await user.type(within(box).getByLabelText('Order amount (optional)'), '45')
		await user.click(within(box).getByRole('button', { name: 'Check' }))
		await waitFor(() => expect(calls).toHaveLength(1))
		expect(calls[0]!.body).toMatchObject({ subtotal: 45 })
		await waitFor(() =>
			expect(screen.getByRole('status')).toHaveTextContent('Fee for this order size: $0.00'),
		)
	})

	it.each([
		[
			{ status: 'out_of_range', reason: 'excluded', excludedBy: 'Campus' },
			'inside “Campus”, a zone where delivery is not allowed',
		],
		[
			{ status: 'out_of_range', reason: 'out_of_range' },
			'outside every delivery zone',
		],
		[{ status: 'not_found' }, 'could not be found'],
		[{ status: 'unavailable', reason: 'no_zones' }, 'No zone is switched on'],
	])('says why delivery is not available (%#)', async (response, text) => {
		stub(response)
		const user = userEvent.setup()
		renderCheck()
		const box = screen.getByTestId('address-check')
		await user.type(within(box).getByLabelText('Address'), '1 Some Street')
		await user.click(within(box).getByRole('button', { name: 'Check' }))
		await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(text))
	})

	it('asks to save a new location first', () => {
		renderStaff(
			<DeliveryZonesManager zones={[wide]} onChange={() => {}} orgSlug="acme" {...STORE} />,
		)
		expect(screen.getByText(/Save this location to check an address/)).toBeInTheDocument()
	})
})
