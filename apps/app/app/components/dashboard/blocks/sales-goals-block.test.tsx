// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SalesGoalsBlock } from './sales-goals-block.tsx'

describe('SalesGoalsBlock', () => {
	beforeEach(() => {
		i18n.load('en', {})
		i18n.activate('en')
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url.includes('/reports/token')) {
					return new Response(JSON.stringify({ token: 'tok' }), { status: 200 })
				}
				if (url.includes('/goals/progress')) {
					return new Response(
						JSON.stringify({
							progress: [
								{
									locationId: 'loc1',
									locationName: 'Main',
									goalMinor: 100_00,
									actualMinor: 0,
									currency: 'USD',
									projection: { kind: 'too_early' },
								},
							],
						}),
						{ status: 200 },
					)
				}
				if (url.includes('/analytics/month-sales')) {
					return new Response(JSON.stringify({ byLocation: { loc1: 50_00 } }), {
						status: 200,
					})
				}
				return new Response('{}', { status: 404 })
			}),
		)
	})

	afterEach(() => {
		cleanup()
		vi.unstubAllGlobals()
	})

	it('shows month-to-date progress when a goal exists', async () => {
		render(
			<I18nProvider i18n={i18n}>
				<SalesGoalsBlock
					orgSlug="acme"
					access={{
						available: true,
						tokenUrl: '/acme/reports/token',
						tenantApiUrl: 'http://tenant.test',
						goalsUrl: '/acme/goals/progress',
					}}
				/>
			</I18nProvider>,
		)
		await waitFor(() =>
			expect(screen.getByTestId('sales-goals-progress')).toBeInTheDocument(),
		)
	})
})
