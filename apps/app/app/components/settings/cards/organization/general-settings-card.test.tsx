// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { SaveBar } from '#app/components/save-bar.tsx'
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
				<>
					<GeneralSettingsCard
						organization={{ id: 'org-1', name: 'acme', slug: 'acme' }}
					/>
					<SaveBar />
				</>
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
	it('shows the save bar only while the form has unsaved changes', async () => {
		const user = userEvent.setup()
		renderCard()

		expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()

		const name = screen.getByLabelText(/^name/i)
		await user.type(name, '4')
		expect(screen.getByText('Unsaved changes')).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Discard' }))
		expect(name).toHaveValue('acme')
		await waitFor(() =>
			expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument(),
		)
	})

	it('validates when saving from the bar and clears the error on valid input', async () => {
		const user = userEvent.setup()
		renderCard()

		const name = screen.getByLabelText(/^name/i)
		await user.clear(name)
		await user.click(screen.getByRole('button', { name: 'Save' }))

		expect(name).toHaveAttribute('aria-invalid', 'true')
		expect(screen.getByText('Required')).toBeInTheDocument()

		await user.type(name, 'acme4')

		expect(name).not.toHaveAttribute('aria-invalid')
		expect(screen.queryByText('Required')).not.toBeInTheDocument()
	})
})
