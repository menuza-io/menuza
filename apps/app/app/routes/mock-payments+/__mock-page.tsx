import { Trans } from '@lingui/macro'
import { Badge } from '@repo/ui/badge'
import { type ReactNode } from 'react'

/**
 * Chrome shared by every mock hosted page: a banner that says, on every page,
 * that nothing here is real (and which emulator it stands in for).
 */
export function MockPage({
	banner,
	testId,
	wide = false,
	children,
}: {
	banner: ReactNode
	testId: string
	/** Dashboards and the event log need room for tables. */
	wide?: boolean
	children: ReactNode
}) {
	return (
		<div className="bg-muted/40 min-h-dvh" data-testid={testId}>
			<div
				className="bg-primary text-primary-foreground sticky top-0 z-10 flex flex-wrap items-center justify-center gap-2 px-4 py-2 text-sm font-medium"
				data-testid="mock-banner"
				role="status"
			>
				<Badge variant="secondary">
					<Trans>Mock</Trans>
				</Badge>
				{banner}
			</div>
			<main
				className={`mx-auto flex w-full flex-col gap-4 px-4 py-8 ${wide ? 'max-w-6xl' : 'max-w-xl'}`}
			>
				{children}
			</main>
		</div>
	)
}

/**
 * Formats an amount in minor units. The exponent comes from the currency
 * itself (`Intl`): 2 for USD, 0 for JPY, 3 for KWD.
 */
export function formatMinor(amount: number, currency: string) {
	const code = currency.toUpperCase()
	try {
		const formatter = new Intl.NumberFormat('en-US', {
			style: 'currency',
			currency: code,
		})
		const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2
		return formatter.format(amount / 10 ** digits)
	} catch {
		return `${(amount / 100).toFixed(2)} ${code}`
	}
}
