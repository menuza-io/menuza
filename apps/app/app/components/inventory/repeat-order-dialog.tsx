import { Trans, useLingui } from '@lingui/react/macro'
import {
	type OrderDetail,
	type RepeatOrderCadenceWeeks,
	type RepeatOrderMode,
	repeatOrderSummarySchema,
	type Supplier,
} from '@repo/inventory'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { weekdayName } from '#app/components/inventory/supplier-form.tsx'
import { TextField } from '#app/components/staff/controls.tsx'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'

const CADENCES: readonly RepeatOrderCadenceWeeks[] = [1, 2, 4]
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const

export type RepeatOrderDialogProps = {
	order: Pick<OrderDetail, 'id' | 'locationId' | 'supplierId'> & {
		lines: ReadonlyArray<{
			itemId: string
			supplierProductId: string | null
			packs: number
		}>
	}
	supplier: Pick<Supplier, 'id' | 'name' | 'deliveryDays'> | null
	open: boolean
	onOpenChange: (open: boolean) => void
	onCreated?: () => void
}

export function RepeatOrderDialog({
	order,
	supplier,
	open,
	onOpenChange,
	onCreated,
}: RepeatOrderDialogProps) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const [cadenceWeeks, setCadenceWeeks] = useState<RepeatOrderCadenceWeeks>(1)
	const [weekdays, setWeekdays] = useState<number[]>(() =>
		supplier?.deliveryDays.length
			? [...supplier.deliveryDays]
			: [new Date().getDay()],
	)
	const [mode, setMode] = useState<RepeatOrderMode>('fixed_lines')
	const [note, setNote] = useState('')
	const [submitting, setSubmitting] = useState(false)

	useEffect(() => {
		if (!open) return
		setCadenceWeeks(1)
		setWeekdays(
			supplier?.deliveryDays.length
				? [...supplier.deliveryDays]
				: [new Date().getDay()],
		)
		setMode('fixed_lines')
		setNote('')
	}, [open, supplier])

	function toggleWeekday(day: number) {
		setWeekdays((prev) =>
			prev.includes(day)
				? prev.filter((d) => d !== day)
				: [...prev, day].sort((a, b) => a - b),
		)
	}

	async function handleSubmit(event: React.FormEvent) {
		event.preventDefault()
		if (weekdays.length === 0 || submitting) return
		setSubmitting(true)
		try {
			const clientId =
				typeof crypto !== 'undefined' && 'randomUUID' in crypto
					? `repeat-${crypto.randomUUID()}`
					: `repeat-${Date.now().toString(36)}`
			repeatOrderSummarySchema.parse(
				await request('/repeat-orders', {
					method: 'POST',
					body: JSON.stringify({
						clientId,
						locationId: order.locationId,
						supplierId: order.supplierId,
						sourceOrderId: order.id,
						cadenceWeeks,
						weekdays,
						mode,
						lines:
							mode === 'fixed_lines'
								? order.lines.map((line) => ({
										itemId: line.itemId,
										supplierProductId: line.supplierProductId,
										packs: line.packs,
									}))
								: undefined,
						note: note.trim() ? note.trim() : null,
					}),
				}),
			)
			toast.success(t`Repeat order schedule created.`)
			onCreated?.()
			onOpenChange(false)
		} catch (caught) {
			toast.error(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent data-testid="repeat-order-dialog">
				<DialogHeader>
					<DialogTitle>
						<Trans>Repeat this order</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Draft orders automatically before the supplier cut-off. Drafts are
							never sent without your review.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={handleSubmit} className="flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<span className="text-sm font-medium">
							<Trans>Frequency</Trans>
						</span>
						<div className="flex flex-wrap gap-2">
							{CADENCES.map((weeks) => (
								<Button
									key={weeks}
									type="button"
									size="sm"
									variant={cadenceWeeks === weeks ? 'default' : 'outline'}
									onClick={() => setCadenceWeeks(weeks)}
									data-testid={`repeat-cadence-${weeks}`}
								>
									{weeks === 1 ? (
										<Trans>Weekly</Trans>
									) : weeks === 2 ? (
										<Trans>Every 2 weeks</Trans>
									) : (
										<Trans>Every 4 weeks</Trans>
									)}
								</Button>
							))}
						</div>
					</div>

					<div className="flex flex-col gap-1.5">
						<span className="text-sm font-medium">
							<Trans>Delivery days</Trans>
						</span>
						<div className="flex flex-wrap gap-1.5">
							{WEEKDAYS.map((day) => (
								<Button
									key={day}
									type="button"
									size="sm"
									variant={weekdays.includes(day) ? 'default' : 'outline'}
									onClick={() => toggleWeekday(day)}
									data-testid={`repeat-weekday-${day}`}
								>
									{weekdayName(day, i18n.locale, 'short')}
								</Button>
							))}
						</div>
					</div>

					<div className="flex flex-col gap-1.5">
						<span className="text-sm font-medium">
							<Trans>Order items</Trans>
						</span>
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								size="sm"
								variant={mode === 'fixed_lines' ? 'default' : 'outline'}
								onClick={() => setMode('fixed_lines')}
								data-testid="repeat-mode-fixed"
							>
								<Trans>Same lines as this order</Trans>
							</Button>
							<Button
								type="button"
								size="sm"
								variant={mode === 'top_up' ? 'default' : 'outline'}
								onClick={() => setMode('top_up')}
								data-testid="repeat-mode-top-up"
							>
								<Trans>Top up to level</Trans>
							</Button>
						</div>
					</div>

					<TextField
						id="repeat-order-note"
						label={t`Note (optional)`}
						value={note}
						onChange={(event) => setNote(event.target.value)}
						placeholder={t`e.g. Weekend prep stock`}
					/>

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
							disabled={submitting}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="submit"
							disabled={weekdays.length === 0 || submitting}
							data-testid="repeat-order-submit"
						>
							<Trans>Save schedule</Trans>
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
