// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type FlowEditorNode } from './flow-model.ts'
import { NodeInspector } from './node-inspector.tsx'

vi.mock('@repo/ui/icon', () => ({ Icon: () => null }))

const LONG_LABEL = 'Get help from the AI assistant'
const LONG_KEYWORDS = 'person, staff, manager, someone, human'

const menuNode: FlowEditorNode = {
	id: 'main_menu',
	type: 'keypad_menu',
	position: { x: 0, y: 0 },
	data: {
		label: 'Main menu',
		message: 'Press 1 for help.',
		options: [
			{ key: '1', label: LONG_LABEL, keywords: LONG_KEYWORDS.split(', ') },
		],
	},
}

function renderInspector(onUpdate = vi.fn()) {
	render(
		<I18nProvider i18n={i18n}>
			<NodeInspector
				node={menuNode}
				issues={[]}
				readOnly={false}
				onUpdate={onUpdate}
				onDelete={vi.fn()}
				onClose={vi.fn()}
			/>
		</I18nProvider>,
	)
	return onUpdate
}

describe('NodeInspector menu options', () => {
	beforeEach(() => {
		i18n.loadAndActivate({ locale: 'en', messages: {} })
	})

	afterEach(() => cleanup())

	it('wraps long option labels and keywords instead of clipping them', () => {
		renderInspector()
		const label = screen.getByLabelText('What this option does')
		const keywords = screen.getByLabelText('Words callers might say')
		// A one-line <input> clips text in the narrow panel; a textarea wraps.
		expect(label.tagName).toBe('TEXTAREA')
		expect(label).toHaveValue(LONG_LABEL)
		expect(keywords.tagName).toBe('TEXTAREA')
		expect(keywords).toHaveValue(LONG_KEYWORDS)
	})

	it('keeps option labels on one line', () => {
		const onUpdate = renderInspector()
		fireEvent.change(screen.getByLabelText('What this option does'), {
			target: { value: 'Speak with\nour team' },
		})
		expect(onUpdate).toHaveBeenCalledWith('main_menu', {
			options: [expect.objectContaining({ label: 'Speak with our team' })],
		})
	})
})
