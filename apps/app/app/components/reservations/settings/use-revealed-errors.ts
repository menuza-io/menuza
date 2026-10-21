import { useCallback, useMemo, useState } from 'react'

/**
 * Field errors that never go stale.
 *
 * The caller derives `live` errors from the current form values on every
 * render (a pure function of the values, `{}` when valid). This hook decides
 * which of them are on screen: all of them once the user has tried to submit,
 * or just the fields they have left (blur) before that. Because the shown
 * errors are always a subset of the live ones, typing a valid value clears the
 * message at once, with no manual `setError(null)` calls to forget.
 */
export function useRevealedErrors<K extends string, E>(
	live: Partial<Record<K, E>>,
) {
	const [attempted, setAttempted] = useState(false)
	const [touched, setTouched] = useState<ReadonlySet<K>>(() => new Set())

	const errors = useMemo(() => {
		const shown: Partial<Record<K, E>> = {}
		for (const key of Object.keys(live) as K[]) {
			if (live[key] !== undefined && (attempted || touched.has(key))) {
				shown[key] = live[key]
			}
		}
		return shown
	}, [live, attempted, touched])

	/** Call from the submit handler; returns true when the form is valid. */
	const attempt = useCallback(() => {
		setAttempted(true)
		return Object.values(live).every((value) => value === undefined)
	}, [live])

	/** Call from a field's `onBlur`. */
	const touch = useCallback((key: K) => {
		setTouched((current) =>
			current.has(key) ? current : new Set(current).add(key),
		)
	}, [])

	/** Call when the form opens for a different record or closes. */
	const reset = useCallback(() => {
		setAttempted(false)
		setTouched(new Set())
	}, [])

	return { errors, attempt, touch, reset, attempted }
}
