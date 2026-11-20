import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { useState } from 'react'
import { saveCsv } from '#app/components/forms/export-form-csv.tsx'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'

/**
 * Export CSV of applicants for the posting chosen in the Job filter, or for
 * every posting (#142). The file is fetched from the regional tenant-api with
 * the hiring token the page already holds; the App server never sees it.
 * Needs the hiring read grant (the page itself does). Audited by the region.
 */
export function ExportApplicantsCsv({
	client,
	postingId,
	disabled,
}: {
	client: StaffClient
	/** `all` exports every posting. */
	postingId: string
	disabled?: boolean
}) {
	const { _ } = useLingui()
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function download() {
		setBusy(true)
		setError(null)
		try {
			const { jwt, tenantApiUrl } = await client.credentials()
			const query =
				postingId === 'all' ? '' : `?postingId=${encodeURIComponent(postingId)}`
			const response = await fetch(
				`${tenantApiUrl}/operator/hiring/applications.csv${query}`,
				{
					headers: { Authorization: `Bearer ${jwt}`, Accept: 'text/csv' },
					cache: 'no-store',
				},
			)
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as {
					error?: string
					message?: string
				} | null
				setError(
					body?.error === 'export_too_large' && body.message
						? body.message
						: _(t`Unable to export. Try again.`),
				)
				return
			}
			saveCsv(await response.blob(), 'applicants.csv')
		} catch {
			setError(_(t`Unable to export. Try again.`))
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="flex flex-col items-end gap-1">
			<Button
				variant="outline"
				size="sm"
				onClick={() => void download()}
				disabled={disabled || busy}
			>
				<Icon name="download" className="size-4" />
				{postingId === 'all' ? (
					<Trans>Export CSV (all jobs)</Trans>
				) : (
					<Trans>Export CSV (this job)</Trans>
				)}
			</Button>
			{error ? (
				<p role="alert" className="text-destructive text-xs">
					{error}
				</p>
			) : null}
		</div>
	)
}
