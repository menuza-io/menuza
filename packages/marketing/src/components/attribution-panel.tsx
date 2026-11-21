import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { useState, type ReactNode } from 'react'
import {
	attributionFigures,
	formatAttributionMoney,
	type AttributionMode,
	type AttributionView,
} from '../attribution.ts'

/**
 * Orders and revenue credited to marketing (#115), with the Clicked / Reached
 * switch. Clicked (the default) counts orders placed after a click on a link
 * in a message; Reached also counts orders from guests who were sent a message
 * in the 14 days before. The switch changes the figures and the labels, and
 * what each view means is written under it.
 */
export function AttributionPanel({
	view,
	heading,
	extra,
	testId = 'attribution-panel',
}: {
	view: AttributionView
	heading?: ReactNode
	/** More figures the page owns (messages sent, guests reached). */
	extra?: ReactNode
	testId?: string
}) {
	const { _, i18n } = useLingui()
	const [mode, setMode] = useState<AttributionMode>('clicked')
	const figures = attributionFigures(view, mode)
	const money = formatAttributionMoney(
		figures.revenueMinor,
		view.currency,
		i18n.locale,
	)
	const clicked = mode === 'clicked'
	return (
		<section
			className="space-y-3"
			data-testid={testId}
			data-mode={mode}
			aria-label={_(msg`Orders and revenue from marketing`)}
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				{heading ?? (
					<h2 className="text-sm font-medium">{_(msg`Orders and revenue`)}</h2>
				)}
				<ToggleGroup
					variant="segmented"
					aria-label={_(msg`How orders are counted`)}
					value={[mode]}
					onValueChange={(next) => {
						const picked = next[0]
						if (picked === 'clicked' || picked === 'reached') setMode(picked)
					}}
				>
					<ToggleGroupItem value="clicked" data-testid={`${testId}-clicked`}>
						{_(msg`Clicked`)}
					</ToggleGroupItem>
					<ToggleGroupItem value="reached" data-testid={`${testId}-reached`}>
						{_(msg`Reached`)}
					</ToggleGroupItem>
				</ToggleGroup>
			</div>
			<dl className="grid gap-3 sm:grid-cols-2">
				{extra}
				<div className="rounded-lg border p-3">
					<dt className="text-muted-foreground text-xs">
						{clicked
							? _(msg`Orders after a click`)
							: _(msg`Orders from guests reached`)}
					</dt>
					<dd
						className="mt-1 text-2xl tracking-tight tabular-nums"
						data-testid={`${testId}-orders`}
					>
						{figures.orders.toLocaleString(i18n.locale)}
					</dd>
				</div>
				<div className="rounded-lg border p-3">
					<dt className="text-muted-foreground text-xs">
						{clicked
							? _(msg`Revenue after a click`)
							: _(msg`Revenue from guests reached`)}
					</dt>
					<dd
						className="mt-1 text-2xl tracking-tight tabular-nums"
						data-testid={`${testId}-revenue`}
					>
						{money}
					</dd>
				</div>
			</dl>
			<p className="text-muted-foreground text-xs">
				{clicked
					? _(
							msg`Clicked: orders placed after a guest followed a link in one of your messages. Revenue is net of refunds.`,
						)
					: _(
							msg`Reached: clicked orders plus orders from guests who were sent a message in the 14 days before. Each order is counted once, for their latest message.`,
						)}
			</p>
		</section>
	)
}
