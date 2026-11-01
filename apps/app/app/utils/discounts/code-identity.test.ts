import { describe, expect, it } from 'vitest'
import { reuseCodeIds } from './discounts.server.ts'

describe('reuseCodeIds', () => {
	it('keeps a stored code when the editor has not been given its id yet', () => {
		const resolved = reuseCodeIds(
			[{ id: 'code_1', normalizedCode: 'SAVE10' }],
			[{ id: null, code: 'save10', maxUses: 1 }],
		)
		expect(resolved).toEqual([{ id: 'code_1', code: 'save10', maxUses: 1 }])
	})

	it('does not attach one stored code to two new rows', () => {
		const resolved = reuseCodeIds(
			[{ id: 'code_1', normalizedCode: 'SAVE10' }],
			[
				{ id: null, code: 'SAVE10', maxUses: 1 },
				{ id: null, code: 'SAVE10', maxUses: 1 },
			],
		)
		expect(resolved[0]?.id).toBe('code_1')
		expect(resolved[1]?.id).toBeNull()
	})

	it('leaves a code that already has an id alone', () => {
		const resolved = reuseCodeIds(
			[{ id: 'code_1', normalizedCode: 'SAVE10' }],
			[{ id: 'code_2', code: 'SAVE10', maxUses: null }],
		)
		expect(resolved[0]?.id).toBe('code_2')
	})
})
