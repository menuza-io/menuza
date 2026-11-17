import { describe, expect, it } from 'vitest'
import { emptyEditorState } from './editor-model.ts'
import { parseEditorStateField } from './editor-state-schema.ts'

describe('the posted editor state and the packaging fee switch (#408)', () => {
	const state = { ...emptyEditorState(), name: { en: 'Bag free' } }

	it('reads the switch the form posted', () => {
		const parsed = parseEditorStateField(
			JSON.stringify({ ...state, waivesPackagingFee: true }),
		)
		expect(parsed?.waivesPackagingFee).toBe(true)
	})

	it('reads a form open from before the switch existed as off, not as malformed', () => {
		const { waivesPackagingFee: _gone, ...stale } = state
		const parsed = parseEditorStateField(JSON.stringify(stale))
		expect(parsed).not.toBeNull()
		expect(parsed?.waivesPackagingFee).toBe(false)
	})

	it('refuses a switch that is not true or false', () => {
		expect(
			parseEditorStateField(
				JSON.stringify({ ...state, waivesPackagingFee: 'yes' }),
			),
		).toBeNull()
	})
})
