import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { type InvoiceLineWarning } from '@repo/inventory'
import { Badge } from '@repo/ui/badge'

const WARNING_LABELS = {
	pack_diff: msg`Pack size differs`,
	price_change_gt_5pct: msg`Price changed >5%`,
	line_total_mismatch: msg`Qty × price ≠ line total`,
	unmatched: msg`Not matched to stock`,
} as const satisfies Record<InvoiceLineWarning, ReturnType<typeof msg>>

export function InvoiceWarningBadges({
	warnings,
}: {
	warnings: readonly InvoiceLineWarning[] | undefined
}) {
	const { i18n } = useLingui()
	if (!warnings || warnings.length === 0) return null
	return (
		<div className="flex flex-wrap gap-1">
			{warnings.map((warning) => (
				<Badge
					key={warning}
					variant={warning === 'unmatched' ? 'outline' : 'warning'}
					data-testid={`invoice-warning-${warning}`}
				>
					{i18n._(WARNING_LABELS[warning])}
				</Badge>
			))}
		</div>
	)
}
