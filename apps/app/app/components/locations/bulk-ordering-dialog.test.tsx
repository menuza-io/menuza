// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it } from 'vitest'
import { BulkOrderingDialog } from './bulk-ordering-dialog.tsx'

describe('BulkOrderingDialog (#365)', () => {
	it('submits the selected locations once and shows how many were done, with skipped and failed ones listed', async () => {
		i18n.load('en', {})
		i18n.activate('en')
		const posted: unknown[] = []
		const router = createMemoryRouter(
			[
				{
					path: '*',
					action: async ({ request }) => {
						const form = await request.formData()
						posted.push(JSON.parse(String(form.get('payload'))))
						return {
							ok: true,
							bulk: {
								action: 'pause',
								total: 3,
								done: 1,
								skipped: 1,
								failed: 1,
								locations: [
									{ locationId: 'a', name: 'Alpha', status: 'done' },
									{
										locationId: 'b',
										name: 'Beta',
										status: 'skipped',
										reason: 'not_manageable',
									},
									{
										locationId: 'c',
										name: 'Gamma',
										status: 'failed',
										reason: 'failed',
									},
								],
							},
						}
					},
					element: (
						<BulkOrderingDialog
							open
							onOpenChange={() => {}}
							action="pause"
							locationIds={['a', 'b', 'c']}
							locationCount={3}
						/>
					),
				},
			],
			{ initialEntries: ['/'] },
		)
		render(
			<I18nProvider i18n={i18n}>
				<RouterProvider router={router} />
			</I18nProvider>,
		)
		fireEvent.click(screen.getByRole('button', { name: 'Pause ordering' }))
		await waitFor(() =>
			expect(screen.getByTestId('bulk-progress')).toBeInTheDocument(),
		)
		expect(screen.getByTestId('bulk-progress')).toHaveTextContent(
			'1 of 3 paused',
		)
		const result = screen.getByTestId('bulk-ordering-result')
		expect(result).toHaveTextContent('Beta')
		expect(result).toHaveTextContent('skipped')
		expect(result).toHaveTextContent('Gamma')
		expect(result).toHaveTextContent('failed')
		// One request carries every selected location.
		expect(posted).toEqual([
			{ action: 'pause', locationIds: ['a', 'b', 'c'], duration: '60m' },
		])
	})
})
