// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	HIDDEN_STAFFING_NAV,
	type StaffingNavAccess,
} from '#app/utils/staffing/nav.ts'
import { CommandMenu, getNavigationCommands } from './command-menu.tsx'

const STAFFING_NAV: StaffingNavAccess = {
	visible: true,
	team: false,
	timeclock: true,
	schedule: true,
	labor: false,
	hiring: false,
}

const ALL_PERMISSIONS = [
	'website',
	'campaign',
	'automation',
	'phone_agent',
	'phone_call',
	'announcement',
].map((entity) => ({ action: 'read', entity }))

const rootData = {
	userOrganizations: {
		currentOrganization: {
			organization: { id: 'org_1', slug: 'acme' },
			organizationRole: { id: 'org_role_admin', permissions: ALL_PERMISSIONS },
		},
	},
	staffingNav: STAFFING_NAV,
}

vi.mock('react-router', async (importOriginal) => ({
	...(await importOriginal<object>()),
	useRouteLoaderData: () => rootData,
}))

beforeEach(() => {
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	Element.prototype.scrollIntoView = vi.fn()
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json({ notes: [] })),
	)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

function renderMenu() {
	i18n.load('en', {})
	i18n.activate('en')
	const router = createMemoryRouter(
		[
			{
				path: '*',
				element: <CommandMenu open onOpenChange={() => {}} />,
			},
			{ path: '/acme/staff/timeclock', element: <div>Time clock page</div> },
			{ path: '/api/onboarding/complete-step', action: () => null },
		],
		{ initialEntries: ['/acme'] },
	)
	render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
	return router
}

describe('CommandMenu', () => {
	it('jumps to an app section by name', async () => {
		const user = userEvent.setup()
		const router = renderMenu()

		await user.type(await screen.findByRole('combobox'), 'staff')

		const listbox = screen.getByRole('listbox')
		const option = within(listbox).getByRole('option', { name: 'Staff' })
		await user.click(option)
		expect(router.state.location.pathname).toBe('/acme/staff/timeclock')
	})

	it('shows a generic empty state when nothing matches', async () => {
		const user = userEvent.setup()
		renderMenu()

		await user.type(await screen.findByRole('combobox'), 'zzzzqqq')

		expect(await screen.findByText('No results found.')).toBeInTheDocument()
		expect(screen.queryByText('No notes found.')).not.toBeInTheDocument()
	})
})

describe('getNavigationCommands', () => {
	const urls = (...args: Parameters<typeof getNavigationCommands>): string[] =>
		getNavigationCommands(...args).map((command) => command.url)

	it('lists every main section the member can open', () => {
		expect(
			urls({
				orgSlug: 'acme',
				permissions: ALL_PERMISSIONS,
				staffingNav: STAFFING_NAV,
			}),
		).toEqual([
			'/acme',
			'/acme/reports',
			'/acme/notes',
			'/acme/media',
			'/acme/customers',
			'/acme/chat',
			'/acme/mailbox',
			'/acme/marketing',
			'/acme/phone-agent',
			'/acme/staff/timeclock',
			'/acme/website',
		])
	})

	it('hides sections the sidebar hides for the role', () => {
		expect(
			urls({
				orgSlug: 'acme',
				permissions: [
					{ action: 'read', entity: 'phone_call' },
					{ action: 'read', entity: 'announcement' },
				],
				staffingNav: HIDDEN_STAFFING_NAV,
			}),
		).toEqual([
			'/acme',
			'/acme/reports',
			'/acme/notes',
			'/acme/media',
			'/acme/customers',
			'/acme/chat',
			'/acme/mailbox',
			'/acme/phone-agent/calls',
			'/acme/website/announcements',
		])
	})
})
