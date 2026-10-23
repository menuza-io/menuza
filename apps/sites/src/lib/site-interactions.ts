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

function mountFluidNav(container: HTMLElement): () => void {
	const highlight = document.createElement('span')
	highlight.className = 'site-nav-highlight'
	highlight.setAttribute('aria-hidden', 'true')
	container.prepend(highlight)
	let current: HTMLElement | null = null
	let frame = 0
	let point: { x: number; y: number } | null = null
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
	function move(event: PointerEvent) {
		if (
			event.pointerType === 'touch' ||
			!window.matchMedia('(hover: hover)').matches
		)
			return
		point = { x: event.clientX, y: event.clientY }
		if (!frame) frame = requestAnimationFrame(pick)
	}
	function leave() {
		point = null
		if (frame) cancelAnimationFrame(frame)
		frame = 0
		hide()
	}
	function click(event: MouseEvent) {
		if (event.target === container && current) current.click()
	}
	function refresh() {
		if (current?.isConnected && current.getClientRects().length) paint(current)
		else hide()
	}
	const observer = new ResizeObserver(refresh)
	observer.observe(container)
	container.addEventListener('pointermove', move)
	container.addEventListener('pointerleave', leave)
	container.addEventListener('click', click)
	container.addEventListener('scroll', refresh, { passive: true })
	return () => {
		leave()
		observer.disconnect()
		container.removeEventListener('pointermove', move)
		container.removeEventListener('pointerleave', leave)
		container.removeEventListener('click', click)
		container.removeEventListener('scroll', refresh)
		highlight.remove()
	}
}

function mountDisclosure(details: HTMLDetailsElement): () => void {
	const trigger = details.querySelector('summary')
	const dropdown = details.querySelector<HTMLElement>(':scope > .t-dropdown')
	const panel = dropdown ?? details.querySelector<HTMLElement>('.t-acc-panel')
	if (!trigger || !panel) return () => {}
	let timer: ReturnType<typeof setTimeout> | undefined
	let open = details.open
	details.dataset.motionReady = 'true'
	details.dataset.open = String(open)
	trigger.setAttribute('aria-expanded', String(open))
	panel.classList.toggle('is-open', open)
	panel.inert = !open

	function setOpen(next: boolean) {
		clearTimeout(timer)
		open = next
		trigger!.setAttribute('aria-expanded', String(open))
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
				details.open = false
				panel!.classList.remove('is-closing')
			}
			const duration = reducedMotion()
				? 0
				: cssDurationMs(
						details,
						dropdown ? '--dropdown-close-dur' : '--acc-collapse',
					)
			if (duration === 0) finish()
			else timer = setTimeout(finish, duration)
		}
	}
	function toggle(event: MouseEvent) {
		event.preventDefault()
		setOpen(!open)
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
	function followLink(event: MouseEvent) {
		if (
			dropdown &&
			event.target instanceof Element &&
			event.target.closest('a[href]')
		)
			setOpen(false)
	}
	trigger.addEventListener('click', toggle)
	panel.addEventListener('click', followLink)
	document.addEventListener('click', outside)
	details.addEventListener('keydown', keydown)
	return () => {
		clearTimeout(timer)
		trigger.removeEventListener('click', toggle)
		panel.removeEventListener('click', followLink)
		document.removeEventListener('click', outside)
		details.removeEventListener('keydown', keydown)
	}
}

export function mountSiteInteractions() {
	let cleanups: Array<() => void> = []
	function mount() {
		cleanups.forEach((cleanup) => cleanup())
		cleanups = [
			...Array.from(
				document.querySelectorAll<HTMLElement>('[data-fluid-nav]'),
				mountFluidNav,
			),
			...Array.from(
				document.querySelectorAll<HTMLDetailsElement>('[data-site-disclosure]'),
				mountDisclosure,
			),
		]
	}
	mount()
	// The website editor replaces the rendered chrome and blocks in place.
	document.addEventListener('sites:content-updated', mount)
	return () => {
		cleanups.forEach((cleanup) => cleanup())
		document.removeEventListener('sites:content-updated', mount)
	}
}
