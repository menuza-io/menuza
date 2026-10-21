/**
 * Window-level pointer tracking for a drag that starts on an element: move,
 * release and cancel are all listened to, and one `detach` removes every
 * listener. Cancel matters: the system takes the pointer for a touch that
 * turned into a scroll or a context menu, and no `pointerup` follows, so a
 * drag without a cancel handler leaves its listeners on `window` for good.
 */
export function trackPointerDrag(
	target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
	handlers: {
		move: (event: PointerEvent) => void
		up: (event: PointerEvent) => void
		cancel: (event: PointerEvent) => void
	},
): () => void {
	let attached = true
	const detach = () => {
		if (!attached) return
		attached = false
		target.removeEventListener('pointermove', onMove as EventListener)
		target.removeEventListener('pointerup', onUp as EventListener)
		target.removeEventListener('pointercancel', onCancel as EventListener)
	}
	const onMove = (event: PointerEvent) => handlers.move(event)
	const onUp = (event: PointerEvent) => {
		detach()
		handlers.up(event)
	}
	const onCancel = (event: PointerEvent) => {
		detach()
		handlers.cancel(event)
	}
	target.addEventListener('pointermove', onMove as EventListener)
	target.addEventListener('pointerup', onUp as EventListener)
	target.addEventListener('pointercancel', onCancel as EventListener)
	return detach
}
