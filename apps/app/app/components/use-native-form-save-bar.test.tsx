// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import {
	createMemoryRouter,
	redirect,
	RouterProvider,
	useFetcher,
	useLoaderData,
} from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { SaveBar } from './save-bar.tsx'
import { useNativeFormSaveBar } from './use-native-form-save-bar.ts'

let db: { title: string; enabled: boolean }
let saves: number

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
	db = { title: 'Starter', enabled: false }
	saves = 0
})

function Page() {
	const data = useLoaderData() as typeof db
	const fetcher = useFetcher()
	const formRef = useRef<HTMLFormElement>(null)
	useNativeFormSaveBar(formRef, fetcher.state !== 'idle')
	return (
		<>
			<fetcher.Form ref={formRef} method="POST">
				<label>
					Title
					<input name="title" defaultValue={data.title} />
				</label>
				<label>
					Enabled
					<input type="checkbox" name="enabled" defaultChecked={data.enabled} />
				</label>
			</fetcher.Form>
			<SaveBar />
		</>
	)
}

function renderPage() {
	const router = createMemoryRouter([
		{
			path: '/',
			element: <Page />,
			HydrateFallback: () => null,
			loader: () => ({ ...db }),
			async action({ request }) {
				const formData = await request.formData()
				saves++
				db = {
					title: String(formData.get('title')),
					enabled: formData.get('enabled') === 'on',
				}
				return redirect('/')
			},
		},
	])
	return render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
}

const bar = () => screen.queryByText('Unsaved changes')

describe('useNativeFormSaveBar', () => {
	it('shows the bar for edits and discards them', async () => {
		const user = userEvent.setup()
		renderPage()
		await screen.findByLabelText('Title')
		expect(bar()).not.toBeInTheDocument()

		await user.type(screen.getByLabelText('Title'), ' pack')
		await user.click(screen.getByLabelText('Enabled'))
		expect(bar()).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Discard' }))
		await waitFor(() => expect(bar()).not.toBeInTheDocument())
		expect(screen.getByLabelText('Title')).toHaveValue('Starter')
		expect(screen.getByLabelText('Enabled')).not.toBeChecked()
	})

	it('hides the bar once the saved values come back from the loader', async () => {
		const user = userEvent.setup()
		renderPage()
		await screen.findByLabelText('Title')

		await user.click(screen.getByLabelText('Enabled'))
		await user.click(screen.getByRole('button', { name: 'Save' }))

		await waitFor(() => expect(saves).toBe(1))
		await waitFor(() => expect(bar()).not.toBeInTheDocument())
		expect(screen.getByLabelText('Enabled')).toBeChecked()
		expect(db.enabled).toBe(true)
	})
})
