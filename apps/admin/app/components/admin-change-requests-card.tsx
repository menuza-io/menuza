import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { Link } from 'react-router'

export type AdminChangeRequest = {
	id: string
	kindLabel: string
	reasonLabel: string
	subReasonLabel: string | null
	locations: string[]
	effectiveAt: string | null
	status: string
	createdAt: string
}

/**
 * The cancel or downgrade requests of one organization (#379), newest first, on
 * its Admin page. Shown only when there is at least one.
 */
export function AdminChangeRequestsCard({
	requests,
}: {
	requests: AdminChangeRequest[]
}) {
	const { i18n } = useLingui()
	if (requests.length === 0) return null
	const date = (iso: string | null) =>
		iso
			? new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' }).format(
					new Date(iso),
				)
			: '—'
	return (
		<Card data-testid="admin-change-requests-card">
			<CardHeader>
				<CardTitle className="flex items-center justify-between gap-2">
					<Trans>Cancel and downgrade requests</Trans>
					<Link
						to="/subscription-requests?status=all"
						className="text-sm font-normal underline underline-offset-2"
					>
						<Trans>All requests</Trans>
					</Link>
				</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				{requests.map((request) => {
					const effective = date(request.effectiveAt)
					return (
						<div
							key={request.id}
							className="flex flex-wrap items-start justify-between gap-2 border-b pb-3 text-sm last:border-b-0 last:pb-0"
						>
							<div>
								<p className="font-medium">{request.kindLabel}</p>
								<p className="text-muted-foreground text-xs">
									{request.reasonLabel}
									{request.subReasonLabel ? ` · ${request.subReasonLabel}` : ''}
								</p>
								{request.locations.length > 0 ? (
									<p className="text-muted-foreground text-xs">
										{request.locations.join(', ')}
									</p>
								) : null}
							</div>
							<div className="text-right text-xs">
								<Badge
									variant={
										request.status === 'requested' ? 'warning' : 'outline'
									}
								>
									{request.status}
								</Badge>
								<p className="text-muted-foreground mt-1">
									<Trans>Takes effect {effective}</Trans>
								</p>
							</div>
						</div>
					)
				})}
			</CardContent>
		</Card>
	)
}
