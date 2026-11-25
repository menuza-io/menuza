// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrderingControls } from './ordering-controls.tsx'

const location = {
	id: 'loc_1',
	name: 'Downtown',
	timezone: 'America/New_York',
	pausedAt: null,
	pausedUntil: null,
	busyExtraPrepMinutes: 0,
	busyUntil: null,
	prepTime: 15,
	variablePrepMinutes: null,
	variablePrepUntil: null,
}

const entry = {
	id: 'loc_1:1',
	locationId: 'loc_1',
	locationName: 'Downtown',
	currency: 'USD',
	timeZone: 'America/New_York',
	current: false,
	startedAt: Date.UTC(2026, 10, 20, 23, 0),
	endedAt: Date.UTC(2026, 10, 21, 0, 40),
	minutesPaused: 100,
	plans: [
		{
			from: Date.UTC(2026, 10, 20, 23, 0),
			to: Date.UTC(2026, 10, 21, 0, 40),
			weeks: [1, 2, 3, 4].map((week) => ({
				from: Date.UTC(2026, 10, 20 - 7 * week, 23, 0),
				to: Date.UTC(2026, 10, 21 - 7 * week, 0, 40),
			})),
			weeksSkipped: 0,
			weekday: 5,
			localFrom: '18:00',
			localTo: '19:40',
		},
	],
}

function stubFetch(answer: unknown, planEntries: unknown[] = [entry]) {
	const calls: string[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			calls.push(`${init?.method ?? 'GET'} ${url}`)
			if (url.includes('/missed-sales-plan')) {
				return Response.json({ entries: planEntries })
			}
			if (url.endsWith('/reports/token')) return Response.json({ token: 'jwt' })
			if (url.endsWith('/analytics/missed-estimate')) return Response.json(answer)
			return new Response('not found', { status: 404 })
		}),
	)
	return calls
}

function renderControls(tenantApiUrl: string | null) {
	i18n.load('en', {})
	i18n.activate('en')
	const router = createMemoryRouter(
		[
			{
				path: '/:orgSlug/orders',
				element: (
					<OrderingControls
						orgSlug="bistro"
						canWrite
						locations={[location]}
						tenantApiUrl={tenantApiUrl}
					/>
				),
			},
		],
		{ initialEntries: ['/bistro/orders'] },
	)
	return render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
}

afterEach(() => vi.unstubAllGlobals())

describe('the pause card estimate (#176)', () => {
	it('shows what the last pause missed, as an estimate, with the period it rests on', async () => {
		const calls = stubFetch({
			estimates: [
				{ id: 'loc_1:1|0', enough: true, orders: 14, salesMinor: 41000, weeksUsed: 4 },
			],
		})
		renderControls('https://region.test')
		const note = await screen.findByTestId('missed-sales-loc_1')
		expect(note.textContent).toMatch(/about 14 orders/)
		expect(note.textContent).toMatch(/\$410\.00/)
		expect(note.textContent).toMatch(/Estimate/)
		expect(note.textContent).toMatch(/18:00 to 19:40/)
		expect(note.textContent).toMatch(/last 4 weeks/)
		// Windows only go to the region; no order, name or contact.
		const posted = calls.find((call) => call.startsWith('POST'))
		expect(posted).toBe('POST https://region.test/analytics/missed-estimate')
	})

	it('shows no figure with less than two usable weeks', async () => {
		stubFetch({
			estimates: [{ id: 'loc_1:1|0', enough: false, weeksUsed: 1 }],
		})
		renderControls('https://region.test')
		const note = await screen.findByTestId('missed-sales-loc_1')
		expect(note.textContent).toMatch(/not enough history yet/i)
		expect(note.textContent).not.toMatch(/\$/)
	})

	it('shows nothing, and asks nobody, without a region or without a pause to estimate', async () => {
		const calls = stubFetch({ estimates: [] })
		renderControls(null)
		expect(calls).toEqual([])
		expect(screen.queryByTestId('missed-sales-loc_1')).toBeNull()
	})

	it('shows nothing when the member has no report grant (the plan route answers 404)', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('Not Found', { status: 404 })),
		)
		renderControls('https://region.test')
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(screen.queryByTestId('missed-sales-loc_1')).toBeNull()
	})
})
