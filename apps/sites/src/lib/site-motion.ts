/** Read resolved CSS timing tokens, including values authored in seconds. */
export function cssDurationMs(element: Element, token: string): number {
	const value = getComputedStyle(element).getPropertyValue(token).trim()
	const amount = Number.parseFloat(value)
	if (!Number.isFinite(amount) || amount < 0) return 0
	return value.endsWith('ms') ? amount : amount * 1000
}

export function reducedMotion(): boolean {
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Keep the layer mounted through its exit, but cancel stale cleanup on reopen.
 * Focus containment and scroll locking stay with the owning interaction. */
export function createOverlayMotion(root: HTMLElement, surface: HTMLElement) {
	let open = false
	let cleanup: ReturnType<typeof setTimeout> | undefined

	return {
		isOpen: () => open,
		open() {
			clearTimeout(cleanup)
			open = true
			root.classList.remove('hidden')
			root.inert = false
			root.removeAttribute('aria-hidden')
			surface.classList.remove('is-closing')
			// Commit the pre-open scale after revealing a display:none layer.
			void surface.offsetWidth
			root.classList.add('is-open')
			surface.classList.add('is-open')
		},
		close() {
			if (!open) return
			open = false
			root.inert = true
			root.setAttribute('aria-hidden', 'true')
			root.classList.remove('is-open')
			surface.classList.remove('is-open')
			surface.classList.add('is-closing')
			const finish = () => {
				root.classList.add('hidden')
				surface.classList.remove('is-closing')
			}
			const duration = reducedMotion()
				? 0
				: cssDurationMs(root, '--modal-close-dur')
			if (duration === 0) finish()
			else cleanup = setTimeout(finish, duration)
		},
	}
}
