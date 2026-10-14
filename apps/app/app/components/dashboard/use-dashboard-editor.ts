import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useFetcher, useFormAction } from 'react-router'
import { toast } from 'sonner'
import {
	type DashboardActionError,
	type DashboardActionErrorCode,
} from '#app/utils/dashboards/actions.server.ts'
import {
	canAddBlockType,
	MAX_DASHBOARD_BLOCKS,
	serializeDashboardConfig,
	type DashboardBlock,
	type DashboardConfig,
	type GridItem,
	type NewDashboardBlock,
	type PersistedBreakpoint,
} from '#app/utils/dashboards/config.ts'
import {
	appendBlock,
	applyGridLayout,
	createBlockId,
	removeBlock as removeBlockFromConfig,
} from '#app/utils/dashboards/layout.ts'

/** Changes are saved once the dashboard has stayed unchanged this long. */
export const SAVE_DELAY_MS = 500

type SaveResult = { ok: true } | { ok: false; error: DashboardActionError }

function saveErrorMessage(code: DashboardActionErrorCode): MessageDescriptor {
	switch (code) {
		case 'too-many-blocks':
			return msg`A dashboard can have at most ${MAX_DASHBOARD_BLOCKS} blocks.`
		case 'duplicate-built-in':
			return msg`That block is already on the dashboard.`
		case 'unknown-template':
		case 'unknown-report':
			return msg`That report is not available in this organization.`
		default:
			return msg`Your dashboard changes could not be saved.`
	}
}

function saveFormData(config: DashboardConfig) {
	const formData = new FormData()
	formData.set('intent', 'save-config')
	formData.set('config', serializeDashboardConfig(config))
	return formData
}

/**
 * Edit state for a dashboard. Changes show at once and are saved with
 * `intent=save-config` once they have settled, and only after the user moved,
 * resized, added or removed a block. Merely loading the page never saves.
 */
export function useDashboardEditor({
	config,
	resetConfig,
}: {
	/** The saved config from the loader. */
	config: DashboardConfig
	/** What "Reset to default" restores; without it there is no reset. */
	resetConfig?: () => DashboardConfig
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<SaveResult>()
	const { submit } = fetcher
	// '.' leaves out the query string, so a change of it in place, such as
	// Home dropping ?celebrate=true, is not mistaken for leaving the page and
	// waiting saves still go through the fetcher.
	const actionUrl = useFormAction('.')
	const [draft, setDraft] = useState<DashboardConfig | null>(null)
	const [editing, setEditing] = useState(false)
	const [hasPendingSave, setHasPendingSave] = useState(false)
	const [saved, setSaved] = useState(false)
	const current = draft ?? config

	const pendingRef = useRef<DashboardConfig | null>(null)
	const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	// What the server holds once the request in flight succeeds, and what it
	// is known to hold, to roll back to when a save is rejected.
	const submittedRef = useRef<DashboardConfig | null>(null)
	const confirmedRef = useRef<DashboardConfig | null>(null)
	const handledResultRef = useRef(fetcher.data)

	const cancelPendingSave = useCallback(() => {
		clearTimeout(timerRef.current)
		pendingRef.current = null
		setHasPendingSave(false)
	}, [])

	const savePending = useCallback(() => {
		const pending = pendingRef.current
		cancelPendingSave()
		if (!pending) return
		submittedRef.current = pending
		void submit(saveFormData(pending), { method: 'POST', action: actionUrl })
	}, [actionUrl, cancelPendingSave, submit])

	const change = useCallback(
		(next: DashboardConfig) => {
			setDraft(next)
			setSaved(false)
			pendingRef.current = next
			setHasPendingSave(true)
			clearTimeout(timerRef.current)
			timerRef.current = setTimeout(savePending, SAVE_DELAY_MS)
		},
		[savePending],
	)

	useEffect(() => {
		const result = fetcher.data
		if (!result || result === handledResultRef.current) return
		handledResultRef.current = result
		const submitted = submittedRef.current
		submittedRef.current = null
		if (result.ok) {
			confirmedRef.current = submitted
			setSaved(true)
			return
		}
		// Later changes build on the rejected one, so they are dropped as well.
		cancelPendingSave()
		setDraft(confirmedRef.current)
		toast.error(_(saveErrorMessage(result.error.code)))
	}, [_, cancelPendingSave, fetcher.data])

	// A change still waiting for its save is sent when the page goes away or
	// the dashboard is left for another route; keepalive lets the request
	// finish while the page unloads.
	useEffect(() => {
		const sendBeforeLeaving = () => {
			const pending = pendingRef.current
			if (!pending) return
			cancelPendingSave()
			void fetch(actionUrl, {
				method: 'POST',
				body: saveFormData(pending),
				keepalive: true,
			}).catch(() => {})
		}
		window.addEventListener('pagehide', sendBeforeLeaving)
		return () => {
			window.removeEventListener('pagehide', sendBeforeLeaving)
			sendBeforeLeaving()
		}
	}, [actionUrl, cancelPendingSave])

	const startEditing = useCallback(() => setEditing(true), [])
	const stopEditing = useCallback(() => {
		setEditing(false)
		setSaved(false)
		savePending()
	}, [savePending])

	const commitLayout = useCallback(
		(
			breakpoint: PersistedBreakpoint,
			layout: readonly GridItem[],
			hiddenBlockIds: readonly string[],
		) => {
			change(applyGridLayout(current, breakpoint, layout, hiddenBlockIds))
		},
		[change, current],
	)

	const addBlock = useCallback(
		(block: NewDashboardBlock) => {
			if (!canAddBlockType(current.blocks, block.type)) return
			const id = createBlockId(
				block.type,
				current.blocks.map((item) => item.id),
			)
			const added: DashboardBlock =
				block.type === 'report'
					? { id, type: 'report', config: block.config }
					: { id, type: block.type }
			change(appendBlock(current, added))
		},
		[change, current],
	)

	const removeBlock = useCallback(
		(blockId: string) => change(removeBlockFromConfig(current, blockId)),
		[change, current],
	)

	const reset = useCallback(() => {
		if (!resetConfig) return
		cancelPendingSave()
		const next = resetConfig()
		setDraft(next)
		setSaved(false)
		submittedRef.current = next
		void submit({ intent: 'reset' }, { method: 'POST', action: actionUrl })
	}, [actionUrl, cancelPendingSave, resetConfig, submit])

	return {
		config: current,
		editing,
		/** A change is waiting to be saved or its save is in flight. */
		saving: hasPendingSave || fetcher.state !== 'idle',
		/** The last change of this edit session was saved. */
		saved,
		atBlockLimit: current.blocks.length >= MAX_DASHBOARD_BLOCKS,
		startEditing,
		stopEditing,
		commitLayout,
		addBlock,
		removeBlock,
		reset: resetConfig ? reset : undefined,
	}
}
