import { type I18n } from '@lingui/core'
import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { useEffect, useState } from 'react'
import { staffingErrorMessage } from '#app/components/staffing/staffing-errors.ts'
import {
	type EntryHistory,
	type EntrySnapshot,
	entryHistorySchema,
	formatZonedDateTime,
	type TimeEntry,
} from '#app/utils/staffing/client.ts'

type Request = <T>(path: string, init?: RequestInit) => Promise<T>

function eventLabel(i18n: I18n, kind: string) {
	switch (kind) {
		case 'clock_in':
			return i18n._(msg`Clocked in`)
		case 'clock_out':
			return i18n._(msg`Clocked out`)
		case 'manual_create':
			return i18n._(msg`Added by a manager`)
		case 'edit':
			return i18n._(msg`Edited`)
		case 'delete':
			return i18n._(msg`Deleted`)
		case 'approve':
			return i18n._(msg`Approved`)
		case 'reopen':
			return i18n._(msg`Reopened`)
		default:
			return kind
	}
}

function snapshotLines(
	i18n: I18n,
	snapshot: EntrySnapshot | null,
	timeZone: string,
	positionName: (id: string | null) => string,
) {
	if (!snapshot) return []
	const lines: string[] = []
	if (snapshot.clockInAt) {
		const at = formatZonedDateTime(i18n.locale, snapshot.clockInAt, timeZone)
		lines.push(i18n._(msg`In ${at}`))
	}
	if (snapshot.clockOutAt !== undefined) {
		const at = snapshot.clockOutAt
			? formatZonedDateTime(i18n.locale, snapshot.clockOutAt, timeZone)
			: i18n._(msg`still clocked in`)
		lines.push(i18n._(msg`Out ${at}`))
	}
	if (snapshot.unpaidBreakMinutes !== undefined) {
		const minutes = snapshot.unpaidBreakMinutes
		lines.push(i18n._(msg`Break ${minutes} min`))
	}
	if (snapshot.positionId !== undefined) {
		const name = positionName(snapshot.positionId)
		lines.push(i18n._(msg`Position ${name}`))
	}
	if (snapshot.note) {
		const note = snapshot.note
		lines.push(i18n._(msg`Note: ${note}`))
	}
	return lines
}

export function EntryHistoryDialog({
	entry,
	onOpenChange,
	request,
	memberNames,
	positionName,
	personName,
}: {
	entry: TimeEntry | null
	onOpenChange: (open: boolean) => void
	request: Request
	memberNames: Record<string, string>
	positionName: (id: string | null) => string
	personName: string
}) {
	const { _, i18n } = useLingui()
	const [history, setHistory] = useState<EntryHistory | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		if (!entry) return
		const controller = new AbortController()
		setHistory(null)
		setError(null)
		request<{ history: unknown }>(
			`/time-entries/${encodeURIComponent(entry.id)}/history`,
			{ signal: controller.signal },
		)
			.then((body) => {
				if (!controller.signal.aborted)
					setHistory(entryHistorySchema.parse(body).history)
			})
			.catch((caught: unknown) => {
				if (!controller.signal.aborted)
					setError(staffingErrorMessage(i18n, caught))
			})
		return () => controller.abort()
	}, [entry, request, i18n])

	if (!entry) return null
	const actorName = (event: EntryHistory['events'][number]) =>
		event.actorType === 'kiosk'
			? (history?.devices[event.actorRef] ?? _(msg`A removed kiosk`))
			: (memberNames[event.actorRef] ?? _(msg`A former member`))

	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						<Trans>Time card history</Trans>
					</DialogTitle>
					<DialogDescription>{personName}</DialogDescription>
				</DialogHeader>
				{error ? (
					<p role="alert" className="text-destructive text-sm">
						{error}
					</p>
				) : !history ? (
					<p role="status" className="text-sm">
						<Trans>Loading history…</Trans>
					</p>
				) : (
					<ol className="divide-border max-h-96 divide-y overflow-y-auto text-sm">
						{history.events.map((event) => {
							const before = snapshotLines(
								i18n,
								event.before,
								entry.timeZone,
								positionName,
							)
							const after = snapshotLines(
								i18n,
								event.after,
								entry.timeZone,
								positionName,
							)
							const reason = event.reason
							return (
								<li key={event.id} className="space-y-1 py-2">
									<div className="flex flex-wrap justify-between gap-2">
										<span className="font-medium">
											{eventLabel(i18n, event.kind)}
										</span>
										<span className="text-muted-foreground">
											{i18n.date(new Date(event.at), {
												dateStyle: 'medium',
												timeStyle: 'short',
											})}
										</span>
									</div>
									<p className="text-muted-foreground">{actorName(event)}</p>
									{reason ? (
										<p>
											<Trans>Reason: {reason}</Trans>
										</p>
									) : null}
									{before.length > 0 && event.kind === 'edit' ? (
										<p className="text-muted-foreground line-through">
											{before.join(' · ')}
										</p>
									) : null}
									{after.length > 0 ? <p>{after.join(' · ')}</p> : null}
								</li>
							)
						})}
					</ol>
				)}
			</DialogContent>
		</Dialog>
	)
}
