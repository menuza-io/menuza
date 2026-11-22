// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { FocalPointEditor } from './focal-point-editor.tsx'

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

function setup(props: Partial<Parameters<typeof FocalPointEditor>[0]> = {}) {
	const onSave = vi.fn()
	render(
		<I18nProvider i18n={i18n}>
			<FocalPointEditor
				url="/resources/images?mediaId=abc"
				focal={null}
				readOnly={false}
				saving={false}
				onSave={onSave}
				{...props}
			/>
		</I18nProvider>,
	)
	return { onSave }
}

describe('FocalPointEditor', () => {
	it('moves the point with the labelled sliders, announces it, and saves it', async () => {
		const { onSave } = setup()
		const left = screen.getByLabelText('Left to right')
		const top = screen.getByLabelText('Top to bottom')
		fireEvent.change(left, { target: { value: '0' } })
		fireEvent.change(top, { target: { value: '0' } })
		// The position is read out in a polite live region.
		expect(screen.getByRole('status').textContent).toBe(
			'0% from the left, 0% from the top',
		)
		await userEvent.click(screen.getByRole('button', { name: 'Save focus' }))
		expect(onSave).toHaveBeenCalledWith({ x: 0, y: 0 })
	})

	it('moves with the arrow keys and announces each move', async () => {
		setup()
		const frame = screen.getByRole('group', { name: 'Crop focus' })
		frame.focus()
		await userEvent.keyboard('{ArrowLeft}{ArrowLeft}{ArrowUp}')
		expect(screen.getByRole('status').textContent).toBe(
			'40% from the left, 45% from the top',
		)
	})

	it('labels the frame and ties the help text to it', () => {
		setup()
		const frame = screen.getByRole('group', { name: 'Crop focus' })
		const help = document.getElementById(
			frame.getAttribute('aria-describedby') ?? '',
		)
		expect(help?.textContent).toMatch(/drag/i)
	})

	it('offers no controls to someone who cannot edit', () => {
		setup({ readOnly: true })
		expect(screen.queryByLabelText('Left to right')).toBeNull()
		expect(screen.queryByRole('button', { name: 'Save focus' })).toBeNull()
	})

	it('resets to the centre', async () => {
		const { onSave } = setup({ focal: { x: 0.1, y: 0.2 } })
		await userEvent.click(
			screen.getByRole('button', { name: 'Reset to centre' }),
		)
		expect(onSave).toHaveBeenCalledWith(null)
	})
})
