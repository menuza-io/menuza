import { Trans, useLingui } from '@lingui/react/macro'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { useState } from 'react'
import { ChannelBadge } from '#app/components/reservations/channel-badge.tsx'
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
				<p className="text-muted-foreground text-xs">
					<Trans>
						Guests asked for these parties on your website. Approve a request to
						confirm the booking.
					</Trans>
				</p>
			</CardHeader>
			<CardContent className="flex flex-col gap-2.5">
				{requests.length === 0 ? (
					<div
						className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-xs"
						data-testid="requests-empty"
					>
						<Trans>No requests are waiting for a decision.</Trans>
					</div>
				) : (
					requests.map((request) => {
						const note = request.guestNotes ?? request.internalNotes
						const busy = busyId === request.id
						return (
							<div
								key={request.id}
								className="bg-background flex flex-col gap-2 rounded-lg border p-3 text-xs"
								data-testid={`request-row-${request.id}`}
							>
								<div className="flex flex-wrap items-start justify-between gap-2">
									<button
										type="button"
										onClick={() => onOpenDetail(request.id)}
										className="text-start font-semibold wrap-anywhere hover:underline"
									>
										{request.hhmm} • {request.guestName} ({request.partySize})
									</button>
									<div className="flex flex-wrap items-center gap-1">
										<ChannelBadge channel={request.channel} />
										<Badge variant="outline" className="font-mono">
											#{request.confirmationCode}
										</Badge>
									</div>
								</div>
								<div className="text-muted-foreground">
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
										<Label
											htmlFor={`request-decline-reason-${request.id}`}
											className="text-xs"
										>
											<Trans>Reason (optional)</Trans>
										</Label>
										<Input
											id={`request-decline-reason-${request.id}`}
											value={reason}
											maxLength={500}
											onChange={(event) => setReason(event.target.value)}
											placeholder={t`Why are you declining?`}
											className="h-8 text-xs"
											data-testid={`request-decline-reason-${request.id}`}
										/>
										<div className="flex items-center gap-1.5">
											<Button
												type="submit"
												size="xs"
												variant="destructive"
												disabled={busy}
												data-testid={`request-decline-confirm-${request.id}`}
											>
												<Trans>Decline request</Trans>
											</Button>
											<Button
												type="button"
												size="xs"
												variant="ghost"
												disabled={busy}
												onClick={closeDecline}
											>
												<Trans>Cancel</Trans>
											</Button>
										</div>
									</form>
								) : canManage ? (
									<div className="flex flex-wrap items-center gap-1.5 pt-1">
										<Button
											type="button"
											size="xs"
											disabled={busy}
											onClick={() => void onApprove(request)}
											data-testid={`request-approve-${request.id}`}
										>
											<Trans>Approve</Trans>
										</Button>
										<Button
											type="button"
											size="xs"
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
						<div className="text-muted-foreground text-xs font-medium">
							<Trans>Decided in this session</Trans>
						</div>
						{decided.map((item) => (
							<div
								key={item.id}
								className="bg-muted/20 flex items-center justify-between gap-2 rounded-lg border p-2.5 text-xs"
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
