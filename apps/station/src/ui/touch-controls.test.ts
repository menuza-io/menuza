// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Keypad } from './Keypad.tsx'
import { PinDots } from './PinDots.tsx'
import { Button, cn, fieldClass, IconButton } from './primitives.tsx'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
	host = document.createElement('div')
	document.body.appendChild(host)
	root = createRoot(host)
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
})

function draw(node: ReactNode) {
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() => root.render(h(I18nProvider, { i18n }, node)))
}
function key(label: string) {
	return host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
}

describe('the shared touch keypad', () => {
	it('keeps phone key order and 64px keys without a separate digit font', () => {
		draw(h(Keypad, { value: '', onChange: vi.fn(), raw: true }))
		expect(host.querySelector('[role="group"]')?.getAttribute('dir')).toBe(
			'ltr',
		)
		const buttons = [...host.querySelectorAll('button')]
		expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
			'1',
			'2',
			'3',
			'4',
			'5',
			'6',
			'7',
			'8',
			'9',
			'Clear',
			'0',
			'Delete',
		])
		for (const button of buttons) {
			expect(button.type).toBe('button')
			expect(button.classList.contains('h-16')).toBe(true)
			expect(button.classList.contains('tabular-nums')).toBe(true)
			expect(button.classList.contains('mono')).toBe(false)
		}
	})

	it('preserves a PIN leading zero and its digit limit', () => {
		const change = vi.fn()
		draw(
			h(Keypad, { value: '0123', onChange: change, raw: true, maxDigits: 6 }),
		)
		act(() => key('0').click())
		expect(change).toHaveBeenLastCalledWith('01230')
		change.mockClear()
		draw(
			h(Keypad, { value: '012345', onChange: change, raw: true, maxDigits: 6 }),
		)
		act(() => key('9').click())
		expect(change).not.toHaveBeenCalled()
	})

	it('keeps amount normalization, clear and backspace unchanged', () => {
		const change = vi.fn()
		draw(h(Keypad, { value: '0', onChange: change }))
		act(() => key('5').click())
		expect(change).toHaveBeenLastCalledWith('5')
		draw(h(Keypad, { value: '0123', onChange: change, raw: true }))
		act(() => key('Delete').click())
		expect(change).toHaveBeenLastCalledWith('012')
		act(() => key('Clear').click())
		expect(change).toHaveBeenLastCalledWith('')
	})
})

describe('PIN feedback', () => {
	it('distinguishes neutral empty dots from brand-filled dots', () => {
		draw(h(PinDots, { length: 2 }))
		const dots = [...host.querySelectorAll('[aria-hidden="true"]')]
		expect(dots).toHaveLength(4)
		expect(
			dots.filter((dot) => dot.classList.contains('bg-primary')),
		).toHaveLength(2)
		expect(
			dots.filter((dot) => dot.classList.contains('bg-muted')),
		).toHaveLength(2)
		expect(host.querySelector('[role="status"]')?.textContent).toContain(
			'2 digits entered',
		)
	})

	it('shows a refusal without obscuring the next PIN', () => {
		draw(h(PinDots, { length: 0, rejected: 1 }))
		expect(
			host.querySelector('[role="status"]')?.classList.contains('is-shaking'),
		).toBe(true)
		expect(host.querySelectorAll('.border-destructive')).toHaveLength(4)
		draw(h(PinDots, { length: 6, rejected: 1 }))
		expect(host.querySelectorAll('.border-destructive')).toHaveLength(0)
		expect(host.querySelectorAll('.bg-primary')).toHaveLength(6)
	})
})

describe('operational shape roles', () => {
	it('lets callers override a control shape without a competing radius class', () => {
		draw(h(Button, { className: 'rounded-full', children: 'Continue' }))
		const button = host.querySelector('button')!
		expect(button.classList.contains('rounded-full')).toBe(true)
		expect(
			button.classList.contains('rounded-(--station-control-radius)'),
		).toBe(false)
		expect(button.classList.contains('h-11')).toBe(true)
		expect(cn(fieldClass, 'rounded-none')).not.toContain(
			'rounded-(--station-control-radius)',
		)
		expect(cn('rounded-(--station-panel-radius)', 'rounded-none')).toBe(
			'rounded-none',
		)
	})

	it('retains icon-button names and disabled behavior', () => {
		const click = vi.fn()
		draw(h(IconButton, { label: 'Apps', disabled: true, onClick: click }))
		const button = key('Apps')
		expect(button.title).toBe('Apps')
		expect(button.classList.contains('size-11')).toBe(true)
		act(() => button.click())
		expect(click).not.toHaveBeenCalled()
	})
})
