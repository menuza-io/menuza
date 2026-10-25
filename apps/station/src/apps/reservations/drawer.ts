import { useEffect, useRef, type RefObject } from 'react'

/**
 * Focus for a drawer over the floor (the narrow tablet's list). It moves into
 * the drawer once, when the drawer opens, and goes back to the button that
 * opened it when it closes. The ref is stable: a callback ref made inline runs
 * again on every commit, and with a search box inside the drawer that took
 * focus from it on every keystroke.
 */
export function useDrawerFocus<T extends HTMLElement>(
	open: boolean,
	opener: RefObject<HTMLElement | null>,
) {
	const drawer = useRef<T>(null)
	useEffect(() => {
		if (!open) return
		const opening = opener.current
		drawer.current?.focus()
		return () => opening?.focus()
		// The opener is a ref: only the drawer opening or closing moves focus.
	}, [open, opener])
	return drawer
}
