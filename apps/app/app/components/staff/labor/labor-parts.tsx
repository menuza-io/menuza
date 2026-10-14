import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type SalesSource } from '@repo/staffing'
import { cn } from '@repo/ui'
import { Icon } from '@repo/ui/icon'
import { EmptyValue } from '#app/components/staff/empty-value.tsx'
import { type LaborMoneyRow } from '#app/utils/staffing/labor-types.ts'
import { formatShare, SOURCE_NAMES } from '#app/utils/staffing/labor-view.ts'
import { formatMoneyMinor } from '#app/utils/staffing/staff-format.ts'

/**
 * Small pieces the Labor screens share. The sales source is named wherever a
 * labor share appears, and a share is only ever marked within or over its
 * target when the server says so (it leaves the status out unless the sales
 * cover everything the scope sells).
 */

export function useSourceName(source: SalesSource): string {
	const { _ } = useLingui()
	return _(SOURCE_NAMES[source])
}

/** A share as text, with its within/over status read aloud and shown by weight and icon. */
export function ShareValue({
	row,
	locale,
	className,
}: {
	row: Pick<LaborMoneyRow, 'laborBp' | 'targetStatus'>
	locale: string
	className?: string
}) {
	if (row.laborBp === null) return <EmptyValue />
	const over = row.targetStatus === 'over'
	return (
		<span
			className={cn(
				'inline-flex items-center gap-1 tabular-nums',
				over && 'text-destructive font-medium',
				className,
			)}
		>
			{row.targetStatus ? (
				<Icon
					name={over ? 'alert-triangle' : 'check'}
					className="size-3.5 shrink-0"
					aria-hidden="true"
				/>
			) : null}
			{formatShare(row.laborBp, locale)}
			{row.targetStatus ? (
				<span className="sr-only">
					{over ? <Trans>over target</Trans> : <Trans>within target</Trans>}
				</span>
			) : null}
		</span>
	)
}

/** One line per currency: amounts of different currencies are never added. */
export function MoneyLines({
	rows,
	pick,
	locale,
	empty,
}: {
	rows: readonly LaborMoneyRow[]
	pick: (row: LaborMoneyRow) => number | null
	locale: string
	empty?: React.ReactNode
}) {
	const lines = rows.flatMap((row) => {
		const value = pick(row)
		return value === null ? [] : [{ currency: row.currency, value }]
	})
	if (lines.length === 0) return <>{empty ?? <EmptyValue />}</>
	return (
		<>
			{lines.map((line) => (
				<span key={line.currency} className="block tabular-nums">
					{formatMoneyMinor(line.value, line.currency, locale)}
				</span>
			))}
		</>
	)
}
