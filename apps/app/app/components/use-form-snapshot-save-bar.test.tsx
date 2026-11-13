// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useRef, useState } from 'react'
import {
	createMemoryRouter,
	Form,
	Link,
	Outlet,
	redirect,
	RouterProvider,
	useActionData,
	useNavigation,
} from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LeavePageDialog } from './leave-page-dialog.tsx'
import { SaveBar, SaveBarGuard } from './save-bar.tsx'
import {
	useDiscardKey,
	useFormSnapshotSaveBar,
} from './use-native-form-save-bar.ts'

let saves: Array<Record<string, string>>
/** What the action does with the next save. */
let outcome: 'redirect' | 'stay' | 'fail'

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
	saves = []
	outcome = 'redirect'
})
afterEach(cleanup)

/** A menu-editor shaped form: controlled inputs and hidden fields from state. */
function Editor({ initial }: { initial: { name: string; tags: string[] } }) {
	const { discardKey, discard } = useDiscardKey()
	return <EditorBody key={discardKey} initial={initial} onDiscard={discard} />
}

function EditorBody({
	initial,
	onDiscard,
}: {
	initial: { name: string; tags: string[] }
	onDiscard: () => void
}) {
	const formRef = useRef<HTMLFormElement>(null)
	const navigation = useNavigation()
	const actionData = useActionData() as { error?: string } | undefined
	useFormSnapshotSaveBar(formRef, {
		saving: navigation.state !== 'idle' && navigation.formMethod != null,
		result: actionData,
		onDiscard,
	})
	const [name, setName] = useState(initial.name)
	const [tags, setTags] = useState(initial.tags)
	// Derived state filled by an effect after mount, as the real editors do.
	const [slug, setSlug] = useState('')
	useEffect(() => {
		setSlug(initial.name.toLowerCase())
	}, [initial.name])

	return (
		<Form ref={formRef} method="POST">
			<label>
				Name
				<input
					name="name"
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
			</label>
			<input type="hidden" name="slug" value={slug} />
			<input type="hidden" name="tags" value={JSON.stringify(tags)} />
			<button type="button" onClick={() => setTags([...tags, 'spicy'])}>
				Add tag
			</button>
			<button type="button" onClick={() => setTags(tags.slice(0, -1))}>
				Remove tag
			</button>
			{actionData?.error ? <p role="alert">{actionData.error}</p> : null}
		</Form>
	)
}

function renderEditor(initial = { name: 'Starters', tags: ['vegan'] }) {
	const router = createMemoryRouter(
		[
			{
				path: '/',
				element: (
					<I18nProvider i18n={i18n}>
						<SaveBarGuard />
						<LeavePageDialog />
						<Link to="/list">List</Link>
						<Link to="/other">Other</Link>
						<Outlet />
						<SaveBar />
					</I18nProvider>
				),
				children: [
					{
						path: 'edit',
						element: <Editor initial={initial} />,
						async action({ request }) {
							const formData = await request.formData()
							saves.push(Object.fromEntries(formData) as Record<string, string>)
							if (outcome === 'fail') return { error: 'Name is taken' }
							if (outcome === 'stay') return { ok: true }
							return redirect('/list')
						},
					},
					{ path: 'list', element: <h1>List page</h1> },
					{ path: 'other', element: <h1>Other page</h1> },
				],
			},
		],
		{ initialEntries: ['/edit'] },
	)
	render(<RouterProvider router={router} />)
	return router
}

const bar = () => screen.queryByText('Unsaved changes')
const prompt = () => screen.queryByText('Leave this page?')

describe('useFormSnapshotSaveBar', () => {
	it('is clean after opening and focusing a field, and leaves without asking', async () => {
		const user = userEvent.setup()
		const router = renderEditor()
		await user.click(await screen.findByLabelText('Name'))
		await user.tab()
		expect(bar()).not.toBeInTheDocument()

		await user.click(screen.getByRole('link', { name: 'Other' }))
		await waitFor(() => expect(router.state.location.pathname).toBe('/other'))
		expect(prompt()).not.toBeInTheDocument()
	})

	it('counts an edit, and not an edit typed back to the same content', async () => {
		const user = userEvent.setup()
		renderEditor()
		const name = await screen.findByLabelText('Name')

		await user.type(name, '!')
		expect(bar()).toBeInTheDocument()
		await user.type(name, '{Backspace}')
		await waitFor(() => expect(bar()).not.toBeInTheDocument())
	})

	it('counts state that is only submitted as a hidden field', async () => {
		const user = userEvent.setup()
		renderEditor()
		await user.click(await screen.findByRole('button', { name: 'Add tag' }))
		expect(bar()).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Remove tag' }))
		await waitFor(() => expect(bar()).not.toBeInTheDocument())
	})

	it('treats a new record as changed once a field differs from blank', async () => {
		const user = userEvent.setup()
		renderEditor({ name: '', tags: [] })
		const name = await screen.findByLabelText('Name')
		expect(bar()).not.toBeInTheDocument()
		await user.type(name, 'S')
		expect(bar()).toBeInTheDocument()
	})

	it('asks before leaving an edited form and stays when told to', async () => {
		const user = userEvent.setup()
		const router = renderEditor()
		await user.type(await screen.findByLabelText('Name'), ' and sides')

		await user.click(screen.getByRole('link', { name: 'Other' }))
		expect(await screen.findByText('Leave this page?')).toBeInTheDocument()
		expect(router.state.location.pathname).toBe('/edit')

		await user.click(screen.getByRole('button', { name: 'Stay' }))
		await waitFor(() => expect(prompt()).not.toBeInTheDocument())
		expect(screen.getByLabelText('Name')).toHaveValue('Starters and sides')
	})

	it('saves and follows the redirect without asking', async () => {
		const user = userEvent.setup()
		const router = renderEditor()
		await user.type(await screen.findByLabelText('Name'), ' and sides')
		await user.click(screen.getByRole('button', { name: 'Save' }))

		await waitFor(() => expect(router.state.location.pathname).toBe('/list'))
		expect(saves).toEqual([
			{ name: 'Starters and sides', slug: 'starters', tags: '["vegan"]' },
		])
		expect(prompt()).not.toBeInTheDocument()
		await waitFor(() => expect(bar()).not.toBeInTheDocument())

		// Nothing is left guarding the next page either.
		await user.click(screen.getByRole('link', { name: 'Other' }))
		await waitFor(() => expect(router.state.location.pathname).toBe('/other'))
		expect(prompt()).not.toBeInTheDocument()
	})

	it('is clean after a save that keeps the page open', async () => {
		outcome = 'stay'
		const user = userEvent.setup()
		const router = renderEditor()
		await user.type(await screen.findByLabelText('Name'), ' and sides')
		await user.click(screen.getByRole('button', { name: 'Save' }))

		await waitFor(() => expect(saves).toHaveLength(1))
		await waitFor(() => expect(bar()).not.toBeInTheDocument())
		expect(screen.getByLabelText('Name')).toHaveValue('Starters and sides')

		// The saved values are the new starting point.
		await user.type(screen.getByLabelText('Name'), '!')
		expect(bar()).toBeInTheDocument()
		await user.type(screen.getByLabelText('Name'), '{Backspace}')
		await waitFor(() => expect(bar()).not.toBeInTheDocument())
		await user.click(screen.getByRole('link', { name: 'Other' }))
		await waitFor(() => expect(router.state.location.pathname).toBe('/other'))
	})

	it('keeps the bar and the prompt after a failed save', async () => {
		outcome = 'fail'
		const user = userEvent.setup()
		const router = renderEditor()
		await user.type(await screen.findByLabelText('Name'), ' and sides')
		await user.click(screen.getByRole('button', { name: 'Save' }))

		expect(await screen.findByRole('alert')).toHaveTextContent('Name is taken')
		expect(bar()).toBeInTheDocument()
		expect(screen.getByLabelText('Name')).toHaveValue('Starters and sides')

		await user.click(screen.getByRole('link', { name: 'Other' }))
		expect(await screen.findByText('Leave this page?')).toBeInTheDocument()
		expect(router.state.location.pathname).toBe('/edit')
	})

	it('discards back to the opening values and then leaves without asking', async () => {
		const user = userEvent.setup()
		const router = renderEditor()
		await user.type(await screen.findByLabelText('Name'), ' and sides')
		await user.click(screen.getByRole('button', { name: 'Add tag' }))
		await user.click(screen.getByRole('button', { name: 'Discard' }))

		await waitFor(() => expect(bar()).not.toBeInTheDocument())
		expect(screen.getByLabelText('Name')).toHaveValue('Starters')

		await user.click(screen.getByRole('link', { name: 'Other' }))
		await waitFor(() => expect(router.state.location.pathname).toBe('/other'))
		expect(prompt()).not.toBeInTheDocument()
	})
})
