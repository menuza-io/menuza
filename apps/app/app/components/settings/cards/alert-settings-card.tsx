import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	isHhmm,
	isOrderAlertKind,
	previewAlertCount,
	type PushCategory,
	type ThresholdKind,
} from '@repo/common/operator-alerts'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Separator } from '@repo/ui/separator'
import { Switch } from '@repo/ui/switch'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useFetcher } from 'react-router'
import { HoneypotInputs } from 'remix-utils/honeypot/react'
import {
	type AlertLogEntry,
	type AlertSettingsView,
	type SaveAlertSetting,
} from '#app/utils/alerts/settings.server.ts'

type Payload = {
	success?: boolean
	settings: AlertSettingsView
	log: { entries: AlertLogEntry[]; scope: 'mine' | 'organization' }
}

const CATEGORY_LABELS: Record<PushCategory, ReturnType<typeof msg>> = {
	new_orders: msg`New orders`,
	orders_waiting: msg`Orders waiting too long`,
	ordering_paused: msg`Ordering paused for too long`,
	payment_review: msg`A payment needs review`,
	large_orders: msg`Large orders`,
	station_offline: msg`A kitchen tablet goes offline`,
	staff: msg`Staff`,
	inventory: msg`Inventory`,
	reservations: msg`Reservations`,
	chat_mentions: msg`Team chat mentions`,
}

const KIND_LABELS = {
	orders_new: msg`New order`,
	orders_waiting: msg`Order waiting`,
	orders_due_soon: msg`Scheduled order due soon`,
	orders_payment_review: msg`Payment needs review`,
	ordering_paused_long: msg`Ordering paused too long`,
	orders_large: msg`Large order`,
	station_offline: msg`Kitchen tablet offline`,
} as const

const OUTCOME_LABELS: Record<string, ReturnType<typeof msg>> = {
	delivered: msg`Sent`,
	critical: msg`Sent (always on)`,
	snoozed: msg`Snoozed`,
	held: msg`Held until quiet hours end`,
	below_threshold: msg`Below your threshold`,
	dropped: msg`Dropped (switched off)`,
}

const THRESHOLD_KINDS_UI: ReadonlyArray<{
	kind: ThresholdKind
	label: ReturnType<typeof msg>
}> = [
	{ kind: 'orders_new', label: msg`New orders` },
	{ kind: 'orders_waiting', label: msg`Orders waiting too long` },
]

function timeZones(): string[] {
	try {
		return (
			(
				Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
			).supportedValuesOf?.('timeZone') ?? []
		)
	} catch {
		return []
	}
}

/**
 * Settings, Notifications: what arrives on the phone and when (#106, #366).
 * Push per kind, quiet hours that hold what can wait, a snooze, "tell me after
 * N in an hour" thresholds with a preview of how many alerts that makes, the
 * phones that get pushes, and a log of what fired, to whom and whether it was
 * snoozed. The same settings the phone app edits.
 */
export function AlertSettingsCard({
	organizationId,
}: {
	organizationId: string
}) {
	const { _, i18n } = useLingui()
	const fetcher = useFetcher<Payload>()
	const formRef = useRef<HTMLFormElement>(null)
	const baseId = useId()
	const [data, setData] = useState<Payload | null>(null)

	useEffect(() => {
		if (fetcher.state === 'idle' && !fetcher.data && !data) {
			void fetcher.load(
				`/api/notifications/alerts?organizationId=${encodeURIComponent(organizationId)}`,
			)
		}
	}, [fetcher, organizationId, data])
	useEffect(() => {
		if (fetcher.data?.settings) setData(fetcher.data)
	}, [fetcher.data])

	const saving = fetcher.state !== 'idle'
	function save(change: SaveAlertSetting) {
		const formData = new FormData(formRef.current!)
		formData.set('action', 'save')
		formData.set('organizationId', organizationId)
		formData.set('change', JSON.stringify(change))
		void fetcher.submit(formData, {
			method: 'POST',
			action: '/api/notifications/alerts',
		})
	}
	function removeDevice(deviceId: string) {
		const formData = new FormData(formRef.current!)
		formData.set('action', 'remove_device')
		formData.set('organizationId', organizationId)
		formData.set('deviceId', deviceId)
		void fetcher.submit(formData, {
			method: 'POST',
			action: '/api/notifications/alerts',
		})
	}

	const settings = data?.settings
	const [quietStart, setQuietStart] = useState('22:00')
	const [quietEnd, setQuietEnd] = useState('07:00')
	const [quietOn, setQuietOn] = useState(false)
	const [zone, setZone] = useState('')
	const [thresholds, setThresholds] = useState<Record<ThresholdKind, number>>({
		orders_new: 1,
		orders_waiting: 1,
	})
	const [customSnooze, setCustomSnooze] = useState('')
	const zones = useMemo(() => timeZones(), [])
	useEffect(() => {
		if (!settings) return
		setQuietOn(Boolean(settings.quiet.quietStart && settings.quiet.quietEnd))
		setQuietStart(settings.quiet.quietStart ?? '22:00')
		setQuietEnd(settings.quiet.quietEnd ?? '07:00')
		setZone(
			settings.quiet.timeZone ??
				Intl.DateTimeFormat().resolvedOptions().timeZone ??
				'UTC',
		)
		setThresholds(settings.thresholds)
	}, [settings])

	const policyDraft = useMemo(
		() => ({
			quietStart: quietOn && isHhmm(quietStart) ? quietStart : null,
			quietEnd: quietOn && isHhmm(quietEnd) ? quietEnd : null,
			timeZone: zone || null,
			snoozedUntil: null,
		}),
		[quietOn, quietStart, quietEnd, zone],
	)

	const previews = useMemo(() => {
		if (!settings) return null
		return Object.fromEntries(
			THRESHOLD_KINDS_UI.map(({ kind }) => [
				kind,
				previewAlertCount({
					occurrences: settings.occurrences[kind],
					settings: policyDraft,
					threshold: thresholds[kind],
				}),
			]),
		)
	}, [settings, policyDraft, thresholds])

	if (!settings) {
		return (
			<Card className="w-full">
				<CardHeader>
					<CardTitle>
						<Trans>Alerts on your phone</Trans>
					</CardTitle>
				</CardHeader>
				<CardContent>
					<p role="status" className="text-muted-foreground text-sm">
						<Trans>Loading…</Trans>
					</p>
				</CardContent>
			</Card>
		)
	}

	const snoozed = settings.snoozedUntil
	const formatTime = (ms: number) =>
		new Intl.DateTimeFormat(i18n.locale, {
			dateStyle: 'medium',
			timeStyle: 'short',
		}).format(new Date(ms))
	const snoozedLabel = snoozed ? formatTime(snoozed) : ''
	const kindLabel = (kind: string) => {
		if (isOrderAlertKind(kind)) return _(KIND_LABELS[kind])
		if (kind.startsWith('staffing-')) return _(msg`Staff`)
		if (kind.startsWith('inventory-')) return _(msg`Inventory`)
		if (kind.startsWith('reservations-')) return _(msg`Reservations`)
		if (kind === 'chat-mention') return _(msg`Team chat mention`)
		return kind
	}

	return (
		<Card className="w-full" data-testid="alert-settings-card">
			<CardHeader>
				<CardTitle>
					<Trans>Alerts on your phone</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Choose which alerts reach your phone, when they are held, and see
						what was sent to you.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				<form ref={formRef} className="hidden">
					<HoneypotInputs />
				</form>

				{settings.pushEnabled ? (
					<section aria-labelledby={`${baseId}-push`} className="space-y-2">
						<h3 id={`${baseId}-push`} className="text-base font-medium">
							<Trans>Push notifications</Trans>
						</h3>
						{settings.categories.map((row) => (
							<div
								key={row.category}
								className="flex items-center justify-between gap-3 py-1"
							>
								<span
									id={`${baseId}-push-${row.category}`}
									className="text-sm font-medium"
								>
									{_(CATEGORY_LABELS[row.category])}
									{row.locked ? (
										<Badge variant="destructive" className="ms-2 text-xs">
											<Trans>Always on</Trans>
										</Badge>
									) : null}
								</span>
								<Switch
									aria-labelledby={`${baseId}-push-${row.category}`}
									checked={row.push}
									disabled={row.locked || saving}
									onCheckedChange={(enabled) =>
										save({ intent: 'push', category: row.category, enabled })
									}
								/>
							</div>
						))}
						<Separator />
					</section>
				) : (
					<p className="text-muted-foreground text-sm">
						<Trans>
							Push notifications to your phone are not turned on for this
							organization yet.
						</Trans>
					</p>
				)}

				<section aria-labelledby={`${baseId}-quiet`} className="space-y-3">
					<h3 id={`${baseId}-quiet`} className="text-base font-medium">
						<Trans>Quiet hours</Trans>
					</h3>
					<p className="text-muted-foreground text-sm">
						<Trans>
							During quiet hours alerts that can wait are kept in your
							notifications and sent to your phone and email when they end.
							Payment reviews and an offline kitchen are never held.
						</Trans>
					</p>
					<div className="flex items-center gap-3">
						<Switch
							id={`${baseId}-quiet-on`}
							checked={quietOn}
							onCheckedChange={(on) => {
								setQuietOn(on)
								if (!on) {
									save({
										intent: 'quiet_hours',
										quiet: {
											quietStart: null,
											quietEnd: null,
											timeZone: zone || null,
										},
									})
								}
							}}
						/>
						<Label htmlFor={`${baseId}-quiet-on`}>
							<Trans>Hold alerts during quiet hours</Trans>
						</Label>
					</div>
					{quietOn ? (
						<div className="grid gap-3 sm:grid-cols-3">
							<div className="grid gap-1">
								<Label htmlFor={`${baseId}-from`}>
									<Trans>From</Trans>
								</Label>
								<Input
									id={`${baseId}-from`}
									type="time"
									value={quietStart}
									onChange={(event) => setQuietStart(event.target.value)}
								/>
							</div>
							<div className="grid gap-1">
								<Label htmlFor={`${baseId}-until`}>
									<Trans>Until</Trans>
								</Label>
								<Input
									id={`${baseId}-until`}
									type="time"
									value={quietEnd}
									onChange={(event) => setQuietEnd(event.target.value)}
								/>
							</div>
							<div className="grid gap-1">
								<Label htmlFor={`${baseId}-zone`}>
									<Trans>Time zone</Trans>
								</Label>
								<Input
									id={`${baseId}-zone`}
									list={`${baseId}-zones`}
									value={zone}
									onChange={(event) => setZone(event.target.value)}
								/>
								<datalist id={`${baseId}-zones`}>
									{zones.map((name) => (
										<option key={name} value={name} />
									))}
								</datalist>
							</div>
							<div className="sm:col-span-3">
								<Button
									variant="outline"
									disabled={
										saving || !isHhmm(quietStart) || !isHhmm(quietEnd) || !zone
									}
									onClick={() =>
										save({
											intent: 'quiet_hours',
											quiet: { quietStart, quietEnd, timeZone: zone },
										})
									}
								>
									<Trans>Save quiet hours</Trans>
								</Button>
							</div>
						</div>
					) : null}
					<Separator />
				</section>

				<section aria-labelledby={`${baseId}-snooze`} className="space-y-3">
					<h3 id={`${baseId}-snooze`} className="text-base font-medium">
						<Trans>Snooze</Trans>
					</h3>
					{snoozed ? (
						<p role="status" className="text-sm">
							<Trans>Snoozed until {snoozedLabel}.</Trans>
						</p>
					) : (
						<p className="text-muted-foreground text-sm">
							<Trans>
								Stops alerts to your phone and email for a while. They still
								appear in your notifications.
							</Trans>
						</p>
					)}
					<div className="flex flex-wrap items-end gap-2">
						<Button
							variant="outline"
							disabled={saving}
							onClick={() => save({ intent: 'snooze', option: '1h' })}
						>
							<Trans>1 hour</Trans>
						</Button>
						<Button
							variant="outline"
							disabled={saving}
							onClick={() =>
								save({
									intent: 'snooze',
									option: 'tomorrow',
									timeZone: zone || null,
								})
							}
						>
							<Trans>Until tomorrow morning</Trans>
						</Button>
						<div className="grid gap-1">
							<Label htmlFor={`${baseId}-custom`}>
								<Trans>Until</Trans>
							</Label>
							<Input
								id={`${baseId}-custom`}
								type="datetime-local"
								value={customSnooze}
								onChange={(event) => setCustomSnooze(event.target.value)}
							/>
						</div>
						<Button
							variant="outline"
							disabled={saving || !customSnooze}
							onClick={() =>
								save({
									intent: 'snooze',
									option: 'custom',
									until: new Date(customSnooze).getTime(),
								})
							}
						>
							<Trans>Snooze until then</Trans>
						</Button>
						{snoozed ? (
							<Button
								variant="ghost"
								disabled={saving}
								onClick={() => save({ intent: 'snooze', option: 'clear' })}
							>
								<Trans>Turn snooze off</Trans>
							</Button>
						) : null}
					</div>
					<Separator />
				</section>

				<section aria-labelledby={`${baseId}-thresholds`} className="space-y-3">
					<h3 id={`${baseId}-thresholds`} className="text-base font-medium">
						<Trans>Only tell me when it adds up</Trans>
					</h3>
					<p className="text-muted-foreground text-sm">
						<Trans>
							Be told only after this many have happened within an hour. 1 means
							every time.
						</Trans>
					</p>
					{THRESHOLD_KINDS_UI.map(({ kind, label }) => {
						const preview = previews?.[kind]
						const perDay = preview?.perDay
						const held = preview?.held
						const belowThreshold = preview?.belowThreshold
						const days = preview?.days
						return (
							<div
								key={kind}
								className="grid gap-1"
								data-testid={`threshold-${kind}`}
							>
								<div className="flex flex-wrap items-center gap-3">
									<Label htmlFor={`${baseId}-${kind}`} className="min-w-48">
										{_(label)}
									</Label>
									<Input
										id={`${baseId}-${kind}`}
										type="number"
										min={1}
										max={50}
										className="w-24"
										value={thresholds[kind]}
										onChange={(event) =>
											setThresholds((current) => ({
												...current,
												[kind]: Math.max(
													1,
													Math.min(
														50,
														Math.floor(Number(event.target.value)) || 1,
													),
												),
											}))
										}
										onBlur={() => {
											if (thresholds[kind] !== settings.thresholds[kind]) {
												save({
													intent: 'threshold',
													kind,
													threshold: thresholds[kind],
												})
											}
										}}
									/>
								</div>
								<p
									className="text-muted-foreground text-sm"
									data-testid={`preview-${kind}`}
									aria-live="polite"
								>
									{!preview || preview.occurrences === 0 ? (
										<Trans>
											Nothing in the last 7 days to base this on yet.
										</Trans>
									) : (
										<Trans>
											About {perDay} a day would reach you at once ({held} held
											for quiet hours, {belowThreshold} below your threshold) in
											the last {days} days.
										</Trans>
									)}
								</p>
							</div>
						)
					})}
					<Separator />
				</section>

				<section aria-labelledby={`${baseId}-devices`} className="space-y-2">
					<h3 id={`${baseId}-devices`} className="text-base font-medium">
						<Trans>Your phones</Trans>
					</h3>
					{settings.devices.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>
								No phone is signed in to the Menuza app for alerts yet.
							</Trans>
						</p>
					) : (
						<ul className="divide-border divide-y">
							{settings.devices.map((device) => {
								const lastUsed = formatTime(device.lastSeenAt)
								return (
									<li
										key={device.id}
										className="flex items-center justify-between gap-3 py-2"
									>
										<span className="min-w-0 text-sm">
											<span className="font-medium wrap-anywhere">
												{device.deviceName ?? device.platform}
											</span>
											<span className="text-muted-foreground block text-xs">
												<Trans>Last used {lastUsed}</Trans>
											</span>
										</span>
										<Button
											variant="ghost"
											disabled={saving}
											onClick={() => removeDevice(device.id)}
										>
											<Trans>Remove</Trans>
										</Button>
									</li>
								)
							})}
						</ul>
					)}
					<Separator />
				</section>

				<section aria-labelledby={`${baseId}-log`} className="space-y-2">
					<h3 id={`${baseId}-log`} className="text-base font-medium">
						<Trans>Alert log</Trans>
					</h3>
					<p className="text-muted-foreground text-sm">
						{data?.log.scope === 'organization' ? (
							<Trans>What fired for everyone in this organization.</Trans>
						) : (
							<Trans>What fired for you.</Trans>
						)}
					</p>
					{data?.log.entries.length ? (
						<ul className="divide-border divide-y" data-testid="alert-log">
							{data.log.entries.map((entry) => (
								<li
									key={entry.id}
									className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
								>
									<span className="min-w-0">
										<span className="font-medium">{kindLabel(entry.kind)}</span>
										{entry.to ? (
											<span className="text-muted-foreground">
												{' '}
												· {entry.to}
											</span>
										) : entry.recipient ? (
											<span className="text-muted-foreground">
												{' '}
												· <Trans>chosen recipient</Trans>
											</span>
										) : null}
									</span>
									<span className="flex items-center gap-2">
										<Badge
											variant={
												entry.outcome === 'snoozed' || entry.outcome === 'held'
													? 'outline'
													: 'secondary'
											}
										>
											{OUTCOME_LABELS[entry.outcome]
												? _(OUTCOME_LABELS[entry.outcome]!)
												: entry.outcome}
										</Badge>
										<span className="text-muted-foreground text-xs">
											{formatTime(entry.createdAt)}
										</span>
									</span>
								</li>
							))}
						</ul>
					) : (
						<p className="text-muted-foreground text-sm">
							<Trans>Nothing has fired yet.</Trans>
						</p>
					)}
				</section>
			</CardContent>
		</Card>
	)
}
