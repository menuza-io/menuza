import { prefersReducedMotion } from './dom.ts'

export type ScrollSpyOptions = {
	/** One or more `<nav>` elements whose `a[href^="#"]` chips mirror `sections`. */
	nav: HTMLElement | HTMLElement[]
	sections: HTMLElement[]
	/** Pixels covered by sticky chrome at the top of the viewport. */
	offset?: number | (() => number)
	activeClass?: string
	inactiveClass?: string
}

export type ScrollSpy = {
	setActive(id: string): void
	destroy(): void
}

const DEFAULT_ACTIVE = 'border-primary bg-primary text-primary-foreground'
const DEFAULT_INACTIVE =
	'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground'

function split(classes: string): string[] {
	return classes.split(/\s+/).filter(Boolean)
}

export function mountScrollSpy(options: ScrollSpyOptions): ScrollSpy {
	const navs = Array.isArray(options.nav) ? options.nav : [options.nav]
	const offset = () =>
		typeof options.offset === 'function'
			? options.offset()
			: (options.offset ?? 0)
	const sections = options.sections.filter((section) => section.id)
	// Each nav may style its chips differently (horizontal pills vs. a rail), so
	// the class sets are read per nav from `data-active-class` / `data-inactive-class`.
	type Chip = {
		element: HTMLAnchorElement
		active: string[]
		inactive: string[]
	}
	const chips: Chip[] = navs.flatMap((nav) => {
		const active = split(
			options.activeClass ?? nav.dataset.activeClass ?? DEFAULT_ACTIVE,
		)
		const inactive = split(
			options.inactiveClass ?? nav.dataset.inactiveClass ?? DEFAULT_INACTIVE,
		)
		return Array.from(
			nav.querySelectorAll<HTMLAnchorElement>('a[href^="#"]'),
		).map((element) => ({ element, active, inactive }))
	})

	let activeId: string | null = null
	let lockUntil = 0
	let frame = 0

	function paint(chip: Chip, on: boolean) {
		chip.element.classList.remove(...(on ? chip.inactive : chip.active))
		chip.element.classList.add(...(on ? chip.active : chip.inactive))
		if (on) chip.element.setAttribute('aria-current', 'true')
		else chip.element.removeAttribute('aria-current')
	}

	function revealChip(chip: HTMLAnchorElement) {
		const scroller =
			chip.closest<HTMLElement>('[data-scroll-spy-scroller]') ??
			chip.parentElement
		if (!scroller) return
		const chipRect = chip.getBoundingClientRect()
		const box = scroller.getBoundingClientRect()
		const horizontal = scroller.scrollWidth > scroller.clientWidth
		const vertical = scroller.scrollHeight > scroller.clientHeight
		const hiddenX =
			horizontal && (chipRect.left < box.left || chipRect.right > box.right)
		const hiddenY =
			vertical && (chipRect.top < box.top || chipRect.bottom > box.bottom)
		if (!hiddenX && !hiddenY) return
		chip.scrollIntoView({
			behavior: prefersReducedMotion() ? 'auto' : 'smooth',
			block: 'nearest',
			inline: 'center',
		})
	}

	function setActive(id: string) {
		if (id === activeId) return
		activeId = id
		for (const chip of chips) {
			const on = chip.element.getAttribute('href') === `#${id}`
			paint(chip, on)
			if (on) revealChip(chip.element)
		}
	}

	function visibleSections(): HTMLElement[] {
		return sections.filter((section) => section.offsetParent !== null)
	}

	// Pick the last section whose top has passed the sticky chrome; falls back
	// to the first section so a chip is always active.
	function update() {
		frame = 0
		if (Date.now() < lockUntil) return
		const candidates = visibleSections()
		if (!candidates.length) return
		const line = offset() + 8
		let current = candidates[0]!
		for (const section of candidates) {
			if (section.getBoundingClientRect().top <= line) current = section
			else break
		}
		const atBottom =
			window.innerHeight + window.scrollY >=
			document.documentElement.scrollHeight - 2
		if (atBottom) current = candidates[candidates.length - 1]!
		setActive(current.id)
	}

	function schedule() {
		if (frame) return
		frame = requestAnimationFrame(update)
	}

	const observer =
		typeof IntersectionObserver === 'function'
			? new IntersectionObserver(schedule, {
					rootMargin: `-${offset()}px 0px 0px 0px`,
					threshold: [0, 0.25, 0.5, 0.75, 1],
				})
			: null
	for (const section of sections) observer?.observe(section)
	window.addEventListener('scroll', schedule, { passive: true })
	window.addEventListener('resize', schedule)

	const onChipClick = (event: Event) => {
		const chip = (event.target as HTMLElement).closest<HTMLAnchorElement>(
			'a[href^="#"]',
		)
		if (!chip) return
		const id = chip.getAttribute('href')!.slice(1)
		const section = sections.find((candidate) => candidate.id === id)
		if (!section) return
		event.preventDefault()
		setActive(id)
		lockUntil = Date.now() + 800
		const top = section.getBoundingClientRect().top + window.scrollY - offset()
		window.scrollTo({
			top,
			behavior: prefersReducedMotion() ? 'auto' : 'smooth',
		})
		section.setAttribute('tabindex', '-1')
		section.focus({ preventScroll: true })
	}
	for (const nav of navs) nav.addEventListener('click', onChipClick)

	update()

	return {
		setActive,
		destroy() {
			observer?.disconnect()
			window.removeEventListener('scroll', schedule)
			window.removeEventListener('resize', schedule)
			for (const nav of navs) nav.removeEventListener('click', onChipClick)
			if (frame) cancelAnimationFrame(frame)
		},
	}
}
