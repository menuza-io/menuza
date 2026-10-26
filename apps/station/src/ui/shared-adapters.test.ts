// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	Badge,
	Button,
	IconButton,
	Input,
	Modal,
	Select,
} from './primitives.tsx'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const issues: unknown[][] = []
const nativeDialog = Object.getOwnPropertyDescriptors(
	HTMLDialogElement.prototype,
)
beforeEach(() => {
	issues.length = 0
	vi.spyOn(console, 'error').mockImplementation((...args) => {
		issues.push(args)
	})
	vi.spyOn(console, 'warn').mockImplementation((...args) => {
		issues.push(args)
	})
	host = document.createElement('div')
	document.body.append(host)
	root = createRoot(host)
	vi.stubGlobal('matchMedia', () => ({ matches: true }))
	Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
		configurable: true,
		value(this: HTMLDialogElement) {
			this.open = true
		},
	})
	Object.defineProperty(HTMLDialogElement.prototype, 'close', {
		configurable: true,
		value(this: HTMLDialogElement) {
			this.open = false
		},
	})
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
	try {
		expect(issues).toEqual([])
	} finally {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
		for (const method of ['showModal', 'close']) {
			const original = nativeDialog[method]
			if (original)
				Object.defineProperty(HTMLDialogElement.prototype, method, original)
			else Reflect.deleteProperty(HTMLDialogElement.prototype, method)
		}
	}
})
function draw(node: ReactNode) {
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() => root.render(h(I18nProvider, { i18n }, node)))
}

describe('real shared controls with Station touch sizing', () => {
	it('preserves button type, events and disabled state without extra hit-area expansion', () => {
		const submit = vi.fn((event: Event) => event.preventDefault())
		const click = vi.fn()
		draw(
			h(
				'form',
				{ onSubmit: submit },
				h(Button, { onClick: click }, 'Save'),
				h(Button, { type: 'submit' }, 'Send'),
				h(IconButton, { label: 'Lock', disabled: true, onClick: click }),
			),
		)
		const buttons = [...host.querySelectorAll('button')]
		expect(buttons.every((button) => button.dataset.slot === 'button')).toBe(
			true,
		)
		expect(buttons[0]!.type).toBe('button')
		expect(buttons[0]!.classList.contains('h-11')).toBe(true)
		expect(buttons[0]!.classList.contains('after:hidden')).toBe(true)
		expect(buttons[2]!.classList.contains('size-11')).toBe(true)
		act(() => buttons[0]!.click())
		expect(click).toHaveBeenCalledTimes(1)
		expect(submit).not.toHaveBeenCalled()
		act(() => buttons[2]!.click())
		expect(click).toHaveBeenCalledTimes(1)
		act(() => buttons[1]!.click())
		expect(submit).toHaveBeenCalledTimes(1)
	})
	it('keeps native input attributes and forwards edits as an event', () => {
		const change = vi.fn()
		draw(
			h(Input, {
				'aria-label': 'Guest name',
				defaultValue: '',
				onChange: change,
				required: true,
				maxLength: 60,
				autoComplete: 'off',
				'aria-invalid': true,
			}),
		)
		const input = host.querySelector('input')!
		expect(input.dataset.slot).toBe('input')
		expect(input.required).toBe(true)
		expect(input.maxLength).toBe(60)
		expect(input.autocomplete).toBe('off')
		expect(input.getAttribute('aria-invalid')).toBe('true')
		expect(input.classList.contains('h-12')).toBe(true)
		const set = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			'value',
		)!.set!
		act(() => {
			set.call(input, 'Guest')
			input.dispatchEvent(new Event('input', { bubbles: true }))
		})
		expect(change).toHaveBeenCalledTimes(1)
		expect(change.mock.calls[0]![0].target.value).toBe('Guest')
	})
	it('preserves live status attributes and semantic badge variants', () => {
		draw(
			h(
				Badge,
				{ tone: 'danger', role: 'status', 'aria-live': 'polite' },
				'Upload refused',
			),
		)
		const badge = host.querySelector('[role="status"]')!
		expect(badge.getAttribute('data-slot')).toBe('badge')
		expect(badge.getAttribute('data-variant')).toBe('destructive')
		expect(badge.getAttribute('aria-live')).toBe('polite')
		expect(badge.textContent).toBe('Upload refused')
	})
	it('keeps native select change events and native dialog interruption semantics', () => {
		const change = vi.fn()
		const close = vi.fn()
		draw(
			h(Modal, {
				open: true,
				onClose: close,
				title: 'Choose a room',
				children: h(
					Select,
					{ defaultValue: 'main', onChange: change, 'aria-label': 'Room' },
					h('option', { value: 'main' }, 'Main'),
					h('option', { value: 'patio' }, 'Patio'),
				),
			}),
		)
		const dialog = host.querySelector('dialog')!
		expect(dialog.open).toBe(true)
		expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
		const select = host.querySelector('select')!
		act(() => {
			select.value = 'patio'
			select.dispatchEvent(new Event('change', { bubbles: true }))
		})
		expect(change.mock.calls[0]![0].target.value).toBe('patio')
		const cancel = new Event('cancel', { cancelable: true })
		act(() => {
			dialog.dispatchEvent(cancel)
		})
		expect(cancel.defaultPrevented).toBe(true)
		expect(close).toHaveBeenCalledTimes(1)
	})
})
