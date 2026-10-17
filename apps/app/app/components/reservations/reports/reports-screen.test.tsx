// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import {
	apiError,
	createScriptedClient,
	type ScriptedCall,
} from '../scripted-test-client.ts'
import { ReportsScreen } from './reports-screen.tsx'

const range = { from: '2026-04-14', to: '2026-04-20', serviceId: null }
const services = [
	{ id: 'svc_lunch', name: 'Lunch' },
	{ id: 'svc_dinner', name: 'Dinner' },
]

const BODIES: Record<string, unknown> = {
	summary: {
		range,
		services,
		totals: { parties: 3, covers: 9 },
		byService: [
			{ serviceId: 'svc_dinner', name: 'Dinner', parties: 3, covers: 9 },
		],
		bySource: [{ channel: 'online', parties: 3, covers: 9 }],
		byPartySize: [{ partySize: 3, parties: 3, covers: 9 }],
		byStatus: [{ status: 'booked', parties: 3, covers: 9 }],
	},
	'no-shows': {
		range,
		services,
		total: 1,
		covers: 2,
		rate: 12.5,
		byService: [],
		byPartySize: [],
		rows: [],
	},
	cancellations: {
		range,
		services,
		total: 2,
		late: 1,
		regular: 1,
		covers: 4,
		byCancelledBy: [{ cancelledBy: 'guest', parties: 2, covers: 4 }],
		rows: [],
	},
	'turn-times': {
		range,
		services,
		total: 4,
		actualAvgMin: 72.5,
		byPartySize: [
			{
				partySize: 2,
				count: 4,
				actualAvgMin: 72.5,
				configuredMin: 60,
				bookedAvgMin: 60,
				varianceMin: 12.5,
			},
		],
		configured: [],
	},
	waitlist: {
		range,
		services,
		total: 2,
		byOutcome: [{ outcome: 'seated', parties: 2, covers: 4 }],
		quotedAvgMin: 20,
		actualAvgMin: 25,
		rows: [],
	},
	pacing: {
		range,
		services,
		totals: { bookings: 2, covers: 6 },
		byService: [],
		slots: [],
		limits: [],
	},
}

const EMPTY: Record<string, unknown> = {
	summary: {
		range,
		services,
		totals: { parties: 0, covers: 0 },
		byService: [],
		bySource: [],
		byPartySize: [],
		byStatus: [],
	},
}

function setup(reply?: (call: ScriptedCall, kind: string) => unknown) {
	const fake = createScriptedClient((call) => {
		const kind = call.path.split('/').pop()!
		return reply ? reply(call, kind) : BODIES[kind]
	})
	renderStaff(
		<ReportsScreen
			client={fake.client}
			locationId="loc_1"
			today="2026-04-20"
		/>,
	)
	return fake
}

describe('ReportsScreen', () => {
	it('offers exactly the six module reports', async () => {
		setup()
		await screen.findByTestId('report-summary')
		const tabs = screen
			.getByTestId('report-tabs')
			.querySelectorAll('[role="tab"]')
		expect([...tabs].map((tab) => tab.textContent)).toEqual([
			'Summary',
			'No-shows',
			'Cancellations',
			'Turn times',
			'Waitlist',
			'Pacing',
		])
	})

	it('runs the summary for the last seven days at the active location', async () => {
		const { calls } = setup()
		await screen.findByTestId('report-summary')
		expect(calls[0]).toMatchObject({
			path: '/operator/reservations/reports/summary',
			query: { locationId: 'loc_1', from: '2026-04-14', to: '2026-04-20' },
		})
		expect(screen.getByTestId('report-total-parties')).toHaveTextContent('3')
		expect(screen.getByTestId('report-total-covers')).toHaveTextContent('9')
	})

	it.each([
		['no-shows', 'report-no-shows'],
		['cancellations', 'report-cancellations'],
		['turn-times', 'report-turn-times'],
		['waitlist', 'report-waitlist'],
		['pacing', 'report-pacing'],
	])('renders the %s report', async (kind, testId) => {
		const { calls } = setup()
		await screen.findByTestId('report-summary')
		fireEvent.click(screen.getByTestId(`report-tab-${kind}`))
		expect(await screen.findByTestId(testId)).toBeInTheDocument()
		expect(calls.at(-1)!.path).toBe(`/operator/reservations/reports/${kind}`)
	})

	it('re-runs with the chosen dates and service', async () => {
		const { calls } = setup()
		await screen.findByTestId('report-summary')
		await screen.findByRole('option', { name: 'Dinner' })
		fireEvent.change(screen.getByTestId('report-service'), {
			target: { value: 'svc_dinner' },
		})
		await waitFor(() =>
			expect(calls.at(-1)!.query).toMatchObject({ serviceId: 'svc_dinner' }),
		)
		fireEvent.change(screen.getByTestId('report-from'), {
			target: { value: '2026-04-01' },
		})
		await waitFor(() =>
			expect(calls.at(-1)!.query).toMatchObject({
				from: '2026-04-01',
				serviceId: 'svc_dinner',
			}),
		)
	})

	it('sends no service to the waitlist report, which has none', async () => {
		const { calls } = setup()
		await screen.findByTestId('report-summary')
		await screen.findByRole('option', { name: 'Dinner' })
		fireEvent.change(screen.getByTestId('report-service'), {
			target: { value: 'svc_dinner' },
		})
		fireEvent.click(screen.getByTestId('report-tab-waitlist'))
		await screen.findByTestId('report-waitlist')
		expect(calls.at(-1)!.query?.serviceId).toBeUndefined()
	})

	it('renders zeros for an empty range, not an error', async () => {
		setup((_call, kind) => EMPTY[kind])
		expect(await screen.findByTestId('report-total-parties')).toHaveTextContent(
			'0',
		)
		expect(screen.queryByTestId('report-error')).not.toBeInTheDocument()
		expect(
			screen.getAllByText('No bookings in this range.').length,
		).toBeGreaterThan(0)
	})

	it('explains a refused range', async () => {
		setup(() => apiError(400, 'range_too_long'))
		expect(await screen.findByTestId('report-error')).toHaveTextContent(
			'at most 366 days',
		)
	})

	it('says so when the report grant is missing', async () => {
		setup(() => apiError(403, 'missing_grant'))
		expect(await screen.findByTestId('report-error')).toHaveTextContent(
			'do not have access',
		)
	})
})
