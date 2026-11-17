// @vitest-environment jsdom

import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { PosDayReport } from './pos-day-report.tsx'

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

const tender = (netCents: number) => ({
	paymentsCents: netCents,
	refundsCents: 0,
	netCents,
})
const summary = (over: Record<string, unknown> = {}) => ({
	orders: { paid: 3, refunded: 0, cancelled: 1, open: 0 },
	grossSalesCents: 3300,
	refundsCents: 0,
	netSalesCents: 3300,
	taxCents: 300,
	tipsCents: 0,
	byTender: { cash: tender(1100), card: tender(2200), other: tender(0) },
	voids: {
		cancelledOrders: 1,
		cancelledCents: 900,
		removedItems: 0,
		removedCents: 0,
	},
	cash: { expectedCents: 6100 },
	...over,
})

function stubApi(day: unknown) {
	const calls: string[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input.toString()
			calls.push(url)
			if (url.includes('/orders-token'))
				return Response.json({
					jwt: 'read-token',
					tenantApiUrl: 'https://api.example.com',
				})
			if (url.includes('/operator/pos/reports/day')) return Response.json(day)
			return new Response('not found', { status: 404 })
		}),
	)
	return calls
}

describe('PosDayReport', () => {
	it('shows the day’s totals by tender and each shift with what it was short', async () => {
		const calls = stubApi({
			businessDate: '2026-10-21',
			currency: 'USD',
			summary: summary(),
			byTerminal: [],
			shifts: [
				{
					shift: {
						id: 's1',
						status: 'closed',
						openedAt: 1,
						closedAt: 2,
						openedBy: { name: 'Lina M.' },
						closedBy: null,
						countedCashCents: 6075,
					},
					summary: summary(),
					overShortCents: -25,
					terminal: { code: 'T1', label: 'Front counter' },
				},
			],
		})
		renderStaff(<PosDayReport orgSlug="joes" />)
		const report = await screen.findByRole('region', { name: 'Day report' })
		expect(await within(report).findAllByText('$33.00')).toHaveLength(2) // sales and net sales
		expect(within(report).getByText('$22.00')).toBeTruthy()
		const shifts = within(report).getByRole('list', {
			name: 'Cash drawer shifts',
		})
		expect(within(shifts).getByText('Short $0.25')).toBeTruthy()
		expect(
			within(shifts).getByText('Expected $61.00, counted $60.75'),
		).toBeTruthy()
		expect(
			calls.some((u) =>
				/\/operator\/pos\/reports\/day\?businessDate=\d{4}-\d{2}-\d{2}$/.test(
					u,
				),
			),
		).toBe(true)
	})

	it('says so when nothing was sold', async () => {
		stubApi({
			businessDate: '2026-10-21',
			currency: null,
			summary: summary({
				orders: { paid: 0, refunded: 0, cancelled: 0, open: 0 },
			}),
			byTerminal: [],
			shifts: [],
		})
		renderStaff(<PosDayReport orgSlug="joes" />)
		expect(
			await screen.findByText('No walk-in sales on this day.'),
		).toBeTruthy()
	})

	it('lets a permitted manager close an open shift remotely and displays remote close details', async () => {
		const user = userEvent.setup()
		let closed = false
		const closeBodies: Array<Record<string, unknown>> = []
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/orders-token'))
					return Response.json({
						jwt: 'shift-token',
						tenantApiUrl: 'https://api.example.com',
					})
				if (url.includes('/operator/pos/shifts/s1/close')) {
					closeBodies.push(
						JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
					)
					closed = true
					return Response.json({ ok: true })
				}
				if (url.includes('/operator/pos/reports/day')) {
					return Response.json({
						businessDate: '2026-10-21',
						currency: 'USD',
						summary: summary(),
						byTerminal: [],
						shifts: [
							closed
								? {
										shift: {
											id: 's1',
											status: 'closed',
											openedAt: 1,
											closedAt: 2,
											openedBy: { name: 'Lina M.' },
											closedBy: null,
											countedCashCents: 6075,
											closedRemotelyBy: { id: 'mgr_1', name: 'Samir K.' },
											remoteCloseReason: 'Cashier forgot to close till',
										},
										summary: summary(),
										overShortCents: -25,
										terminal: { code: 'T1', label: 'Front counter' },
									}
								: {
										shift: {
											id: 's1',
											status: 'open',
											openedAt: 1,
											closedAt: null,
											openedBy: { name: 'Lina M.' },
											closedBy: null,
											countedCashCents: null,
											closedRemotelyBy: null,
											remoteCloseReason: null,
										},
										summary: summary(),
										overShortCents: null,
										terminal: { code: 'T1', label: 'Front counter' },
									},
						],
					})
				}
				return new Response('not found', { status: 404 })
			}),
		)

		renderStaff(<PosDayReport orgSlug="joes" canCloseShifts={false} />)
		const initialReport = await screen.findByRole('region', {
			name: 'Day report',
		})
		expect(
			within(initialReport).queryByRole('button', { name: 'Close shift' }),
		).toBeNull()

		cleanup()
		renderStaff(<PosDayReport orgSlug="joes" canCloseShifts />)
		const report = await screen.findByRole('region', { name: 'Day report' })
		const closeBtn = await within(report).findByRole('button', {
			name: 'Close shift',
		})
		await user.click(closeBtn)

		const dialog = await screen.findByRole('dialog')
		await user.type(within(dialog).getByLabelText('Counted cash'), '60.75')
		await user.type(
			within(dialog).getByLabelText('Reason'),
			'Cashier forgot to close till',
		)
		await user.click(
			within(dialog).getByRole('button', { name: 'Confirm close' }),
		)

		await waitFor(() => expect(closeBodies).toHaveLength(1))
		expect(closeBodies[0]).toEqual({
			countedCashCents: 6075,
			reason: 'Cashier forgot to close till',
		})
		expect(
			await within(report).findByText(
				/Closed remotely by Samir K\. — Cashier forgot to close till/,
			),
		).toBeTruthy()
	})
})
