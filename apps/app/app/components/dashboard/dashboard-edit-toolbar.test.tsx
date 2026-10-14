// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardEditToolbar } from './dashboard-edit-toolbar.tsx'

function renderToolbar({
	editing = false,
	onReset,
}: {
	editing?: boolean
	onReset?: () => void
} = {}) {
	const handlers = { onStartEditing: vi.fn(), onStopEditing: vi.fn() }
	render(
		<I18nProvider i18n={i18n}>
			<DashboardEditToolbar
				editing={editing}
				saving={false}
				saved={false}
				addBlock={<button type="button">Add block</button>}
				onReset={onReset}
				{...handlers}
			/>
		</I18nProvider>,
	)
	return handlers
}

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

describe('DashboardEditToolbar', () => {
	it('only offers Edit layout outside edit mode', async () => {
		const { onStartEditing } = renderToolbar({ onReset: vi.fn() })
		expect(screen.getAllByRole('button')).toHaveLength(1)
		await userEvent.click(screen.getByRole('button', { name: 'Edit layout' }))
		expect(onStartEditing).toHaveBeenCalledOnce()
	})

	it('offers Add block, Reset to default and Done while editing', async () => {
		const { onStopEditing } = renderToolbar({ editing: true, onReset: vi.fn() })
		expect(
			screen.queryByRole('button', { name: 'Edit layout' }),
		).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Add block' })).toBeVisible()
		expect(
			screen.getByRole('button', { name: 'Reset to default' }),
		).toBeVisible()
		await userEvent.click(screen.getByRole('button', { name: 'Done' }))
		expect(onStopEditing).toHaveBeenCalledOnce()
	})

	it('has no reset without onReset', () => {
		renderToolbar({ editing: true })
		expect(
			screen.queryByRole('button', { name: 'Reset to default' }),
		).not.toBeInTheDocument()
	})

	it('resets only after the reset is confirmed', async () => {
		const onReset = vi.fn()
		renderToolbar({ editing: true, onReset })
		await userEvent.click(
			screen.getByRole('button', { name: 'Reset to default' }),
		)
		const confirm = await screen.findByRole('alertdialog')
		await userEvent.click(
			within(confirm).getByRole('button', { name: 'Cancel' }),
		)
		expect(onReset).not.toHaveBeenCalled()

		await userEvent.click(
			screen.getByRole('button', { name: 'Reset to default' }),
		)
		await userEvent.click(
			within(await screen.findByRole('alertdialog')).getByRole('button', {
				name: 'Reset',
			}),
		)
		expect(onReset).toHaveBeenCalledOnce()
	})
})
