// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./training.server.ts', () => ({ loader: vi.fn(), action: vi.fn() }))

async function renderEmpty({
	canUpdate = true,
	verticalUi = {},
}: {
	canUpdate?: boolean
	verticalUi?: object
} = {}) {
	vi.resetModules()
	vi.doMock('#app/components/phone-agent/vertical-ui.tsx', () => ({
		phoneAgentVerticalUi: verticalUi,
	}))
	const { default: PhoneAgentTraining } = await import('./training.tsx')
	const router = createMemoryRouter(
		[
			{
				path: '/',
				loader: () => ({
					rules: [],
					scopes: [],
					canUpdate,
					verticalSettings: {},
				}),
				HydrateFallback: () => null,
				element: <PhoneAgentTraining />,
			},
		],
		{ initialEntries: ['/'] },
	)
	i18n.load('en', {})
	i18n.activate('en')
	render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
	await screen.findByText('No training rules yet')
}

afterEach(() => {
	vi.doUnmock('#app/components/phone-agent/vertical-ui.tsx')
})

describe('training rules empty state', () => {
	it('does not promise examples when the vertical has none', async () => {
		await renderEmpty()
		expect(
			screen.getByText(
				'Add a rule to teach the agent how your business works.',
			),
		).toBeTruthy()
		expect(screen.queryByText(/Start with an example/)).toBeNull()
		expect(screen.getByRole('button', { name: /Add rule/ })).toBeTruthy()
	})

	it('offers the examples when the vertical has some', async () => {
		await renderEmpty({
			verticalUi: {
				ruleExamples: [
					{
						category: 'general',
						title: { id: 'Mention the daily special' },
						description: { id: 'Tell callers about the special.' },
					},
				],
			},
		})
		expect(screen.getByText(/Start with an example/)).toBeTruthy()
		expect(
			screen.getByRole('button', { name: 'Mention the daily special' }),
		).toBeTruthy()
	})

	it('tells a read-only member who can add rules', async () => {
		await renderEmpty({
			canUpdate: false,
			verticalUi: {
				ruleExamples: [
					{
						category: 'general',
						title: { id: 'Mention the daily special' },
						description: { id: 'Tell callers about the special.' },
					},
				],
			},
		})
		expect(
			screen.getByText('Ask an administrator to add training rules.'),
		).toBeTruthy()
		expect(screen.queryByText(/Add a rule to teach/)).toBeNull()
		expect(screen.queryByText(/Start with an example/)).toBeNull()
		expect(screen.queryByRole('button', { name: /Add rule/ })).toBeNull()
		expect(
			screen.queryByRole('button', { name: 'Mention the daily special' }),
		).toBeNull()
	})
})
