// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createOverlayMotion, cssDurationMs } from './site-motion'

let reduced = false

function layer() {
	vi.useFakeTimers()
	reduced = false
	vi.stubGlobal('matchMedia', () => ({ matches: reduced }))
	const root = document.createElement('div')
	const surface = document.createElement('div')
	root.className = 'hidden'
	root.style.setProperty('--modal-close-dur', '150ms')
	root.append(surface)
	document.body.append(root)
	return {
		root,
		surface,
		motion: createOverlayMotion(root, surface),
		[Symbol.dispose]() {
			vi.useRealTimers()
			vi.unstubAllGlobals()
			document.body.replaceChildren()
		},
	}
}

describe('CSS timing tokens', () => {
	it('reads milliseconds and seconds, and tolerates missing tokens', () => {
		using context = layer()
		const { root } = context
		expect(cssDurationMs(root, '--modal-close-dur')).toBe(150)
		root.style.setProperty('--modal-close-dur', '0.35s')
		expect(cssDurationMs(root, '--modal-close-dur')).toBe(350)
		expect(cssDurationMs(root, '--missing')).toBe(0)
		root.style.setProperty('--modal-close-dur', '-1s')
		expect(cssDurationMs(root, '--modal-close-dur')).toBe(0)
	})
})

describe('overlay motion', () => {
	it('keeps exits mounted, excludes closing content from interaction, and cleans up', () => {
		using context = layer()
		const { root, surface, motion } = context
		motion.open()
		expect(motion.isOpen()).toBe(true)
		expect(root.classList.contains('hidden')).toBe(false)
		expect(surface.classList.contains('is-open')).toBe(true)
		motion.close()
		expect(motion.isOpen()).toBe(false)
		expect(root.inert).toBe(true)
		expect(root.getAttribute('aria-hidden')).toBe('true')
		expect(surface.classList.contains('is-closing')).toBe(true)
		expect(root.classList.contains('hidden')).toBe(false)
		vi.advanceTimersByTime(150)
		expect(root.classList.contains('hidden')).toBe(true)
		expect(surface.classList.contains('is-closing')).toBe(false)
	})

	it('cancels a stale close when reopened rapidly', () => {
		using context = layer()
		const { root, surface, motion } = context
		motion.open()
		motion.close()
		vi.advanceTimersByTime(75)
		motion.open()
		vi.runAllTimers()
		expect(motion.isOpen()).toBe(true)
		expect(root.inert).toBe(false)
		expect(root.hasAttribute('aria-hidden')).toBe(false)
		expect(root.classList.contains('hidden')).toBe(false)
		expect(surface.classList.contains('is-closing')).toBe(false)
	})

	it('dismisses immediately for reduced motion, without a lingering backdrop', () => {
		using context = layer()
		const { root, motion } = context
		reduced = true
		motion.open()
		motion.close()
		expect(root.classList.contains('hidden')).toBe(true)
		expect(vi.getTimerCount()).toBe(0)
	})

	it('ignores repeated closes without queuing another cleanup', () => {
		using context = layer()
		const { motion } = context
		motion.open()
		motion.close()
		motion.close()
		expect(vi.getTimerCount()).toBe(1)
	})
})
