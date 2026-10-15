import { describe, expect, it } from 'vitest'
import {
	MAX_DAY_EXPANSIONS,
	MAX_REPAIR_EXPANSIONS,
	assignTables,
	detectConflicts,
	reflowDay,
	scoreCandidate,
} from './assign.ts'

describe('assign barrel exports', () => {
	it('re-exports assignTables, scoreCandidate, reflowDay, detectConflicts, and expansion caps', () => {
		expect(MAX_REPAIR_EXPANSIONS).toBe(200)
		expect(MAX_DAY_EXPANSIONS).toBe(2_000)
		expect(typeof assignTables).toBe('function')
		expect(typeof scoreCandidate).toBe('function')
		expect(typeof reflowDay).toBe('function')
		expect(typeof detectConflicts).toBe('function')
	})
})
