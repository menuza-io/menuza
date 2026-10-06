// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { IntegrationsCard } from './integrations-card'

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

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

function renderIntegrations({
	providers = availableProviders,
	connected = false,
} = {}) {
	const router = createMemoryRouter([
		{
			path: '/',
			element: (
				<IntegrationsCard
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
})
