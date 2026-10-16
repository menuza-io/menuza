// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { GeneralSettingsCard } from './general-settings-card'

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

function renderCard() {
	const router = createMemoryRouter([
		{
			path: '/',
			element: (
				<GeneralSettingsCard
					organization={{ id: 'org-1', name: 'acme', slug: 'acme' }}
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

describe('GeneralSettingsCard', () => {
	it('clears the name error as soon as a valid name is typed', async () => {
		const user = userEvent.setup()
		renderCard()

		const name = screen.getByLabelText(/^name/i)
		const save = screen.getByRole('button', { name: /save changes/i })

		await user.clear(name)
		await user.click(save)

		expect(name).toHaveAttribute('aria-invalid', 'true')
		expect(screen.getByText('Required')).toBeInTheDocument()
		expect(save).toHaveAttribute('data-status', 'error')

		await user.type(name, 'acme4')

		expect(name).not.toHaveAttribute('aria-invalid')
		expect(screen.queryByText('Required')).not.toBeInTheDocument()
		expect(save).toHaveAttribute('data-status', 'idle')
	})
})
