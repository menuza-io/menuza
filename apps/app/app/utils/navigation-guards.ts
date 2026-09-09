import {
	useEffect,
	useLayoutEffect,
	useRef,
	useSyncExternalStore,
	type Dispatch,
	type MutableRefObject,
	type SetStateAction,
} from 'react'
import { useBlocker, type BlockerFunction } from 'react-router'

function subscribeToMediaQuery(query: string, callback: () => void) {
	const mql = window.matchMedia(query)
	mql.addEventListener('change', callback)
	return () => mql.removeEventListener('change', callback)
}

export function useMinWidthMediaQuery(
	minWidthPx: number,
	serverFallback = true,
) {
	const query = `(min-width: ${minWidthPx}px)`
	return useSyncExternalStore(
		(callback) => subscribeToMediaQuery(query, callback),
		() => window.matchMedia(query).matches,
		() => serverFallback,
	)
}

export function useConfirmBlocker(
	shouldBlock: boolean | BlockerFunction,
	message: string,
) {
	const blocker = useBlocker(shouldBlock)
	const prompted = useRef(false)

	useEffect(() => {
		if (blocker.state !== 'blocked') {
			prompted.current = false
			return
		}
		if (prompted.current) return
		prompted.current = true
		if (window.confirm(message)) blocker.proceed()
		else blocker.reset()
	}, [blocker, message])
}

export function useDirtyBeforeUnload(isDirty: boolean) {
	useEffect(() => {
		const warn = (event: BeforeUnloadEvent) => {
			if (!isDirty) return
			event.preventDefault()
		}
		window.addEventListener('beforeunload', warn)
		return () => window.removeEventListener('beforeunload', warn)
	}, [isDirty])
}

export function useFetcherSavedSnapshot<T>({
	fetcherState,
	fetcherData,
	pendingSnapshot,
	setSaved,
	setDraft,
}: {
	fetcherState: 'idle' | 'submitting' | 'loading'
	fetcherData: { form?: T } | undefined
	pendingSnapshot: MutableRefObject<string>
	setSaved: Dispatch<SetStateAction<T>>
	setDraft: Dispatch<SetStateAction<T>>
}) {
	useLayoutEffect(() => {
		if (fetcherState !== 'idle' || !fetcherData?.form) return
		const snapshot = pendingSnapshot.current
		if (!snapshot) return
		const savedForm = fetcherData.form
		setSaved(savedForm)
		setDraft((current) =>
			JSON.stringify(current) === snapshot ? savedForm : current,
		)
		pendingSnapshot.current = ''
	}, [fetcherData, fetcherState, pendingSnapshot, setDraft, setSaved])
}
