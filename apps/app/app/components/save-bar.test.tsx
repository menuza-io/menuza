// @vitest-environment jsdom

import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
	createMemoryRouter,
	redirect,
	RouterProvider,
	useFetcher,
	useLoaderData,
} from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SaveBar, useConformSaveBar } from './save-bar.tsx'

const Schema = z.object({
	intent: z.string().optional(),
	value: z.string().min(1, 'Required'),
})

let db: { alpha: string; beta: string }
let saved: string[]
let gate: Promise<void> | null = null

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
	db = { alpha: 'one', beta: 'two' }
	saved = []
	gate = null
})

function TestForm({ name, value }: { name: 'alpha' | 'beta'; value: string }) {
	const fetcher = useFetcher()
	const [form, fields] = useForm({
		id: `${name}-form`,
		constraint: getZodConstraint(Schema),
		lastResult: fetcher.data?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: Schema })
		},
		defaultValue: { intent: name, value },
	})
	useConformSaveBar(form, fetcher)
	return (
		<fetcher.Form method="POST" {...getFormProps(form)}>
			<input type="hidden" name="intent" value={name} />
			<label htmlFor={fields.value.id}>{name}</label>
			<input {...getInputProps(fields.value, { type: 'text' })} />
			<p>{fields.value.errors?.[0]}</p>
		</fetcher.Form>
	)
}

function Page() {
	const data = useLoaderData() as typeof db
	return (
		<>
			<TestForm name="alpha" value={data.alpha} />
			<TestForm name="beta" value={data.beta} />
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
				const intent = formData.get('intent') as 'alpha' | 'beta'
				const result = parseWithZod(formData, { schema: Schema })
				if (result.status !== 'success') {
					return { result: result.reply() }
				}
				if (result.value.value === 'taken') {
					return {
						result: result.reply({ fieldErrors: { value: ['Already taken'] } }),
					}
				}
				if (gate) await gate
				saved.push(intent)
				db[intent] = result.value.value
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

describe('save bar with several forms', () => {
	it('saves every dirty form and hides once all are clean', async () => {
		const user = userEvent.setup()
		renderPage()
		await screen.findByLabelText('alpha')

		await user.type(screen.getByLabelText('alpha'), '1')
		await user.type(screen.getByLabelText('beta'), '2')
		await user.click(screen.getByRole('button', { name: 'Save' }))

		await waitFor(() => expect(saved.sort()).toEqual(['alpha', 'beta']))
		await waitFor(() => expect(bar()).not.toBeInTheDocument())
		expect(screen.getByLabelText('alpha')).toHaveValue('one1')
		expect(screen.getByLabelText('beta')).toHaveValue('two2')
	})

	it('discards every dirty form', async () => {
		const user = userEvent.setup()
		renderPage()
		await screen.findByLabelText('alpha')

		await user.type(screen.getByLabelText('alpha'), '1')
		await user.type(screen.getByLabelText('beta'), '2')
		await user.click(screen.getByRole('button', { name: 'Discard' }))

		await waitFor(() => expect(bar()).not.toBeInTheDocument())
		expect(screen.getByLabelText('alpha')).toHaveValue('one')
		expect(screen.getByLabelText('beta')).toHaveValue('two')
		expect(saved).toEqual([])
	})

	it('keeps a failing form dirty and does not block the other', async () => {
		const user = userEvent.setup()
		renderPage()
		await screen.findByLabelText('alpha')

		await user.clear(screen.getByLabelText('alpha'))
		await user.type(screen.getByLabelText('beta'), '2')
		await user.click(screen.getByRole('button', { name: 'Save' }))

		await waitFor(() => expect(saved).toEqual(['beta']))
		expect(screen.getByText('Required')).toBeInTheDocument()
		expect(bar()).toBeInTheDocument()
		expect(screen.getByLabelText('beta')).toHaveValue('two2')
	})

	it("keeps another form's unsaved edit when one form saves", async () => {
		const user = userEvent.setup()
		renderPage()
		await screen.findByLabelText('alpha')

		await user.type(screen.getByLabelText('alpha'), '1')
		await user.type(screen.getByLabelText('beta'), '2')
		// Submit only alpha, as pressing Enter in its field would.
		document.forms.namedItem('alpha-form')?.requestSubmit()

		await waitFor(() => expect(saved).toEqual(['alpha']))
		await waitFor(() =>
			expect(screen.getByLabelText('beta')).toHaveValue('two2'),
		)
		expect(bar()).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Discard' }))
		await waitFor(() => expect(bar()).not.toBeInTheDocument())
		expect(screen.getByLabelText('alpha')).toHaveValue('one1')
		expect(screen.getByLabelText('beta')).toHaveValue('two')
	})

	it('keeps the edit and the bar after a server-side error', async () => {
		const user = userEvent.setup()
		renderPage()
		await screen.findByLabelText('alpha')

		await user.clear(screen.getByLabelText('alpha'))
		await user.type(screen.getByLabelText('alpha'), 'taken')
		await user.click(screen.getByRole('button', { name: 'Save' }))

		expect(await screen.findByText('Already taken')).toBeInTheDocument()
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(screen.getByLabelText('alpha')).toHaveValue('taken')
		expect(bar()).toBeInTheDocument()
		expect(saved).toEqual([])
	})

	it('keeps what is typed while a save is still in flight', async () => {
		const user = userEvent.setup()
		let release!: () => void
		gate = new Promise<void>((resolve) => (release = resolve))
		renderPage()
		await screen.findByLabelText('alpha')

		await user.type(screen.getByLabelText('alpha'), '1')
		await user.click(screen.getByRole('button', { name: 'Save' }))
		await user.type(screen.getByLabelText('alpha'), '2')
		release()

		await waitFor(() => expect(saved).toEqual(['alpha']))
		await waitFor(() => expect(db.alpha).toBe('one1'))
		expect(screen.getByLabelText('alpha')).toHaveValue('one12')
		expect(bar()).toBeInTheDocument()
	})
})
