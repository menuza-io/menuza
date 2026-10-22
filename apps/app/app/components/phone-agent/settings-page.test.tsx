// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { createMemoryRouter, RouterProvider, useLoaderData } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { SaveBar } from '#app/components/save-bar.tsx'
import { SettingsSaveBar, useSettingsFormState } from './settings-page.tsx'

type Saved = { greeting: string; closing: string }
type Body = { patch: Partial<Saved> }

function TextForm({
	field,
	label,
	saved,
}: {
	field: keyof Saved
	label: string
	saved: string
}) {
	const [value, setValue] = useState(saved)
	const form = useSettingsFormState({
		saved: { [field]: saved },
		versions: { [field]: 'v1' },
		draft: value,
		reset: (next) => setValue((next as Saved)[field]),
	})
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault()
				form.save({ [field]: value })
			}}
		>
			<input
				aria-label={label}
				value={value}
				onChange={(event) => setValue(event.target.value)}
			/>
			<SettingsSaveBar canUpdate form={form} />
		</form>
	)
}

function Screen() {
	const data = useLoaderData() as Saved
	return (
		<>
			<TextForm field="greeting" label="Greeting" saved={data.greeting} />
			<TextForm field="closing" label="Closing" saved={data.closing} />
			<SaveBar />
		</>
	)
}

function renderScreen({ failClosing = false } = {}) {
	const saved: Saved = { greeting: 'Hello', closing: 'Bye' }
	const calls: Body[] = []
	const router = createMemoryRouter(
		[
			{
				path: '/',
				loader: () => ({ ...saved }),
				action: async ({ request }) => {
					const body = (await request.json()) as Body
					calls.push(body)
					if (failClosing && 'closing' in body.patch) {
						return { ok: false, error: 'conflict' }
					}
					Object.assign(saved, body.patch)
					return { ok: true }
				},
				element: <Screen />,
				HydrateFallback: () => null,
			},
		],
		{ initialEntries: ['/'] },
	)
	render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
	return { calls }
}

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

describe('phone agent settings with several forms', () => {
	it('shows no bar until a form has edits', async () => {
		renderScreen()
		await screen.findByLabelText('Greeting')
		expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
	})

	it('saves every edited form from one Save', async () => {
		const user = userEvent.setup()
		const { calls } = renderScreen()
		await user.type(await screen.findByLabelText('Greeting'), '!')
		await user.type(screen.getByLabelText('Closing'), '!')

		await user.click(screen.getByRole('button', { name: 'Save' }))

		await waitFor(() => expect(calls).toHaveLength(2))
		expect(calls.map((call) => call.patch)).toEqual(
			expect.arrayContaining([{ greeting: 'Hello!' }, { closing: 'Bye!' }]),
		)
		await waitFor(() =>
			expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument(),
		)
		expect(screen.getByLabelText('Greeting')).toHaveValue('Hello!')
		expect(screen.getByLabelText('Closing')).toHaveValue('Bye!')
	})

	it('discards every edited form from one Discard', async () => {
		const user = userEvent.setup()
		const { calls } = renderScreen()
		await user.type(await screen.findByLabelText('Greeting'), '!')
		await user.type(screen.getByLabelText('Closing'), '!')

		await user.click(screen.getByRole('button', { name: 'Discard' }))

		await waitFor(() =>
			expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument(),
		)
		expect(screen.getByLabelText('Greeting')).toHaveValue('Hello')
		expect(screen.getByLabelText('Closing')).toHaveValue('Bye')
		expect(calls).toHaveLength(0)
	})

	it('keeps a form dirty when its save fails and still saves the others', async () => {
		const user = userEvent.setup()
		const { calls } = renderScreen({ failClosing: true })
		await user.type(await screen.findByLabelText('Greeting'), '!')
		await user.type(screen.getByLabelText('Closing'), '!')

		await user.click(screen.getByRole('button', { name: 'Save' }))

		await waitFor(() => expect(calls).toHaveLength(2))
		// The failed form keeps its edits, so the bar stays for it.
		await screen.findByRole('alert')
		expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
		expect(screen.getByLabelText('Closing')).toHaveValue('Bye!')
		expect(screen.getByLabelText('Greeting')).toHaveValue('Hello!')

		// Discard now only has the failed form left to reset.
		await user.click(screen.getByRole('button', { name: 'Discard' }))
		await waitFor(() =>
			expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument(),
		)
		expect(screen.getByLabelText('Closing')).toHaveValue('Bye')
		expect(screen.getByLabelText('Greeting')).toHaveValue('Hello!')
	})
})
