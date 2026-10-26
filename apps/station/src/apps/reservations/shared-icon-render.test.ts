// @vitest-environment jsdom
import { Icon, type IconName } from '@repo/ui/icon'

import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => vi.restoreAllMocks())

it('updates the real shared Icon through every reported dynamic glyph without custom HTML or warnings', () => {
	const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
	const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const host = document.createElement('div')
	document.body.appendChild(host)
	const root = createRoot(host)
	const names: IconName[] = [
		'smartphone',
		'crown',
		'globe',
		'cake',
		'footprints',
		'armchair',
		'clock-3',
		'circle-check',
		'credit-card',
	]
	try {
		for (const name of names) {
			// eslint-disable-next-line testing-library/no-unnecessary-act
			act(() => root.render(h(Icon, { name, className: 'size-4 self-start' })))
			const svg = host.firstElementChild!
			expect(svg.localName).toBe('svg')
			expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg')
			expect(svg.getAttribute('aria-hidden')).toBe('true')
			expect(svg.getAttribute('focusable')).toBe('false')
			expect(svg.classList.contains('size-4')).toBe(true)
			expect(svg.classList.contains('self-start')).toBe(true)
			expect(svg.classList.contains('self-center')).toBe(false)
			expect(svg.children).toHaveLength(1)
			expect(svg.firstElementChild!.localName).toBe('use')
			expect(svg.firstElementChild!.getAttribute('href')).toMatch(
				new RegExp(`sprite\\.svg.*#${name}$`),
			)
			expect(host.querySelector(names.join(','))).toBeNull()
		}
	} finally {
		act(() => root.unmount())
		host.remove()
	}
	expect(errors).not.toHaveBeenCalled()
	expect(warnings).not.toHaveBeenCalled()
})
