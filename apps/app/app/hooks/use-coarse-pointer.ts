import { useEffect, useState } from 'react'

const QUERY = '(pointer: coarse)'

/** True when the primary pointer is touch. SSR and first paint answer `false`. */
export function useCoarsePointer(): boolean {
	const [coarse, setCoarse] = useState(false)
	useEffect(() => {
		if (typeof window === 'undefined' || !window.matchMedia) return
		const mql = window.matchMedia(QUERY)
		const update = () => setCoarse(mql.matches)
		update()
		mql.addEventListener('change', update)
		return () => mql.removeEventListener('change', update)
	}, [])
	return coarse
}
