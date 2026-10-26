// @vitest-environment jsdom
import {
	createElement as h,
	act,
	useRef,
	useState,
	type ReactElement,
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useDrawerFocus } from './drawer.ts'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

function Harness() {
	const [open, setOpen] = useState(false)
	const [text, setText] = useState('')
	const opener = useRef<HTMLButtonElement>(null)
	const drawer = useDrawerFocus<HTMLDivElement>(open, opener)
	return h(
		'div',
		null,
		h(
			'button',
			{ ref: opener, id: 'opener', onClick: () => setOpen((value) => !value) },
			'List',
		),
		open
			? h(
					'div',
					{ ref: drawer, id: 'drawer', tabIndex: -1 },
					h('input', {
						id: 'search',
						value: text,
						onChange: (event: { target: { value: string } }) =>
							setText(event.target.value),
					}),
				)
			: null,
	)
}

let host: HTMLDivElement
let root: Root
// React's own `act` around a root, not Testing Library's.
const mount = (element: ReactElement) =>
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() => root.render(element))
/** The id of what has focus. */
const focused = () => document.activeElement?.id

beforeEach(() => {
	host = document.createElement('div')
	document.body.appendChild(host)
	root = createRoot(host)
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
})

/** Types into an input the way a person does: the value, then an input event. */
function type(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		'value',
	)!.set!
	act(() => {
		setter.call(input, value)
		input.dispatchEvent(new Event('input', { bubbles: true }))
	})
}

describe('the narrow tablet’s drawer', () => {
	it('takes focus once when it opens', async () => {
		await mount(h(Harness))
		const opener = host.querySelector<HTMLButtonElement>('#opener')!
		act(() => opener.click())
		expect(focused()).toBe('drawer')
	})

	it('keeps focus in the search box while the host types', async () => {
		await mount(h(Harness))
		act(() => host.querySelector<HTMLButtonElement>('#opener')!.click())
		const search = host.querySelector<HTMLInputElement>('#search')!
		act(() => search.focus())
		expect(focused()).toBe('search')
		// Every keystroke re-renders the drawer: focus must stay where it is.
		for (const typed of ['m', 'ma', 'may', 'maya']) {
			type(search, typed)
			expect(focused()).toBe('search')
		}
		expect(search.value).toBe('maya')
	})

	it('gives focus back to the button that opened it when it closes', async () => {
		await mount(h(Harness))
		const opener = host.querySelector<HTMLButtonElement>('#opener')!
		act(() => opener.click())
		act(() => host.querySelector<HTMLInputElement>('#search')!.focus())
		act(() => opener.click())
		expect(host.querySelector('#drawer')).toBeNull()
		expect(focused()).toBe('opener')
	})
})
