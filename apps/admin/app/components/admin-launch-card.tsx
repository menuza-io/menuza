import { type MessageDescriptor } from '@lingui/core'
import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import {
	type LaunchStatus,
	type LaunchStatusResult,
} from '#app/utils/launch-status.ts'

const STEP_LABELS: Record<string, MessageDescriptor> = {
	launch_location_details: msg`Address, phone and opening hours`,
	launch_menu: msg`Menu`,
	launch_branding: msg`Logo and site theme`,
	launch_payments: msg`Payments or pay at pickup`,
	launch_fulfillment: msg`Pickup, delivery and prep time`,
	launch_station: msg`Station terminal or kitchen display`,
	launch_test_order: msg`Test order`,
	launch_custom_domain: msg`Custom domain`,
	launch_go_live: msg`Site published and ordering on`,
}

type Step = LaunchStatus['locations'][number]['steps'][number]

function StepState({ step }: { step: Step }) {
	switch (step.state) {
		case 'done':
			return (
				<Badge variant="success">
					<Trans>Done</Trans>
				</Badge>
			)
		case 'skipped':
			return (
				<Badge variant="outline">
					<Trans>Skipped</Trans>
				</Badge>
			)
		case 'optional':
			return (
				<Badge variant="secondary">
					<Trans>Optional</Trans>
				</Badge>
			)
		case 'todo':
			return (
				<Badge variant="warning">
					<Trans>To do</Trans>
				</Badge>
			)
	}
}

function LocationProgress({
	done,
	total,
	firstLive,
}: {
	done: number
	total: number
	firstLive: string | null
}) {
	return (
		<>
			<span className="text-muted-foreground text-xs">
				<Trans>
					{done} of {total} required steps
				</Trans>
			</span>
			{firstLive ? (
				<span className="text-muted-foreground text-xs">
					<Trans>First live {firstLive}</Trans>
				</span>
			) : null}
		</>
	)
}

/**
 * Admin's Launch card: each location's launch steps with their dates, days
 * since sign-up and the date of the first real order. State and dates only;
 * no guest, member or contact data.
 */
export function AdminLaunchCard({ result }: { result: LaunchStatusResult }) {
	const { _, i18n } = useLingui()
	const date = (iso: string | null) =>
		iso
			? new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' }).format(
					new Date(iso),
				)
			: '—'

	return (
		<Card data-testid="admin-launch-card">
			<CardHeader>
				<CardTitle>
					<Trans>Launch</Trans>
				</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{result.status === 'unavailable' ? (
					<p className="text-muted-foreground text-sm">
						<Trans>The launch status could not be loaded from the App.</Trans>
					</p>
				) : (
					<>
						<dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
							<div>
								<dt className="text-muted-foreground text-xs">
									<Trans>Checklist</Trans>
								</dt>
								<dd>
									{result.launch.enabled ? (
										<Trans>On</Trans>
									) : (
										<Trans>Off</Trans>
									)}
								</dd>
							</div>
							<div>
								<dt className="text-muted-foreground text-xs">
									<Trans>Days since sign-up</Trans>
								</dt>
								<dd className="tabular-nums">
									{result.launch.daysSinceSignup}
								</dd>
							</div>
							<div>
								<dt className="text-muted-foreground text-xs">
									<Trans>First real order</Trans>
								</dt>
								<dd>
									{result.launch.regionAnswered ? (
										date(result.launch.firstOrderAt)
									) : (
										<Trans>Unknown</Trans>
									)}
								</dd>
							</div>
						</dl>
						{result.launch.locations.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								<Trans>No active locations.</Trans>
							</p>
						) : (
							result.launch.locations.map((location) => (
								<section
									key={location.id}
									className="flex flex-col gap-2"
									data-testid={`admin-launch-location-${location.id}`}
								>
									<div className="flex flex-wrap items-center gap-2">
										<h3 className="text-sm font-semibold">{location.name}</h3>
										{location.live ? (
											<Badge variant="success">
												<Trans>Live</Trans>
											</Badge>
										) : (
											<Badge variant="warning">
												<Trans>In setup</Trans>
											</Badge>
										)}
										<LocationProgress
											done={location.requiredDone}
											total={location.requiredTotal}
											firstLive={location.liveAt ? date(location.liveAt) : null}
										/>
									</div>
									<ul className="flex flex-col gap-1 text-sm">
										{location.steps.map((step) => (
											<li
												key={step.key}
												className="flex flex-wrap items-center justify-between gap-2"
											>
												<span>
													{STEP_LABELS[step.key]
														? _(STEP_LABELS[step.key]!)
														: step.key}
												</span>
												<span className="flex items-center gap-2">
													<span className="text-muted-foreground text-xs tabular-nums">
														{date(step.completedAt ?? step.skippedAt)}
													</span>
													<StepState step={step} />
												</span>
											</li>
										))}
									</ul>
								</section>
							))
						)}
					</>
				)}
			</CardContent>
		</Card>
	)
}
