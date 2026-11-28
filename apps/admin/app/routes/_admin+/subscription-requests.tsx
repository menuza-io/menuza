import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { Form, Link, useLoaderData, useNavigation } from 'react-router'
import { action, loader } from './subscription-requests.server.ts'

export { action, loader }

const FILTERS = ['requested', 'handled', 'withdrawn', 'all'] as const

export default function SubscriptionRequestsAdminRoute() {
	const { requests, status } = useLoaderData<typeof loader>()
	const { _, i18n } = useLingui()
	const busy = useNavigation().state !== 'idle'
	const date = (iso: string | null) =>
		iso
			? new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' }).format(
					new Date(iso),
				)
			: '—'
	const filterLabel: Record<(typeof FILTERS)[number], string> = {
		requested: _(msg`Open`),
		handled: _(msg`Handled`),
		withdrawn: _(msg`Withdrawn`),
		all: _(msg`All`),
	}
	return (
		<div className="space-y-6">
			<PageHeader
				title={<Trans>Cancel and downgrade requests</Trans>}
				description={
					<Trans>
						Every request an owner sent from the billing page, with the reason
						they gave. A request cancels nothing by itself: it takes effect at
						the end of the billing period, and you act on it here by hand.
					</Trans>
				}
			/>
			<nav
				className="flex flex-wrap gap-2"
				aria-label={_(msg`Filter by status`)}
			>
				{FILTERS.map((value) => (
					<Button
						key={value}
						size="sm"
						variant={status === value ? 'default' : 'outline'}
						render={<Link to={`?status=${value}`} />}
					>
						{filterLabel[value]}
					</Button>
				))}
			</nav>
			{requests.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>No requests.</Trans>
				</p>
			) : (
				<Frame className="w-full">
					<Table variant="card">
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Organization</Trans>
								</TableHead>
								<TableHead>
									<Trans>Request</Trans>
								</TableHead>
								<TableHead>
									<Trans>Reason</Trans>
								</TableHead>
								<TableHead>
									<Trans>Takes effect</Trans>
								</TableHead>
								<TableHead>
									<Trans>Status</Trans>
								</TableHead>
								<TableHead />
							</TableRow>
						</TableHeader>
						<TableBody>
							{requests.map((request) => {
								const sender = request.requestedBy ?? ''
								return (
									<TableRow key={request.id} data-testid="change-request-row">
										<TableCell>
											<Link
												to={`/organizations/${request.organization.id}`}
												className="font-medium underline underline-offset-2"
											>
												{request.organization.name}
											</Link>
											<div className="text-muted-foreground text-xs">
												{request.requestedBy ? _(msg`Sent by ${sender}`) : null}
											</div>
											<div className="text-muted-foreground text-xs">
												{date(request.createdAt)}
											</div>
										</TableCell>
										<TableCell>
											<div className="text-sm font-medium">
												{request.kindLabel}
											</div>
											{request.locations.length > 0 ? (
												<div className="text-muted-foreground text-xs">
													{request.locations.join(', ')}
												</div>
											) : null}
											{request.targetPlan ? (
												<div className="text-muted-foreground text-xs">
													{request.targetPlan}
												</div>
											) : null}
										</TableCell>
										<TableCell className="max-w-xs">
											<div className="text-sm">{request.reasonLabel}</div>
											{request.subReasonLabel ? (
												<div className="text-muted-foreground text-xs">
													{request.subReasonLabel}
												</div>
											) : null}
											{request.note ? (
												<div className="text-muted-foreground mt-1 text-xs wrap-anywhere whitespace-pre-wrap">
													{request.note}
												</div>
											) : null}
											{request.retentionOffer ? (
												<div className="text-muted-foreground mt-1 text-xs">
													<Trans>An offer was shown.</Trans>
												</div>
											) : null}
										</TableCell>
										<TableCell className="whitespace-nowrap">
											{date(request.effectiveAt)}
										</TableCell>
										<TableCell>
											<Badge
												variant={
													request.status === 'requested' ? 'warning' : 'outline'
												}
											>
												{request.status === 'requested'
													? _(msg`Open`)
													: request.status === 'handled'
														? _(msg`Handled`)
														: _(msg`Withdrawn`)}
											</Badge>
										</TableCell>
										<TableCell>
											{request.status === 'requested' ? (
												<Form method="post">
													<input
														type="hidden"
														name="_action"
														value="mark-handled"
													/>
													<input
														type="hidden"
														name="requestId"
														value={request.id}
													/>
													<Button
														type="submit"
														size="sm"
														variant="outline"
														disabled={busy}
													>
														<Trans>Mark handled</Trans>
													</Button>
												</Form>
											) : null}
										</TableCell>
									</TableRow>
								)
							})}
						</TableBody>
					</Table>
				</Frame>
			)}
		</div>
	)
}
