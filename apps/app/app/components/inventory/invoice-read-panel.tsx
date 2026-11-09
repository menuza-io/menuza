import { Trans, useLingui } from '@lingui/react/macro'
import { type InvoiceRead, invoiceReadSchema } from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { useState } from 'react'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import {
	invoiceReadErrorMessage,
	isInvoiceReaderMissing,
} from '#app/utils/inventory/inventory-errors.ts'

/**
 * "Read the invoice": a computer reads the stored photo into lines to check.
 * It is a help, never a record: nothing is saved or priced from it, and the
 * person compares each line with the paper invoice. The photo is read in the
 * business's own data region. The button goes away if the region has no reader.
 */
export function InvoiceReadPanel({
	deliveryId,
	currency,
	canSeeCost,
}: {
	deliveryId: string
	currency: string
	canSeeCost: boolean
}) {
	const { i18n } = useLingui()
	const { request } = useInventoryClient()
	const [state, setState] = useState<
		| { kind: 'idle' }
		| { kind: 'reading' }
		| { kind: 'done'; read: InvoiceRead }
		| { kind: 'error'; message: string }
		| { kind: 'missing' }
	>({ kind: 'idle' })

	async function read() {
		setState({ kind: 'reading' })
		try {
			const read = invoiceReadSchema.parse(
				await request(
					`/deliveries/${encodeURIComponent(deliveryId)}/invoice-photo/read`,
					{ method: 'POST', body: JSON.stringify({}) },
				),
			)
			setState({ kind: 'done', read })
		} catch (caught) {
			setState(
				isInvoiceReaderMissing(caught)
					? { kind: 'missing' }
					: {
							kind: 'error',
							message: i18n._(invoiceReadErrorMessage(caught)),
						},
			)
		}
	}

	if (state.kind === 'missing') return null
	const money = (minor: number) => formatMoney(minor, currency, i18n.locale)
	return (
		<div className="flex flex-col gap-3" data-testid="invoice-read">
			<Button
				type="button"
				variant="outline"
				size="sm"
				className="self-start"
				disabled={state.kind === 'reading'}
				onClick={() => void read()}
				data-testid="invoice-read-button"
			>
				<Icon name={state.kind === 'reading' ? 'loader' : 'refresh-cw'} />
				{state.kind === 'done' ? (
					<Trans>Read again</Trans>
				) : (
					<Trans>Read the invoice</Trans>
				)}
			</Button>
			{state.kind === 'error' ? (
				<Alert variant="destructive" data-testid="invoice-read-error">
					<AlertDescription>{state.message}</AlertDescription>
				</Alert>
			) : null}
			{state.kind === 'done' ? (
				<div className="flex flex-col gap-2" data-testid="invoice-read-result">
					<Alert>
						<AlertDescription>
							<Trans>
								Read from the photo by a computer, so it can be wrong. Check
								each line against the invoice. Nothing was saved.
							</Trans>
						</AlertDescription>
					</Alert>
					{state.read.supplierName || state.read.invoiceNumber ? (
						<p className="text-sm">
							{state.read.supplierName ? (
								<span className="font-medium wrap-anywhere">
									{state.read.supplierName}
								</span>
							) : null}
							{state.read.invoiceNumber ? (
								<span className="text-muted-foreground">
									{' · '}
									<bdi dir="ltr">{state.read.invoiceNumber}</bdi>
								</span>
							) : null}
							{canSeeCost && state.read.totalMinor !== undefined ? (
								<span className="text-muted-foreground">
									{' · '}
									<bdi dir="ltr">{money(state.read.totalMinor)}</bdi>
								</span>
							) : null}
						</p>
					) : null}
					{state.read.lines.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>No lines could be read from this photo.</Trans>
						</p>
					) : (
						<ul className="flex flex-col divide-y rounded-xl border">
							{state.read.lines.map((line, index) => (
								<li
									key={`${index}-${line.text}`}
									className="flex flex-wrap items-center justify-between gap-2 p-3"
									data-testid={`invoice-read-line-${index}`}
								>
									<div className="flex min-w-0 flex-col">
										<span className="text-sm wrap-anywhere">{line.text}</span>
										<span className="text-muted-foreground text-xs tabular-nums">
											{line.quantity !== null ? (
												<bdi dir="ltr">
													{line.quantity}
													{line.unit ? ` ${line.unit}` : ''}
												</bdi>
											) : (
												<Trans>No amount</Trans>
											)}
											{canSeeCost && line.lineTotalMinor !== undefined ? (
												<>
													{' · '}
													<bdi dir="ltr">{money(line.lineTotalMinor)}</bdi>
												</>
											) : null}
										</span>
									</div>
									{line.itemName ? (
										<Badge variant="outline" className="wrap-anywhere">
											{line.itemName}
										</Badge>
									) : (
										<Badge variant="warning">
											<Trans>Not in your stock</Trans>
										</Badge>
									)}
								</li>
							))}
						</ul>
					)}
				</div>
			) : null}
		</div>
	)
}
