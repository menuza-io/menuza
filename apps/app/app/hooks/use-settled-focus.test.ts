/** @vitest-environment jsdom */
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useSettledFocus } from './use-settled-focus.ts'

function addToPage(html: string) {
	const host = document.createElement('div')
	host.innerHTML = html
	document.body.appendChild(host)
	return host
}

describe('useSettledFocus', () => {
	it('returns focus to the trigger while the action has not worked', () => {
		const host = addToPage('<h2 id="queue-heading">Review queue</h2>')
		const { result } = renderHook(() => useSettledFocus('queue-heading'))
		expect(result.current.finalFocus()).toBe(true)
		expect(
			document.getElementById('queue-heading')?.hasAttribute('tabindex'),
		).toBe(false)
		host.remove()
	})

	it('after a success, sends focus to the target once and makes it focusable', () => {
		const host = addToPage('<h2 id="queue-heading">Review queue</h2>')
		const { result } = renderHook(() => useSettledFocus('queue-heading'))
		result.current.settle()
		const heading = document.getElementById('queue-heading')
		expect(result.current.finalFocus()).toBe(heading)
		expect(heading?.getAttribute('tabindex')).toBe('-1')
		// The next close (a cancel) goes back to its trigger again.
		expect(result.current.finalFocus()).toBe(true)
		host.remove()
	})

	it('keeps a tabindex the target already has', () => {
		const host = addToPage(
			'<button id="queue-heading" tabindex="0">Queue</button>',
		)
		const { result } = renderHook(() => useSettledFocus('queue-heading'))
		result.current.settle()
		const target = document.getElementById('queue-heading')
		expect(result.current.finalFocus()).toBe(target)
		expect(target?.getAttribute('tabindex')).toBe('0')
		host.remove()
	})

	it('falls back to the trigger when the target is not on the page', () => {
		const { result } = renderHook(() => useSettledFocus('queue-heading'))
		result.current.settle()
		expect(result.current.finalFocus()).toBe(true)
	})
})
