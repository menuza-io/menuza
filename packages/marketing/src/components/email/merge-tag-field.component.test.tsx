// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import { MergeTagField } from './merge-tag-field.tsx'

i18n.loadAndActivate({ locale: 'en', messages: {} })

function Harness({ initial }: { initial: string }) {
	const [value, setValue] = useState(initial)
	return (
		<I18nProvider i18n={i18n}>
			<div>
				<MergeTagField
					value={value}
					onChange={setValue}
					placeholder="Subject"
				/>
				<output data-testid="value">{value}</output>
			</div>
		</I18nProvider>
	)
}

// The editor is a contenteditable textbox; the popover's fallback input is also
// a textbox, so scope by the editor's accessible name.
const editor = () => screen.getByRole('textbox', { name: 'Subject' })
const chip = (name: string) => within(editor()).getByText(name)
const storedValue = () => screen.getByTestId('value').textContent

function popover() {
	const heading = screen.getByText('Swap variable')
	const content = heading.closest('[data-slot="popover-content"]')
	if (!content) throw new Error('popover content not found')
	return within(content as HTMLElement)
}

/** Put the caret inside `container` at `offset` (like a user clicking there). */
function placeCaret(container: Node, offset: number) {
	const range = document.createRange()
	range.setStart(container, offset)
	range.collapse(true)
	const selection = window.getSelection()
	selection?.removeAllRanges()
	selection?.addRange(range)
}

describe('MergeTagField', () => {
	it('renders merge tags as chips instead of raw tokens', () => {
		render(<Harness initial="Hey {{firstName}}, welcome" />)

		const firstChip = chip('First name')
		expect(firstChip).toBeInTheDocument()
		expect(firstChip).toHaveAttribute('data-merge-tag', 'firstName')
		// The raw token is never shown to the author.
		expect(editor().textContent).not.toContain('{{')
	})

	it('opens a swap/fallback popover when a chip is clicked', async () => {
		const user = userEvent.setup()
		render(<Harness initial="Hey {{firstName}}, welcome" />)

		await user.click(chip('First name'))

		expect(await screen.findByText('Swap variable')).toBeInTheDocument()
		expect(screen.getByLabelText('Fallback')).toBeInTheDocument()
		// The catalog lists alternatives with sample values.
		expect(popover().getByText('Alex Morgan')).toBeInTheDocument()
		expect(popover().getByText('alex@example.com')).toBeInTheDocument()
	})

	it('saves a fallback onto the token', async () => {
		const user = userEvent.setup()
		render(<Harness initial="Hey {{firstName}}, welcome" />)

		await user.click(chip('First name'))
		await user.type(await screen.findByLabelText('Fallback'), 'there')
		await user.click(popover().getByRole('button', { name: 'Save' }))

		expect(storedValue()).toBe('Hey {{firstName|there}}, welcome')
		expect(chip('First name')).toHaveAttribute('data-merge-fallback', 'there')
	})

	it('swaps the tag from the popover list, keeping the fallback', async () => {
		const user = userEvent.setup()
		render(<Harness initial="Hey {{firstName}}" />)

		await user.click(chip('First name'))
		await user.type(await screen.findByLabelText('Fallback'), 'friend')
		await user.click(popover().getByRole('button', { name: /Full name/ }))

		expect(storedValue()).toBe('Hey {{name|friend}}')
		expect(chip('Full name')).toHaveAttribute('data-merge-fallback', 'friend')
	})

	it('removes a variable', async () => {
		const user = userEvent.setup()
		render(<Harness initial="Hey {{firstName}}!" />)

		await user.click(chip('First name'))
		await user.click(popover().getByRole('button', { name: 'Remove variable' }))

		expect(storedValue()).toBe('Hey !')
	})

	it('inserts a tag from the quick buttons', async () => {
		const user = userEvent.setup()
		render(<Harness initial="Hi " />)

		const insertRow = screen.getByText('Insert').parentElement as HTMLElement
		await user.click(within(insertRow).getByRole('button', { name: 'Company' }))

		expect(storedValue()).toBe('Hi {{organizationName}}')
		expect(chip('Company')).toBeInTheDocument()
	})

	it('inserts a chip, not raw token text, when the caret is in the editor', () => {
		// Regression: clicking a tag button used to insert the literal text
		// "{{email}}", which only became a pill after a save/reload re-render.
		render(<Harness initial="Welcome, " />)

		const editorEl = editor()
		const textNode = editorEl.firstChild as Text
		placeCaret(textNode, textNode.data.length)

		const insertRow = screen.getByText('Insert').parentElement as HTMLElement
		fireEvent.click(within(insertRow).getByRole('button', { name: 'Email' }))

		expect(chip('Email')).toHaveAttribute('data-merge-tag', 'email')
		expect(editorEl.textContent).not.toContain('{{')
		expect(storedValue()).toBe('Welcome, {{email}}')
	})

	it('splits the surrounding text when inserting into the middle', () => {
		render(<Harness initial="Hello world" />)

		const editorEl = editor()
		const textNode = editorEl.firstChild as Text
		placeCaret(textNode, 'Hello '.length)

		const insertRow = screen.getByText('Insert').parentElement as HTMLElement
		fireEvent.click(
			within(insertRow).getByRole('button', { name: 'Full name' }),
		)

		// Text is preserved on both sides of the chip.
		expect(storedValue()).toBe('Hello {{name}}world')
		expect(editorEl.textContent).toBe('Hello Full nameworld')
	})

	it('renders pasted tokens as chips', () => {
		render(<Harness initial="" />)

		const editorEl = editor()
		placeCaret(editorEl, 0)
		fireEvent.paste(editorEl, {
			clipboardData: { getData: () => 'Hey {{firstName|there}}' },
		})

		expect(chip('First name')).toHaveAttribute('data-merge-fallback', 'there')
		expect(editorEl.textContent).not.toContain('{{')
		expect(storedValue()).toBe('Hey {{firstName|there}}')
	})

	it('keeps plain text editable alongside chips', async () => {
		const user = userEvent.setup()
		render(<Harness initial="Hey {{firstName}}" />)

		await user.type(editor(), '!')

		// Typing appends and the chip survives in the serialized value.
		expect(storedValue()).toContain('{{firstName}}')
		expect(chip('First name')).toBeInTheDocument()
	})
})
