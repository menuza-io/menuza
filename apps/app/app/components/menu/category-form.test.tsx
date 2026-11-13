// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
	createMemoryRouter,
	Link,
	Outlet,
	redirect,
	RouterProvider,
} from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LeavePageDialog } from '#app/components/leave-page-dialog.tsx'
import { SaveBar, SaveBarGuard } from '#app/components/save-bar.tsx'
import { CategoryForm } from './category-form.tsx'

let saved: FormData[]
let fail: boolean

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
	saved = []
	fail = false
})
afterEach(cleanup)

const NAME = 'e.g. Starters, Wood-Fired Pizza, Craft Cocktails'

function renderForm(initialName?: string) {
	const router = createMemoryRouter(
		[
			{
				path: '/',
				element: (
					<I18nProvider i18n={i18n}>
						<SaveBarGuard />
						<LeavePageDialog />
						<Link to="/acme/orders">Orders</Link>
						<Outlet />
						<SaveBar />
					</I18nProvider>
				),
				children: [
					{
						path: ':orgSlug/menu/categories/edit',
						element: (
							<CategoryForm
								categoryId={initialName ? 'cat_1' : undefined}
								initialData={
									initialName ? { displayName: initialName } : undefined
								}
								orgSlug="acme"
								defaultLocale="en"
								supportedLocales={['en']}
								allItems={[]}
								allMenus={[]}
								allCategories={[]}
								allLocations={[]}
								isSubmitting={false}
								pageTitle="Category"
							/>
						),
						async action({ request }) {
							saved.push(await request.formData())
							if (fail) return { error: { displayName: ['Required'] } }
							return redirect('/acme/menu/categories')
						},
					},
					{
						path: ':orgSlug/menu/categories',
						element: <h1>All categories</h1>,
					},
					{ path: ':orgSlug/orders', element: <h1>Orders page</h1> },
				],
			},
		],
		{ initialEntries: ['/acme/menu/categories/edit'] },
	)
	render(<RouterProvider router={router} />)
	return router
}

const bar = () => screen.queryByText('Unsaved changes')

describe('CategoryForm unsaved changes', () => {
	it('opens clean and leaves without asking', async () => {
		const user = userEvent.setup()
		const router = renderForm('Starters')
		await user.click(await screen.findByPlaceholderText(NAME))
		expect(bar()).not.toBeInTheDocument()

		await user.click(screen.getByRole('link', { name: 'Orders' }))
		await waitFor(() =>
			expect(router.state.location.pathname).toBe('/acme/orders'),
		)
	})

	it('asks before leaving an edited category and discards back to the saved name', async () => {
		const user = userEvent.setup()
		const router = renderForm('Starters')
		await user.type(await screen.findByPlaceholderText(NAME), ' and sides')
		expect(bar()).toBeInTheDocument()

		await user.click(screen.getByRole('link', { name: 'Orders' }))
		expect(await screen.findByText('Leave this page?')).toBeInTheDocument()
		expect(router.state.location.pathname).toBe('/acme/menu/categories/edit')
		await user.click(screen.getByRole('button', { name: 'Stay' }))

		await user.click(screen.getByRole('button', { name: 'Discard' }))
		await waitFor(() => expect(bar()).not.toBeInTheDocument())
		expect(screen.getByPlaceholderText(NAME)).toHaveValue('Starters')

		await user.click(screen.getByRole('link', { name: 'Orders' }))
		await waitFor(() =>
			expect(router.state.location.pathname).toBe('/acme/orders'),
		)
	})

	it('saves a new category from the bar and follows the redirect without asking', async () => {
		const user = userEvent.setup()
		const router = renderForm()
		await user.type(await screen.findByPlaceholderText(NAME), 'Desserts')
		expect(bar()).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Save' }))
		await waitFor(() =>
			expect(router.state.location.pathname).toBe('/acme/menu/categories'),
		)
		expect(saved).toHaveLength(1)
		expect(String(saved[0]?.get('displayName'))).toContain('Desserts')
		expect(screen.queryByText('Leave this page?')).not.toBeInTheDocument()
		await waitFor(() => expect(bar()).not.toBeInTheDocument())
	})

	it('keeps the bar and the prompt when the save is refused', async () => {
		fail = true
		const user = userEvent.setup()
		const router = renderForm('Starters')
		await user.type(await screen.findByPlaceholderText(NAME), ' and sides')
		await user.click(screen.getByRole('button', { name: 'Save' }))

		await waitFor(() => expect(saved).toHaveLength(1))
		await waitFor(() => expect(router.state.navigation.state).toBe('idle'))
		expect(bar()).toBeInTheDocument()

		await user.click(screen.getByRole('link', { name: 'Orders' }))
		expect(await screen.findByText('Leave this page?')).toBeInTheDocument()
		expect(router.state.location.pathname).toBe('/acme/menu/categories/edit')
	})
})
