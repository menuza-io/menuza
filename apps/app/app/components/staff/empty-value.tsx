import { Trans } from '@lingui/macro'

/**
 * The quiet placeholder for a missing value in a table or list. The dash is
 * visual only; screen readers hear "None" instead of "en dash".
 */
export function EmptyValue() {
	return (
		<>
			<span aria-hidden="true" className="text-muted-foreground">
				–
			</span>
			<span className="sr-only">
				<Trans>None</Trans>
			</span>
		</>
	)
}
