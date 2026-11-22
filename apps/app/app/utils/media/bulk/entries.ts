import { type PrecheckFlag } from './precheck.ts'

/** One file of the batch on the page (#316), before and while it uploads. */
export type BulkEntry = {
	key: string
	file: File
	name: string
	size: number
	/** `checking` until the header and content hash have been read. */
	check: 'checking' | 'done'
	hash: string | null
	flags: PrecheckFlag[]
	/** The upload queue's id once it was queued. */
	queueId: string | null
}

/** Not uploaded: not a photo, too large, or a copy of an earlier one. */
export function isSkippedEntry(entry: Pick<BulkEntry, 'flags'>) {
	return (
		entry.flags.includes('not_an_image') ||
		entry.flags.includes('too_large') ||
		entry.flags.includes('duplicate')
	)
}

export function uploadableEntries(entries: readonly BulkEntry[]) {
	return entries.filter(
		(entry) => entry.check === 'done' && !isSkippedEntry(entry),
	)
}

export function formatBytes(bytes: number) {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
