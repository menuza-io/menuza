// @vitest-environment jsdom

import { screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StaffClientProvider } from '#app/components/staff/staff-client-provider.tsx'
import { type StaffAssignmentRow } from '#app/utils/staffing/staff-types.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { useStaffAttention } from './use-staff-attention.ts'

afterEach(async () => {
	// Let the token mint that every mounted provider starts finish while fetch
	// is still stubbed; otherwise it lands on the real fetch and MSW warns.
	await new Promise((resolve) => setTimeout(resolve, 0))
	vi.unstubAllGlobals()
})

const GRANTS = ['read:hiring:any', 'update:hiring:any']

function inDays(days: number): string {
	const date = new Date()
	date.setDate(date.getDate() + days)
	const month = String(date.getMonth() + 1).padStart(2, '0')
	const day = String(date.getDate()).padStart(2, '0')
	return `${date.getFullYear()}-${month}-${day}`
}

function task(id: string, status: string, dueDate: string | null = null) {
	return {
		id,
		staffId: 's1',
		taskKey: null,
		title: `Task ${id}`,
		type: 'custom',
		instructions: null,
		linkUrl: null,
		assignee: 'manager',
		assigneeUserId: null,
		templateId: null,
		status,
		dueDate,
		sortOrder: 1,
		source: 'manual',
		completedAt: null,
		completedBy: null,
		createdAt: 1,
	}
}

function certificate(id: string, kind: string, expiresOn: string | null) {
	return {
		id,
		staffId: 's1',
		kind,
		label: null,
		issuedOn: null,
		expiresOn,
		note: null,
		createdAt: 1,
		updatedAt: 1,
	}
}

function stubApi(options: {
	tasks?: ReturnType<typeof task>[]
	certificates?: ReturnType<typeof certificate>[]
}) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input)
			if (url.includes('/staff/token')) {
				return Response.json({
					jwt: 'jwt',
					tenantApiUrl: 'https://us.tenant.test',
					scope: 'hiring',
					grants: GRANTS,
					expiresAt: Date.now() + 600_000,
				})
			}
			if (url.includes('/onboarding/staff/')) {
				return Response.json({ tasks: options.tasks ?? [] })
			}
			if (url.includes('/certificates/staff/')) {
				return Response.json({ certificates: options.certificates ?? [] })
			}
			return Response.json({})
		}),
	)
}

function assignment(
	scopeId: string,
	overrides: Partial<StaffAssignmentRow> = {},
): StaffAssignmentRow {
	return {
		id: `a-${scopeId}`,
		staffId: 's1',
		scopeId,
		isPrimary: true,
		showInSchedule: true,
		eligibleOpenShifts: true,
		includeInClockErrors: true,
		canWaiveBreaks: false,
		active: true,
		hasPin: true,
		pinSetAt: 1,
		...overrides,
	}
}

const NAMES = new Map([
	['downtown', 'Downtown'],
	['riverside', 'Riverside'],
])

function Probe({
	assignments,
	hiring = true,
	terminated = false,
}: {
	assignments: StaffAssignmentRow[]
	hiring?: boolean
	terminated?: boolean
}) {
	const { items, badges } = useStaffAttention({
		staffId: 's1',
		assignments,
		scopeNames: NAMES,
		hiring,
		terminated,
	})
	return (
		<div>
			<ul>
				{items.map((item) => (
					<li key={item.key} data-urgent={item.urgent}>
						{item.message}|{item.section}
					</li>
				))}
			</ul>
			<p data-testid="badges">{JSON.stringify(badges)}</p>
		</div>
	)
}

function view(props: Parameters<typeof Probe>[0]) {
	return renderStaff(
		<StaffClientProvider orgSlug="acme">
			<Probe {...props} />
		</StaffClientProvider>,
	)
}

describe('useStaffAttention', () => {
	it('names an expiring certificate, open onboarding tasks and a missing PIN', async () => {
		stubApi({
			tasks: [
				task('1', 'done'),
				task('2', 'todo', inDays(5)),
				task('3', 'todo', inDays(9)),
			],
			certificates: [certificate('c1', 'alcohol_service', inDays(12))],
		})
		view({
			assignments: [
				assignment('downtown'),
				assignment('riverside', { hasPin: false, pinSetAt: null }),
			],
		})
		await screen.findByText(/expires in 12 days\|certificates/)
		expect(
			screen.getByText('2 onboarding tasks are still open|onboarding'),
		).toBeTruthy()
		expect(screen.getByText('No PIN at Riverside yet|access')).toBeTruthy()
		const badges = JSON.parse(screen.getByTestId('badges').textContent ?? '{}')
		expect(badges).toEqual({
			certificates: { count: 1, urgent: false },
			onboarding: { count: 2, urgent: false },
			access: { count: 1, urgent: false },
		})
	})

	it('marks late tasks and expired certificates as urgent', async () => {
		stubApi({
			tasks: [task('1', 'todo', inDays(-3))],
			certificates: [certificate('c1', 'food_handler', inDays(-2))],
		})
		view({ assignments: [assignment('downtown')] })
		const expired = await screen.findByText(/has expired\|certificates/)
		expect(expired.getAttribute('data-urgent')).toBe('true')
		const late = screen.getByText(/onboarding tasks? .*late|1 onboarding task/)
		expect(late).toBeTruthy()
		await waitFor(() =>
			expect(screen.getByTestId('badges').textContent).toContain(
				'"onboarding":{"count":1,"urgent":true}',
			),
		)
	})

	it('says nothing when everything is in order, and nothing for someone who left', async () => {
		stubApi({
			tasks: [task('1', 'done')],
			certificates: [certificate('c1', 'food_handler', inDays(300))],
		})
		view({ assignments: [assignment('downtown')] })
		await waitFor(() =>
			expect(screen.getByTestId('badges').textContent).toBe('{}'),
		)
		expect(screen.queryAllByRole('listitem')).toHaveLength(0)
	})

	it('only reports PINs when Hiring is off, and never for someone who left', async () => {
		stubApi({ tasks: [task('1', 'todo')] })
		view({
			assignments: [assignment('downtown', { hasPin: false, pinSetAt: null })],
			hiring: false,
		})
		await screen.findByText('No PIN at Downtown yet|access')
		expect(screen.queryByText(/onboarding/)).toBeNull()
	})

	it('reports nothing at all for someone who has left', async () => {
		stubApi({})
		view({
			assignments: [assignment('downtown', { hasPin: false, pinSetAt: null })],
			terminated: true,
		})
		await waitFor(() =>
			expect(screen.getByTestId('badges').textContent).toBe('{}'),
		)
		expect(screen.queryAllByRole('listitem')).toHaveLength(0)
	})
})
