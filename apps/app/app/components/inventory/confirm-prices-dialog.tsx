import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import {
	type DeliveryDetail,
	recordDeliveryResultSchema,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Label } from '@repo/ui/label'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { TextField } from '#app/components/staff/controls.tsx'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import {
	buildConfirmPrices,
	type ConfirmHeaderDraft,
	type ConfirmLineDraft,
	type ConfirmLineProblem,
	confirmLineDrafts,
	confirmLineHint,
} from '#app/utils/inventory/confirm-prices.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import { packsText } from '#app/utils/inventory/order-view.ts'

/**
 * "Confirm prices": a delivery was recorded as quantities only. Read the
 * invoice and type what each line cost; saving posts the prices, updates the
 * item costs and the supplier's pack prices, and clears "prices to confirm".
 * Needs the purchasing role.
 */
export function ConfirmPricesDialog({
	open,
	onOpenChange,
	delivery,
	currency,
	onConfirmed,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	delivery: DeliveryDetail
	currency: string
	onConfirmed: () => void
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const idPrefix = useId()
	const [lines, setLines] = useState<ConfirmLineDraft[]>(() =>
		confirmLineDrafts(delivery),
	)
	const [header, setHeader] = useState<ConfirmHeaderDraft>({
		invoiceNumber: delivery.invoiceNumber ?? '',
		invoiceDate: delivery.invoiceDate ?? '',
		vatText: '',
		totalText: '',
		paid: false,
	})
	const [problems, setProblems] = useState<{
		lines: Record<string, ConfirmLineProblem[]>
		header: string[]
	} | null>(null)
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)

	function patchLine(lineId: string, update: Partial<ConfirmLineDraft>) {
		setLines((current) =>
			current.map((line) =>
				line.lineId === lineId ? { ...line, ...update } : line,
			),
		)
	}

	async function submit() {
		if (pending) return
		setError(null)
		const built = buildConfirmPrices(lines, header, {
			expectedVersion: delivery.version,
			currency,
		})
		if (!built.ok) {
			setProblems({ lines: built.lines, header: built.header })
			return
		}
		setProblems(null)
		setPending(true)
		try {
			const result = recordDeliveryResultSchema.parse(
				await request(
					`/deliveries/${encodeURIComponent(delivery.id)}/confirm-prices`,
					{ method: 'POST', body: JSON.stringify(built.payload) },
				),
			)
			const moved = result.priceChanges?.length ?? 0
			toast.success(t`Prices confirmed.`, {
				description:
					moved > 0
						? plural(moved, {
								one: 'Prices updated for # item',
								other: 'Prices updated for # items',
							})
						: undefined,
			})
			onConfirmed()
			onOpenChange(false)
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setPending(false)
		}
	}

	return (
		<Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
			<DialogContent
				className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
				data-testid="confirm-prices-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						<Trans>Confirm prices</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Type what each line cost on the invoice, before VAT. Item costs
							and supplier prices update when you save.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				{error ? (
					<Alert variant="destructive" data-testid="confirm-prices-error">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}
				<ul className="flex flex-col gap-3" data-testid="confirm-prices-lines">
					{lines.map((line) => {
						const found = problems?.lines[line.lineId] ?? []
						const name = line.itemName
						const packName = line.packName
						const received =
							line.packs !== null && line.packName
								? `${packsText(line.packs, i18n.locale)} × ${line.packName}`
								: null
						return (
							<li
								key={line.lineId}
								className="bg-card flex flex-col gap-2 rounded-xl border p-3"
								data-testid={`confirm-line-${line.lineId}`}
							>
								<div className="flex flex-col">
									<span className="font-medium wrap-anywhere">{name}</span>
									{received ? (
										<span className="text-muted-foreground text-xs">
											<bdi dir="ltr">{received}</bdi>
										</span>
									) : null}
								</div>
								<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
									{line.packs !== null && !line.weighed ? (
										<TextField
											label={
												<Trans>
													Price of one {packName} ({currency})
												</Trans>
											}
											optional
											value={line.priceText}
											onChange={(event) =>
												patchLine(line.lineId, {
													priceText: event.target.value,
												})
											}
											error={
												found.includes('price')
													? t`Enter the price on the invoice, for example 28.50.`
													: null
											}
											inputMode="decimal"
											dir="ltr"
											data-testid={`confirm-price-${line.lineId}`}
										/>
									) : null}
									<TextField
										label={<Trans>Line total ({currency})</Trans>}
										value={line.totalText}
										placeholder={confirmLineHint(line, currency)}
										onChange={(event) =>
											patchLine(line.lineId, { totalText: event.target.value })
										}
										error={
											found.includes('total')
												? t`Enter the line total on the invoice.`
												: null
										}
										inputMode="decimal"
										dir="ltr"
										data-testid={`confirm-total-${line.lineId}`}
									/>
								</div>
							</li>
						)
					})}
				</ul>
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<TextField
						label={<Trans>Invoice number</Trans>}
						optional
						value={header.invoiceNumber}
						onChange={(event) =>
							setHeader({ ...header, invoiceNumber: event.target.value })
						}
						maxLength={60}
						dir="ltr"
						data-testid="confirm-invoice-number"
					/>
					<TextField
						label={<Trans>VAT ({currency})</Trans>}
						optional
						value={header.vatText}
						onChange={(event) =>
							setHeader({ ...header, vatText: event.target.value })
						}
						error={
							problems?.header.includes('vat')
								? t`Enter the VAT amount, for example 106.80.`
								: null
						}
						inputMode="decimal"
						dir="ltr"
						data-testid="confirm-vat"
					/>
					<TextField
						label={<Trans>Invoice total ({currency})</Trans>}
						optional
						value={header.totalText}
						onChange={(event) =>
							setHeader({ ...header, totalText: event.target.value })
						}
						error={
							problems?.header.includes('total')
								? t`Enter the total on the invoice, for example 818.80.`
								: null
						}
						inputMode="decimal"
						dir="ltr"
						data-testid="confirm-invoice-total"
					/>
				</div>
				<div className="flex items-center gap-2">
					<Checkbox
						id={`${idPrefix}-paid`}
						checked={header.paid}
						onCheckedChange={(next) => setHeader({ ...header, paid: next })}
						data-testid="confirm-paid"
					/>
					<Label
						htmlFor={`${idPrefix}-paid`}
						className="cursor-pointer font-normal"
					>
						<Trans>Already paid</Trans>
					</Label>
				</div>
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={pending}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						onClick={() => void submit()}
						disabled={pending}
						data-testid="confirm-prices-submit"
					>
						<Trans>Confirm prices</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
