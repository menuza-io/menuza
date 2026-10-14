import { useEffect, useState } from 'react'

const MOBILE_QUERY = '(max-width: 767px)'

/**
 * Whether the viewport is narrower than 768px. It is false on the server and
 * during hydration. A change only applies once the viewport has stayed on the
 * other side of 768px for `settleMs`, so a brief resize (for example while the
 * browser captures a full-page screenshot) does not rearrange the page.
 */
export function useMobileViewport(settleMs = 100) {
	const [isMobile, setIsMobile] = useState(false)

	useEffect(() => {
		const query = window.matchMedia(MOBILE_QUERY)
		let timer: ReturnType<typeof setTimeout> | undefined
		const onChange = () => {
			clearTimeout(timer)
			timer = setTimeout(() => setIsMobile(query.matches), settleMs)
		}
		setIsMobile(query.matches)
		query.addEventListener('change', onChange)
		return () => {
			clearTimeout(timer)
			query.removeEventListener('change', onChange)
		}
	}, [settleMs])

	return isMobile
}
