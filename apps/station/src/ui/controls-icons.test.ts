// @vitest-environment jsdom
import { Icon } from '@repo/ui/icon'
import { act, createElement as h, createRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SuccessMark } from './motion.tsx'
import { Button, Checkbox, Segmented, Select } from './primitives.tsx'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
	host = document.createElement('div')
	document.body.appendChild(host)
	root = createRoot(host)
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			disconnect() {}
		},
	)
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
	vi.unstubAllGlobals()
})
function draw(node: ReactNode) {
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() => root.render(node))
}
const choices = [
	h('option', { key: 'en', value: 'en' }, 'English'),
	h('option', { key: 'ar', value: 'ar' }, 'العربية'),
]

describe('native Select with a shared chevron', () => {
	it('forwards the native ref, label, change event, name and form value', () => {
		const ref = createRef<HTMLSelectElement>()
		const change = vi.fn()
		draw(
			h(
				'form',
				null,
				h('label', { htmlFor: 'language' }, 'Language'),
				h(Select, {
					ref,
					id: 'language',
					name: 'language',
					defaultValue: 'en',
					onChange: change,
					required: true,
					children: choices,
				}),
			),
		)
		const select = host.querySelector('select')!
		expect(ref.current).toBe(select)
		expect(select.labels?.[0]?.textContent).toBe('Language')
		expect(select.required).toBe(true)
		expect(select.options).toHaveLength(2)
		expect(new FormData(host.querySelector('form')!).get('language')).toBe('en')
		act(() => {
			select.value = 'ar'
			select.dispatchEvent(new Event('change', { bubbles: true }))
		})
		expect(change).toHaveBeenCalledOnce()
		expect(new FormData(host.querySelector('form')!).get('language')).toBe('ar')
		expect(select.classList.contains('appearance-none')).toBe(true)
		expect(select.classList.contains('pe-10')).toBe(true)
		const chevron = host.querySelector('svg')!
		expect(chevron.querySelector('use')?.getAttribute('href')).toMatch(
			/sprite\.svg.*#chevron-down$/,
		)
		expect(chevron.getAttribute('aria-hidden')).toBe('true')
		expect(chevron.getAttribute('focusable')).toBe('false')
		expect(chevron.classList.contains('pointer-events-none')).toBe(true)
	})

	it('keeps disabled semantics and logical RTL spacing, without changing the radius', () => {
		draw(
			h(
				'form',
				{ dir: 'rtl' },
				h(Select, {
					name: 'language',
					dir: 'rtl',
					value: 'ar',
					disabled: true,
					className: 'h-11 ps-10',
					containerClassName: 'sm:w-auto',
					children: choices,
				}),
			),
		)
		const select = host.querySelector('select')!
		expect(select.disabled).toBe(true)
		expect(select.value).toBe('ar')
		expect(new FormData(host.querySelector('form')!).has('language')).toBe(
			false,
		)
		expect(select.classList.contains('h-11')).toBe(true)
		expect(select.classList.contains('h-12')).toBe(false)
		expect(select.classList.contains('ps-10')).toBe(true)
		expect(select.classList.contains('pe-10')).toBe(true)
		expect(
			select.classList.contains('rounded-(--station-control-radius)'),
		).toBe(true)
		expect(select.parentElement?.classList.contains('sm:w-auto')).toBe(true)
		expect(select.parentElement?.getAttribute('dir')).toBe('rtl')
		const chevron = host.querySelector('svg')!
		expect(chevron.classList.contains('end-3')).toBe(true)
		expect(chevron.classList.contains('peer-disabled:opacity-45')).toBe(true)
	})

	it('preserves native listbox props instead of adding a dropdown glyph', () => {
		draw(
			h(Select, {
				multiple: true,
				size: 4,
				defaultValue: ['en', 'ar'],
				children: choices,
			}),
		)
		const select = host.querySelector('select')!
		expect(select.multiple).toBe(true)
		expect(select.size).toBe(4)
		expect(select.selectedOptions).toHaveLength(2)
		expect(host.querySelector('svg')).toBeNull()
	})
})

describe('segmented controls keep button-sized hit areas', () => {
	const options = [
		{ value: 'floor', label: 'Floor' },
		{ value: 'timeline', label: 'Timeline' },
	]
	it.each(['md', 'lg'] as const)(
		'keeps %s height without vertical group padding',
		(size) => {
			draw(
				h(
					'div',
					null,
					h(Button, { size, children: 'Book' }),
					h(Segmented, {
						size,
						value: 'floor',
						options,
						label: 'View',
						onChange: vi.fn(),
					}),
				),
			)
			const group = host.querySelector('[role="radiogroup"]')!
			const height = size === 'lg' ? '14' : '11'
			expect(
				host.querySelector('button')?.classList.contains(`h-${height}`),
			).toBe(true)
			expect(group.classList.contains('px-1')).toBe(true)
			expect(group.classList.contains('p-1')).toBe(false)
			for (const radio of group.querySelectorAll('[role="radio"]')) {
				expect(radio.classList.contains(`min-h-${height}`)).toBe(true)
				expect(radio.classList.contains('min-w-11')).toBe(true)
			}
		},
	)

	it('retains radio names, selection, focus and RTL arrow navigation', () => {
		const change = vi.fn()
		draw(
			h(Segmented, {
				value: 'floor',
				options,
				label: 'View',
				onChange: change,
			}),
		)
		const group = host.querySelector<HTMLElement>('[role="radiogroup"]')!
		group.style.direction = 'rtl'
		const radios = [
			...group.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
		]
		expect(group.getAttribute('aria-label')).toBe('View')
		expect(radios.map((radio) => radio.textContent)).toEqual([
			'Floor',
			'Timeline',
		])
		expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1])
		expect(radios[0]?.getAttribute('aria-checked')).toBe('true')
		radios[0]!.focus()
		act(() => {
			group.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
			)
		})
		expect(change).toHaveBeenLastCalledWith('timeline')
		expect(radios[1]!.matches(':focus')).toBe(true)
		act(() => {
			group.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
			)
		})
		expect(change).toHaveBeenLastCalledWith('floor')
		expect(radios[0]!.matches(':focus')).toBe(true)
	})
})

describe('shared glyph feedback', () => {
	it('keeps explicit sizes and animated checks backed by the shared sprite', () => {
		draw(
			h(
				'div',
				null,
				h(Icon, { name: 'users', className: 'size-5' }),
				h(Checkbox, {
					checked: true,
					onChange: vi.fn(),
					'aria-label': 'Notify',
				}),
				h(SuccessMark),
			),
		)
		expect(host.querySelector('svg')?.classList.contains('size-5')).toBe(true)
		expect(host.querySelector('svg')?.classList.contains('w-[1em]')).toBe(false)
		expect(host.querySelector('svg')?.classList.contains('h-[1em]')).toBe(false)
		expect(
			host
				.querySelector('.t-check[data-checked="true"] use')
				?.getAttribute('href'),
		).toMatch(/#check$/)
		expect(
			host
				.querySelector('.t-success-check[data-state="in"] use')
				?.getAttribute('href'),
		).toMatch(/#check$/)
		expect(host.querySelector('path')).toBeNull()
	})
})
