import { type ColorMode } from '@xyflow/react'
import { useSyncExternalStore } from 'react'

function subscribe(onChange: () => void) {
	const observer = new MutationObserver(onChange)
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ['class'],
	})
	return () => observer.disconnect()
}

const getSnapshot = (): ColorMode =>
	document.documentElement.classList.contains('dark') ? 'dark' : 'light'

/**
 * React Flow's `colorMode="system"` follows the OS preference, but the apps
 * pick their theme with a `dark` class on <html> (user setting, cookie). Read
 * that class so the canvas, controls and minimap match the rest of the UI.
 */
export function useFlowColorMode(): ColorMode {
	return useSyncExternalStore(subscribe, getSnapshot, () => 'light')
}
