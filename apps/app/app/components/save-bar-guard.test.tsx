// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, Link, Outlet, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LeavePageDialog } from './leave-page-dialog.tsx'
import { SaveBarGuard, useSaveBar } from './save-bar.tsx'

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})
afterEach(cleanup)

function Source({
	dirty,
	guard,
	showBar,
}: {
	dirty: boolean
	guard?: boolean
	showBar?: boolean
}) {
	useSaveBar({
		dirty,
		saving: false,
		onSave() {},
		onDiscard() {},
		guard,
		showBar,
	})
	return null
}

function renderPage(sources: React.ReactNode) {
	const router = createMemoryRouter([
		{
			path: '/',
			element: (
				<I18nProvider i18n={i18n}>
					<SaveBarGuard />
					<LeavePageDialog />
					{sources}
					<Link to="/away">Away</Link>
					<Outlet />
				</I18nProvider>
			),
			children: [{ path: 'away', element: <h1>Away</h1> }],
		},
	])
	render(<RouterProvider router={router} />)
	return router
}

describe('SaveBarGuard', () => {
	it('still blocks when a clean form registers after a dirty one', async () => {
		const router = renderPage(
			<>
				<Source dirty />
				<Source dirty={false} />
			</>,
		)
		await userEvent.click(screen.getByRole('link', { name: 'Away' }))
		expect(await screen.findByText('Leave this page?')).toBeInTheDocument()
		expect(router.state.location.pathname).toBe('/')
	})

	it('lets navigation through when nothing is dirty', async () => {
		const router = renderPage(<Source dirty={false} />)
		await userEvent.click(screen.getByRole('link', { name: 'Away' }))
		await waitFor(() => expect(router.state.location.pathname).toBe('/away'))
	})

	it('stands down while a dirty source guards itself', async () => {
		const router = renderPage(<Source dirty guard={false} />)
		await userEvent.click(screen.getByRole('link', { name: 'Away' }))
		await waitFor(() => expect(router.state.location.pathname).toBe('/away'))
	})

	it('guards a dirty source that keeps the bar hidden', async () => {
		const router = renderPage(<Source dirty showBar={false} />)
		await userEvent.click(screen.getByRole('link', { name: 'Away' }))
		expect(await screen.findByText('Leave this page?')).toBeInTheDocument()
		expect(router.state.location.pathname).toBe('/')
	})
})
