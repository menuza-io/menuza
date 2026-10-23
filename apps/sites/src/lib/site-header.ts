import { closeSiteDisclosure } from './site-interactions'

/** Section links describe a location within a page, not the current page. */
export function isCurrentHeaderLink(href: string, currentUrl: URL): boolean {
	if (!href || href.startsWith('#')) return false
	try {
		const target = new URL(href, currentUrl)
		if (target.hash) return false
		const path = (value: string) => value.replace(/\/+$/, '') || '/'
		return (
			target.origin === currentUrl.origin &&
			path(target.pathname) === path(currentUrl.pathname)
		)
	} catch {
		return false
	}
}

export function headerNeedsCompactNavigation({
	available,
	brand,
	navigation,
	actions,
	gap,
}: {
	available: number
	brand: number
	navigation: number
	actions: number
	gap: number
}): boolean {
	return navigation > 0 && brand + navigation + actions + gap * 2 > available
}

/** Keep long labels reachable in the menu rather than clipping desktop links. */
function mountHeader(header: HTMLElement): () => void {
	const row = header.querySelector<HTMLElement>('[data-header-row]')
	const brand = header.querySelector<HTMLElement>('[data-header-brand]')
	const links = header.querySelector<HTMLElement>('[data-header-links]')
	const actions = header.querySelector<HTMLElement>('[data-header-actions]')
	const menu = header.querySelector<HTMLElement>('[data-header-menu]')
	if (!row || !brand || !links || !actions || !menu) return () => {}
	let frame = 0

	function measure() {
		frame = 0
		if (!window.matchMedia('(min-width: 64rem)').matches) {
			header.removeAttribute('data-compact')
			return
		}
		const style = getComputedStyle(row!)
		const actionStyle = getComputedStyle(actions!)
		const gap = Number.parseFloat(style.columnGap) || 0
		const actionGap = Number.parseFloat(actionStyle.columnGap) || 0
		const toggleWidth = menu!.offsetWidth
		const actionWidth =
			actions!.offsetWidth - (toggleWidth ? toggleWidth + actionGap : 0)
		const name = brand!.querySelector<HTMLElement>('[data-header-name]')
		const logo = brand!.querySelector<HTMLElement>('img')
		const brandGap = Number.parseFloat(getComputedStyle(brand!).columnGap) || 0
		// The CSS `max-width` (in rem) is the cap, so it follows the font size.
		const brandMax =
			Number.parseFloat(getComputedStyle(brand!).maxWidth) || Infinity
		const brandWidth = Math.min(
			brandMax,
			(name?.scrollWidth ?? 0) +
				(logo?.offsetWidth ?? 0) +
				(name && logo ? brandGap : 0),
		)
		const compact = headerNeedsCompactNavigation({
			available:
				row!.clientWidth -
				Number.parseFloat(style.paddingLeft) -
				Number.parseFloat(style.paddingRight),
			brand: brandWidth,
			navigation: links!.offsetWidth,
			actions: actionWidth,
			gap,
		})
		header.toggleAttribute('data-compact', compact)
		if (!compact && menu instanceof HTMLDetailsElement && menu.open)
			closeSiteDisclosure(menu)
	}
	function schedule() {
		if (!frame) frame = requestAnimationFrame(measure)
	}
	const observer = new ResizeObserver(schedule)
	for (const element of [row, links, actions]) observer.observe(element)
	measure()
	return () => {
		observer.disconnect()
		if (frame) cancelAnimationFrame(frame)
	}
}

export function mountSiteHeaders(): () => void {
	let cleanups: Array<() => void> = []
	function mount() {
		cleanups.forEach((cleanup) => cleanup())
		cleanups = Array.from(
			document.querySelectorAll<HTMLElement>('[data-site-header]'),
			mountHeader,
		)
	}
	mount()
	document.addEventListener('sites:content-updated', mount)
	return () => {
		cleanups.forEach((cleanup) => cleanup())
		document.removeEventListener('sites:content-updated', mount)
	}
}
