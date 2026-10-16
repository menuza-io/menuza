// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { OrganizationInvitations } from './organization-invitations'

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

function renderInvitations() {
	const router = createMemoryRouter([
		{
			path: '/',
			element: (
				<OrganizationInvitations
					availableRoles={[
						{
							id: 'org_role_member',
							name: 'member',
							description: null,
							isSystem: true,
						} as any,
					]}
				/>
			),
			action: () => null,
		},
	])
	return render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
}

describe('OrganizationInvitations', () => {
	it('explains an empty email under the field on submit', async () => {
		renderInvitations()

		fireEvent.click(screen.getByRole('button', { name: 'Send Invitations' }))

		const message = await screen.findByText('Enter an email address')
		const email = screen.getByRole('textbox', { name: 'Email' })
		expect(email.getAttribute('aria-invalid')).toBe('true')
		expect(email.getAttribute('aria-describedby')).toContain(
			message.closest('ul')?.id,
		)
	})

	it('sizes the role picker text like the email input', () => {
		renderInvitations()

		const email = screen.getByRole('textbox', { name: 'Email' })
		const rolePicker = screen.getByRole('button', { name: /Member/ })
		for (const size of ['text-base', 'md:text-sm']) {
			expect(email.className.split(' ')).toContain(size)
			expect(rolePicker.className.split(' ')).toContain(size)
		}
	})
})
