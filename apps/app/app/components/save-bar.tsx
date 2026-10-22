import { type FormMetadata } from '@conform-to/react'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { SaveBar as SaveBarView } from '@repo/ui/save-bar'
import {
	useCallback,
	useEffect,
	useId,
	useRef,
	useSyncExternalStore,
} from 'react'
import { type BlockerFunction } from 'react-router'
import {
	useConfirmBlocker,
	useDirtyBeforeUnload,
} from '#app/utils/navigation-guards.ts'

type SaveBarSource = {
	dirty: boolean
	saving: boolean
	guard: boolean
	showBar: boolean
	saveLast: boolean
	save: () => void
	discard: () => void
}

type SaveBarSnapshot = {
	visible: boolean
	saving: boolean
	/** Block navigation: something is dirty and no source guards itself. */
	guard: boolean
}

// One bar for the whole app, like the leave prompt in navigation-guards: every
// form on the page registers a source and the bar acts on all dirty ones.
const sources = new Map<string, SaveBarSource>()
const listeners = new Set<() => void>()
const HIDDEN: SaveBarSnapshot = { visible: false, saving: false, guard: false }
let snapshot: SaveBarSnapshot = HIDDEN
// `saveLast` sources waiting for the rest of a combined save to finish.
let deferredSaves: string[] = []
// Sources of the combined save that must finish before `deferredSaves` run.
let awaitedSaves: string[] = []
let settleTimer: ReturnType<typeof setTimeout> | undefined
const SETTLE_MS = 150

function clearDeferred() {
	deferredSaves = []
	awaitedSaves = []
	clearTimeout(settleTimer)
	settleTimer = undefined
}

// The page-moving save runs only once every other save landed and its form
// reset. A form still dirty and idle after a grace period failed: running the
// last save would navigate away from the edits that were kept.
function settleDeferred() {
	if (deferredSaves.length === 0 || snapshot.saving) return
	const blocked = awaitedSaves.some((id) => {
		const source = sources.get(id)
		return Boolean(source && source.dirty)
	})
	if (!blocked) {
		clearTimeout(settleTimer)
		settleTimer = undefined
		flushDeferredSaves()
		return
	}
	if (settleTimer) return
	settleTimer = setTimeout(() => {
		settleTimer = undefined
		if (deferredSaves.length === 0 || snapshot.saving) return
		const stillBlocked = awaitedSaves.some((id) => sources.get(id)?.dirty)
		if (stillBlocked) clearDeferred()
		else flushDeferredSaves()
	}, SETTLE_MS)
}

function publish() {
	let visible = false
	let saving = false
	let unsaved = false
	let selfGuarded = false
	for (const source of sources.values()) {
		if (source.showBar && (source.dirty || source.saving)) visible = true
		if (source.saving) saving = true
		if (source.dirty) {
			if (!source.guard) selfGuarded = true
			// A form that is saving is not lost by leaving; any other dirty one is.
			else if (!source.saving) unsaved = true
		}
	}
	const guard = unsaved && !selfGuarded
	if (
		visible !== snapshot.visible ||
		saving !== snapshot.saving ||
		guard !== snapshot.guard
	) {
		snapshot = visible || saving || guard ? { visible, saving, guard } : HIDDEN
		for (const listener of listeners) listener()
	}
	if (deferredSaves.length > 0 && !saving) settleDeferred()
}

function subscribe(callback: () => void) {
	listeners.add(callback)
	return () => listeners.delete(callback)
}

function useSaveBarSnapshot() {
	return useSyncExternalStore(
		subscribe,
		() => snapshot,
		() => HIDDEN,
	)
}

/** Registers a form with the global save bar. */
export function useSaveBar({
	dirty,
	saving,
	onSave,
	onDiscard,
	guard = true,
	showBar = true,
	saveLast = false,
}: {
	dirty: boolean
	saving: boolean
	onSave: () => void
	onDiscard: () => void
	/**
	 * Set `false` when the page already blocks navigation itself (for example
	 * with `useUnsavedChangesWarning`). The bar registers the one leave guard
	 * (React Router honors a single blocker) and stands down while any dirty
	 * source sets this to `false`.
	 */
	guard?: boolean
	/** `false` keeps the bar hidden but still guards leaving (new, unsaved records). */
	showBar?: boolean
	/**
	 * Save after every other dirty form finished saving, for a save that moves
	 * the page (an organization slug change redirects to the new URL).
	 */
	saveLast?: boolean
}) {
	const id = useId()
	// The bar calls the latest handlers without re-registering on every render.
	const handlers = useRef({ onSave, onDiscard })
	useEffect(() => {
		handlers.current = { onSave, onDiscard }
	})

	useEffect(() => {
		sources.set(id, {
			dirty,
			saving,
			guard,
			showBar,
			saveLast,
			save: () => handlers.current.onSave(),
			discard: () => handlers.current.onDiscard(),
		})
		publish()
	}, [id, dirty, saving, guard, showBar, saveLast])

	useEffect(
		() => () => {
			sources.delete(id)
			publish()
		},
		[id],
	)
}

/** Whether an action response reports a failed save (edits must be kept). */
function isFailedSave(data: unknown) {
	if (!data || typeof data !== 'object') return false
	const { result, error } = data as {
		result?: { status?: string }
		error?: unknown
	}
	return result?.status === 'error' || Boolean(error)
}

/** What the browser would submit right now, for "did anything change since". */
function snapshotForm(id: string) {
	const element = document.getElementById(id)
	if (!(element instanceof HTMLFormElement)) return null
	return JSON.stringify(
		Array.from(new FormData(element)).map(([key, value]) => [
			key,
			typeof value === 'string' ? value : value.name,
		]),
	)
}

/**
 * Registers a Conform form with the save bar: Save submits the form, Discard
 * resets it to its default values. Pass the fetcher that submits the form.
 */
export function useConformSaveBar(
	form: Pick<FormMetadata<any, any>, 'id' | 'dirty' | 'reset'>,
	fetcher: { state: string; data?: unknown },
	options: { saveLast?: boolean } = {},
) {
	const saving = fetcher.state !== 'idle'
	// Conform adopts new `defaultValue`s only on reset, so a saved form would
	// stay dirty after the loader returns the new values. A fetcher goes idle
	// only after the action and the revalidation landed. Reset then, but only
	// when this save got a fresh, error-free response and the fields still hold
	// what was submitted: failures and edits made mid-save are kept.
	const latest = useRef({ form, data: fetcher.data })
	const submitted = useRef<{ values: string | null; data: unknown } | null>(
		null,
	)
	const wasSaving = useRef(false)
	useEffect(() => {
		latest.current = { form, data: fetcher.data }
	})
	useEffect(() => {
		// Listen on the document so a form that mounts later or remounts under
		// the same id is still seen.
		const onSubmit = (event: Event) => {
			if (!(event.target instanceof HTMLFormElement)) return
			if (event.target.id !== form.id) return
			submitted.current = {
				values: snapshotForm(form.id),
				data: latest.current.data,
			}
		}
		document.addEventListener('submit', onSubmit, true)
		return () => document.removeEventListener('submit', onSubmit, true)
	}, [form.id])
	useEffect(() => {
		const finished = wasSaving.current && !saving
		wasSaving.current = saving
		if (!finished || !submitted.current) return
		const { values, data: dataAtSubmit } = submitted.current
		submitted.current = null
		const { form: current, data } = latest.current
		// A redirect leaves no data; otherwise a response must be new.
		const fresh = data === undefined || data !== dataAtSubmit
		if (!fresh || isFailedSave(data)) return
		if (snapshotForm(current.id) === values) current.reset()
	}, [saving])

	useSaveBar({
		dirty: form.dirty,
		saving,
		onSave: () => {
			const element = document.getElementById(form.id)
			if (element instanceof HTMLFormElement) element.requestSubmit()
		},
		onDiscard: () => {
			const element = document.getElementById(form.id)
			if (element instanceof HTMLFormElement) element.reset()
		},
		saveLast: options.saveLast,
	})
}

function runnable(source: SaveBarSource | undefined) {
	return Boolean(source && source.showBar && source.dirty && !source.saving)
}

function flushDeferredSaves() {
	const ids = deferredSaves
	clearDeferred()
	for (const id of ids) {
		const source = sources.get(id)
		if (source && runnable(source)) source.save()
	}
}

function run(action: 'save' | 'discard') {
	const ready = [...sources.entries()].filter(([, source]) => runnable(source))
	if (action === 'discard') {
		clearDeferred()
		for (const [, source] of ready) source.discard()
		return
	}
	const first = ready.filter(([, source]) => !source.saveLast)
	const last = ready.filter(([, source]) => source.saveLast)
	clearDeferred()
	deferredSaves = last.map(([id]) => id)
	awaitedSaves = first.map(([id]) => id)
	for (const [, source] of first) source.save()
	// Started saves are published by now; with none in flight, save the rest.
	if (deferredSaves.length > 0) {
		setTimeout(settleDeferred, 0)
	}
}

/**
 * The one leave guard for every registered form (React Router honors a single
 * blocker). Mounted once in root.tsx, inside the router.
 */
export function SaveBarGuard() {
	const { _ } = useLingui()
	const { guard } = useSaveBarSnapshot()
	useDirtyBeforeUnload(guard)
	// Only leaving the page loses edits: same-page posts and search or hash
	// changes are not blocked.
	const shouldBlock = useCallback<BlockerFunction>(
		({ currentLocation, nextLocation }) =>
			guard && currentLocation.pathname !== nextLocation.pathname,
		[guard],
	)
	useConfirmBlocker(
		shouldBlock,
		_(msg`You have unsaved changes. Leave this page and lose them?`),
	)
	return null
}

/** Global "Unsaved changes" bar (mounted once in root.tsx). */
export function SaveBar() {
	const { _ } = useLingui()
	const { visible, saving } = useSaveBarSnapshot()
	useEffect(() => {
		if (!visible) return
		// Ctrl/Cmd+S saves, like the browser's own habit for documents.
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key.toLowerCase() !== 's' || !(event.metaKey || event.ctrlKey))
				return
			// Leave the shortcut to an open dialog or an editor that handled it.
			if (event.defaultPrevented) return
			if (document.querySelector('[role="dialog"], [role="alertdialog"]'))
				return
			event.preventDefault()
			if (!snapshot.saving) run('save')
		}
		window.addEventListener('keydown', onKeyDown)
		return () => window.removeEventListener('keydown', onKeyDown)
	}, [visible])
	if (!visible) return null

	return (
		<SaveBarView
			aria-label={_(msg`Unsaved changes`)}
			savingLabel={_(msg`Saving…`)}
			message={<Trans>Unsaved changes</Trans>}
			discardLabel={<Trans>Discard</Trans>}
			saveLabel={<Trans>Save</Trans>}
			saving={saving}
			onDiscard={() => run('discard')}
			onSave={() => run('save')}
		/>
	)
}
