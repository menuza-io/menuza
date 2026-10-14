import { staffExportFileSchema } from '@repo/staffing'
import { type StaffClient } from './staff-client.ts'

/**
 * Browser-side backup of the regional staff data, offered before a region
 * switch wipes it. The file comes from the region that holds the data straight
 * to the admin's browser (a staff-scope token, then `GET /operator/staff/export`
 * on the regional node) and is saved locally; it never touches the US servers.
 */

/** `staff-backup-<slug>-<YYYY-MM-DD>.json`, with anything odd in the slug removed. */
export function staffBackupFilename(slug: string, now: Date): string {
	const safeSlug = slug
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, '-')
		.slice(0, 60)
	return `staff-backup-${safeSlug || 'organization'}-${now.toISOString().slice(0, 10)}.json`
}

/** Fetches the export and returns it as pretty JSON text. */
export async function fetchStaffBackup(
	client: Pick<StaffClient, 'request'>,
): Promise<string> {
	const body = await client.request('/export')
	const parsed = staffExportFileSchema.safeParse(body)
	if (!parsed.success) throw new Error('malformed_export')
	return JSON.stringify(body, null, 2)
}

/** Saves text as a local file through a temporary object URL. */
export function saveTextFile(
	filename: string,
	text: string,
	mime = 'application/json',
	doc: Document = document,
): void {
	const blob = new Blob([text], { type: mime })
	const url = URL.createObjectURL(blob)
	try {
		const link = doc.createElement('a')
		link.href = url
		link.download = filename
		link.rel = 'noopener'
		doc.body.appendChild(link)
		link.click()
		link.remove()
	} finally {
		URL.revokeObjectURL(url)
	}
}
