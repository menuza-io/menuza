import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { type AccountantExport, accountantExportSchema } from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import { triggerBlobDownload } from '#app/utils/inventory/file-base64.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import { inventoryErrorMessage } from '#app/utils/inventory/inventory-errors.ts'

function todayIso(): string {
	const now = new Date()
	const m = String(now.getMonth() + 1).padStart(2, '0')
	const d = String(now.getDate()).padStart(2, '0')
	return `${now.getFullYear()}-${m}-${d}`
}

function monthStartIso(): string {
	const now = new Date()
	const m = String(now.getMonth() + 1).padStart(2, '0')
	return `${now.getFullYear()}-${m}-01`
}

function toBlob(
	raw: unknown,
	format: 'csv' | 'pdf',
): { blob: Blob; filename: string | null } {
	if (
		raw &&
		typeof raw === 'object' &&
		'blob' in raw &&
		raw.blob instanceof Blob
	) {
		return {
			blob: raw.blob,
			filename:
				'filename' in raw && typeof raw.filename === 'string'
					? raw.filename
					: null,
		}
	}
	if (raw instanceof Blob) {
		return { blob: raw, filename: null }
	}
	const mime = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/pdf'
	if (raw instanceof Uint8Array) {
		return {
			blob: new Blob([new Uint8Array(raw)], { type: mime }),
			filename: null,
		}
	}
	if (typeof raw === 'string') {
		return { blob: new Blob([raw], { type: mime }), filename: null }
	}
	return {
		blob: new Blob([JSON.stringify(raw)], { type: mime }),
		filename: null,
	}
}

/**
 * Export deliveries, VAT, ZATCA references, credit notes and category totals
 * for the accountant (#507). Needs the cost grant.
 */
export function AccountantExportDialog({
	open,
	onOpenChange,
	locations,
	activeLocationId,
	currency,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	locations: ReadonlyArray<{ id: string; name: string }>
	activeLocationId: string
	currency: string
}) {
	const { t, i18n } = useLingui()
	const { request, requestBlob } = useInventoryClient()
	const [from, setFrom] = useState(monthStartIso)
	const [to, setTo] = useState(todayIso)
	const [locationId, setLocationId] = useState(
		locations.length > 1 ? 'all' : activeLocationId,
	)
	const [preview, setPreview] = useState<AccountantExport | null>(null)
	const [loadingPreview, setLoadingPreview] = useState(false)
	const [downloading, setDownloading] = useState<'csv' | 'pdf' | null>(null)
	const [error, setError] = useState<string | null>(null)

	const dateRangeInvalid = Boolean(from && to && from > to)

	useEffect(() => {
		if (!open || !from || !to) return
		if (dateRangeInvalid) {
			setPreview(null)
			setLoadingPreview(false)
			setError(t`Start date must be on or before end date.`)
			return
		}
		let live = true
		setLoadingPreview(true)
		setError(null)
		const params = new URLSearchParams({
			from,
			to,
			locationId,
			format: 'json',
		})
		request(`/purchasing/accountant-export?${params.toString()}`).then(
			(body) => {
				if (!live) return
				const parsed = accountantExportSchema.safeParse(body)
				if (parsed.success) {
					setPreview(parsed.data)
				} else {
					setPreview(null)
					setError(t`Could not load export summary.`)
				}
				setLoadingPreview(false)
			},
			(caught) => {
				if (!live) return
				setPreview(null)
				setError(i18n._(inventoryErrorMessage(caught)))
				setLoadingPreview(false)
			},
		)
		return () => {
			live = false
		}
	}, [open, from, to, dateRangeInvalid, locationId, request, i18n, t])

	async function download(format: 'csv' | 'pdf') {
		if (downloading || !from || !to || dateRangeInvalid) return
		setDownloading(format)
		setError(null)
		try {
			const params = new URLSearchParams({
				from,
				to,
				locationId,
				format,
			})
			const path = `/purchasing/accountant-export?${params.toString()}`
			const result = requestBlob
				? await requestBlob(path)
				: toBlob(await request(path), format)
			const fallbackName = `accountant-export-${from}-to-${to}.${format}`
			triggerBlobDownload(result.blob, result.filename ?? fallbackName)
			toast.success(t`Export downloaded.`)
		} catch (caught) {
			setError(i18n._(inventoryErrorMessage(caught)))
		} finally {
			setDownloading(null)
		}
	}

	const money = (minor: number) =>
		formatMoney(minor, preview?.currency ?? currency, i18n.locale)

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!downloading) onOpenChange(next)
			}}
		>
			<DialogContent
				className="sm:max-w-lg"
				data-testid="accountant-export-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						<Trans>Export for accountant</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Download deliveries, supplier VAT numbers, ZATCA references,
							credits and category totals as CSV or PDF.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				{error ? (
					<Alert variant="destructive" data-testid="accountant-export-error">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}

				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<TextField
						label={<Trans>From</Trans>}
						type="date"
						value={from}
						onChange={(event) => setFrom(event.target.value)}
						dir="ltr"
						data-testid="accountant-export-from"
					/>
					<TextField
						label={<Trans>To</Trans>}
						type="date"
						value={to}
						onChange={(event) => setTo(event.target.value)}
						dir="ltr"
						data-testid="accountant-export-to"
					/>
				</div>

				{locations.length > 1 ? (
					<SelectField
						label={<Trans>Location</Trans>}
						testId="accountant-export-location"
						options={[
							{ value: 'all', label: t`All locations` },
							...locations.map((loc) => ({ value: loc.id, label: loc.name })),
						]}
						value={locationId}
						onValueChange={setLocationId}
					/>
				) : null}

				<div role="status" aria-live="polite">
					{loadingPreview ? (
						<div className="flex flex-col gap-2">
							<Skeleton className="h-16 w-full rounded-xl" />
						</div>
					) : preview ? (
						<dl
							className="grid grid-cols-2 gap-3 rounded-xl border p-3 text-sm"
							data-testid="accountant-export-summary"
						>
							<div className="flex flex-col">
								<dt className="text-muted-foreground text-xs">
									<Trans>Deliveries</Trans>
								</dt>
								<dd className="font-medium tabular-nums">
									<bdi dir="ltr">
										<Plural
											value={preview.totals.count}
											one="# delivery"
											other="# deliveries"
										/>
									</bdi>
								</dd>
							</div>
							<div className="flex flex-col">
								<dt className="text-muted-foreground text-xs">
									<Trans>Net</Trans>
								</dt>
								<dd className="font-medium tabular-nums">
									<bdi dir="ltr">{money(preview.totals.netMinor)}</bdi>
								</dd>
							</div>
							<div className="flex flex-col">
								<dt className="text-muted-foreground text-xs">
									<Trans>VAT</Trans>
								</dt>
								<dd className="font-medium tabular-nums">
									<bdi dir="ltr">{money(preview.totals.vatMinor)}</bdi>
								</dd>
							</div>
							<div className="flex flex-col">
								<dt className="text-muted-foreground text-xs">
									<Trans>Total</Trans>
								</dt>
								<dd className="font-semibold tabular-nums">
									<bdi dir="ltr">{money(preview.totals.totalMinor)}</bdi>
								</dd>
							</div>
						</dl>
					) : null}
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						disabled={downloading !== null}
						onClick={() => onOpenChange(false)}
					>
						<Trans>Close</Trans>
					</Button>
					<Button
						type="button"
						variant="outline"
						disabled={downloading !== null || !from || !to || dateRangeInvalid}
						onClick={() => void download('csv')}
						data-testid="accountant-export-csv"
					>
						<Icon name={downloading === 'csv' ? 'loader' : 'download'} />
						<Trans>Download CSV</Trans>
					</Button>
					<Button
						type="button"
						disabled={downloading !== null || !from || !to || dateRangeInvalid}
						onClick={() => void download('pdf')}
						data-testid="accountant-export-pdf"
					>
						<Icon name={downloading === 'pdf' ? 'loader' : 'file-text'} />
						<Trans>Download PDF</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
