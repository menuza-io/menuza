import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { type Connection } from './connection.ts'

/**
 * A strip across the book while it cannot be trusted: the tablet is offline, or
 * the last look at the day failed. It says when the book was last read, and
 * that seating, booking and texts wait for the connection: the small "not up
 * to date" mark in the header is easy to miss from across the stand.
 */
export function OfflineStrip({
	connection,
	formatTime,
}: {
	connection: Connection
	formatTime: (epochMs: number) => string
}) {
	const { _ } = useLingui()
	if (connection.kind === 'ok') return null
	const when = connection.readAt !== null ? formatTime(connection.readAt) : null
	const text =
		connection.kind === 'offline'
			? when
				? _(
						msg`Offline: book as of ${when}. Seating, booking and texts wait for the connection.`,
					)
				: _(
						msg`Offline: this book may be out of date. Seating, booking and texts wait for the connection.`,
					)
			: connection.blocksWrites
				? when
					? _(
							msg`Not connected: book as of ${when}. Seating, booking and texts wait for the connection. Trying again.`,
						)
					: _(
							msg`Not connected: this book may be out of date. Seating, booking and texts wait for the connection. Trying again.`,
						)
				: when
					? _(
							msg`The waitlist is not up to date (as of ${when}). Trying again.`,
						)
					: _(msg`The waitlist is not up to date. Trying again.`)
	return (
		<div
			role="status"
			className="bk-strip text-foreground flex shrink-0 items-start gap-2.5 px-4 py-2 font-medium"
			data-kind={connection.kind}
		>
			<Icon name="cloud-off" aria-hidden className="mt-0.5 size-4 shrink-0" />
			<p className="min-w-0">{text}</p>
		</div>
	)
}

/** The reason a sheet's actions are unavailable, at the top of its footer. */
export function OfflineNote({ reason }: { reason: string | null | undefined }) {
	if (!reason) return null
	return (
		<p
			role="note"
			className="text-warning flex items-center gap-2 text-sm font-medium"
		>
			<Icon name="cloud-off" aria-hidden className="size-4 shrink-0" />
			{reason}
		</p>
	)
}
