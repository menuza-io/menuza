import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { useRef, useState } from 'react'
import { StockApiError } from './api.ts'
import { prepareInvoicePhoto, PhotoError } from './photo.ts'
import { newClientId } from './queue.ts'
import { type StockState } from './useStock.ts'
import { Button } from '~/ui/primitives.tsx'

/** A Blob as base64 (the region takes the photo in the request, not through storage). */
async function toBase64(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer())
	let binary = ''
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
	}
	return btoa(binary)
}

/**
 * "Photograph an invoice" (#503): a photo with no delivery goes to the
 * location's "Invoices to match" inbox, in this region's storage, for the
 * office to read and match. Online only; one id per photo, so a retry after a
 * lost answer never adds a second row.
 */
export function InvoicePhotoButton({
	stock,
	onToast,
}: {
	stock: StockState
	onToast: (text: string) => void
}) {
	const { _ } = useLingui()
	const input = useRef<HTMLInputElement>(null)
	const [busy, setBusy] = useState(false)
	const [problem, setProblem] = useState<string | null>(null)
	const clientId = useRef(newClientId())
	const { catalog, ctx } = stock
	if (!catalog?.settings.invoiceInboxEnabled || !ctx) return null
	const pick = async (file: File | undefined) => {
		if (!file) return
		setBusy(true)
		setProblem(null)
		try {
			const prepared = await prepareInvoicePhoto(
				file,
				catalog.settings.photoMaxBytes,
			)
			await stock.api.invoicePhoto({
				clientId: clientId.current,
				locationId: ctx.locationId,
				...(file.name ? { fileName: file.name.slice(0, 120) } : {}),
				contentType: prepared.contentType,
				contentBase64: await toBase64(prepared.blob),
			})
			clientId.current = newClientId()
			onToast(_(t`Invoice photo sent to the office.`))
		} catch (caught) {
			setProblem(
				caught instanceof PhotoError && caught.reason === 'too_large'
					? _(
							t`That photo is too large. Take it again from a little further away.`,
						)
					: caught instanceof StockApiError && caught.code === 'connection_lost'
						? _(t`You are offline. Photos of invoices need the connection.`)
						: _(t`That photo could not be sent. Try again.`),
			)
		} finally {
			setBusy(false)
			if (input.current) input.current.value = ''
		}
	}
	return (
		<div className="flex flex-col gap-2">
			<input
				ref={input}
				type="file"
				accept="image/*"
				capture="environment"
				className="sr-only"
				tabIndex={-1}
				aria-hidden
				onChange={(event) => void pick(event.target.files?.[0])}
				data-testid="invoice-photo-input"
			/>
			<Button
				variant="outline"
				size="lg"
				disabled={busy || !stock.reachable}
				onClick={() => input.current?.click()}
			>
				<Icon name="camera" className="size-5" aria-hidden />
				<Trans>Photograph an invoice</Trans>
			</Button>
			{problem ? (
				<p role="alert" className="notice-danger px-4 py-2 text-sm">
					{problem}
				</p>
			) : null}
		</div>
	)
}
