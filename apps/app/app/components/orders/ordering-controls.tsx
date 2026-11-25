import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { useState } from 'react'
import { useFetcher } from 'react-router'
import {
	type DeliveryPauseFailure,
	type LocationOrderingControl,
	type OrderingPauseDuration,
} from '#app/utils/location/ordering-pause.ts'

const BUSY_CHOICES = [10, 20, 30] as const

/** "7:30 PM", or "Thu 7:30 PM" when not today, in the location time zone. */
function formatLocalTime(iso: string, timeZone: string, locale: string) {
	const date = new Date(iso)
	const dayOf = (value: Date) =>
		new Intl.DateTimeFormat('en-CA', { timeZone }).format(value)
	try {
		return new Intl.DateTimeFormat(locale, {
			timeZone,
			hour: 'numeric',
			minute: '2-digit',
			...(dayOf(date) === dayOf(new Date()) ? {} : { weekday: 'short' }),
		}).format(date)
	} catch {
		return date.toLocaleString(locale)
	}
}

/**
 * "Online ordering" panel on the Orders page: per location, pause web and QR
 * ordering for a while (walk-in POS sales continue) and busy mode, which adds
 * minutes to every prep estimate.
 */
export function OrderingControls({
	orgSlug,
	locations,
	canWrite,
}: {
	orgSlug: string
	locations: LocationOrderingControl[]
	canWrite: boolean
}) {
	if (locations.length === 0) return null
	return (
		<section
			className="space-y-3 rounded-lg border p-4"
			aria-labelledby="ordering-controls-title"
			data-testid="ordering-controls"
		>
			<div>
				<h2 id="ordering-controls-title" className="font-medium">
					<Trans>Online ordering</Trans>
				</h2>
				<p className="text-muted-foreground text-sm">
					<Trans>
						Pause web and QR orders when the kitchen is overwhelmed, or add prep
						time in busy mode. Counter sales are not affected.
					</Trans>
				</p>
			</div>
			<ul className="divide-border divide-y">
				{locations.map((location) => (
					<LocationRow
						key={location.id}
						orgSlug={orgSlug}
						location={location}
						canWrite={canWrite}
						showName={locations.length > 1}
					/>
				))}
			</ul>
		</section>
	)
}

function LocationRow({
	orgSlug,
	location,
	canWrite,
	showName,
}: {
	orgSlug: string
	location: LocationOrderingControl
	canWrite: boolean
	showName: boolean
}) {
	const { _, i18n } = useLingui()
	const fetcher = useFetcher<{
		ok: boolean
		error: string | null
		deliveryPauseError?: string | null
		failedDeliveryStores?: DeliveryPauseFailure[]
	}>()
	const retryFetcher = useFetcher<{
		ok: boolean
		error: string | null
		deliveryPauseError?: string | null
		failedDeliveryStores?: DeliveryPauseFailure[]
	}>()
	const [alsoPauseDelivery, setAlsoPauseDelivery] = useState(true)
	const [lastRetriedId, setLastRetriedId] = useState<string | null>(null)
	const pending = fetcher.state !== 'idle'
	const retryingIntegrationId =
		retryFetcher.state !== 'idle' ? lastRetriedId : null
	const action = `/${orgSlug}/orders/ordering-controls`
	const submit = (values: Record<string, string>) => {
		setLastRetriedId(null)
		void fetcher.submit(
			{ locationId: location.id, ...values },
			{ method: 'POST', action },
		)
	}
	const retryDeliveryStore = (integrationId: string) => {
		setLastRetriedId(integrationId)
		void retryFetcher.submit(
			{
				intent: 'retry-delivery-pause',
				locationId: location.id,
				integrationId,
			},
			{ method: 'POST', action },
		)
	}
	const time = (iso: string) =>
		formatLocalTime(iso, location.timezone, i18n.locale)
	const paused = location.pausedAt !== null
	const busy = location.busyExtraPrepMinutes > 0
	const failed = fetcher.state === 'idle' && fetcher.data?.ok === false
	const baseFailures =
		fetcher.data?.deliveryPauseError === 'platform_pause_failed' &&
		fetcher.data.failedDeliveryStores
			? fetcher.data.failedDeliveryStores
			: (location.deliveryPauseFailures ?? [])
	const retriedOkId =
		retryFetcher.state === 'idle' && retryFetcher.data?.ok === true
			? lastRetriedId
			: null
	const deliveryFailures = baseFailures
		.filter((store) => store.integrationId !== retriedOkId)
		.map((store) => {
			const updated =
				retryFetcher.state === 'idle' && retryFetcher.data?.ok === false
					? retryFetcher.data.failedDeliveryStores?.find(
							(item) => item.integrationId === store.integrationId,
						)
					: undefined
			return updated ?? store
		})

	const pauseChoices: { duration: OrderingPauseDuration; label: string }[] = [
		{ duration: '15m', label: _(msg`15 minutes`) },
		{ duration: '30m', label: _(msg`30 minutes`) },
		{ duration: '60m', label: _(msg`1 hour`) },
		{ duration: 'rest_of_day', label: _(msg`Rest of today`) },
		{ duration: 'until_resumed', label: _(msg`Until I turn it back on`) },
	]

	const pauseEnd = location.pausedUntil ? time(location.pausedUntil) : null
	const busyEnd = location.busyUntil ? time(location.busyUntil) : null
	const busyMinutes = location.busyExtraPrepMinutes
	const totalPrep = location.prepTime + busyMinutes

	return (
		<li
			className="flex flex-wrap items-center justify-between gap-3 py-3"
			data-testid={`ordering-control-${location.id}`}
		>
			<div className="min-w-0 space-y-1">
				{showName ? (
					<p className="truncate font-medium">{location.name}</p>
				) : null}
				<div className="flex flex-wrap items-center gap-2 text-sm">
					{paused ? (
						<Badge variant="warning" data-testid="ordering-paused">
							{pauseEnd
								? _(msg`Paused until ${pauseEnd}`)
								: _(msg`Paused until you resume`)}
						</Badge>
					) : (
						<Badge variant="success" data-testid="ordering-open">
							<Trans>Taking online orders</Trans>
						</Badge>
					)}
					{busy ? (
						<Badge variant="outline" data-testid="ordering-busy">
							<Icon name="flame" />
							{busyEnd
								? _(
										msg`Busy: ${totalPrep} min prep (+${busyMinutes}) until ${busyEnd}`,
									)
								: _(msg`Busy: ${totalPrep} min prep (+${busyMinutes})`)}
						</Badge>
					) : null}
				</div>
				{failed ? (
					<p role="alert" className="text-destructive text-sm">
						<Trans>That did not save. Try again.</Trans>
					</p>
				) : null}
				{deliveryFailures.length > 0 ? (
					<div className="space-y-1.5 pt-1">
						{deliveryFailures.map((store) => {
							const storeName = store.displayName
							const storeError = store.error
							return (
								<div
									key={store.integrationId}
									role="alert"
									data-error-code="platform_pause_failed"
									data-testid={`delivery-pause-error-${store.integrationId}`}
									className="border-destructive/30 bg-destructive/5 text-destructive flex flex-wrap items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs"
								>
									<span>
										<Trans>
											Could not update {storeName}: {storeError}
										</Trans>
									</span>
									{canWrite ? (
										<Button
											type="button"
											variant="outline"
											size="sm"
											disabled={retryingIntegrationId === store.integrationId}
											onClick={() => retryDeliveryStore(store.integrationId)}
											data-testid={`retry-delivery-pause-${store.integrationId}`}
										>
											<Trans>Retry</Trans>
										</Button>
									) : null}
								</div>
							)
						})}
					</div>
				) : null}
			</div>
			{canWrite ? (
				<div className="flex flex-wrap items-center gap-2">
					{!paused && location.hasDeliveryConnections ? (
						<label
							htmlFor={`also-pause-delivery-${location.id}`}
							className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs select-none"
						>
							<Checkbox
								id={`also-pause-delivery-${location.id}`}
								checked={alsoPauseDelivery}
								onCheckedChange={(checked) =>
									setAlsoPauseDelivery(Boolean(checked))
								}
							/>
							<span>
								<Trans>Also pause delivery apps</Trans>
							</span>
						</label>
					) : null}
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={pending}
									data-testid="busy-mode-menu"
								>
									<Icon name="clock" />
									<Trans>Busy mode</Trans>
								</Button>
							}
						/>
						<DropdownMenuContent align="end">
							<DropdownMenuGroup>
								<DropdownMenuLabel>
									<Trans>Add prep time for the rest of today</Trans>
								</DropdownMenuLabel>
								{BUSY_CHOICES.map((minutes) => (
									<DropdownMenuItem
										key={minutes}
										onClick={() =>
											submit({
												intent: 'busy',
												minutes: String(minutes),
												duration: 'rest_of_day',
											})
										}
										data-testid={`busy-${minutes}`}
									>
										{_(msg`+${minutes} minutes`)}
									</DropdownMenuItem>
								))}
							</DropdownMenuGroup>
							{busy ? (
								<>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										onClick={() => submit({ intent: 'busy_off' })}
										data-testid="busy-off"
									>
										<Trans>Turn off busy mode</Trans>
									</DropdownMenuItem>
								</>
							) : null}
						</DropdownMenuContent>
					</DropdownMenu>
					{paused ? (
						<Button
							type="button"
							size="sm"
							disabled={pending}
							onClick={() => submit({ intent: 'resume' })}
							data-testid="resume-ordering"
						>
							<Icon name="play" />
							<Trans>Resume orders</Trans>
						</Button>
					) : (
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										type="button"
										variant="destructive"
										size="sm"
										disabled={pending}
										data-testid="pause-ordering-menu"
									>
										<Trans>Pause orders</Trans>
									</Button>
								}
							/>
							<DropdownMenuContent align="end">
								<DropdownMenuGroup>
									<DropdownMenuLabel>
										<Trans>Pause online orders for</Trans>
									</DropdownMenuLabel>
									{pauseChoices.map((choice) => (
										<DropdownMenuItem
											key={choice.duration}
											onClick={() =>
												submit({
													intent: 'pause',
													duration: choice.duration,
													...(location.hasDeliveryConnections
														? { alsoPauseDelivery: String(alsoPauseDelivery) }
														: {}),
												})
											}
											data-testid={`pause-${choice.duration}`}
										>
											{choice.label}
										</DropdownMenuItem>
									))}
								</DropdownMenuGroup>
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
			) : null}
		</li>
	)
}
