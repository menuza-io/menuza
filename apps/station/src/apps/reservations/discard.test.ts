// @vitest-environment jsdom
import { createElement as h, act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDiscardGuard } from './discard.tsx'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

type Guard = ReturnType<typeof useDiscardGuard>
let latest: Guard
function Harness(props: {
	open: boolean
	dirty: boolean
	onClose: () => void
}) {
	latest = useDiscardGuard(props)
	return null
}

let host: HTMLDivElement
let root: Root
// React's own `act` around a root, not Testing Library's.
const draw = (element: ReactElement) =>
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() => root.render(element))
const escape = () =>
	act(() => {
		window.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }),
		)
	})

beforeEach(() => {
	host = document.createElement('div')
	document.body.appendChild(host)
	root = createRoot(host)
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
})

describe('a form that holds something typed', () => {
	it('is not dismissed by the backdrop (the modal is not dismissible)', async () => {
		const onClose = vi.fn()
		await draw(h(Harness, { open: true, dirty: true, onClose }))
		expect(latest.dismissible).toBe(false)
		await draw(h(Harness, { open: true, dirty: false, onClose }))
		expect(latest.dismissible).toBe(true)
	})

	it('asks before the close button closes it, and keeps it on "Keep editing"', async () => {
		const onClose = vi.fn()
		await draw(h(Harness, { open: true, dirty: true, onClose }))
		act(() => latest.requestClose())
		expect(latest.asking).toBe(true)
		expect(onClose).not.toHaveBeenCalled()
		act(() => latest.keep())
		expect(latest.asking).toBe(false)
		expect(onClose).not.toHaveBeenCalled()
	})

	it('closes on "Discard"', async () => {
		const onClose = vi.fn()
		await draw(h(Harness, { open: true, dirty: true, onClose }))
		act(() => latest.requestClose())
		act(() => latest.discard())
		expect(onClose).toHaveBeenCalledTimes(1)
		expect(latest.asking).toBe(false)
	})

	it('asks on Escape, and Escape again goes back to the form', async () => {
		const onClose = vi.fn()
		await draw(h(Harness, { open: true, dirty: true, onClose }))
		await escape()
		expect(latest.asking).toBe(true)
		await escape()
		expect(latest.asking).toBe(false)
		expect(onClose).not.toHaveBeenCalled()
	})
})

describe('a clean form', () => {
	it('closes at once from the close button, and Escape is the modal’s own', async () => {
		const onClose = vi.fn()
		await draw(h(Harness, { open: true, dirty: false, onClose }))
		act(() => latest.requestClose())
		expect(onClose).toHaveBeenCalledTimes(1)
		expect(latest.asking).toBe(false)
		// No listener of ours: Escape asks nothing of a form with nothing in it.
		await escape()
		expect(latest.asking).toBe(false)
		expect(onClose).toHaveBeenCalledTimes(1)
	})

	it('stops asking once the form is emptied, or the sheet is closed', async () => {
		const onClose = vi.fn()
		await draw(h(Harness, { open: true, dirty: true, onClose }))
		act(() => latest.requestClose())
		expect(latest.asking).toBe(true)
		await draw(h(Harness, { open: true, dirty: false, onClose }))
		expect(latest.asking).toBe(false)
		await draw(h(Harness, { open: true, dirty: true, onClose }))
		act(() => latest.requestClose())
		await draw(h(Harness, { open: false, dirty: true, onClose }))
		expect(latest.asking).toBe(false)
	})
})
