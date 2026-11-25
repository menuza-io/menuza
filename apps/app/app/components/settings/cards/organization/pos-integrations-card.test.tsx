// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { SaveBar } from '#app/components/save-bar.tsx'
import { renderStaff } from '#tests/staff-render.tsx'
import { PosIntegrationCard } from './pos-integrations-card.tsx'

describe('PosIntegrationCard (#74 & #94)', () => {
	it('displays "Sync failing" badge and error alert when failing >= 24h while keeping Sync button available', () => {
		renderStaff(
			<PosIntegrationCard
				provider={{
					name: 'doordash',
					kind: 'delivery',
					displayName: 'DoorDash',
					description: 'DoorDash Marketplace',
					icon: 'shopping-bag',
					writeMode: 'menu',
				}}
				integration={{
					id: 'int_dd',
					providerName: 'doordash',
					isActive: true,
					lastSyncAt: '2026-11-23T00:00:00.000Z',
					environment: 'sandbox',
					syncFailing: true,
					lastSyncError: 'The provider is temporarily unavailable.',
				}}
				selectedLocationId="loc_1"
				menus={[{ id: 'menu_1', name: 'All Day' }]}
				doorDashLiveConfigured={false}
			/>,
		)

		expect(screen.getByText('Connected')).toBeInTheDocument()
		expect(screen.getByText('Sync failing')).toBeInTheDocument()
		expect(
			screen.getByText('Menu updates have been failing for over 24 hours.'),
		).toBeInTheDocument()
		expect(
			screen.getByText('The provider is temporarily unavailable.'),
		).toBeInTheDocument()
		expect(
			screen.getByRole('button', { name: /Sync All Day/i }),
		).toBeInTheDocument()
	})

	it('hides "Sync failing" badge when syncFailing is false', () => {
		renderStaff(
			<PosIntegrationCard
				provider={{
					name: 'doordash',
					kind: 'delivery',
					displayName: 'DoorDash',
					description: 'DoorDash Marketplace',
					icon: 'shopping-bag',
					writeMode: 'menu',
				}}
				integration={{
					id: 'int_dd',
					providerName: 'doordash',
					isActive: true,
					lastSyncAt: '2026-11-24T12:00:00.000Z',
					environment: 'sandbox',
					syncFailing: false,
					lastSyncError: null,
				}}
				selectedLocationId="loc_1"
				menus={[{ id: 'menu_1', name: 'All Day' }]}
				doorDashLiveConfigured={false}
			/>,
		)

		expect(screen.getByText('Connected')).toBeInTheDocument()
		expect(screen.queryByText('Sync failing')).not.toBeInTheDocument()
	})

	it('hides Sync history button when canManageIntegrations is false', () => {
		renderStaff(
			<PosIntegrationCard
				provider={{
					name: 'square',
					kind: 'pos',
					displayName: 'Square',
					description: 'Square POS',
					icon: 'credit-card',
					writeMode: 'item',
				}}
				integration={{
					id: 'int_sq',
					providerName: 'square',
					isActive: true,
					lastSyncAt: '2026-11-24T12:00:00.000Z',
					environment: 'sandbox',
				}}
				selectedLocationId="loc_1"
				menus={[{ id: 'menu_1', name: 'All Day' }]}
				doorDashLiveConfigured={false}
				canManageIntegrations={false}
			/>,
		)

		expect(
			screen.queryByRole('button', { name: /Sync history/i }),
		).not.toBeInTheDocument()
	})

	it('opens Sync history sheet, filters Failures only, paginates, and retries a failed sync', async () => {
		i18n.load('en', {})
		i18n.activate('en')

		const entries: Array<{
			id: string
			action: string
			kind: string
			status: string
			itemCounts: Record<string, unknown> | null
			errorMessage: string | null
			createdAt: string
			retryable: boolean
		}> = [
			{
				id: 'log_err_1',
				action: 'pos_push',
				kind: 'push',
				status: 'error',
				itemCounts: { menuName: 'All Day', pushed: 0 },
				errorMessage: 'Rate limit reached. We will retry on the next sync.',
				createdAt: '2026-11-24T12:05:00.000Z',
				retryable: true,
			},
			{
				id: 'log_ok_1',
				action: 'pos_import',
				kind: 'import',
				status: 'success',
				itemCounts: { menuName: 'All Day', created: 4, updated: 2, skipped: 1 },
				errorMessage: null,
				createdAt: '2026-11-24T12:00:00.000Z',
				retryable: false,
			},
		]

		const historyLoaderSpy = vi.fn(({ request }: { request: Request }) => {
			const url = new URL(request.url)
			const page = Number(url.searchParams.get('page') ?? '1')
			const failuresOnly = url.searchParams.get('status') === 'error'
			if (failuresOnly) {
				return Response.json({
					entries: entries.filter((e) => e.status === 'error'),
					page,
					pageSize: 50,
					hasMore: false,
				})
			}
			if (page === 2) {
				return Response.json({
					entries: [
						{
							id: 'log_avail_2',
							action: 'pos_availability',
							kind: 'availability',
							status: 'success',
							itemCounts: { available: false, pushed: 1 },
							errorMessage: null,
							createdAt: '2026-11-24T11:00:00.000Z',
							retryable: false,
						},
					],
					page: 2,
					pageSize: 50,
					hasMore: false,
				})
			}
			return Response.json({
				entries,
				page: 1,
				pageSize: 50,
				hasMore: true,
			})
		})

		const retryActionSpy = vi.fn(async ({ request }: { request: Request }) => {
			const formData = await request.formData()
			if (
				formData.get('intent') === 'retry' &&
				formData.get('logId') === 'log_err_1'
			) {
				entries.unshift({
					id: 'log_ok_retry',
					action: 'pos_push',
					kind: 'push',
					status: 'success',
					itemCounts: { menuName: 'All Day', pushed: 5 },
					errorMessage: null,
					createdAt: '2026-11-24T12:10:00.000Z',
					retryable: false,
				})
				return Response.json({ ok: true, mode: 'direct', pushed: 5 })
			}
			return Response.json({ ok: false, error: 'Bad request' }, { status: 400 })
		})

		const router = createMemoryRouter(
			[
				{
					path: '/:orgSlug/settings/integrations',
					element: (
						<PosIntegrationCard
							provider={{
								name: 'doordash',
								kind: 'delivery',
								displayName: 'DoorDash',
								description: 'DoorDash Marketplace',
								icon: 'shopping-bag',
								writeMode: 'menu',
							}}
							integration={{
								id: 'int_dd',
								providerName: 'doordash',
								isActive: true,
								lastSyncAt: '2026-11-24T12:00:00.000Z',
								environment: 'sandbox',
							}}
							selectedLocationId="loc_1"
							menus={[{ id: 'menu_1', name: 'All Day' }]}
							doorDashLiveConfigured={false}
							canManageIntegrations={true}
							orgSlug="bistro"
						/>
					),
				},
				{
					path: '/:orgSlug/settings/integrations/:integrationId/history',
					loader: historyLoaderSpy,
					action: retryActionSpy,
				},
			],
			{ initialEntries: ['/bistro/settings/integrations'] },
		)

		render(
			<I18nProvider i18n={i18n}>
				<RouterProvider router={router} />
				<SaveBar />
			</I18nProvider>,
		)

		fireEvent.click(screen.getByRole('button', { name: /Sync history/i }))

		await waitFor(() => {
			expect(screen.getByText('DoorDash sync history')).toBeInTheDocument()
			expect(
				screen.getByText('Rate limit reached. We will retry on the next sync.'),
			).toBeInTheDocument()
		})
		expect(screen.getByText('4 created')).toBeInTheDocument()
		expect(screen.getByText('2 updated')).toBeInTheDocument()
		expect(screen.getByText('1 unchanged')).toBeInTheDocument()

		// Pagination Next -> page 2
		fireEvent.click(screen.getByRole('button', { name: /^Next$/i }))
		await waitFor(() => {
			expect(screen.getByText('Marked unavailable')).toBeInTheDocument()
		})

		// Filter toggle: Failures only
		fireEvent.click(screen.getByRole('button', { name: /Failures only/i }))
		await waitFor(() => {
			expect(
				screen.getByText('Rate limit reached. We will retry on the next sync.'),
			).toBeInTheDocument()
			expect(screen.queryByText('4 created')).not.toBeInTheDocument()
		})

		// Retry failed push
		fireEvent.click(screen.getByRole('button', { name: /^Retry$/i }))
		await waitFor(() => {
			expect(retryActionSpy).toHaveBeenCalledTimes(1)
			expect(screen.getByRole('button', { name: /^Retry$/i })).toBeEnabled()
		})

		// Turn off Failures only and confirm retried success entry is shown
		fireEvent.click(screen.getByRole('button', { name: /Failures only/i }))
		await waitFor(() => {
			expect(screen.getByText('5 pushed')).toBeInTheDocument()
		})
	})

	it('renders delivery pause badge in location timezone and platform_pause_failed + Retry button (#95)', () => {
		i18n.load('en', {})
		i18n.activate('en')

		const router = createMemoryRouter(
			[
				{
					path: '/:orgSlug/settings/integrations',
					element: (
						<div className="grid gap-4">
							<PosIntegrationCard
								provider={{
									name: 'ubereats',
									kind: 'delivery',
									displayName: 'Uber Eats',
									description: 'Uber Eats Marketplace',
									icon: 'shopping-bag',
									writeMode: 'menu',
								}}
								integration={{
									id: 'int_uber',
									providerName: 'ubereats',
									isActive: true,
									lastSyncAt: '2026-11-24T12:00:00.000Z',
									environment: 'sandbox',
									pausedUntil: '2026-11-24T18:30:00.000Z',
									pauseOpenEnded: false,
									lastPauseError: null,
								}}
								selectedLocationId="loc_1"
								locationTimezone="America/New_York"
								deliveryPauseEnabled={true}
								menus={[{ id: 'menu_1', name: 'All Day' }]}
								doorDashLiveConfigured={false}
							/>
							<PosIntegrationCard
								provider={{
									name: 'doordash',
									kind: 'delivery',
									displayName: 'DoorDash',
									description: 'DoorDash Marketplace',
									icon: 'shopping-bag',
									writeMode: 'menu',
								}}
								integration={{
									id: 'int_dd',
									providerName: 'doordash',
									isActive: true,
									lastSyncAt: '2026-11-24T12:00:00.000Z',
									environment: 'sandbox',
									pausedUntil: null,
									pauseOpenEnded: true,
									lastPauseError: 'The provider is temporarily unavailable.',
								}}
								selectedLocationId="loc_1"
								locationTimezone="America/New_York"
								deliveryPauseEnabled={true}
								menus={[{ id: 'menu_1', name: 'All Day' }]}
								doorDashLiveConfigured={false}
							/>
						</div>
					),
				},
			],
			{ initialEntries: ['/bistro/settings/integrations'] },
		)

		render(
			<I18nProvider i18n={i18n}>
				<RouterProvider router={router} />
			</I18nProvider>,
		)

		// 18:30 UTC == 13:30 America/New_York
		expect(screen.getByText('Paused until 13:30')).toBeInTheDocument()
		expect(screen.getByText('Paused until resumed')).toBeInTheDocument()
		expect(screen.getByText('Delivery pause update failed')).toBeInTheDocument()
		expect(
			screen.getByText('The provider is temporarily unavailable.'),
		).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /^Retry$/i })).toBeInTheDocument()
	})

	it('renders Store settings sheet with menu checkboxes, holiday hours toggle, readiness links, and Go live button (#96)', async () => {
		i18n.load('en', {})
		i18n.activate('en')

		const router = createMemoryRouter(
			[
				{
					path: '/bistro/settings/integrations',
					element: (
						<PosIntegrationCard
							provider={{
								name: 'ubereats',
								kind: 'delivery',
								displayName: 'Uber Eats',
								description: 'Uber Eats Marketplace',
								icon: 'shopping-bag',
								writeMode: 'menu',
							}}
							integration={{
								id: 'int_uber',
								providerName: 'ubereats',
								isActive: true,
								lastSyncAt: '2026-11-24T12:00:00.000Z',
								environment: 'sandbox',
								managedByPos: false,
								storeSettings: {
									menuIds: ['menu_1'],
									holidaySync: true,
									live: false,
									menuLimit: 5,
								},
								readiness: {
									ready: false,
									managedByPos: false,
									reasons: [
										{
											code: 'zero_price',
											message: '1 published dish has a $0 price.',
											href: '/bistro/menu/items?health=zero_price',
										},
									],
								},
							}}
							selectedLocationId="loc_1"
							storeSettingsEnabled={true}
							menus={[
								{ id: 'menu_1', name: 'Lunch' },
								{ id: 'menu_2', name: 'Dinner' },
							]}
							doorDashLiveConfigured={false}
						/>
					),
				},
			],
			{ initialEntries: ['/bistro/settings/integrations'] },
		)

		render(
			<I18nProvider i18n={i18n}>
				<RouterProvider router={router} />
			</I18nProvider>,
		)

		fireEvent.click(screen.getByRole('button', { name: /Store settings/i }))

		await waitFor(() => {
			expect(screen.getByText('Uber Eats store settings')).toBeInTheDocument()
		})
		expect(screen.getByText('Lunch')).toBeInTheDocument()
		expect(screen.getByText('Dinner')).toBeInTheDocument()
		expect(screen.getByText('Holiday hours sync')).toBeInTheDocument()
		expect(
			screen.getByText('1 published dish has a $0 price.'),
		).toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'Fix' })).toHaveAttribute(
			'href',
			'/bistro/menu/items?health=zero_price',
		)
		expect(screen.getByRole('button', { name: 'Go live' })).toBeDisabled()
	})

	it('renders delivery menu check status badges, Check now, View differences sheet, Changed in POS badge, and Fix by pushing (#144)', async () => {
		i18n.load('en', {})
		i18n.activate('en')

		const router = createMemoryRouter(
			[
				{
					path: '/bistro/settings/integrations',
					element: (
						<div className="grid gap-4">
							<PosIntegrationCard
								provider={{
									name: 'ubereats',
									kind: 'delivery',
									displayName: 'Uber Eats',
									description: 'Uber Eats Marketplace',
									icon: 'shopping-bag',
									writeMode: 'menu',
								}}
								integration={{
									id: 'int_uber',
									providerName: 'ubereats',
									isActive: true,
									lastSyncAt: '2026-11-24T12:00:00.000Z',
									environment: 'sandbox',
									menuCheck: {
										lastCheckedAt: '2026-11-24T03:00:00.000Z',
										lastAttemptAt: '2026-11-24T03:00:00.000Z',
										lastStatus: 'diff',
										diffCount: 2,
										posChangedCount: 1,
										lastError: null,
										manualChecksToday: 0,
										manualChecksLimit: 3,
										diffs: [
											{
												kind: 'price',
												dishName: 'Hummus',
												localPrice: 800,
												remotePrice: 950,
												changedInPos: false,
											},
											{
												kind: 'missing',
												dishName: 'Falafel',
												changedInPos: false,
											},
											{
												kind: 'available',
												dishName: 'POS Shawarma',
												localAvailable: true,
												remoteAvailable: false,
												changedInPos: true,
											},
										],
									},
								}}
								selectedLocationId="loc_1"
								menuCheckEnabled={true}
								menus={[{ id: 'menu_1', name: 'Lunch' }]}
								doorDashLiveConfigured={false}
							/>
							<PosIntegrationCard
								provider={{
									name: 'doordash',
									kind: 'delivery',
									displayName: 'DoorDash',
									description: 'DoorDash Marketplace',
									icon: 'shopping-bag',
									writeMode: 'menu',
								}}
								integration={{
									id: 'int_dd',
									providerName: 'doordash',
									isActive: true,
									lastSyncAt: '2026-11-24T12:00:00.000Z',
									environment: 'sandbox',
									menuCheck: {
										lastCheckedAt: '2026-11-24T03:00:00.000Z',
										lastAttemptAt: '2026-11-24T04:00:00.000Z',
										lastStatus: 'error',
										diffCount: 0,
										posChangedCount: 0,
										lastError: 'Could not check',
										manualChecksToday: 1,
										manualChecksLimit: 3,
										diffs: [],
									},
								}}
								selectedLocationId="loc_1"
								menuCheckEnabled={true}
								menus={[{ id: 'menu_1', name: 'Lunch' }]}
								doorDashLiveConfigured={false}
							/>
						</div>
					),
				},
			],
			{ initialEntries: ['/bistro/settings/integrations'] },
		)

		render(
			<I18nProvider i18n={i18n}>
				<RouterProvider router={router} />
			</I18nProvider>,
		)

		expect(screen.getByText('2 differences')).toBeInTheDocument()
		expect(screen.getByText('Could not check')).toBeInTheDocument()
		expect(screen.getAllByRole('button', { name: /Check now/i })).toHaveLength(
			2,
		)

		fireEvent.click(screen.getByRole('button', { name: /View differences/i }))

		await waitFor(() => {
			expect(screen.getByText('Uber Eats menu differences')).toBeInTheDocument()
		})
		expect(screen.getByText('Hummus')).toBeInTheDocument()
		expect(screen.getByText('Falafel')).toBeInTheDocument()
		expect(screen.getByText('POS Shawarma')).toBeInTheDocument()
		expect(screen.getByText('Changed in POS')).toBeInTheDocument()
		expect(
			screen.getByRole('button', { name: /Fix by pushing/i }),
		).toBeInTheDocument()
	})
})
