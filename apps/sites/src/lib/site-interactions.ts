import { cssDurationMs, reducedMotion } from './site-motion'

type ItemRect = { left: number; right: number; top: number; bottom: number }

/** Inside always wins; gaps resolve to the nearest center, as in @fluid. */
export function nearestNavItem(
	rects: ItemRect[],
	x: number,
	y: number,
	axis: string,
): number {
	let nearest = -1
	let distance = Infinity
	for (const [index, rect] of rects.entries()) {
		if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
			return index
		const dx = axis === 'y' ? 0 : x - (rect.left + rect.right) / 2
		const dy = axis === 'x' ? 0 : y - (rect.top + rect.bottom) / 2
		const next = Math.hypot(dx, dy)
		if (next < distance) {
			distance = next
			nearest = index
		}
	}
	return nearest
}

// Taps get no hover preview, so they never light or forward to an item.
function hovers(event: MouseEvent): boolean {
	return (
		(event as PointerEvent).pointerType !== 'touch' &&
		window.matchMedia('(hover: hover)').matches
	)
}

function mountFluidNav(container: HTMLElement): () => void {
	// A list may only hold list items; the hidden one stays out of the count.
	const highlight = document.createElement(
		container.matches('ul, ol') ? 'li' : 'span',
	)
	highlight.className = 'site-nav-highlight'
	highlight.setAttribute('aria-hidden', 'true')
	container.prepend(highlight)
	let current: HTMLElement | null = null
	let frame = 0
	let point: { x: number; y: number } | null = null
	let touched = false
	const items = () =>
		Array.from(
			container.querySelectorAll<HTMLElement>('a[href], button'),
		).filter(
			(item) =>
				item.getClientRects().length > 0 &&
				!item.matches(':disabled, [aria-disabled="true"]') &&
				!item.closest('[inert]'),
		)

	function paint(item: HTMLElement) {
		const box = container.getBoundingClientRect()
		const rect = item.getBoundingClientRect()
		if (!box.width || !box.height) return
		// Account for a dropdown's scale, scrolling, and RTL scrollLeft.
		const scaleX = box.width / container.offsetWidth
		const scaleY = box.height / container.offsetHeight
		const x =
			(rect.left - box.left) / scaleX +
			container.scrollLeft -
			container.clientLeft
		const y =
			(rect.top - box.top) / scaleY + container.scrollTop - container.clientTop
		highlight.style.width = `${rect.width / scaleX}px`
		highlight.style.height = `${rect.height / scaleY}px`
		highlight.style.transform = `translate(${x}px, ${y}px)`
		if (!current) {
			highlight.classList.remove('is-positioned')
			void highlight.offsetWidth
			highlight.classList.add('is-positioned')
		}
		current = item
		highlight.classList.add('is-visible')
	}
	function hide() {
		current = null
		highlight.classList.remove('is-visible', 'is-positioned')
	}
	function pick() {
		frame = 0
		if (!point) return
		const candidates = items()
		const rects = candidates.map((item) => item.getBoundingClientRect())
		const axis = container.dataset.fluidNav ?? 'xy'
		const index = nearestNavItem(rects, point.x, point.y, axis)
		const rect = rects[index]
		if (!rect) return hide()
		// Do not light distant links across a full-width navigation's empty space.
		const distance = Math.hypot(
			Math.max(rect.left - point.x, 0, point.x - rect.right),
			Math.max(rect.top - point.y, 0, point.y - rect.bottom),
		)
		const item = candidates[index]
		if (item && distance <= 16) paint(item)
		else hide()
	}
	function down(event: PointerEvent) {
		touched = event.pointerType === 'touch'
	}
	function move(event: PointerEvent) {
		if (!hovers(event)) return
		touched = false
		point = { x: event.clientX, y: event.clientY }
		if (!frame) frame = requestAnimationFrame(pick)
	}
	function leave() {
		point = null
		if (frame) cancelAnimationFrame(frame)
		frame = 0
		hide()
	}
	// A click in the gap between items goes to the item under the pointer now,
	// never to a highlight left behind by an earlier move.
	function click(event: MouseEvent) {
		const touchTap = touched
		touched = false
		if (event.target !== container || touchTap || !hovers(event)) return
		point = { x: event.clientX, y: event.clientY }
		pick()
		current?.click()
	}
	function refresh() {
		if (current?.isConnected && current.getClientRects().length) paint(current)
		else hide()
	}
	const observer = new ResizeObserver(refresh)
	observer.observe(container)
	container.addEventListener('pointerdown', down)
	container.addEventListener('pointermove', move)
	container.addEventListener('pointerleave', leave)
	container.addEventListener('click', click)
	container.addEventListener('scroll', refresh, { passive: true })
	return () => {
		leave()
		observer.disconnect()
		container.removeEventListener('pointerdown', down)
		container.removeEventListener('pointermove', move)
		container.removeEventListener('pointerleave', leave)
		container.removeEventListener('click', click)
		container.removeEventListener('scroll', refresh)
		highlight.remove()
	}
}

/** Asks an enhanced disclosure to close with its exit motion. */
export const SITE_DISCLOSURE_CLOSE = 'site-disclosure:close'

export function closeSiteDisclosure(details: HTMLDetailsElement) {
	if (details.dataset.motionReady) {
		details.dispatchEvent(new Event(SITE_DISCLOSURE_CLOSE))
	} else details.open = false
}

function mountDisclosure(details: HTMLDetailsElement): () => void {
	const trigger = details.querySelector('summary')
	const dropdown = details.querySelector<HTMLElement>(':scope > .t-dropdown')
	const panel = dropdown ?? details.querySelector<HTMLElement>('.t-acc-panel')
	if (!trigger || !panel) return () => {}
	let timer: ReturnType<typeof setTimeout> | undefined
	let open = details.open
	let closing = false
	details.dataset.motionReady = 'true'
	details.dataset.open = String(open)
	trigger.setAttribute('aria-expanded', String(open))
	panel.classList.toggle('is-open', open)

	function setOpen(next: boolean) {
		clearTimeout(timer)
		open = next
		closing = !open
		trigger!.setAttribute('aria-expanded', String(open))
		// Only the exit needs inert: a closed <details> already hides its
		// content, and inert would also hide it from find-in-page.
		panel!.inert = !open
		if (open) {
			details.open = true
			panel!.classList.remove('is-closing')
			void panel!.offsetWidth
			panel!.classList.add('is-open')
			details.dataset.open = 'true'
		} else {
			details.dataset.open = 'false'
			panel!.classList.remove('is-open')
			if (dropdown) panel!.classList.add('is-closing')
			const finish = () => {
				closing = false
				details.open = false
				panel!.inert = false
				panel!.classList.remove('is-closing')
			}
			const duration = reducedMotion()
				? 0
				: cssDurationMs(
						details,
						dropdown ? '--dropdown-close-dur' : '--acc-collapse',
					)
			// A natively closed element has no exit left to show.
			if (duration === 0 || !details.open) finish()
			else timer = setTimeout(finish, duration)
		}
	}
	function toggle(event: MouseEvent) {
		event.preventDefault()
		setOpen(!open)
	}
	// Find-in-page and scripts open or close the element natively.
	function sync() {
		if (details.open && !open && !closing) setOpen(true)
		else if (!details.open && open) setOpen(false)
	}
	function outside(event: MouseEvent) {
		if (
			dropdown &&
			open &&
			event.target instanceof Node &&
			!details.contains(event.target)
		)
			setOpen(false)
	}
	function keydown(event: KeyboardEvent) {
		if (dropdown && open && event.key === 'Escape') {
			event.preventDefault()
			setOpen(false)
			trigger!.focus({ preventScroll: true })
		}
	}
	// Tabbing out of a dropdown closes it, as with an outside click.
	function focusout(event: FocusEvent) {
		if (
			dropdown &&
			open &&
			event.relatedTarget instanceof Node &&
			!details.contains(event.relatedTarget)
		)
			setOpen(false)
	}
	function close() {
		if (open) setOpen(false)
	}
	function followLink(event: MouseEvent) {
		if (
			dropdown &&
			event.target instanceof Element &&
			event.target.closest('a[href]')
		)
			setOpen(false)
	}
	trigger.addEventListener('click', toggle)
	details.addEventListener('toggle', sync)
	panel.addEventListener('click', followLink)
	if (dropdown) document.addEventListener('click', outside)
	details.addEventListener('keydown', keydown)
	details.addEventListener('focusout', focusout)
	details.addEventListener(SITE_DISCLOSURE_CLOSE, close)
	return () => {
		clearTimeout(timer)
		trigger.removeEventListener('click', toggle)
		details.removeEventListener('toggle', sync)
		panel.removeEventListener('click', followLink)
		document.removeEventListener('click', outside)
		details.removeEventListener('keydown', keydown)
		details.removeEventListener('focusout', focusout)
		details.removeEventListener(SITE_DISCLOSURE_CLOSE, close)
	}
}

export function mountSiteInteractions() {
	const mounted = new Map<HTMLElement, () => void>()
	/** Mounts new elements once; elements that survive an update keep their
	 * state (an open menu stays open), and removed ones are cleaned up. */
	function mount() {
		for (const [element, cleanup] of mounted) {
			if (element.isConnected) continue
			cleanup()
			mounted.delete(element)
		}
		const add = <T extends HTMLElement>(
			elements: NodeListOf<T>,
			mountOne: (element: T) => () => void,
		) => {
			for (const element of elements)
				if (!mounted.has(element)) mounted.set(element, mountOne(element))
		}
		add(
			document.querySelectorAll<HTMLElement>('[data-fluid-nav]'),
			mountFluidNav,
		)
		add(
			document.querySelectorAll<HTMLDetailsElement>('[data-site-disclosure]'),
			mountDisclosure,
		)
	}
	mount()
	// The website editor replaces the rendered chrome and blocks in place.
	document.addEventListener('sites:content-updated', mount)
	return () => {
		mounted.forEach((cleanup) => cleanup())
		mounted.clear()
		document.removeEventListener('sites:content-updated', mount)
	}
}
