import { Trans, useLingui } from '@lingui/react/macro'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from '@repo/ui/empty'
import { Tabs, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { useState } from 'react'
import { ChannelBadge } from '#app/components/reservations/channel-badge.tsx'
import { TextField } from '#app/components/staff/controls.tsx'
import { type DayReservationView } from '#app/utils/reservations/book-api.ts'
import { type DecidedRequest } from '#app/utils/reservations/requests.ts'

export type ReservationsViewTab = 'reservations' | 'requests'

export function RequestsTabs({
	value,
	onValueChange,
	pendingCount,
}: {
	value: ReservationsViewTab
	onValueChange: (value: ReservationsViewTab) => void
	pendingCount: number
}) {
	return (
		<Tabs
			value={value}
			onValueChange={(next) => onValueChange(next as ReservationsViewTab)}
		>
			<TabsList data-testid="reservations-view-tabs">
				<TabsTrigger value="reservations" data-testid="tab-reservations">
					<Trans>Reservations</Trans>
				</TabsTrigger>
				<TabsTrigger value="requests" data-testid="tab-requests">
					<Trans>Requests</Trans>
					<Badge
						variant={pendingCount > 0 ? 'warning' : 'secondary'}
						data-testid="requests-pending-count"
					>
						{pendingCount}
					</Badge>
				</TabsTrigger>
			</TabsList>
		</Tabs>
	)
}

export function RequestsPanel({
	requests,
	decided,
	canManage,
	busyId,
	onApprove,
	onDecline,
	onOpenDetail,
}: {
	requests: readonly DayReservationView[]
	decided: readonly DecidedRequest[]
	canManage: boolean
	busyId: string | null
	onApprove: (request: DayReservationView) => Promise<boolean>
	onDecline: (request: DayReservationView, reason?: string) => Promise<boolean>
	onOpenDetail: (id: string) => void
}) {
	const { t } = useLingui()
	const [decliningId, setDecliningId] = useState<string | null>(null)
	const [reason, setReason] = useState('')

	const closeDecline = () => {
		setDecliningId(null)
		setReason('')
	}

	return (
		<Card data-testid="requests-panel">
			<CardHeader className="pb-2">
				<CardTitle className="flex items-center justify-between text-base">
					<span>
						<Trans>Large-party requests</Trans>
					</span>
					<Badge variant="secondary">{requests.length}</Badge>
				</CardTitle>
				<p className="text-muted-foreground text-sm text-pretty">
					<Trans>
						Guests asked for these parties on your website. Approve a request to
						confirm the booking.
					</Trans>
				</p>
			</CardHeader>
			<CardContent className="flex flex-col gap-2.5">
				{requests.length === 0 ? (
					<div
						className="rounded-lg border border-dashed"
						data-testid="requests-empty"
					>
						<Empty>
							<EmptyHeader>
								<EmptyTitle>
									<Trans>No requests are waiting for a decision.</Trans>
								</EmptyTitle>
								<EmptyDescription>
									<Trans>
										Large-party requests from your website appear here for you
										to approve or decline.
									</Trans>
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					</div>
				) : (
					requests.map((request) => {
						const note = request.guestNotes ?? request.internalNotes
						const busy = busyId === request.id
						return (
							<div
								key={request.id}
								className="bg-background flex flex-col gap-2 rounded-lg border p-3 text-sm"
								data-testid={`request-row-${request.id}`}
							>
								<div className="flex flex-wrap items-start justify-between gap-2">
									<Button
										type="button"
										variant="link"
										onClick={() => onOpenDetail(request.id)}
										className="h-auto min-h-11 justify-start p-0 text-start font-medium wrap-anywhere whitespace-normal md:min-h-0"
									>
										{request.hhmm} • {request.guestName} ({request.partySize})
									</Button>
									<div className="flex flex-wrap items-center gap-1">
										<ChannelBadge channel={request.channel} />
										<Badge variant="outline" className="font-mono">
											#{request.confirmationCode}
										</Badge>
									</div>
								</div>
								<div className="text-muted-foreground tabular-nums">
									{request.guestPhone || '—'}
								</div>
								{note ? (
									<div
										className="text-muted-foreground wrap-anywhere"
										data-testid={`request-note-${request.id}`}
									>
										{note}
									</div>
								) : null}

								{canManage && decliningId === request.id ? (
									<form
										className="flex flex-col gap-2 pt-1"
										onSubmit={(event) => {
											event.preventDefault()
											void onDecline(request, reason).then((ok) => {
												if (ok) closeDecline()
											})
										}}
									>
										<TextField
											label={<Trans>Reason (optional)</Trans>}
											id={`request-decline-reason-${request.id}`}
											value={reason}
											maxLength={500}
											onChange={(event) => setReason(event.target.value)}
											placeholder={t`Why are you declining?`}
											data-testid={`request-decline-reason-${request.id}`}
										/>
										<div className="flex items-center gap-2">
											<Button
												type="submit"
												className="h-11 md:h-8"
												variant="destructive"
												disabled={busy}
												data-testid={`request-decline-confirm-${request.id}`}
											>
												<Trans>Decline request</Trans>
											</Button>
											<Button
												type="button"
												className="h-11 md:h-8"
												variant="ghost"
												disabled={busy}
												onClick={closeDecline}
											>
												<Trans>Cancel</Trans>
											</Button>
										</div>
									</form>
								) : canManage ? (
									<div className="flex flex-wrap items-center gap-2 pt-1">
										<Button
											type="button"
											className="h-11 md:h-8"
											disabled={busy}
											onClick={() => void onApprove(request)}
											data-testid={`request-approve-${request.id}`}
										>
											<Trans>Approve</Trans>
										</Button>
										<Button
											type="button"
											className="h-11 md:h-8"
											variant="outline"
											disabled={busy}
											onClick={() => {
												setReason('')
												setDecliningId(request.id)
											}}
											data-testid={`request-decline-${request.id}`}
										>
											<Trans>Decline</Trans>
										</Button>
									</div>
								) : null}
							</div>
						)
					})
				)}

				{decided.length > 0 ? (
					<div
						className="flex flex-col gap-1.5 border-t pt-3"
						data-testid="requests-decided"
					>
						<div className="text-muted-foreground text-xs">
							<Trans>Decided in this session</Trans>
						</div>
						{decided.map((item) => (
							<div
								key={item.id}
								className="bg-muted/30 flex items-center justify-between gap-2 rounded-lg border p-2.5 text-sm"
								data-testid={`request-decided-${item.id}`}
							>
								<span className="wrap-anywhere">
									{item.hhmm} • {item.guestName} ({item.partySize})
								</span>
								<Badge
									variant={
										item.outcome === 'approved' ? 'success' : 'destructive'
									}
								>
									{item.outcome === 'approved' ? (
										<Trans>Approved</Trans>
									) : (
										<Trans>Declined</Trans>
									)}
								</Badge>
							</div>
						))}
					</div>
				) : null}
			</CardContent>
		</Card>
	)
}
