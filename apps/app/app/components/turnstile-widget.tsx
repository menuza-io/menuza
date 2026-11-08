import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { useNonce } from '@repo/common'
import { Button } from '@repo/ui/button'
import { useEffect, useRef, useState } from 'react'
import { useOptionalTheme } from '#app/routes/resources+/theme-switch.tsx'

const TURNSTILE_SCRIPT_URL =
	'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

type TurnstileApi = {
	render: (
		container: HTMLElement,
		options: {
			sitekey: string
			action?: string
			theme?: 'light' | 'dark' | 'auto'
			language?: string
			size?: 'normal' | 'flexible' | 'compact'
			callback?: (token: string) => void
			'expired-callback'?: () => void
			'error-callback'?: () => void
		},
	) => string | undefined
	reset: (widgetId: string) => void
	remove: (widgetId: string) => void
}

declare global {
	interface Window {
		turnstile?: TurnstileApi
		/** In-flight api.js load, on `window` so it survives hot updates. */
		__turnstileLoad?: Promise<TurnstileApi>
	}
}

/**
 * Loads api.js once. The script is inserted by the App's own nonce'd bundle,
 * which `'strict-dynamic'` trusts; it also carries the nonce when one is known.
 * The challenge needs `https://challenges.cloudflare.com` in `frame-src`,
 * `connect-src` and `script-src` (added in entry.server.tsx when Turnstile is
 * configured). A failed load removes its script so the next attempt starts
 * clean.
 */
function loadTurnstile(nonce: string): Promise<TurnstileApi> {
	if (window.turnstile) return Promise.resolve(window.turnstile)
	if (window.__turnstileLoad) return window.__turnstileLoad
	const script = document.createElement('script')
	let deadline: ReturnType<typeof setTimeout> | undefined
	const load = new Promise<TurnstileApi>((resolve, reject) => {
		script.src = TURNSTILE_SCRIPT_URL
		script.async = true
		if (nonce) script.nonce = nonce
		script.onload = () => {
			if (window.turnstile) resolve(window.turnstile)
			else reject(new Error('Turnstile did not load'))
		}
		script.onerror = () => reject(new Error('Turnstile did not load'))
		// A load that never settles (a stalled connection) counts as failed, so
		// the retry path and the Try again message still run.
		deadline = setTimeout(
			() => reject(new Error('Turnstile load timed out')),
			LOAD_TIMEOUT_MS,
		)
		document.head.appendChild(script)
	})
		.finally(() => clearTimeout(deadline))
		.catch((error: unknown) => {
			// A late load or error event from this script must not touch a newer
			// attempt: detach the handlers and the element.
			script.onload = null
			script.onerror = null
			script.remove()
			if (window.__turnstileLoad === load) window.__turnstileLoad = undefined
			throw error
		})
	window.__turnstileLoad = load
	return load
}

/** How long one api.js load may take before it counts as failed. */
const LOAD_TIMEOUT_MS = 15_000

const MAX_LOAD_ATTEMPTS = 5

/**
 * Whether a form with this site key may be submitted: always when Turnstile is
 * off, otherwise once the widget holds a token. Pass the setter to the widget
 * as `onReadyChange` and disable the submit button while this is false.
 */
export function useTurnstileReady(siteKey: string | null | undefined) {
	const [ready, setReady] = useState(false)
	return [!siteKey || ready, setReady] as const
}

/**
 * Cloudflare Turnstile challenge for a form. Renders nothing without a site
 * key. The widget adds a hidden `cf-turnstile-response` input to the
 * surrounding form; the action verifies it with `checkOperatorTurnstile`.
 *
 * A token is single use, so pass the latest action result as `resetKey`: the
 * widget fetches a new token whenever it changes. `onReadyChange` reports
 * whether the widget currently holds a token (see `useTurnstileReady`).
 */
export function TurnstileWidget({
	siteKey,
	action,
	resetKey,
	onReadyChange,
}: {
	siteKey: string | null | undefined
	action: string
	resetKey?: unknown
	onReadyChange?: (ready: boolean) => void
}) {
	const containerRef = useRef<HTMLDivElement>(null)
	const widgetIdRef = useRef<string | null>(null)
	const onReadyRef = useRef(onReadyChange)
	onReadyRef.current = onReadyChange
	const [attempt, setAttempt] = useState(1)
	// Bumped by the Try again button to start a fresh load.
	const [loadRun, setLoadRun] = useState(0)
	const [loadFailed, setLoadFailed] = useState(false)
	const nonce = useNonce()
	const { i18n, _ } = useLingui()
	// Read at render time only: a theme or language change must not throw away
	// a challenge the visitor already solved.
	const theme = useOptionalTheme()
	const optionsRef = useRef({ theme, locale: i18n.locale })
	optionsRef.current = { theme, locale: i18n.locale }

	useEffect(() => {
		const container = containerRef.current
		if (!siteKey || !container) return
		let cancelled = false
		let retryTimer: ReturnType<typeof setTimeout> | undefined
		loadTurnstile(nonce)
			.then((turnstile) => {
				if (cancelled) return
				setLoadFailed(false)
				const options = optionsRef.current
				widgetIdRef.current =
					turnstile.render(container, {
						sitekey: siteKey,
						action,
						theme: options.theme ?? 'auto',
						language: options.locale || 'auto',
						size: 'flexible',
						callback: () => {
							setLoadFailed(false)
							onReadyRef.current?.(true)
						},
						'expired-callback': () => onReadyRef.current?.(false),
						// The challenge itself failed (network, blocked iframe): say so
						// and offer a retry, or the disabled form would be a dead end.
						'error-callback': () => {
							onReadyRef.current?.(false)
							setLoadFailed(true)
						},
					}) ?? null
			})
			.catch(() => {
				// Blocked or offline: try again with a growing delay, then say so.
				// Until a token exists the form stays disabled.
				if (cancelled) return
				if (attempt >= MAX_LOAD_ATTEMPTS) {
					setLoadFailed(true)
					return
				}
				retryTimer = setTimeout(() => setAttempt((n) => n + 1), attempt * 2000)
			})
		return () => {
			cancelled = true
			clearTimeout(retryTimer)
			const widgetId = widgetIdRef.current
			widgetIdRef.current = null
			onReadyRef.current?.(false)
			if (widgetId) window.turnstile?.remove(widgetId)
		}
	}, [siteKey, action, nonce, attempt, loadRun])

	useEffect(() => {
		if (resetKey === undefined) return
		const widgetId = widgetIdRef.current
		if (widgetId) {
			onReadyRef.current?.(false)
			window.turnstile?.reset(widgetId)
		}
	}, [resetKey])

	if (!siteKey) return null
	return (
		<div className="flex w-full flex-col gap-2">
			<div
				ref={containerRef}
				role="group"
				aria-label={_(msg`Security check`)}
				className={loadFailed ? 'w-full' : 'min-h-16.25 w-full'}
			/>
			<div aria-live="polite">
				{loadFailed ? (
					<div className="text-destructive flex flex-col items-start gap-2 text-sm">
						<p>
							<Trans>
								The security check could not load. Turn off content blockers or
								check your connection, then try again.
							</Trans>
						</p>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => {
								setLoadFailed(false)
								const widgetId = widgetIdRef.current
								// A rendered widget gets a fresh challenge; a script that
								// never loaded starts loading again.
								if (widgetId) window.turnstile?.reset(widgetId)
								else {
									setAttempt(1)
									setLoadRun((n) => n + 1)
								}
							}}
						>
							<Trans>Try again</Trans>
						</Button>
					</div>
				) : null}
			</div>
		</div>
	)
}
