// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { TurnstileSubmitStatus, TurnstileWidget } from './turnstile-widget.tsx'

type RenderOptions = {
	callback?: (token: string) => void
	'error-callback'?: () => void
}

/** What the next api.js load does: fail, or load a fake Turnstile. */
let network: 'down' | 'up' | 'stalled' = 'down'
let lastOptions: RenderOptions | undefined
const turnstile = {
	render: vi.fn((_container: HTMLElement, options: RenderOptions) => {
		lastOptions = options
		return 'widget-1'
	}),
	reset: vi.fn(),
	remove: vi.fn(),
}

const realAppendChild = document.head.appendChild.bind(document.head)

function isTurnstileScript(node: Node) {
	if (!(node instanceof HTMLScriptElement) || !node.src) return false
	return new URL(node.src).hostname === 'challenges.cloudflare.com'
}

beforeEach(() => {
	vi.useFakeTimers()
	network = 'down'
	lastOptions = undefined
	turnstile.render.mockClear()
	turnstile.reset.mockClear()
	delete window.turnstile
	delete window.__turnstileLoad
	vi.spyOn(document.head, 'appendChild').mockImplementation(
		<T extends Node>(node: T): T => {
			const script = node as unknown as HTMLScriptElement
			if (isTurnstileScript(script)) {
				queueMicrotask(() => {
					if (network === 'stalled') return
					if (network === 'up') {
						window.turnstile = turnstile
						script.onload?.(new Event('load'))
					} else {
						script.onerror?.(new Event('error'))
					}
				})
				return node
			}
			return realAppendChild(node)
		},
	)
})

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

function renderWidget(onReadyChange: (ready: boolean) => void) {
	return renderStaff(
		<TurnstileWidget
			siteKey="0x4AAAAAAA-site"
			action="login"
			onReadyChange={onReadyChange}
		/>,
	)
}

describe('TurnstileWidget', () => {
	it('renders nothing without a site key', () => {
		renderStaff(<TurnstileWidget siteKey={null} action="login" />)
		expect(screen.queryByRole('group')).toBeNull()
	})

	it('says so after every load fails, and recovers with Try again', async () => {
		const onReadyChange = vi.fn()
		renderWidget(onReadyChange)
		expect(screen.getByRole('group', { name: 'Security check' })).toBeTruthy()

		// Five failed loads with growing delays between them.
		for (let step = 0; step < 15; step += 1) {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(2_000)
			})
		}
		expect(screen.getByText(/The security check could not load/)).toBeTruthy()
		expect(onReadyChange).not.toHaveBeenCalledWith(true)

		network = 'up'
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
			await vi.advanceTimersByTimeAsync(0)
		})
		expect(turnstile.render).toHaveBeenCalledTimes(1)
		expect(screen.queryByText(/The security check could not load/)).toBeNull()

		act(() => lastOptions?.callback?.('token'))
		expect(onReadyChange).toHaveBeenLastCalledWith(true)
	})

	it('treats a load that never finishes as failed', async () => {
		network = 'stalled'
		renderWidget(vi.fn())
		// Five loads that each hit the 15 s deadline, with retry delays between.
		for (let step = 0; step < 50; step += 1) {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(2_000)
			})
		}
		expect(screen.getByText(/The security check could not load/)).toBeTruthy()
		expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
	})

	it('offers a retry when the challenge itself fails', async () => {
		network = 'up'
		const onReadyChange = vi.fn()
		renderWidget(onReadyChange)
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0)
		})
		expect(turnstile.render).toHaveBeenCalledTimes(1)

		act(() => lastOptions?.['error-callback']?.())
		expect(onReadyChange).toHaveBeenLastCalledWith(false)
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
		expect(turnstile.reset).toHaveBeenCalledWith('widget-1')
		expect(screen.queryByText(/The security check could not load/)).toBeNull()
	})
})

describe('TurnstileSubmitStatus', () => {
	function Form() {
		const [ready, setReady] = useState(false)
		return (
			<form>
				<TurnstileSubmitStatus id="hint" siteKey="site-key" ready={ready} />
				<button
					type="submit"
					disabled={!ready}
					aria-describedby={ready ? undefined : 'hint'}
				>
					Sign in
				</button>
				<button type="button" onClick={() => setReady(true)}>
					Solve
				</button>
			</form>
		)
	}

	it('describes the disabled button, then announces the completed check', () => {
		renderStaff(<Form />)
		expect(
			screen.getByRole('button', { name: 'Sign in' }),
		).toHaveAccessibleDescription('Complete the security check to continue.')

		fireEvent.click(screen.getByRole('button', { name: 'Solve' }))
		expect(screen.getByRole('status')).toHaveTextContent(
			'Security check complete.',
		)
		expect(screen.getByRole('button', { name: 'Sign in' })).not.toHaveAttribute(
			'aria-describedby',
		)
	})

	it('renders nothing while Turnstile is off', () => {
		renderStaff(
			<TurnstileSubmitStatus id="hint" siteKey={null} ready={false} />,
		)
		expect(screen.queryByRole('status')).toBeNull()
	})
})
