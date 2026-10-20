import { type RefObject, useLayoutEffect, useState } from 'react'

/**
 * Whether the element is narrower than `breakpoint` pixels. Screens that sit
 * beside a sidebar care about the room they are given, not the window, so a
 * dense table can fall back to stacked cards exactly when it stops fitting.
 * Starts wide (no flash of cards on a desktop) and settles after the first
 * measurement. Without `ResizeObserver` it reads the window once.
 */
export function useIsNarrow(
	ref: RefObject<HTMLElement | null>,
	breakpoint: number,
): boolean {
	const [narrow, setNarrow] = useState(false)
	useLayoutEffect(() => {
		const element = ref.current
		if (!element) return
		const measure = (width: number) => setNarrow(width < breakpoint)
		if (typeof ResizeObserver === 'undefined') {
			measure(element.clientWidth || window.innerWidth)
			return
		}
		measure(element.getBoundingClientRect().width || window.innerWidth)
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0]
			if (entry) measure(entry.contentRect.width)
		})
		observer.observe(element)
		return () => observer.disconnect()
	}, [ref, breakpoint])
	return narrow
}
