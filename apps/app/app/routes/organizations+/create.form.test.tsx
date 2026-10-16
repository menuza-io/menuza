// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRoutesStub } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import CreateOrganizationPage from './create.tsx'

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

function renderPage() {
	const Stub = createRoutesStub([
		{
			path: '/organizations/create',
			Component: CreateOrganizationPage,
			HydrateFallback: () => null,
			loader: () => ({
				trialConfig: { creditCardRequired: 'manual', trialDays: 14 },
				plansAndPrices: null,
				launchStatus: 'LAUNCHED',
			}),
		},
	])
	return render(
		<I18nProvider i18n={i18n}>
			<Stub initialEntries={['/organizations/create']} />
		</I18nProvider>,
	)
}

describe('CreateOrganizationPage step 1', () => {
	it('clears the name and slug errors as soon as valid values are typed', async () => {
		const user = userEvent.setup()
		renderPage()

		const name = await screen.findByLabelText(/^Name/)
		const slug = screen.getByLabelText(/^Slug/)

		await user.click(screen.getByRole('button', { name: /^Continue$/ }))

		expect(name).toHaveAttribute('aria-invalid', 'true')
		expect(slug).toHaveAttribute('aria-invalid', 'true')

		await user.type(name, 'QA Test Org')

		expect(slug).toHaveValue('qa-test-org')
		expect(name).not.toHaveAttribute('aria-invalid')
		expect(slug).not.toHaveAttribute('aria-invalid')
		expect(screen.queryByText('Required')).not.toBeInTheDocument()
	})
})
