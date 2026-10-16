/**
 * @vitest-environment jsdom
 */
import { screen } from '@testing-library/react'
import { createRoutesStub } from 'react-router'
import { describe, expect, it } from 'vitest'
import { renderWithI18n as render } from '#tests/utils.tsx'
import { FeatureFlags } from './feature-flags.tsx'

const now = new Date('2026-01-01T00:00:00Z')

function renderFeatureFlags() {
	const App = createRoutesStub([
		{
			path: '/feature-flags',
			Component: FeatureFlags,
			HydrateFallback: () => null,
			loader: () => ({
				flags: [
					{
						id: 'flag-1',
						key: 'beta.enabled',
						value: true,
						level: 'system' as const,
						organizationId: null,
						userId: null,
						createdAt: now,
						updatedAt: now,
					},
				],
			}),
		},
	])
	return render(<App initialEntries={['/feature-flags']} />)
}

describe('FeatureFlags', () => {
	it('shows a page heading above the tabs', async () => {
		renderFeatureFlags()

		expect(
			await screen.findByRole('heading', { level: 1, name: 'Feature flags' }),
		).toBeInTheDocument()
	})

	it('renders each dialog trigger as a single button', async () => {
		const { container } = renderFeatureFlags()

		expect(
			await screen.findAllByRole('button', { name: 'Add Flag' }),
		).toHaveLength(1)
		expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1)
		expect(container.querySelector('button button')).toBeNull()
	})
})
