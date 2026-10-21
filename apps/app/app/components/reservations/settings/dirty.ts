import { useEffect, useState } from 'react'

/**
 * Pure: whether an edit sheet has unsaved changes. Both sides are compared as
 * JSON so form drafts (strings, numbers, arrays) can be passed as they are.
 */
export function isDraftDirty(baseline: unknown, current: unknown): boolean {
	if (baseline === null || baseline === undefined) return false
	return JSON.stringify(baseline) !== JSON.stringify(current)
}

/**
 * Tracks whether the open sheet has been edited. `sheetId` is `null` while the
 * sheet is closed and changes whenever a different record opens; the draft
 * present on the first render after that is the baseline.
 */
export function useSheetDirty(sheetId: string | null, draft: unknown): boolean {
	const [baseline, setBaseline] = useState<{
		id: string
		value: unknown
	} | null>(null)
	useEffect(() => {
		setBaseline(sheetId === null ? null : { id: sheetId, value: draft })
		// The baseline is the draft at open time only.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sheetId])
	if (sheetId === null || baseline?.id !== sheetId) return false
	return isDraftDirty(baseline.value, draft)
}
