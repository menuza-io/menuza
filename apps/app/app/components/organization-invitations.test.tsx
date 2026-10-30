// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { OrganizationInvitations } from './organization-invitations'
import { type OrganizationRoleOption } from './organization-members'

const MEMBER_ROLE: OrganizationRoleOption = {
	id: 'org_role_member',
	name: 'member',
	description: '',
	isBuiltIn: true,
}

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

function renderInvitations(actionData?: unknown) {
	const router = createMemoryRouter([
		{
			path: '/',
			element: (
				<OrganizationInvitations
					availableRoles={[MEMBER_ROLE]}
					actionData={actionData}
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

function submit() {
	fireEvent.click(screen.getByRole('button', { name: 'Send Invitations' }))
}

function expectDescribedBy(element: HTMLElement, message: HTMLElement) {
	const errorId = message.closest('ul')?.id
	expect(errorId).toBeTruthy()
	expect(element.getAttribute('aria-describedby')?.split(' ')).toContain(
		errorId,
	)
}

describe('OrganizationInvitations', () => {
	it('explains an empty email under the field on submit', async () => {
		renderInvitations()

		submit()

		const message = await screen.findByText('Enter an email address')
		const email = screen.getByRole('textbox', { name: 'Email' })
		expect(email.getAttribute('aria-invalid')).toBe('true')
		expectDescribedBy(email, message)
		// Focus lands on the invalid field, so screen readers read the message.
		expect(email).toHaveFocus()
	})

	it('explains a malformed email and clears the error once it is valid', async () => {
		renderInvitations()
		const email = screen.getByRole('textbox', { name: 'Email' })

		fireEvent.change(email, { target: { value: 'foo' } })
		submit()

		const message = await screen.findByText('Invalid email address')
		expectDescribedBy(email, message)

		fireEvent.change(email, { target: { value: 'foo@example.com' } })
		fireEvent.blur(email)

		await expect
			.poll(() => screen.queryByText('Invalid email address'))
			.toBeNull()
		expect(email.getAttribute('aria-invalid')).toBeNull()
	})

	it('shows a role error from the server on the role picker', async () => {
		renderInvitations({
			result: {
				status: 'error',
				initialValue: {
					invites: [{ email: 'foo@example.com', roleId: MEMBER_ROLE.id }],
				},
				error: { 'invites[0].roleId': ['A role is required'] },
			},
		})

		const message = await screen.findByText('A role is required')
		const rolePicker = screen.getByRole('button', { name: /Member/ })
		expect(rolePicker.getAttribute('aria-invalid')).toBe('true')
		expectDescribedBy(rolePicker, message)
	})

	// Regression guard for a visual bug (the role label rendered larger than
	// the email placeholder). jsdom has no layout, so assert the shared
	// responsive text classes instead of computed font sizes.
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
