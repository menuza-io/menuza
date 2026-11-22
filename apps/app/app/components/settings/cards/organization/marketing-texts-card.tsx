import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'

export type MarketingTextsUsage = {
	periodKey: string
	limit: number
	extra: number
	used: number
	remaining: number
	/** Epoch ms the allowance comes back. */
	resetsAt: number
	locations: Array<{
		locationId: string
		name: string
		used: number
		limit: number
	}>
}

/**
 * Billing: marketing text sends used this month at each location (#247). A
 * send is one broadcast text to an audience (or an automation text step, once a
 * month); it counts once for each location it reaches. Transactional texts
 * (order ready, booking reminders, sign-in codes) are never counted.
 */
export function MarketingTextsCard({ usage }: { usage: MarketingTextsUsage }) {
	const { i18n } = useLingui()
	const resets = new Intl.DateTimeFormat(i18n.locale, {
		dateStyle: 'long',
		timeZone: 'UTC',
	}).format(new Date(usage.resetsAt))
	return (
		<Frame>
			<FrameHeader>
				<FrameTitle>
					<Trans>Marketing texts</Trans>
				</FrameTitle>
				<FrameDescription>
					<Trans>
						Text sends included in your plan each month. Order and booking
						texts never count. Your sends come back on {resets}.
					</Trans>
				</FrameDescription>
			</FrameHeader>
			<FramePanel>
				<ul className="divide-y" data-testid="marketing-texts-usage">
					{usage.locations.length === 0 ? (
						<li className="py-3 text-sm">
							<Trans>
								{usage.used} of {usage.limit} text sends used this month
							</Trans>
						</li>
					) : (
						usage.locations.map((location) => (
							<li
								key={location.locationId}
								className="flex items-center justify-between gap-4 py-3 text-sm"
								data-testid={`marketing-texts-${location.locationId}`}
							>
								<span className="wrap-anywhere font-medium">
									{location.name}
								</span>
								<span className="text-muted-foreground">
									<Trans>
										{location.used} of {location.limit} text sends used
									</Trans>
								</span>
							</li>
						))
					)}
				</ul>
				{usage.extra > 0 ? (
					<p className="text-muted-foreground mt-3 text-xs">
						<Trans>This month includes {usage.extra} extra sends from us.</Trans>
					</p>
				) : null}
			</FramePanel>
		</Frame>
	)
}
