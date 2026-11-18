import { type I18n } from '@lingui/core'
import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	dayStrip,
	inferOutages,
	totalOutageMinutes,
	type Interval,
	type Outage,
	type StripCell,
} from '@repo/common/device-health'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import { type OperatorRequest } from './terminal-profiles.tsx'

/** The days and opening hours the loader worked out for a location (#356). */
export type HealthWindow = {
	timeZone: string
	days: Array<{ date: string; startMs: number; endMs: number }>
	open: Interval[] | null
}
export type HealthWindows = Record<string, HealthWindow>

const intervalSchema = z.object({ startMs: z.number(), endMs: z.number() })
const summaryDeviceSchema = z.object({
	id: z.string(),
	locationId: z.string().nullable(),
	revokedAt: z.number().nullable(),
	firstSeenAt: z.number().nullable(),
	presence: z.array(intervalSchema),
})
const summarySchema = z.discriminatedUnion('enabled', [
	z.object({ enabled: z.literal(false) }).passthrough(),
	z.object({
		enabled: z.literal(true),
		now: z.number(),
		devices: z.array(summaryDeviceSchema),
	}),
])
export type HealthSummaryDevice = z.infer<typeof summaryDeviceSchema>

const latestSchema = z.object({
	at: z.number(),
	appVersion: z.string().nullable(),
	browser: z.string().nullable(),
	batteryPct: z.number().nullable(),
	charging: z.boolean().nullable(),
	storageUsedMb: z.number().nullable(),
	storageQuotaMb: z.number().nullable(),
	pendingUploads: z.number().nullable(),
	lastUploadAt: z.number().nullable(),
	printerState: z.string().nullable(),
	drawerOpenedAt: z.number().nullable(),
	drawerShiftId: z.string().nullable(),
})
const detailSchema = z.discriminatedUnion('enabled', [
	z.object({ enabled: z.literal(false) }).passthrough(),
	z.object({
		enabled: z.literal(true),
		now: z.number(),
		firstSeenAt: z.number().nullable(),
		presence: z.array(intervalSchema),
		latest: latestSchema.nullable(),
		lastShiftOpened: z
			.object({ id: z.string(), openedAt: z.number() })
			.nullable(),
	}),
])

/** The week for every terminal, reloaded with the terminal list. */
export function useHealthSummary(
	request: OperatorRequest,
	enabled: boolean,
	/** Bumped by the list each time it reloads. */
	tick: number,
) {
	const [summary, setSummary] = useState<{
		now: number
		devices: Map<string, HealthSummaryDevice>
	} | null>(null)
	useEffect(() => {
		if (!enabled) return
		let cancelled = false
		void (async () => {
			try {
				const body = summarySchema.parse(await request('/health'))
				if (cancelled || !body.enabled) return
				setSummary({
					now: body.now,
					devices: new Map(body.devices.map((d) => [d.id, d])),
				})
			} catch {
				/* connection history is a convenience: the list works without it */
			}
		})()
		return () => {
			cancelled = true
		}
	}, [request, enabled, tick])
	return summary
}

const windowFor = (
	windows: HealthWindows,
	locationId: string | null,
): HealthWindow =>
	(locationId ? windows[locationId] : undefined) ?? windows.none!

function outagesFor(
	device: Pick<HealthSummaryDevice, 'presence' | 'firstSeenAt'>,
	window: HealthWindow,
	now: number,
): Outage[] {
	return inferOutages({
		presence: device.presence,
		openIntervals: window.open,
		fromMs: window.days[0]!.startMs,
		toMs: window.days[window.days.length - 1]!.endMs,
		nowMs: now,
		firstSeenAt: device.firstSeenAt,
	})
}

function durationText(_: I18n['_'], minutes: number) {
	if (minutes < 60) return _(t`${minutes} min`)
	const hours = Math.floor(minutes / 60)
	const rest = minutes % 60
	return rest === 0 ? _(t`${hours} h`) : _(t`${hours} h ${rest} min`)
}

/** On the Terminals list: how long a terminal was offline during opening hours this week. */
export function OfflineThisWeek({
	device,
	summary,
	windows,
}: {
	device: { id: string; locationId: string | null }
	summary: { now: number; devices: Map<string, HealthSummaryDevice> } | null
	windows: HealthWindows
}) {
	const { _ } = useLingui()
	const entry = summary?.devices.get(device.id)
	if (!summary || !entry) return null
	const window = windowFor(windows, device.locationId)
	let text: string
	if (entry.firstSeenAt === null) text = _(t`No history yet`)
	else if (window.open === null)
		text = _(t`Set the opening hours to see offline time`)
	else
		text = durationText(
			_,
			totalOutageMinutes(outagesFor(entry, window, summary.now)),
		)
	return (
		<p className="text-muted-foreground text-sm">
			<Trans>Offline time this week:</Trans>{' '}
			<span className="text-foreground font-medium">{text}</span>
		</p>
	)
}

const CELL_CLASS: Record<StripCell, string> = {
	online: 'bg-primary',
	offline: 'bg-destructive',
	unknown: 'bg-muted-foreground/30',
	closed: 'bg-muted',
	future: 'bg-transparent',
}

function Strip({ cells, label }: { cells: StripCell[]; label: string }) {
	return (
		<div
			role="img"
			aria-label={label}
			className="border-border flex h-4 min-w-0 flex-1 overflow-hidden rounded-sm border"
			dir="ltr"
		>
			{cells.map((cell, index) => (
				<span key={index} className={cn('h-full flex-1', CELL_CLASS[cell])} />
			))}
		</div>
	)
}

function PrinterState({ state }: { state: string }) {
	switch (state) {
		case 'ok':
			return <Trans>Connected</Trans>
		case 'out_of_paper':
			return <Trans>Out of paper</Trans>
		case 'cover_open':
			return <Trans>Cover open</Trans>
		case 'offline':
			return <Trans>Offline</Trans>
		default:
			return <Trans>Error</Trans>
	}
}

/**
 * Settings, Terminals, a terminal: the last seven days of connection as a strip
 * per day, the outages during opening hours, and what the tablet reported
 * about itself. The printer and the cash drawer appear only when the till
 * reported them: a browser cannot read either, so today they stay out.
 */
export function TerminalHealthPanel({
	device,
	windows,
	request,
}: {
	device: { id: string; label: string; locationId: string | null }
	windows: HealthWindows
	request: OperatorRequest
}) {
	const { _ } = useLingui()
	const [open, setOpen] = useState(false)
	const [state, setState] = useState<
		| { status: 'idle' }
		| { status: 'error' }
		| { status: 'ready'; data: z.infer<typeof detailSchema> }
	>({ status: 'idle' })
	const load = useCallback(async () => {
		try {
			const data = detailSchema.parse(
				await request(`/health/${encodeURIComponent(device.id)}`),
			)
			setState({ status: 'ready', data })
		} catch {
			setState({ status: 'error' })
		}
	}, [request, device.id])
	useEffect(() => {
		if (!open) return
		void load()
		const timer = setInterval(() => void load(), 60_000)
		return () => clearInterval(timer)
	}, [open, load])
	const window = windowFor(windows, device.locationId)
	const label = device.label

	return (
		<div className="border-border w-full min-w-0 border-t pt-4">
			<Button
				variant="ghost"
				className="h-11 md:h-8"
				aria-expanded={open}
				aria-label={_(t`Health of ${label}`)}
				onClick={() => setOpen((v) => !v)}
			>
				<Trans>Health</Trans>
			</Button>
			{open ? (
				<div className="mt-3 flex min-w-0 flex-col gap-4">
					{state.status === 'error' ? (
						<p role="alert" className="text-destructive text-sm">
							<Trans>Could not load this terminal's health.</Trans>
						</p>
					) : null}
					{state.status === 'ready' && state.data.enabled ? (
						<HealthBody
							data={state.data}
							window={window}
							timeZone={window.timeZone}
						/>
					) : null}
				</div>
			) : null}
		</div>
	)
}

function HealthBody({
	data,
	window,
	timeZone,
}: {
	data: Extract<z.infer<typeof detailSchema>, { enabled: true }>
	window: HealthWindow
	timeZone: string
}) {
	const { _ } = useLingui()
	const outages = useMemo(
		() =>
			outagesFor(
				{ presence: data.presence, firstSeenAt: data.firstSeenAt },
				window,
				data.now,
			),
		[data, window],
	)
	const time = new Intl.DateTimeFormat(undefined, {
		timeZone,
		hour: '2-digit',
		minute: '2-digit',
	})
	const when = new Intl.DateTimeFormat(undefined, {
		timeZone,
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit',
	})
	const dayName = new Intl.DateTimeFormat(undefined, {
		timeZone,
		weekday: 'short',
		day: 'numeric',
		month: 'short',
	})
	const latest = data.latest
	const rows: Array<[string, React.ReactNode]> = []
	if (latest) {
		rows.push([_(t`Last check-in`), when.format(latest.at)])
		if (latest.appVersion) rows.push([_(t`App version`), latest.appVersion])
		if (latest.browser) rows.push([_(t`Browser`), latest.browser])
		if (latest.batteryPct !== null) {
			const pct = latest.batteryPct
			rows.push([
				_(t`Battery`),
				latest.charging ? _(t`${pct}%, charging`) : `${pct}%`,
			])
		}
		if (latest.storageUsedMb !== null && latest.storageQuotaMb !== null) {
			const used = latest.storageUsedMb
			const quota = latest.storageQuotaMb
			rows.push([_(t`Storage`), _(t`${used} MB of ${quota} MB`)])
		}
		if (latest.lastUploadAt !== null)
			rows.push([_(t`Last uploaded orders`), when.format(latest.lastUploadAt)])
		if (latest.pendingUploads !== null)
			rows.push([_(t`Waiting to upload`), String(latest.pendingUploads)])
		// Only what the till really reported.
		if (latest.printerState)
			rows.push([
				_(t`Receipt printer`),
				<PrinterState key="p" state={latest.printerState} />,
			])
		if (latest.drawerOpenedAt !== null)
			rows.push([
				_(t`Cash drawer last opened`),
				when.format(latest.drawerOpenedAt),
			])
	}
	if (data.lastShiftOpened)
		rows.push([
			_(t`Last cash drawer shift opened`),
			when.format(data.lastShiftOpened.openedAt),
		])

	return (
		<>
			<section aria-label={_(t`Connection over the last 7 days`)}>
				<h4 className="text-sm font-medium">
					<Trans>Connection over the last 7 days</Trans>
				</h4>
				{data.firstSeenAt === null ? (
					<p className="text-muted-foreground mt-1 text-sm">
						<Trans>
							No history yet. It builds up once this terminal has checked in.
						</Trans>
					</p>
				) : (
					<>
						<ul className="mt-2 flex flex-col gap-1.5">
							{window.days.map((day) => {
								const cells = dayStrip({
									dayStartMs: day.startMs,
									dayEndMs: day.endMs,
									presence: data.presence,
									openIntervals: window.open,
									outages: outages.filter(
										(o) => o.endMs > day.startMs && o.startMs < day.endMs,
									),
									nowMs: data.now,
									firstSeenAt: data.firstSeenAt,
								})
								const name = dayName.format(day.startMs)
								const count = outages.filter(
									(o) => o.endMs > day.startMs && o.startMs < day.endMs,
								).length
								const summary =
									count > 0
										? _(t`${name}: ${count} outages`)
										: cells.every((c) => c === 'unknown')
											? _(t`${name}: no data`)
											: _(t`${name}: online`)
								return (
									<li key={day.date} className="flex items-center gap-3">
										<span className="text-muted-foreground w-24 shrink-0 text-xs">
											{name}
										</span>
										<Strip cells={cells} label={summary} />
									</li>
								)
							})}
						</ul>
						<p className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
							<Legend tone="online" label={_(t`Online`)} />
							<Legend tone="offline" label={_(t`Offline`)} />
							<Legend tone="unknown" label={_(t`Unknown`)} />
							<Legend tone="closed" label={_(t`Closed`)} />
						</p>
						{window.open === null ? (
							<p className="text-muted-foreground mt-2 text-sm">
								<Trans>
									This terminal's location has no opening hours (or it has no
									location), so no outage is reported. Set the opening hours to
									see them.
								</Trans>
							</p>
						) : null}
					</>
				)}
			</section>
			{window.open !== null && data.firstSeenAt !== null ? (
				<section aria-label={_(t`Outages`)}>
					<h4 className="text-sm font-medium">
						<Trans>Outages during opening hours</Trans>
					</h4>
					{outages.length === 0 ? (
						<p className="text-muted-foreground mt-1 text-sm">
							<Trans>None this week.</Trans>
						</p>
					) : (
						<ul className="mt-1 flex flex-col gap-1 text-sm">
							{[...outages].reverse().map((o) => {
								const from = when.format(o.startMs)
								const to = time.format(o.endMs)
								const length = durationText(_, o.minutes)
								return (
									<li key={o.startMs}>
										{o.ongoing ? (
											<Trans>
												Offline since {from} ({length} and counting)
											</Trans>
										) : (
											<Trans>
												Offline {from} to {to}, {length}
											</Trans>
										)}
									</li>
								)
							})}
						</ul>
					)}
				</section>
			) : null}
			{rows.length > 0 ? (
				<dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
					{rows.map(([name, value]) => (
						<div key={name} className="flex min-w-0 justify-between gap-3">
							<dt className="text-muted-foreground">{name}</dt>
							<dd className="min-w-0 text-end wrap-anywhere">{value}</dd>
						</div>
					))}
				</dl>
			) : null}
			<p className="text-muted-foreground text-xs">
				<Trans>
					The receipt printer and cash drawer appear here only when the terminal
					reports them. A browser cannot read either today. Heartbeats carry no
					staff names or order contents.
				</Trans>
			</p>
		</>
	)
}

function Legend({ tone, label }: { tone: StripCell; label: string }) {
	return (
		<span className="inline-flex items-center gap-1.5">
			<span
				aria-hidden
				className={cn('size-2.5 rounded-sm border', CELL_CLASS[tone])}
			/>
			{label}
		</span>
	)
}
