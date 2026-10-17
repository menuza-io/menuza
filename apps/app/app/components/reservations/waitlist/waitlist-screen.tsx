import { Trans } from '@lingui/react/macro'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import { useCallback, useState } from 'react'
import { AddPartyDialog } from '#app/components/reservations/waitlist/add-party-dialog.tsx'
import { EditPartyDialog } from '#app/components/reservations/waitlist/edit-party-dialog.tsx'
import { SeatDialog } from '#app/components/reservations/waitlist/seat-dialog.tsx'
import { useWaitlist } from '#app/components/reservations/waitlist/use-waitlist.ts'
import { useWaitlistVenue } from '#app/components/reservations/waitlist/use-waitlist-venue.ts'
import { useFormatMinutes } from '#app/components/reservations/waitlist/waitlist-clock.tsx'
import { WaitlistQueue } from '#app/components/reservations/waitlist/waitlist-queue.tsx'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'

export function WaitlistScreen({
	client,
	locationId,
	canManage,
}: {
	client: ReservationsScopedClient
	locationId: string
	canManage: boolean
}) {
	const formatMinutes = useFormatMinutes()
	const [addOpen, setAddOpen] = useState(false)
	const [editingId, setEditingId] = useState<string | null>(null)
	const [seatingId, setSeatingId] = useState<string | null>(null)
	const [dragging, setDragging] = useState(false)

	const waitlist = useWaitlist({
		client,
		locationId,
		paused: dragging || addOpen || editingId !== null || seatingId !== null,
	})
	const venue = useWaitlistVenue({
		client,
		locationId,
		enabled: canManage,
	})
	const reloadVenue = venue.reload

	const areaName = useCallback(
		(id: string | null) =>
			id ? (venue.areas.find((area) => area.id === id)?.name ?? null) : null,
		[venue.areas],
	)

	const listing = waitlist.listing
	const editing = waitlist.active
		.concat(waitlist.settled)
		.find((entry) => entry.id === editingId)
	const seating = waitlist.active.find((entry) => entry.id === seatingId)

	const activeCount = listing?.counts.active ?? 0
	const notifiedCount = listing?.counts.notified ?? 0
	const onTheWayCount = listing?.counts.onTheWay ?? 0
	const responseWindow = formatMinutes(listing?.waitlistResponseMin ?? 0)

	return (
		<div className="flex flex-col gap-4" data-testid="waitlist-screen">
			<PageHeader
				title={<Trans>Waitlist</Trans>}
				description={
					<Trans>
						Live walk-in queue, quoted wait times, table-ready notifications,
						and seating.
					</Trans>
				}
				actions={
					<>
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => void waitlist.refresh()}
							disabled={waitlist.refreshing}
							data-testid="waitlist-refresh"
						>
							<Icon name="refresh-cw" className="size-4" />
							<span>
								<Trans>Refresh</Trans>
							</span>
						</Button>
						{canManage ? (
							<Button
								type="button"
								size="sm"
								onClick={() => setAddOpen(true)}
								data-testid="waitlist-add-button"
							>
								<Icon name="user-plus" className="size-4" />
								<span>
									<Trans>Add party</Trans>
								</span>
							</Button>
						) : null}
					</>
				}
			/>

			<div role="status" aria-live="polite" className="sr-only">
				{waitlist.announcement}
			</div>

			{listing ? (
				<div
					className="flex flex-wrap items-center gap-2 text-xs"
					data-testid="waitlist-summary"
				>
					<Badge variant="secondary" data-testid="waitlist-count-active">
						<Trans>In line: {activeCount}</Trans>
					</Badge>
					<Badge variant="warning" data-testid="waitlist-count-notified">
						<Trans>Notified: {notifiedCount}</Trans>
					</Badge>
					<Badge variant="success" data-testid="waitlist-count-on-the-way">
						<Trans>On the way: {onTheWayCount}</Trans>
					</Badge>
					<span className="text-muted-foreground">
						<Trans>
							Guests have {responseWindow} to answer a table-ready message.
						</Trans>
					</span>
				</div>
			) : null}

			{!canManage ? (
				<Alert data-testid="waitlist-read-only">
					<AlertDescription>
						<Trans>
							You can view the waitlist but not change it. Ask a manager for
							permission to edit reservations.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}

			{waitlist.actionError ? (
				<Alert variant="destructive" data-testid="waitlist-action-error">
					<AlertDescription className="flex items-center justify-between gap-2">
						<span>{waitlist.actionError}</span>
						<Button
							type="button"
							size="xs"
							variant="ghost"
							onClick={waitlist.clearActionError}
						>
							<Trans>Dismiss</Trans>
						</Button>
					</AlertDescription>
				</Alert>
			) : null}

			{!locationId ? (
				<div
					className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm"
					data-testid="waitlist-no-location"
				>
					<Trans>Pick a location to see its waitlist.</Trans>
				</div>
			) : !listing && waitlist.loading ? (
				<div
					className="text-muted-foreground p-8 text-center text-sm"
					data-testid="waitlist-loading"
				>
					<Trans>Loading the waitlist...</Trans>
				</div>
			) : !listing ? (
				<Alert variant="destructive" data-testid="waitlist-load-error">
					<AlertDescription className="flex items-center justify-between gap-2">
						<span>{waitlist.loadError}</span>
						<Button
							type="button"
							size="xs"
							variant="outline"
							onClick={() => void waitlist.refresh()}
						>
							<Trans>Retry</Trans>
						</Button>
					</AlertDescription>
				</Alert>
			) : (
				<>
					{waitlist.loadError ? (
						<Alert data-testid="waitlist-stale-warning">
							<AlertDescription>
								<Trans>
									The list could not be refreshed. What you see may be out of
									date.
								</Trans>
							</AlertDescription>
						</Alert>
					) : null}
					<WaitlistQueue
						active={waitlist.active}
						settled={waitlist.settled}
						canManage={canManage}
						busyId={waitlist.busyId}
						reordering={waitlist.reordering}
						clockOffsetMs={waitlist.clockOffsetMs}
						areaName={areaName}
						onDraggingChange={setDragging}
						onNotify={(entry) => void waitlist.notify(entry)}
						onSeat={(entry) => setSeatingId(entry.id)}
						onEdit={(entry) => setEditingId(entry.id)}
						onStatus={(entry, status) => void waitlist.setStatus(entry, status)}
						onReorder={(ids, movedId) => void waitlist.reorder(ids, movedId)}
					/>
				</>
			)}

			<AddPartyDialog
				open={addOpen}
				onOpenChange={setAddOpen}
				client={client}
				locationId={locationId}
				areas={venue.areas}
				onAdd={waitlist.add}
			/>
			<EditPartyDialog
				entry={editing ?? null}
				onClose={() => setEditingId(null)}
				areas={venue.areas}
				onSave={waitlist.update}
			/>
			<SeatDialog
				entry={seating ?? null}
				onClose={() => setSeatingId(null)}
				tableStates={venue.tableStates}
				tablesLoading={venue.loading}
				onOpened={() => void reloadVenue()}
				onSeat={waitlist.seat}
			/>
		</div>
	)
}
