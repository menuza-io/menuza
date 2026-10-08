/** Builds an element with text set via `textContent` so menu text is never parsed as HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string | number,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag)
	if (className) node.className = className
	if (text !== undefined) node.textContent = String(text)
	return node
}

const ICON_PATHS = {
	plus: ['M5 12h14', 'M12 5v14'],
	minus: ['M5 12h14'],
	close: ['M18 6 6 18', 'm6 6 12 12'],
	check: ['M20 6 9 17l-5-5'],
	chevronDown: ['m6 9 6 6 6-6'],
	bag: [
		'M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z',
		'M3 6h18',
		'M16 10a4 4 0 0 1-8 0',
	],
	trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4h8v2'],
} as const

export type IconName = keyof typeof ICON_PATHS

const SVG_NS = 'http://www.w3.org/2000/svg'

/** 16px lucide-style stroke icon, decorative by default. */
export function icon(name: IconName, className = 'size-4'): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg')
	svg.setAttribute('viewBox', '0 0 24 24')
	svg.setAttribute('fill', 'none')
	svg.setAttribute('stroke', 'currentColor')
	svg.setAttribute('stroke-width', '2')
	svg.setAttribute('stroke-linecap', 'round')
	svg.setAttribute('stroke-linejoin', 'round')
	svg.setAttribute('aria-hidden', 'true')
	svg.setAttribute('class', className)
	for (const d of ICON_PATHS[name]) {
		const path = document.createElementNS(SVG_NS, 'path')
		path.setAttribute('d', d)
		svg.appendChild(path)
	}
	return svg
}

export function prefersReducedMotion(): boolean {
	return (
		typeof matchMedia === 'function' &&
		matchMedia('(prefers-reduced-motion: reduce)').matches
	)
}

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function focusableWithin(root: HTMLElement): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
		(node) => !node.closest('.hidden') && node.offsetParent !== null,
	)
}

/** Keeps Tab focus inside `container` until the returned function is called. */
export function trapFocus(container: HTMLElement): () => void {
	const onKeydown = (event: KeyboardEvent) => {
		if (event.key !== 'Tab') return
		const nodes = focusableWithin(container)
		if (!nodes.length) {
			event.preventDefault()
			container.focus()
			return
		}
		const first = nodes[0]!
		const last = nodes[nodes.length - 1]!
		const active = document.activeElement as HTMLElement | null
		if (event.shiftKey && (active === first || !container.contains(active))) {
			event.preventDefault()
			last.focus()
		} else if (!event.shiftKey && active === last) {
			event.preventDefault()
			first.focus()
		}
	}
	container.addEventListener('keydown', onKeydown)
	return () => container.removeEventListener('keydown', onKeydown)
}

let scrollLocks = 0

/** Locks page scroll while a layer is open; nested layers share one lock. */
export function lockScroll(): () => void {
	scrollLocks += 1
	document.documentElement.style.overflow = 'hidden'
	let released = false
	return () => {
		if (released) return
		released = true
		scrollLocks = Math.max(0, scrollLocks - 1)
		if (scrollLocks === 0) document.documentElement.style.overflow = ''
	}
}
