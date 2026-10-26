// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, createElement as h, Fragment, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Keypad } from './Keypad.tsx'
import { ManagerPinPad } from './ManagerPinPad.tsx'

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

const draw = (node: ReactNode) =>
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() => root.render(h(I18nProvider, { i18n }, node)))
const type = (key: string) =>
	act(() => {
		document.body.dispatchEvent(
			new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
		)
	})

describe('a hardware keyboard on the till', () => {
	it('types an amount into a keypad that asks for it', () => {
		const onChange = vi.fn()
		draw(h(Keypad, { value: '12', onChange, keyboard: true }))
		type('5')
		expect(onChange).toHaveBeenLastCalledWith('125')
		type('Backspace')
		expect(onChange).toHaveBeenLastCalledWith('1')
	})

	it('sends a manager PIN to the PIN pad, never into the amount beside it', () => {
		const amount = vi.fn()
		const onPin = vi.fn()
		draw(
			h(
				Fragment,
				null,
				h(Keypad, { value: '', onChange: amount, keyboard: true }),
				h(ManagerPinPad, {
					prompt: 'A manager approves this',
					pin: '12',
					onPin,
					onApprove: vi.fn(),
					busy: false,
				}),
			),
		)
		type('3')
		expect(onPin).toHaveBeenLastCalledWith('123')
		expect(amount).not.toHaveBeenCalled()
	})
})

describe('keys the PIN pad leaves alone', () => {
	it('lets Enter press a focused button rather than approve', () => {
		const onApprove = vi.fn()
		draw(
			h(
				Fragment,
				null,
				h('button', { type: 'button', id: 'back' }, 'Back'),
				h(ManagerPinPad, {
					prompt: 'A manager approves this',
					pin: '1234',
					onPin: vi.fn(),
					onApprove,
					busy: false,
				}),
			),
		)
		const back = host.querySelector<HTMLButtonElement>('#back')!
		back.focus()
		act(() => {
			back.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: 'Enter',
					bubbles: true,
					cancelable: true,
				}),
			)
		})
		expect(onApprove).not.toHaveBeenCalled()
	})
})
