import {
	useEffect,
	useLayoutEffect,
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

export type LeavePrompt = {
	message: string
	leave: () => void
	stay: () => void
}

// One prompt for the whole app: React Router honors one blocker at a time,
// and `LeavePageDialog` (mounted in root.tsx) shows it.
let leavePrompt: LeavePrompt | null = null
const leavePromptListeners = new Set<() => void>()

function setLeavePrompt(next: LeavePrompt | null) {
	leavePrompt = next
	for (const listener of leavePromptListeners) listener()
}

function subscribeToLeavePrompt(callback: () => void) {
	leavePromptListeners.add(callback)
	return () => leavePromptListeners.delete(callback)
}

export function useLeavePrompt() {
	return useSyncExternalStore(
		subscribeToLeavePrompt,
		() => leavePrompt,
		() => null,
	)
}

/**
 * Blocks in-app navigation while `shouldBlock` holds and asks the operator,
 * in an in-app dialog, whether to leave. Not `window.confirm`: a native
 * dialog is easy to miss and is dismissed silently by browser automation,
 * which makes every link look dead.
 */
export function useConfirmBlocker(
	shouldBlock: boolean | BlockerFunction,
	message: string,
) {
	const blocker = useBlocker(shouldBlock)

	useEffect(() => {
		if (blocker.state !== 'blocked') return
		const prompt: LeavePrompt = {
			message,
			leave: () => blocker.proceed(),
			stay: () => blocker.reset(),
		}
		setLeavePrompt(prompt)
		return () => {
			if (leavePrompt === prompt) setLeavePrompt(null)
		}
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
