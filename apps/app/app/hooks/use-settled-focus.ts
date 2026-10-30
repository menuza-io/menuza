import { useCallback, useRef } from 'react'

/**
 * Where focus goes when a dialog closes after its action worked. The action
 * can remove the button that opened the dialog (a decided review, a fully
 * refunded sale), and focus would then fall to the page body. Call `settle()`
 * on success and pass `finalFocus` to the dialog content: focus lands on the
 * element with `targetId`, made focusable. A cancelled dialog still returns
 * focus to its trigger.
 */
export function useSettledFocus(targetId: string) {
	const settled = useRef(false)
	const settle = useCallback(() => {
		settled.current = true
	}, [])
	const finalFocus = useCallback((): HTMLElement | boolean => {
		if (!settled.current) return true
		settled.current = false
		const target = document.getElementById(targetId)
		if (!target) return true
		if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
		return target
	}, [targetId])
	return { settle, finalFocus }
}
