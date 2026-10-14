// @vitest-environment jsdom

import {
	type LaborSummaryView,
	type TipPoolReport,
	type TargetStatus,
} from '@repo/staffing'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StaffClientProvider } from '#app/components/staff/staff-client-provider.tsx'
import { renderStaff } from '#tests/staff-render.tsx'
import { LaborPage } from './labor-page.tsx'

const download = vi.hoisted(() => vi.fn())
vi.mock('#app/utils/staffing/roster-export.ts', () => ({
	downloadCsv: download,
}))

beforeEach(() => {
	// The screen reads "today" from the clock: fix it so the ranges are known.
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(new Date('2026-03-10T18:00:00Z'))
})

afterEach(() => {
	download.mockReset()
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json({})),
	)
	vi.useRealTimers()
})

const SCOPES = [
	{
		id: 'loc-1',
		name: 'Downtown',
		timeZone: 'America/Chicago',
		currency: 'USD' as const,
	},
	{
		id: 'loc-2',
		name: 'Airport',
		timeZone: 'America/Chicago',
		currency: 'USD' as const,
	},
]
const ALL = { editSales: true, editSettings: true, seeTips: true }
const GRANTS = [
	'read:labor:any',
	'read:staff:any',
	'read:staff_pay:any',
	'update:timesheet:any',
	'update:labor_policy:any',
]

type Call = { method: string; url: string; body: any }

function summaryFor(
	source: LaborSummaryView['salesSource'],
	over: Partial<LaborSummaryView> = {},
): LaborSummaryView {
	const complete = source !== 'online_orders'
	const status: TargetStatus | undefined = complete ? 'over' : undefined
	return {
		estimate: true,
		scopeId: 'loc-1',
		timeZone: 'America/Chicago',
		from: '2026-03-04',
		to: '2026-03-10',
		salesSource: source,
		salesComplete: complete,
		targetBp: 2000,
		targetColoring: complete,
		days: [
			{
				date: '2026-03-09',
				paidMinutes: 480,
				overtimeMinutes: 0,
				cards: 1,
				people: 1,
				hasSales: true,
				money: [
					{
						currency: 'USD',
						costMinor: 16_000,
						salesMinor: 64_000,
						laborBp: 2500,
						salesPerLaborHourMinor: 8000,
						...(status ? { targetStatus: status } : {}),
					},
				],
			},
			{
				date: '2026-03-10',
				paidMinutes: 240,
				overtimeMinutes: 0,
				cards: 1,
				people: 1,
				hasSales: false,
				money: [
					{
						currency: 'USD',
						costMinor: 8_000,
						salesMinor: null,
						laborBp: null,
						salesPerLaborHourMinor: null,
					},
				],
			},
		],
		totals: {
			paidMinutes: 720,
			overtimeMinutes: 0,
			cards: 2,
			salesDays: 1,
			daysWithoutSales: 1,
			money: [
				{
					currency: 'USD',
					costMinor: 24_000,
					salesMinor: 64_000,
					laborBp: 2500,
					salesPerLaborHourMinor: 8000,
					...(status ? { targetStatus: status } : {}),
				},
			],
		},
		currencyMismatch: null,
		unpricedMinutes: 0,
		openCards: 0,
		truncated: false,
		...over,
	}
}

const TIPS: TipPoolReport = {
	estimate: true,
	payout: false,
	scopeId: 'loc-1',
	timeZone: 'America/Chicago',
	from: '2026-03-04',
	to: '2026-03-10',
	settings: {
		scopeId: 'loc-1',
		splitBasis: 'hours',
		cadence: 'period',
		cardFeeBp: 300,
		fulfillment: ['pickup'],
		positionPercentBp: {},
		configured: true,
		updatedAt: 1,
	},
	pools: [
		{
			currency: 'USD',
			onlineTipsMinor: 1500,
			cardFeeMinor: 45,
			cashTipsMinor: 2000,
			poolMinor: 3455,
			unallocatedMinor: 0,
			groups: [],
			people: [
				{
					staffId: 's1',
					firstName: 'Ana',
					lastName: 'Adams',
					firstNameAr: null,
					lastNameAr: null,
					employeeNumber: null,
					minutes: 480,
					shareMinor: 1974,
				},
				{
					staffId: 's2',
					firstName: 'Ben',
					lastName: 'Brown',
					firstNameAr: null,
					lastNameAr: null,
					employeeNumber: null,
					minutes: 360,
					shareMinor: 1481,
				},
			],
		},
	],
	undeclaredCurrencyCashTips: 0,
	openCards: 0,
	unapprovedCards: 2,
	ineligibleMinutes: 0,
	truncated: false,
}

function stubApi(
	options: {
		source?: LaborSummaryView['salesSource']
		grants?: string[]
		summary?: LaborSummaryView
		entries?: unknown[]
		respond?: (call: Call) => Response | undefined
	} = {},
) {
	const calls: Call[] = []
	const source = options.source ?? 'online_orders'
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			if (url.includes('/staff/token')) {
				return Response.json({
					jwt: 'jwt',
					tenantApiUrl: 'https://us.tenant.test',
					scope: 'labor',
					grants: options.grants ?? GRANTS,
					expiresAt: Date.now() + 600_000,
				})
			}
			const call: Call = {
				method: init?.method ?? 'GET',
				url,
				body: init?.body ? JSON.parse(String(init.body)) : null,
			}
			calls.push(call)
			const custom = options.respond?.(call)
			if (custom) return custom
			if (url.includes('/summary/export')) {
				return Response.json({
					filename: 'labor-summary.csv',
					kind: 'labor_summary',
					rowCount: 3,
					headers: ['Date'],
					rows: [],
					csv: 'Date\r\n',
				})
			}
			if (url.includes('/summary?')) {
				return Response.json(options.summary ?? summaryFor(source))
			}
			if (url.includes('/sales/bulk')) {
				return Response.json({ created: 2, updated: 0, unchanged: 0 })
			}
			if (url.includes('/sales?') && call.method === 'GET') {
				return Response.json({
					scopeId: 'loc-1',
					from: '2026-03-04',
					to: '2026-03-10',
					entries: options.entries ?? [],
				})
			}
			if (url.includes('/sales') && call.method === 'PUT') {
				return Response.json({
					id: 'e1',
					scopeId: 'loc-1',
					date: call.body.date,
					netSalesMinor: call.body.netSalesMinor,
					currency: call.body.currency,
					source: 'manual',
					note: null,
					updatedAt: 2,
				})
			}
			if (url.includes('/settings') && call.method === 'PUT') {
				return Response.json({
					scopeId: 'loc-1',
					salesSource: call.body.salesSource ?? 'online_orders',
					ordersPerLaborHour: call.body.ordersPerLaborHour ?? {},
					configured: true,
					updatedAt: 3,
				})
			}
			if (url.includes('/settings')) {
				return Response.json({
					scopeId: 'loc-1',
					salesSource: source,
					ordersPerLaborHour: { cook: 12.5 },
					configured: true,
					updatedAt: 1,
				})
			}
			if (url.includes('/positions')) {
				return Response.json({
					positions: [
						{ id: 'cook', name: 'Cook', nameAr: null },
						{ id: 'server', name: 'Server', nameAr: null },
					],
				})
			}
			if (url.includes('/tips/export')) {
				return Response.json({
					filename: 'tip-pool.csv',
					kind: 'tip_pool',
					rowCount: 4,
					headers: [],
					rows: [],
					csv: 'x',
				})
			}
			if (url.includes('/tips?')) return Response.json(TIPS)
			return Response.json({})
		}),
	)
	return calls
}

function view(route = '/', can = ALL) {
	return renderStaff(
		<StaffClientProvider orgSlug="acme">
			<LaborPage scopes={SCOPES} can={can} />
		</StaffClientProvider>,
		{ route },
	)
}

describe('LaborPage overview', () => {
	it('names the sales source beside the share and never says met or missed for online orders', async () => {
		stubApi({ source: 'online_orders' })
		view()
		expect(await screen.findByText(/Sales: Online orders only\./)).toBeTruthy()
		expect(screen.getByText(/In-person and other sales are not/)).toBeTruthy()
		// The share is shown (25.0%) and labeled with where it comes from.
		expect((await screen.findAllByText('25.0%')).length).toBeGreaterThan(0)
		expect(screen.getAllByText(/of Online orders only/).length).toBeGreaterThan(
			0,
		)
		expect(screen.getByText(/Target 20%, not applied/)).toBeTruthy()
		expect(screen.queryByText(/over target/)).toBeNull()
		expect(screen.queryByText(/within target/)).toBeNull()
	})

	it('marks the share against the target once the sales are complete', async () => {
		stubApi({ source: 'manual' })
		view()
		expect(await screen.findByText(/Sales: Entered sales\./)).toBeTruthy()
		expect((await screen.findAllByText(/over target/)).length).toBeGreaterThan(
			0,
		)
		expect(screen.getByText(/Target 20%/)).toBeTruthy()
	})

	it('offers to enter sales for a day that has hours and no sales, on a manual source', async () => {
		stubApi({ source: 'manual' })
		view()
		const enter = await screen.findAllByRole('button', { name: 'Enter sales' })
		fireEvent.click(enter[0]!)
		expect(await screen.findByLabelText(/Mar 10/)).toBeTruthy()
	})

	it('says plainly that wages and sales in different currencies are not compared', async () => {
		stubApi({
			summary: summaryFor('manual', {
				currencyMismatch: { costOnly: ['SAR'], salesOnly: ['USD'] },
			}),
		})
		view()
		expect(await screen.findByText(/different currencies/)).toBeTruthy()
		expect(screen.getByText(/never converted/)).toBeTruthy()
	})

	it('shows an empty state with nothing to add up', async () => {
		stubApi({
			summary: summaryFor('online_orders', {
				days: [],
				totals: {
					paidMinutes: 0,
					overtimeMinutes: 0,
					cards: 0,
					salesDays: 0,
					daysWithoutSales: 0,
					money: [],
				},
			}),
		})
		view()
		expect(
			await screen.findByText('No hours or sales in this range'),
		).toBeTruthy()
	})

	it('asks the regional node for the last seven days at the first workplace', async () => {
		const calls = stubApi()
		view()
		await screen.findByText(/Sales:/)
		const summary = calls.find((c) => c.url.includes('/summary?'))!
		expect(summary.url).toContain(
			'https://us.tenant.test/operator/labor/summary',
		)
		const query = new URL(summary.url).searchParams
		expect(query.get('scopeId')).toBe('loc-1')
		const from = new Date(`${query.get('from')}T00:00:00Z`).getTime()
		const to = new Date(`${query.get('to')}T00:00:00Z`).getTime()
		expect((to - from) / 86_400_000).toBe(6)
	})

	it('exports the file the node built', async () => {
		stubApi()
		view()
		fireEvent.click(await screen.findByRole('button', { name: /Export/ }))
		await waitFor(() =>
			expect(download).toHaveBeenCalledWith('labor-summary.csv', 'Date\r\n'),
		)
	})

	it('keeps the settings link out of reach without the settings grant', async () => {
		stubApi()
		view('/', { ...ALL, editSettings: false })
		await screen.findByText(/Sales: Online orders only\./)
		expect(screen.queryByRole('button', { name: 'Change' })).toBeNull()
	})

	it('shows a plain message when the node cannot be reached', async () => {
		stubApi({
			respond: (call) =>
				call.url.includes('/summary?')
					? Response.json({ error: 'Internal Server Error' }, { status: 500 })
					: undefined,
		})
		view()
		expect(await screen.findByRole('alert')).toBeTruthy()
		expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
	})
})

describe('LaborPage sales', () => {
	it('saves a day with the workplace currency and shows it saved', async () => {
		const calls = stubApi({ source: 'manual' })
		view('/?view=sales')
		const box = await screen.findByLabelText(/Mar 10/)
		fireEvent.change(box, { target: { value: '1,250.50' } })
		fireEvent.keyDown(box, { key: 'Enter' })
		await waitFor(() =>
			expect(calls.find((c) => c.method === 'PUT')).toBeTruthy(),
		)
		const put = calls.find((c) => c.method === 'PUT')!
		expect(put.url).toContain('/operator/labor/sales')
		expect(put.body).toEqual({
			scopeId: 'loc-1',
			date: '2026-03-10',
			netSalesMinor: 125_050,
			currency: 'USD',
		})
	})

	it('refuses an amount it cannot read without calling the node', async () => {
		const calls = stubApi({ source: 'manual' })
		view('/?view=sales')
		const box = await screen.findByLabelText(/Mar 10/)
		fireEvent.change(box, { target: { value: 'lots' } })
		fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
		expect(await screen.findByText(/Enter an amount like/)).toBeTruthy()
		expect(calls.some((c) => c.method === 'PUT')).toBe(false)
	})

	it('explains that entered sales are ignored on an online source', async () => {
		stubApi({ source: 'online_orders' })
		view('/?view=sales')
		expect(await screen.findByText(/only used when/)).toBeTruthy()
	})

	it('imports a pasted file, showing what is ready and what was skipped', async () => {
		const calls = stubApi({ source: 'manual' })
		view('/?view=sales')
		fireEvent.click(
			await screen.findByRole('button', { name: /Import a file/ }),
		)
		const dialog = await screen.findByRole('dialog')
		fireEvent.change(within(dialog).getByLabelText('CSV text'), {
			target: {
				value: 'Date,Net sales\n2026-03-08,"1,200.00"\n2026-03-09,800\nbad,5\n',
			},
		})
		expect(
			await within(dialog).findByText(/2 days are ready to import/),
		).toBeTruthy()
		expect(within(dialog).getByText(/1 line was skipped/)).toBeTruthy()
		expect(within(dialog).getByText(/Line 4:/)).toBeTruthy()
		fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }))
		await waitFor(() =>
			expect(calls.find((c) => c.url.includes('/sales/bulk'))).toBeTruthy(),
		)
		const bulk = calls.find((c) => c.url.includes('/sales/bulk'))!
		expect(bulk.body).toEqual({
			scopeId: 'loc-1',
			currency: 'USD',
			entries: [
				{ date: '2026-03-08', netSalesMinor: 120_000, note: null },
				{ date: '2026-03-09', netSalesMinor: 80_000, note: null },
			],
		})
	})

	it('will not import a file with nothing readable in it', async () => {
		stubApi({ source: 'manual' })
		view('/?view=sales')
		fireEvent.click(
			await screen.findByRole('button', { name: /Import a file/ }),
		)
		const dialog = await screen.findByRole('dialog')
		fireEvent.change(within(dialog).getByLabelText('CSV text'), {
			target: { value: 'foo,bar\n1,2' },
		})
		expect(
			await within(dialog).findByText(/Nothing in this file can be imported/),
		).toBeTruthy()
		expect(
			within(dialog).getByRole('button', { name: 'Import' }),
		).toBeDisabled()
	})

	it('is read-only without the timesheet edit grant', async () => {
		stubApi({
			source: 'manual',
			grants: ['read:labor:any', 'read:staff:any'],
		})
		view('/?view=sales', { ...ALL, editSales: false })
		expect(await screen.findByLabelText(/Mar 10/)).toBeDisabled()
		expect(screen.queryByRole('button', { name: /Import a file/ })).toBeNull()
	})
})

describe('LaborPage tips', () => {
	it('shows the pool and each share, and says it is only a report', async () => {
		stubApi()
		view('/?view=tips')
		expect(await screen.findByText('Ana Adams')).toBeTruthy()
		expect(screen.getAllByText('$34.55').length).toBeGreaterThan(0)
		expect(screen.getByText('$19.74')).toBeTruthy()
		expect(screen.getByText('$14.81')).toBeTruthy()
		expect(screen.getByText(/does not pay anyone/)).toBeTruthy()
		expect(screen.getByText(/2 cards are not approved yet/)).toBeTruthy()
		expect(screen.getByText(/Split by hours worked/)).toBeTruthy()
	})

	it('has no Tips tab without the pay and roster grants, and falls back to the overview', async () => {
		stubApi()
		view('/?view=tips', { ...ALL, seeTips: false })
		await screen.findByText(/Sales:/)
		expect(screen.queryByRole('radio', { name: 'Tips' })).toBeNull()
	})

	it('checks percentages add up to 100 before saving the rules', async () => {
		const calls = stubApi({
			respond: (call) =>
				call.url.includes('/tips?')
					? Response.json({
							...TIPS,
							settings: { ...TIPS.settings, splitBasis: 'position_percent' },
						})
					: undefined,
		})
		view('/?view=tips')
		fireEvent.click(await screen.findByRole('button', { name: 'Change rules' }))
		const dialog = await screen.findByRole('dialog')
		fireEvent.change(await within(dialog).findByLabelText('Cook'), {
			target: { value: '60' },
		})
		fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
		expect(
			await within(dialog).findByText('The percentages need to add up to 100.'),
		).toBeTruthy()
		expect(calls.some((c) => c.url.includes('/tips/settings'))).toBe(false)
		// Fix the total and the rules go to the node as basis points.
		fireEvent.change(within(dialog).getByLabelText('Server'), {
			target: { value: '40' },
		})
		fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
		await waitFor(() =>
			expect(calls.find((c) => c.url.includes('/tips/settings'))).toBeTruthy(),
		)
		expect(calls.find((c) => c.url.includes('/tips/settings'))!.body).toEqual({
			scopeId: 'loc-1',
			splitBasis: 'position_percent',
			cadence: 'period',
			cardFeeBp: 300,
			fulfillment: ['pickup'],
			positionPercentBp: { cook: 6000, server: 4000 },
		})
	})
})

describe('LaborPage settings', () => {
	it('saves the sales source and the staffing standards', async () => {
		const calls = stubApi({ source: 'online_orders' })
		view('/?view=settings')
		fireEvent.click(await screen.findByRole('radio', { name: /Sales I enter/ }))
		fireEvent.change(await screen.findByLabelText('Server'), {
			target: { value: '20' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Save' }))
		await waitFor(() =>
			expect(calls.find((c) => c.method === 'PUT')).toBeTruthy(),
		)
		expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
			scopeId: 'loc-1',
			salesSource: 'manual',
			ordersPerLaborHour: { cook: 12.5, server: 20 },
		})
	})

	it('refuses a standard out of range', async () => {
		const calls = stubApi()
		view('/?view=settings')
		fireEvent.change(await screen.findByLabelText('Server'), {
			target: { value: '999' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Save' }))
		expect(await screen.findByText(/Enter orders per hour/)).toBeTruthy()
		expect(calls.some((c) => c.method === 'PUT')).toBe(false)
	})

	it('can be read but not changed without the policy grant', async () => {
		stubApi()
		view('/?view=settings', { ...ALL, editSettings: false })
		expect(
			await screen.findByText(/look at these settings but not change/),
		).toBeTruthy()
		expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
	})
})

describe('LaborPage without a workplace', () => {
	it('says there is nothing to show', () => {
		renderStaff(
			<StaffClientProvider orgSlug="acme">
				<LaborPage scopes={[]} can={ALL} />
			</StaffClientProvider>,
		)
		expect(screen.getByText('No workplaces to show')).toBeTruthy()
	})
})
