import { Trans } from '@lingui/macro'
import { Badge } from '@repo/ui/badge'

export function MenuScopeBadge({
	operatorContext,
}: {
	operatorContext: 'brand' | 'branch'
}) {
	return (
		<Badge variant="secondary">
			{operatorContext === 'brand' ? (
				<Trans>Brand catalog</Trans>
			) : (
				<Trans>Branch catalog</Trans>
			)}
		</Badge>
	)
}
