import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	splitCheckByItem,
	type SplitCheckPlan,
	type SplitCheckResult,
} from '@repo/common/pos-split-check'
import { useMemo, useState } from 'react'
import { type MoneyFormatter } from '~/lib/money.ts'
import { lineTotalCents, type CartLine } from '~/lib/pricing.ts'
import { Button, Modal } from '~/ui/primitives.tsx'

/**
 * Station Checkout "Split by item" (#289).
 *
 * Lets staff put dishes onto Check 1, Check 2, … or divide a shared dish
 * across checks. Uses `splitCheckByItem` so checks ALWAYS add up to the order
 * total to the cent, order-level discounts apportion in proportion, and each
 * check can be paid and receipted individually with its own tip.
 */
export function SplitByItemSheet({
	lines,
	orderDiscountCents = 0,
	taxRatePercent,
	taxInclusive,
	taxExempt = false,
	serviceChargeCents = 0,
	serviceChargeTaxCents = 0,
	deliveryFeeCents = 0,
	paidCheckNumbers = [],
	money,
	onPayCheck,
	onClose,
}: {
	lines: CartLine[]
	orderDiscountCents?: number
	taxRatePercent: number
	taxInclusive: boolean
	taxExempt?: boolean
	serviceChargeCents?: number
	serviceChargeTaxCents?: number
	deliveryFeeCents?: number
	paidCheckNumbers?: number[]
	money: MoneyFormatter
	onPayCheck: (check: SplitCheckResult) => void
	onClose: () => void
}) {
	const { _ } = useLingui()
	const [checkCount, setCheckCount] = useState(2)
	// Map of lineId -> array of 1-based check numbers sharing that line (default [1]).
	const [assignments, setAssignments] = useState<Record<string, number[]>>(() =>
		Object.fromEntries(lines.map((l) => [l.id, [1]])),
	)

	const toggleLineOnCheck = (lineId: string, checkNum: number) => {
		setAssignments((prev) => {
			const current = prev[lineId] ?? [1]
			const has = current.includes(checkNum)
			if (has && current.length === 1) return prev // every dish must belong to at least 1 check
			const next = has
				? current.filter((n) => n !== checkNum)
				: [...current, checkNum].sort((a, b) => a - b)
			return { ...prev, [lineId]: next }
		})
	}

	const plan: SplitCheckPlan = useMemo(() => {
		const splitLines = lines.map((line) => {
			const total = lineTotalCents(line)
			const taxable =
				((line.taxable === false ? 0 : line.baseCents) +
					line.options.reduce(
						(s, o) => s + (o.taxable ? o.unitCents * o.quantity : 0),
						0,
					)) *
				line.quantity
			return {
				id: line.id,
				name: line.name,
				quantity: line.quantity,
				totalCents: total,
				taxableCents: taxable,
			}
		})
		const checks = Array.from({ length: checkCount }, (_, idx) => {
			const checkNumber = idx + 1
			const checkAssignments = lines.flatMap((line) => {
				const holders = assignments[line.id] ?? [1]
				if (!holders.includes(checkNumber)) return []
				return [{ lineId: line.id, shareNum: 1, shareDen: holders.length }]
			})
			return { checkNumber, assignments: checkAssignments }
		})
		return splitCheckByItem({
			lines: splitLines,
			checks,
			orderDiscountCents,
			taxRatePercent,
			taxInclusive,
			taxExempt,
			serviceChargeCents,
			serviceChargeTaxCents,
			deliveryFeeCents,
		})
	}, [
		lines,
		checkCount,
		assignments,
		orderDiscountCents,
		taxRatePercent,
		taxInclusive,
		taxExempt,
		serviceChargeCents,
		serviceChargeTaxCents,
		deliveryFeeCents,
	])

	const paidSet = new Set(paidCheckNumbers)

	return (
		<Modal
			open
			title={_(t`Split by item`)}
			onClose={onClose}
			footer={
				<div className="flex items-center justify-between gap-3">
					<Button
						type="button"
						variant="outline"
						onClick={() => setCheckCount((c) => Math.min(10, c + 1))}
					>
						<Trans>Add check</Trans>
					</Button>
					<Button type="button" variant="outline" onClick={onClose}>
						<Trans>Done</Trans>
					</Button>
				</div>
			}
		>
			<div className="space-y-4 p-4">
				<div className="space-y-2">
					<p className="text-sm font-semibold">
						<Trans>Tap checks to assign or share each dish</Trans>
					</p>
					{lines.map((line) => {
						const holders = assignments[line.id] ?? [1]
						return (
							<div
								key={line.id}
								className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2.5"
							>
								<div className="text-sm">
									<span className="font-medium">
										{line.quantity} × {line.name}
									</span>{' '}
									<span className="text-muted-foreground">
										{money(lineTotalCents(line))}
									</span>
								</div>
								<div className="flex flex-wrap gap-1.5">
									{Array.from({ length: checkCount }, (_, i) => i + 1).map(
										(num) => {
											const active = holders.includes(num)
											return (
												<Button
													key={num}
													type="button"
													size="md"
													variant={active ? 'primary' : 'outline'}
													disabled={paidSet.has(num)}
													onClick={() => toggleLineOnCheck(line.id, num)}
												>
													{_(t`Check ${num}`)}
												</Button>
											)
										},
									)}
								</div>
							</div>
						)
					})}
				</div>

				<div className="grid gap-3 sm:grid-cols-2">
					{plan.checks.map((check) => {
						const isPaid = paidSet.has(check.checkNumber)
						return (
							<div
								key={check.checkNumber}
								className="flex flex-col justify-between gap-2 rounded-lg border p-3"
								data-check-card={check.checkNumber}
							>
								<div>
									<div className="flex items-center justify-between font-semibold">
										<span>
											<Trans>Check #{check.checkNumber}</Trans>
										</span>
										<span className="tabular-nums">
											{money(check.totalCents)}
										</span>
									</div>
									<ul className="text-muted-foreground mt-1 space-y-0.5 text-xs">
										{check.items.map((item) => (
											<li key={item.lineId} className="flex justify-between">
												<span>
													{item.shareDen > 1
														? `${item.shareNum}/${item.shareDen} `
														: `${item.quantity} × `}
													{item.name}
												</span>
												<span>{money(item.amountCents)}</span>
											</li>
										))}
									</ul>
								</div>
								<Button
									type="button"
									size="md"
									variant={isPaid ? 'outline' : 'primary'}
									disabled={isPaid || check.totalCents <= 0}
									onClick={() => onPayCheck(check)}
								>
									{isPaid ? <Trans>Paid</Trans> : <Trans>Pay check</Trans>}
								</Button>
							</div>
						)
					})}
				</div>
			</div>
		</Modal>
	)
}
