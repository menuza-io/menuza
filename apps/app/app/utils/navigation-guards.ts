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

// One prompt for the whole app: React Router consults only the most recently
// registered blocker, so at most one blocker is ever `blocked` and one slot is
// enough. `LeavePageDialog` (mounted in root.tsx) shows it.
let leavePrompt: LeavePrompt | null = null
const leavePromptListeners = new Set<() => void>()

function setLeavePrompt(next: LeavePrompt | null) {
	const previous = leavePrompt
	leavePrompt = next
	// A newer prompt replaces an unanswered one. Reset that blocker so its
	// navigation is not stuck with no dialog.
	if (previous && next && previous !== next) previous.stay()
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
		// Answer once: a closing dialog can report "stay" after "leave".
		let answered = false
		const answer = (decide: () => void) => () => {
			if (answered) return
			answered = true
			decide()
		}
		const prompt: LeavePrompt = {
			message,
			leave: answer(() => blocker.proceed()),
			stay: answer(() => blocker.reset()),
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
