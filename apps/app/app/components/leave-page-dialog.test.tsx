// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from '@testing-library/react'
import { createMemoryRouter, Link, Outlet, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useConfirmBlocker } from '#app/utils/navigation-guards.ts'
import { LeavePageDialog } from './leave-page-dialog.tsx'

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

const MESSAGE = 'You have unsaved changes. Leave this page and lose them?'

function DirtyPage() {
	useConfirmBlocker(true, MESSAGE)
	return <h1>Setup</h1>
}

function renderApp() {
	i18n.load('en', {})
	i18n.activate('en')
	const router = createMemoryRouter(
		[
			{
				path: '/',
				element: (
					<>
						<Link to="/knowledge">Knowledge</Link>
						<Outlet />
						<LeavePageDialog />
					</>
				),
				children: [
					{ index: true, element: <DirtyPage /> },
					{ path: 'knowledge', element: <h1>Knowledge page</h1> },
				],
			},
		],
		{ initialEntries: ['/'] },
	)
	render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
	return router
}

describe('LeavePageDialog', () => {
	it('asks in the page, not with window.confirm, before leaving unsaved edits', async () => {
		const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
		const router = renderApp()

		fireEvent.click(screen.getByRole('link', { name: 'Knowledge' }))
		const dialog = await screen.findByRole('alertdialog')
		expect(dialog.textContent).toContain(MESSAGE)
		expect(confirm).not.toHaveBeenCalled()

		fireEvent.click(screen.getByRole('button', { name: 'Stay' }))
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
		expect(router.state.location.pathname).toBe('/')

		fireEvent.click(screen.getByRole('link', { name: 'Knowledge' }))
		await screen.findByRole('alertdialog')
		fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
		await waitFor(() =>
			expect(router.state.location.pathname).toBe('/knowledge'),
		)
		expect(await screen.findByText('Knowledge page')).toBeTruthy()
	})
})
