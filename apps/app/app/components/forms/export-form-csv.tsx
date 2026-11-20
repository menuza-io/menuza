import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/popover'
import { useState } from 'react'
import { useMailboxFetch } from '#app/hooks/use-mailbox.ts'

/** Saves text the browser holds as a file. */
export function saveCsv(csv: Blob, filename: string) {
	const url = URL.createObjectURL(csv)
	const link = document.createElement('a')
	link.href = url
	link.download = filename
	document.body.appendChild(link)
	link.click()
	link.remove()
	setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * Export CSV for one form's responses (#142). The file is fetched from the
 * regional tenant-api by the browser and saved; the App server never sees it.
 * The range is optional; a range with more than 10,000 responses is refused by
 * the region with a message to choose a smaller one.
 */
export function ExportFormCsv({
	orgSlug,
	formId,
	formName,
	disabled,
}: {
	orgSlug: string
	formId: string
	formName: string
	disabled?: boolean
}) {
	const { _ } = useLingui()
	const mailboxFetch = useMailboxFetch(orgSlug)
	const [from, setFrom] = useState('')
	const [to, setTo] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function download() {
		setBusy(true)
		setError(null)
		try {
			const params = new URLSearchParams()
			if (from) params.set('from', from)
			if (to) params.set('to', to)
			const response = await mailboxFetch(
				`/forms/${encodeURIComponent(formId)}/export?${params}`,
			)
			if (!response.ok) {
				const payload = (await response.json().catch(() => null)) as {
					error?: string
					message?: string
				} | null
				setError(
					payload?.error === 'export_too_large' && payload.message
						? payload.message
						: payload?.error === 'restricted_form'
							? _(msg`You do not have access to this form's responses.`)
							: _(msg`Unable to export. Try again.`),
				)
				return
			}
			saveCsv(
				await response.blob(),
				`${formName.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 40) || 'form'}-responses.csv`,
			)
		} catch {
			setError(_(msg`Unable to export. Try again.`))
		} finally {
			setBusy(false)
		}
	}

	return (
		<Popover>
			<PopoverTrigger
				render={
					<Button variant="outline" size="sm" disabled={disabled}>
						<Icon name="download" className="size-4" />
						<Trans>Export CSV</Trans>
					</Button>
				}
			/>
			<PopoverContent align="end" className="w-72 space-y-3">
				<p className="text-muted-foreground text-xs">
					<Trans>
						Choose a date range, or leave it empty for every response. The file
						comes straight from your region.
					</Trans>
				</p>
				<div className="grid grid-cols-2 gap-2">
					<div className="space-y-1">
						<Label htmlFor={`export-from-${formId}`}>
							<Trans>From</Trans>
						</Label>
						<Input
							id={`export-from-${formId}`}
							type="date"
							value={from}
							max={to || undefined}
							onChange={(event) => setFrom(event.target.value)}
						/>
					</div>
					<div className="space-y-1">
						<Label htmlFor={`export-to-${formId}`}>
							<Trans>To</Trans>
						</Label>
						<Input
							id={`export-to-${formId}`}
							type="date"
							value={to}
							min={from || undefined}
							onChange={(event) => setTo(event.target.value)}
						/>
					</div>
				</div>
				{error ? (
					<p role="alert" className="text-destructive text-xs">
						{error}
					</p>
				) : null}
				<Button
					size="sm"
					className="w-full"
					onClick={() => void download()}
					disabled={busy}
				>
					{busy ? <Trans>Preparing…</Trans> : <Trans>Download CSV</Trans>}
				</Button>
			</PopoverContent>
		</Popover>
	)
}
