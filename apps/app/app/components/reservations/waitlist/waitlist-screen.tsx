import { Trans } from '@lingui/react/macro'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { WorkspaceMetric, WorkspaceMetricGrid } from '@repo/ui/workspace'
import { useCallback, useState } from 'react'
import { EmptyState } from '#app/components/empty-state.tsx'
import { ReservationsHeaderActions } from '#app/components/reservations/shell-context.tsx'
import { AddPartyDialog } from '#app/components/reservations/waitlist/add-party-dialog.tsx'
import { EditPartyDialog } from '#app/components/reservations/waitlist/edit-party-dialog.tsx'
import { SeatDialog } from '#app/components/reservations/waitlist/seat-dialog.tsx'
import { useWaitlistVenue } from '#app/components/reservations/waitlist/use-waitlist-venue.ts'
import { useWaitlist } from '#app/components/reservations/waitlist/use-waitlist.ts'
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
		<div className="flex flex-col gap-6" data-testid="waitlist-screen">
			<ReservationsHeaderActions>
				<Button
					type="button"
					variant="outline"
					onClick={() => void waitlist.refresh()}
					disabled={waitlist.refreshing}
					data-testid="waitlist-refresh"
				>
					<Icon name="refresh-cw" />
					<Trans>Refresh</Trans>
				</Button>
				{canManage ? (
					<Button
						type="button"
						onClick={() => setAddOpen(true)}
						data-testid="waitlist-add-button"
					>
						<Icon name="user-plus" />
						<Trans>Add party</Trans>
					</Button>
				) : null}
			</ReservationsHeaderActions>

			<div role="status" aria-live="polite" className="sr-only">
				{waitlist.announcement}
			</div>

			{listing ? (
				<div data-testid="waitlist-summary">
					<WorkspaceMetricGrid className="sm:grid-cols-3 xl:grid-cols-3">
						<WorkspaceMetric
							label={<Trans>In line</Trans>}
							value={
								<span data-testid="waitlist-count-active">{activeCount}</span>
							}
						/>
						<WorkspaceMetric
							label={<Trans>Notified</Trans>}
							tone={notifiedCount > 0 ? 'warning' : 'default'}
							value={
								<span data-testid="waitlist-count-notified">
									{notifiedCount}
								</span>
							}
							hint={
								<Trans>
									Guests have {responseWindow} to answer a table-ready message.
								</Trans>
							}
						/>
						<WorkspaceMetric
							label={<Trans>On the way</Trans>}
							value={
								<span data-testid="waitlist-count-on-the-way">
									{onTheWayCount}
								</span>
							}
						/>
					</WorkspaceMetricGrid>
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
					<AlertDescription>
						<div className="flex items-center justify-between gap-2">
							<span>{waitlist.actionError}</span>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={waitlist.clearActionError}
							>
								<Trans>Dismiss</Trans>
							</Button>
						</div>
					</AlertDescription>
				</Alert>
			) : null}

			{!locationId ? (
				<div data-testid="waitlist-no-location">
					<EmptyState
						icons={['building', 'users', 'clock']}
						title={<Trans>Pick a location</Trans>}
						description={<Trans>Choose a location to see its waitlist.</Trans>}
					/>
				</div>
			) : !listing && waitlist.loading ? (
				<Frame data-testid="waitlist-loading" aria-busy="true">
					<div className="divide-border flex flex-col divide-y">
						{[0, 1, 2].map((row) => (
							<div key={row} className="flex items-center gap-4 px-3 py-3">
								<div className="flex flex-1 flex-col gap-2">
									<Skeleton className="h-4 w-40" />
									<Skeleton className="h-3 w-56" />
								</div>
								<Skeleton className="h-8 w-16" />
							</div>
						))}
					</div>
				</Frame>
			) : !listing ? (
				<Alert variant="destructive" data-testid="waitlist-load-error">
					<AlertDescription>
						<div className="flex items-center justify-between gap-2">
							<span>{waitlist.loadError}</span>
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() => void waitlist.refresh()}
							>
								<Trans>Retry</Trans>
							</Button>
						</div>
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
						onAdd={canManage ? () => setAddOpen(true) : undefined}
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
