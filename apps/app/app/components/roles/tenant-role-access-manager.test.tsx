// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
	createMemoryRouter,
	createRoutesStub,
	RouterProvider,
	useActionData,
} from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	RoleAccessForm,
	type TenantRole,
	TenantRoleAccessManager,
} from './tenant-role-access-manager.tsx'

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

function renderForm() {
	const Stub = createRoutesStub([
		{
			path: '/acme/settings/roles/new',
			Component: () => <RoleAccessForm cancelHref="/acme/settings/roles" />,
			HydrateFallback: () => null,
		},
	])
	return render(
		<I18nProvider i18n={i18n}>
			<Stub initialEntries={['/acme/settings/roles/new']} />
		</I18nProvider>,
	)
}

describe('RoleAccessForm permission checkboxes', () => {
	it('names each permission checkbox after its permission', async () => {
		renderForm()

		const createNotes = await screen.findByRole('checkbox', {
			name: 'Create notes',
		})
		expect(createNotes).toBeChecked()
		expect(
			screen.getByRole('checkbox', { name: 'Delete team notes' }),
		).not.toBeChecked()
	})

	it('shows the group checkbox as mixed while only some permissions are selected', async () => {
		const user = userEvent.setup()
		renderForm()

		// The default "Content editor" template selects 4 of the 7 note permissions.
		const group = await screen.findByRole('checkbox', {
			name: 'Select all Notes & Documents',
		})
		expect(group).toBePartiallyChecked()
		// The box draws a dash, not an empty square, for the mixed state.
		expect(group.querySelector('use')?.getAttribute('href')).toMatch(/#minus$/)

		await user.click(group)
		expect(group.querySelector('use')?.getAttribute('href')).toMatch(/#check$/)
		expect(group).toBeChecked()

		await user.click(group)
		expect(group).not.toBeChecked()
	})
})

const builtInRoles: TenantRole[] = [
	{ id: 'org_role_admin', name: 'admin', memberCount: 1 },
	{ id: 'org_role_member', name: 'member', memberCount: 0 },
	{ id: 'org_role_viewer', name: 'viewer', memberCount: 0 },
	{ id: 'org_role_guest', name: 'guest', memberCount: 0 },
].map((role) => ({
	...role,
	description: '',
	isBuiltIn: true,
	permissionIds: [],
}))

function renderManager(roles: TenantRole[]) {
	const router = createMemoryRouter([
		{
			path: '/',
			element: <TenantRoleAccessManager roles={roles} orgSlug="acme" />,
		},
	])
	return render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
}

describe('TenantRoleAccessManager built-in roles table', () => {
	it('gives each role row one link, named by the role', () => {
		renderManager(builtInRoles)

		const table = screen.getAllByRole('table').at(-1)!
		const rows = within(table).getAllByRole('row').slice(1)
		expect(rows).toHaveLength(4)

		const expected = [
			['Admin', 'org_role_admin'],
			['Member', 'org_role_member'],
			['Viewer', 'org_role_viewer'],
			['Guest', 'org_role_guest'],
		]
		rows.forEach((row, index) => {
			const [name, id] = expected[index]!
			const links = within(row).getAllByRole('link')
			expect(links).toHaveLength(1)
			expect(links[0]).toHaveAccessibleName(name)
			expect(links[0]).toHaveAttribute('href', `/acme/settings/roles/${id}`)
		})
		expect(
			within(table).queryByRole('link', { name: /^\d+$/ }),
		).not.toBeInTheDocument()
	})
})

function renderFormWithErrors(errors: { error?: string; nameError?: string }) {
	function CreateRole() {
		const actionData = useActionData<typeof errors>()
		return (
			<RoleAccessForm cancelHref="/acme/settings/roles" errors={actionData} />
		)
	}
	const Stub = createRoutesStub([
		{
			path: '/acme/settings/roles/new',
			Component: CreateRole,
			action: () => errors,
		},
	])
	return render(
		<I18nProvider i18n={i18n}>
			<Stub initialEntries={['/acme/settings/roles/new']} />
		</I18nProvider>,
	)
}

describe('RoleAccessForm errors', () => {
	it('shows a bad role name under Role name, marks it invalid, and focuses it', async () => {
		const user = userEvent.setup()
		renderFormWithErrors({
			nameError: 'Give the role a name with at least 2 characters.',
		})

		const name = await screen.findByLabelText(/^Role name/)
		await user.type(name, '   ')
		await user.click(screen.getByRole('button', { name: 'Create role' }))

		const message = await screen.findByText(
			'Give the role a name with at least 2 characters.',
		)
		expect(name).toHaveAttribute('aria-invalid', 'true')
		expect(name).toHaveAccessibleDescription(message.textContent!)
		expect(name).toHaveFocus()
		expect(screen.queryByRole('alert')).not.toBeInTheDocument()
	})

	it('focuses a form-level error so it is read once', async () => {
		const user = userEvent.setup()
		renderFormWithErrors({
			error:
				'One or more selected access options are not available for custom roles.',
		})

		await user.type(await screen.findByLabelText(/^Role name/), 'Editors')
		await user.click(screen.getByRole('button', { name: 'Create role' }))

		const message = await screen.findByText(
			'One or more selected access options are not available for custom roles.',
		)
		expect(message).toHaveFocus()
		expect(screen.queryByRole('alert')).not.toBeInTheDocument()
		expect(screen.getByLabelText(/^Role name/)).not.toHaveAttribute(
			'aria-invalid',
		)
	})
})
