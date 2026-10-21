import { describe, expect, it } from 'vitest'
import {
	MAX_BOOK_EXPANSIONS,
	MAX_REFLOW_EXPANSIONS,
	MAX_SEARCH_SLOT_EXPANSIONS,
	assignTables,
	detectConflicts,
	reflowDay,
	scoreCandidate,
} from './assign.ts'

describe('assign barrel exports', () => {
	it('re-exports assignTables, scoreCandidate, reflowDay, detectConflicts, and expansion caps', () => {
		expect(MAX_SEARCH_SLOT_EXPANSIONS).toBe(200)
		expect(MAX_BOOK_EXPANSIONS).toBe(2_000)
		expect(MAX_REFLOW_EXPANSIONS).toBe(5_000)
		expect(typeof assignTables).toBe('function')
		expect(typeof scoreCandidate).toBe('function')
		expect(typeof reflowDay).toBe('function')
		expect(typeof detectConflicts).toBe('function')
	})
})
