// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, within } from '@testing-library/react'
import { type ComponentProps } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { IntegrationsCard } from './integrations-card'
import { type ReviewIntegrationItem } from './review-integrations-card'

const availableProviders = (
	[
		['slack', 'Slack'],
		['jira', 'Jira'],
		['linear', 'Linear'],
		['gitlab', 'GitLab'],
		['clickup', 'ClickUp'],
		['notion', 'Notion'],
		['asana', 'Asana'],
		['trello', 'Trello'],
		['github', 'GitHub'],
	] satisfies Array<[string, string]>
).map(([name, displayName]) => ({
	name,
	type: 'productivity',
	displayName,
	description: `Connect to ${displayName}`,
	icon: 'link',
}))

const reviewProviders: ReviewIntegrationItem[] = (
	[
		['google-business-profile', 'Google Business Profile'],
		['yelp', 'Yelp'],
		['tripadvisor', 'TripAdvisor'],
		['deliveroo', 'Deliveroo'],
		['just-eat', 'Just Eat'],
		['opentable', 'OpenTable'],
		['resy', 'Resy'],
	] satisfies Array<[string, string]>
).map(([name, displayName]) => ({
	name,
	displayName,
	description: `Connect to ${displayName}`,
	icon: 'link',
	isActive: false,
	locations: [],
	error: null,
}))

const availablePosProviders = (
	[
		['clover', 'Clover', 'pos'],
		['square', 'Square', 'pos'],
		['toast', 'Toast', 'pos'],
		['ubereats', 'Uber Eats', 'delivery'],
		['doordash', 'DoorDash', 'delivery'],
	] satisfies Array<[string, string, string]>
).map(([name, displayName, kind]) => ({
	name,
	displayName,
	kind,
	description: `Connect to ${displayName}`,
	icon: 'link',
	writeMode: 'push',
}))

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

function renderIntegrations({
	providers = availableProviders,
	connected = false,
	...props
}: Partial<ComponentProps<typeof IntegrationsCard>> & {
	providers?: typeof availableProviders
	connected?: boolean
} = {}) {
	const router = createMemoryRouter([
		{
			path: '/',
			element: (
				<IntegrationsCard
					{...props}
					availableProviders={providers}
					integrations={
						connected
							? [
									{
										id: 'slack-integration',
										providerName: 'slack',
										providerType: 'productivity',
										isActive: true,
										lastSyncAt: null,
										config: {},
									},
								]
							: []
					}
				/>
			),
		},
	])

	return render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
}

describe('integration groups', () => {
	it('shows one catalog for productivity, reviews, POS, delivery, and reservations', () => {
		renderIntegrations({
			reviewProviders,
			availablePosProviders,
			selectedLocationId: 'main-location',
		})

		const groups = [
			[
				'Reviews & Listings',
				['Google Business Profile', 'Yelp', 'TripAdvisor'],
			],
			['Point of sale', ['Clover', 'Square', 'Toast']],
			['Marketplaces', ['Deliveroo', 'Just Eat', 'Uber Eats', 'DoorDash']],
			['Reservations', ['OpenTable', 'Resy']],
		] as const

		expect(screen.getAllByRole('region')).toHaveLength(8)
		expect(
			screen.getAllByRole('heading', { name: 'Integrations', level: 2 }),
		).toHaveLength(1)
		expect(
			screen.getAllByRole('link', { name: 'Request integration' }),
		).toHaveLength(1)
		for (const [name, providers] of groups) {
			const group = within(screen.getByRole('region', { name }))
			expect(group.getByRole('heading', { name, level: 3 })).toBeInTheDocument()
			expect(group.getAllByRole('heading', { level: 4 })).toHaveLength(
				providers.length,
			)
			for (const provider of providers) {
				expect(
					group.getByRole('heading', { name: provider, level: 4 }),
				).toBeInTheDocument()
				expect(screen.getAllByRole('heading', { name: provider })).toHaveLength(
					1,
				)
			}
		}
	})

	it('shows every provider once in the appropriate group', () => {
		renderIntegrations()

		const groups = [
			['Communication', ['Slack']],
			['Project management', ['Jira', 'Linear', 'ClickUp', 'Asana', 'Trello']],
			['Development', ['GitLab', 'GitHub']],
			['Knowledge management', ['Notion']],
		] as const

		expect(screen.getAllByRole('region')).toHaveLength(groups.length)
		for (const [name, providers] of groups) {
			const group = within(screen.getByRole('region', { name }))
			expect(group.getByRole('heading', { name, level: 3 })).toBeInTheDocument()
			expect(group.getAllByRole('heading', { level: 4 })).toHaveLength(
				providers.length,
			)
			for (const provider of providers) {
				expect(
					group.getByRole('heading', { name: provider, level: 4 }),
				).toBeInTheDocument()
				expect(screen.getAllByRole('heading', { name: provider })).toHaveLength(
					1,
				)
			}
		}
	})

	it('hides empty groups', () => {
		renderIntegrations({ providers: availableProviders.slice(0, 1) })

		expect(screen.getAllByRole('region')).toHaveLength(1)
		expect(
			screen.getByRole('region', { name: 'Communication' }),
		).toBeInTheDocument()
		expect(
			screen.getByRole('link', { name: 'Request integration' }),
		).toBeInTheDocument()
	})

	it('keeps uncategorized providers visible in a fallback group', () => {
		renderIntegrations({
			providers: [
				{
					name: 'new-provider',
					type: 'productivity',
					displayName: 'New provider',
					description: 'A new integration',
					icon: 'link',
				},
			],
		})

		const group = within(
			screen.getByRole('region', { name: 'Other integrations' }),
		)
		expect(
			group.getByRole('heading', { name: 'New provider' }),
		).toBeInTheDocument()
	})

	it('preserves connected and disconnected provider controls', () => {
		const { container } = renderIntegrations({ connected: true })

		const communication = within(
			screen.getByRole('region', { name: 'Communication' }),
		)
		expect(
			communication.getByRole('button', { name: 'Disconnect' }),
		).toBeInTheDocument()
		expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(
			availableProviders.length - 1,
		)
		expect(container.querySelector('input[name="integrationId"]')).toHaveValue(
			'slack-integration',
		)
		expect(
			screen.getAllByRole('link', { name: 'Read documentation' }),
		).toHaveLength(availableProviders.length)
	})

	it('preserves location-scoped review connections and sync controls', () => {
		renderIntegrations({
			providers: [],
			selectedLocationId: 'main-location',
			reviewProviders: reviewProviders.map((provider) =>
				provider.name === 'yelp'
					? {
							...provider,
							isActive: true,
							locations: [{ name: 'yelp-location', title: 'Main restaurant' }],
							error: 'Could not refresh reviews',
						}
					: provider,
			),
		})

		const yelp = within(screen.getByRole('group', { name: 'Yelp' }))
		expect(yelp.getByText('Connected')).toBeInTheDocument()
		expect(yelp.getByRole('alert')).toHaveTextContent(
			'Could not refresh reviews',
		)
		expect(yelp.getByRole('combobox', { name: 'Yelp location' })).toHaveValue(
			'yelp-location',
		)
		for (const [name, intent] of [
			['Sync details', 'import-review-provider'],
			['Disconnect', 'disconnect-review-provider'],
		]) {
			const form = yelp.getByRole('button', { name }).closest('form')!
			const data = new FormData(form)
			expect(data.get('intent')).toBe(intent)
			expect(data.get('providerName')).toBe('yelp')
			expect(data.get('organizationLocationId')).toBe('main-location')
		}

		const connectForm = screen
			.getByRole('button', { name: 'Connect Deliveroo' })
			.closest('form')!
		const data = new FormData(connectForm)
		expect(data.get('intent')).toBe('connect-review-provider')
		expect(data.get('providerName')).toBe('deliveroo')
		expect(data.get('organizationLocationId')).toBe('main-location')
	})

	it('preserves POS menu import, sync, and disconnect controls', () => {
		renderIntegrations({
			providers: [],
			selectedLocationId: 'main-location',
			availablePosProviders,
			posIntegrations: [
				{
					id: 'clover-integration',
					providerName: 'clover',
					isActive: true,
					lastSyncAt: null,
					environment: 'sandbox',
				},
			],
			menus: [{ id: 'dinner-menu', name: 'Dinner' }],
		})

		const clover = within(screen.getByRole('group', { name: 'Clover' }))
		for (const [name, intent] of [
			['Import menu', 'import-pos-menu'],
			['Sync Dinner', 'sync-pos-menu'],
			['Disconnect', 'disconnect-pos'],
		]) {
			const form = clover.getByRole('button', { name }).closest('form')!
			const data = new FormData(form)
			expect(data.get('intent')).toBe(intent)
			expect(data.get('integrationId')).toBe('clover-integration')
			expect(data.get('organizationLocationId')).toBe('main-location')
			if (intent === 'sync-pos-menu') {
				expect(data.get('menuId')).toBe('dinner-menu')
			}
		}
	})

	it('keeps live DoorDash store linking inside the marketplaces group', () => {
		renderIntegrations({
			providers: [],
			selectedLocationId: 'main-location',
			availablePosProviders,
			doorDashLiveConfigured: true,
		})

		const marketplaces = within(
			screen.getByRole('region', { name: 'Marketplaces' }),
		)
		const doorDash = within(
			marketplaces.getByRole('group', { name: 'DoorDash' }),
		)
		expect(
			doorDash.getByRole('textbox', { name: 'DoorDash store ID' }),
		).toHaveValue('')
		expect(doorDash.getByRole('button', { name: 'Connect' })).toBeDisabled()
	})

	it('groups future POS providers and retains unknown review providers', () => {
		renderIntegrations({
			providers: [],
			availablePosProviders: [
				{
					...availablePosProviders[0]!,
					name: 'new-pos',
					displayName: 'New POS',
				},
			],
			reviewProviders: [
				{
					...reviewProviders[0]!,
					name: 'new-review',
					displayName: 'New review',
				},
			],
		})

		expect(
			within(screen.getByRole('region', { name: 'Point of sale' })).getByRole(
				'heading',
				{ name: 'New POS' },
			),
		).toBeInTheDocument()
		expect(
			within(
				screen.getByRole('region', { name: 'Other integrations' }),
			).getByRole('heading', { name: 'New review' }),
		).toBeInTheDocument()
	})
})
