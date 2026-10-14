import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Item, ItemGroup } from '@repo/ui/item'
import { Spinner } from '@repo/ui/spinner'
import { useEffect, useState } from 'react'
import { type SyncIndicator } from '#app/hooks/use-kiosk-runtime.ts'
import { type KioskLocale } from '#app/utils/kiosk/kiosk-device.ts'
import { describeKioskError } from '#app/utils/kiosk/kiosk-messages.ts'
import { type QueuedPunch } from '#app/utils/kiosk/kiosk-queue.ts'

/**
 * The big clock. It has its own tick so the rest of the screen does not
 * re-render every second. Time is shown in the scope's zone (the tablet's
 * own zone is often wrong), corrected by how far the server's clock is ahead.
 */
export function KioskClock({
	timeZone,
	serverOffset,
}: {
	timeZone: string | null
	serverOffset: number
}) {
	const { i18n } = useLingui()
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(timer)
	}, [])
	const at = now + serverOffset
	const zone = timeZone ?? undefined
	let time: string
	let date: string
	try {
		time = new Intl.DateTimeFormat(i18n.locale, {
			hour: 'numeric',
			minute: '2-digit',
			timeZone: zone,
		}).format(at)
		date = new Intl.DateTimeFormat(i18n.locale, {
			weekday: 'long',
			month: 'long',
			day: 'numeric',
			timeZone: zone,
		}).format(at)
	} catch {
		time = new Intl.DateTimeFormat(i18n.locale, {
			hour: 'numeric',
			minute: '2-digit',
		}).format(at)
		date = new Intl.DateTimeFormat(i18n.locale, {
			weekday: 'long',
			month: 'long',
			day: 'numeric',
		}).format(at)
	}
	return (
		<div className="flex flex-col gap-1">
			<p
				className="text-6xl font-semibold tracking-tight tabular-nums md:text-8xl"
				// A ticking clock must not be announced every minute.
				aria-hidden="true"
			>
				{time}
			</p>
			<p className="text-muted-foreground text-lg md:text-2xl">{date}</p>
			<span className="sr-only">
				<Trans>
					Current time {time}, {date}
				</Trans>
			</span>
		</div>
	)
}

/** Plain-language connection state: always visible, never alarming. */
export function ConnectionPill({
	online,
	queued,
	failed,
	indicator,
	onShowFailed,
}: {
	online: boolean
	queued: number
	failed: number
	indicator: SyncIndicator
	onShowFailed: () => void
}) {
	// Subscribes to language changes: the labels below use the global catalog.
	useLingui()
	let icon: 'signal-high' | 'signal-low' | 'refresh-cw' | 'check-circle' =
		'signal-high'
	let label: string
	let tone: 'ok' | 'warn' = 'ok'
	if (!online) {
		icon = 'signal-low'
		tone = 'warn'
		label =
			queued > 0
				? plural(queued, {
						one: 'Offline · # punch saved',
						other: 'Offline · # punches saved',
					})
				: t`Offline`
	} else if (indicator === 'syncing' || queued > 0) {
		icon = 'refresh-cw'
		label = plural(queued, {
			one: 'Sending # saved punch',
			other: 'Sending # saved punches',
		})
	} else if (indicator === 'synced') {
		icon = 'check-circle'
		label = t`All saved`
	} else {
		label = t`Online`
	}
	return (
		<div className="flex items-center gap-2">
			<Badge
				role="status"
				variant={tone === 'warn' ? 'secondary' : 'ghost'}
				className="text-sm"
			>
				{icon === 'refresh-cw' ? (
					<Spinner role="presentation" aria-hidden="true" />
				) : (
					<Icon name={icon} />
				)}
				{label}
			</Badge>
			{failed > 0 ? (
				<Button
					type="button"
					variant="destructive"
					className="h-11"
					onClick={onShowFailed}
				>
					<Icon name="alert-triangle" />
					{plural(failed, {
						one: '# punch needs a manager',
						other: '# punches need a manager',
					})}
				</Button>
			) : null}
		</div>
	)
}

export function LanguageToggle({
	locale,
	onChange,
}: {
	locale: KioskLocale
	onChange: (locale: KioskLocale) => void
}) {
	// The button names the OTHER language, in that language.
	const next: KioskLocale = locale === 'ar' ? 'en' : 'ar'
	return (
		<Button
			type="button"
			variant="outline"
			lang={next}
			className="h-11 touch-manipulation"
			onClick={() => onChange(next)}
		>
			<Icon name="languages" />
			{next === 'ar' ? 'العربية' : 'English'}
		</Button>
	)
}

/** Punches the server refused after they were saved offline: a manager must add them. */
export function FailedPunchesDialog({
	open,
	items,
	timeZone,
	onClose,
	onClear,
}: {
	open: boolean
	items: readonly QueuedPunch[]
	timeZone: string | null
	onClose: () => void
	onClear: () => void
}) {
	const { _, i18n } = useLingui()
	const kindLabel: Record<QueuedPunch['kind'], string> = {
		clock_in: _(t`Clock in`),
		break_start: _(t`Start break`),
		break_end: _(t`End break`),
		clock_out: _(t`Clock out`),
	}
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose()
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						<Trans>Punches a manager needs to add</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							These were saved while the tablet was offline, but the time clock
							could not accept them. They were not recorded.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<ItemGroup>
					{items.map((item) => {
						let when: string
						try {
							when = new Intl.DateTimeFormat(i18n.locale, {
								weekday: 'short',
								hour: 'numeric',
								minute: '2-digit',
								timeZone: timeZone ?? undefined,
							}).format(item.clientAt)
						} catch {
							when = new Date(item.clientAt).toLocaleString(i18n.locale)
						}
						return (
							<Item key={item.id} variant="outline" render={<li />}>
								<div className="flex w-full flex-col gap-1 text-sm">
									<span className="font-medium">
										{kindLabel[item.kind]} · {when}
									</span>
									<span className="text-muted-foreground">
										{_(describeKioskError(item.failure ?? '').message)}
									</span>
								</div>
							</Item>
						)
					})}
				</ItemGroup>
				<DialogFooter>
					<Button variant="outline" className="h-11" onClick={onClear}>
						<Trans>A manager has noted these</Trans>
					</Button>
					<Button className="h-11" onClick={onClose}>
						<Trans>Close</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
