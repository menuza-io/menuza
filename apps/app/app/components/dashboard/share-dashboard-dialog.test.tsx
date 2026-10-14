// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import {
	createMemoryRouter,
	data,
	RouterProvider,
	type ActionFunctionArgs,
} from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type DashboardSharing } from '#app/utils/dashboards/queries.server.ts'
import { ShareDashboardDialog } from './share-dashboard-dialog.tsx'

type Submission = Record<string, FormDataEntryValue>

const members: DashboardSharing['members'] = [
	{ id: 'bea', name: 'Bea Viewer', username: 'bea', image: null },
	{ id: 'cal', name: 'Cal Editor', username: 'cal', image: null },
	{ id: 'dee', name: null, username: 'dee_member', image: null },
]

const shares: DashboardSharing['shares'] = [
	{
		userId: 'cal',
		name: 'Cal Editor',
		username: 'cal',
		image: null,
		access: 'edit',
		isActiveMember: true,
	},
	{
		userId: 'fay',
		name: 'Fay Former',
		username: 'fay',
		image: null,
		access: 'view',
		isActiveMember: false,
	},
]

function renderDialog({
	sharing,
	respond = () => ({ ok: true }),
}: {
	sharing: DashboardSharing
	respond?: () => unknown
}) {
	const submissions: Submission[] = []
	const action = vi.fn(async ({ request }: ActionFunctionArgs) => {
		submissions.push(Object.fromEntries(await request.formData()))
		return respond()
	})
	const router = createMemoryRouter(
		[
			{
				path: '/board',
				action,
				element: (
					<ShareDashboardDialog
						action="/board"
						name="Team board"
						sharing={sharing}
					/>
				),
			},
		],
		{ initialEntries: ['/board'] },
	)
	render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
	return { submissions }
}

async function openDialog() {
	await userEvent.click(screen.getByRole('button', { name: 'Share' }))
	return screen.findByRole('dialog', { name: 'Share “Team board”' })
}

async function choose(combobox: HTMLElement, option: string | RegExp) {
	await userEvent.click(combobox)
	await userEvent.click(await screen.findByRole('option', { name: option }))
}

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

describe('ShareDashboardDialog', () => {
	it('opens with a member picker, an access select and no shares yet', async () => {
		renderDialog({ sharing: { shares: [], members } })
		const dialog = await openDialog()

		expect(
			within(dialog).getByRole('combobox', { name: 'Person' }),
		).toHaveTextContent('Choose a member')
		expect(
			within(dialog).getByRole('combobox', { name: 'Access' }),
		).toHaveTextContent('View')
		expect(
			within(dialog).getByText('Not shared with anyone yet.'),
		).toBeInTheDocument()
		expect(within(dialog).getByRole('button', { name: 'Share' })).toBeDisabled()
	})

	it('lists every member to share with and marks who already has access', async () => {
		renderDialog({ sharing: { shares, members } })
		const dialog = await openDialog()

		await userEvent.click(
			within(dialog).getByRole('combobox', { name: 'Person' }),
		)
		const options = await screen.findAllByRole('option')
		expect(
			options.map((option) => [
				option.textContent,
				option.getAttribute('aria-disabled') === 'true',
			]),
		).toEqual([
			['Bea Viewer@bea', false],
			['Cal EditorHas access', true],
			['dee_member@dee_member', false],
		])
	})

	it('shares with the chosen member and access, then starts over', async () => {
		const { submissions } = renderDialog({ sharing: { shares: [], members } })
		const dialog = await openDialog()
		const person = within(dialog).getByRole('combobox', { name: 'Person' })

		await choose(person, /^Bea Viewer/)
		await choose(
			within(dialog).getByRole('combobox', { name: 'Access' }),
			'Edit',
		)
		await userEvent.click(within(dialog).getByRole('button', { name: 'Share' }))

		await waitFor(() =>
			expect(submissions).toEqual([
				{ intent: 'share', userId: 'bea', access: 'edit' },
			]),
		)
		await waitFor(() => expect(person).toHaveTextContent('Choose a member'))
		expect(
			within(dialog).getByRole('combobox', { name: 'Access' }),
		).toHaveTextContent('View')
	})

	it('explains why a share was refused', async () => {
		renderDialog({
			sharing: { shares: [], members },
			respond: () =>
				data(
					{
						ok: false,
						error: { code: 'invalid-share-target', message: 'Nope.' },
					},
					{ status: 400 },
				),
		})
		const dialog = await openDialog()

		await choose(
			within(dialog).getByRole('combobox', { name: 'Person' }),
			/^Bea Viewer/,
		)
		await userEvent.click(within(dialog).getByRole('button', { name: 'Share' }))

		expect(await within(dialog).findByRole('alert')).toHaveTextContent(
			'Choose an active member of this organization.',
		)
	})

	it('changes and removes access from the list of people with access', async () => {
		const { submissions } = renderDialog({ sharing: { shares, members } })
		const dialog = await openDialog()
		const list = within(dialog).getByRole('list', {
			name: 'People with access',
		})
		const cal = within(list).getAllByRole('listitem')[0]!
		expect(cal).toHaveTextContent('Cal Editor')
		const calAccess = within(cal).getByRole('combobox', {
			name: 'Access for Cal Editor',
		})
		expect(calAccess).toHaveTextContent('Edit')

		await choose(calAccess, 'View')
		await waitFor(() =>
			expect(submissions).toEqual([
				{ intent: 'share', userId: 'cal', access: 'view' },
			]),
		)

		await userEvent.click(
			within(cal).getByRole('button', { name: 'Remove access for Cal Editor' }),
		)
		await waitFor(() =>
			expect(submissions).toEqual([
				{ intent: 'share', userId: 'cal', access: 'view' },
				{ intent: 'unshare', userId: 'cal' },
			]),
		)
	})

	it('marks people who are no longer members of the organization', async () => {
		renderDialog({ sharing: { shares, members } })
		const dialog = await openDialog()
		const fay = within(
			within(dialog).getByRole('list', { name: 'People with access' }),
		).getAllByRole('listitem')[1]!

		expect(fay).toHaveTextContent('Fay Former')
		expect(fay).toHaveTextContent('No longer a member of this organization')
		expect(
			within(fay).getByRole('combobox', { name: 'Access for Fay Former' }),
		).toHaveAttribute('data-disabled')
		expect(
			within(fay).getByRole('button', { name: 'Remove access for Fay Former' }),
		).toBeEnabled()
	})
})
