import { Trans } from '@lingui/macro'
import { RestaurantHandoffPayloadSchema } from '@repo/phone-agent-restaurant'
import { type CallHandoff } from '../call-data.ts'

/** The cart the agent texted to the caller. */
export function OrderHandoffDetails({ handoff }: { handoff: CallHandoff }) {
	const parsed = RestaurantHandoffPayloadSchema.safeParse(handoff.payload)
	if (!parsed.success) {
		return (
			<p className="text-muted-foreground">
				<Trans>The order on this link can't be shown.</Trans>
			</p>
		)
	}
	return (
		<ul className="flex flex-col gap-1">
			{parsed.data.cart.map((line, index) => (
				<li key={index}>
					<span className="tabular-nums">{line.quantity}×</span> {line.name}
					{line.options.length ? (
						<span className="text-muted-foreground">
							{' '}
							({line.options.map((option) => option.optionName).join(', ')})
						</span>
					) : null}
					{line.instructions ? (
						<span className="text-muted-foreground block text-xs">
							{line.instructions}
						</span>
					) : null}
				</li>
			))}
		</ul>
	)
}
