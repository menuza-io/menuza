// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { isDraftDirty, useSheetDirty } from './dirty.ts'

describe('isDraftDirty', () => {
	it('is clean without a baseline and when drafts match', () => {
		expect(isDraftDirty(null, { a: 1 })).toBe(false)
		expect(isDraftDirty({ a: 1, b: ['x'] }, { a: 1, b: ['x'] })).toBe(false)
	})
	it('is dirty once a field or list item changes', () => {
		expect(isDraftDirty({ a: 1 }, { a: 2 })).toBe(true)
		expect(isDraftDirty(['x'], ['x', 'y'])).toBe(true)
	})
})

describe('useSheetDirty', () => {
	it('uses the draft at open time as the baseline', () => {
		const { result, rerender } = renderHook(
			({ id, draft }: { id: string | null; draft: unknown }) =>
				useSheetDirty(id, draft),
			{ initialProps: { id: null as string | null, draft: ['a'] as unknown } },
		)
		expect(result.current).toBe(false)
		rerender({ id: 'table:1', draft: ['a'] })
		expect(result.current).toBe(false)
		rerender({ id: 'table:1', draft: ['b'] })
		expect(result.current).toBe(true)
		rerender({ id: null, draft: ['b'] })
		expect(result.current).toBe(false)
		rerender({ id: 'table:2', draft: ['c'] })
		expect(result.current).toBe(false)
	})
})
