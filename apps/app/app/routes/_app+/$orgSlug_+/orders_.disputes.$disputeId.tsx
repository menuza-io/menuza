import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId, userHasOrganizationPermission } from '@repo/auth'
import { and, db, eq, PaymentDispute } from '@repo/database'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Textarea } from '@repo/ui/textarea'
import { useEffect, useState } from 'react'
import {
	type ActionFunctionArgs,
	Form,
	Link,
	type LoaderFunctionArgs,
	useActionData,
	useLoaderData,
	useNavigation,
} from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { requireMenuRead } from '#app/utils/menu/access.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import {
	acceptDisputeForOrg,
	submitDisputeEvidenceForOrg,
} from '#app/utils/payments/disputes.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		dataRegion: true,
	})
	await requireMenuRead(request, organization.id)

	const disputeId = params.disputeId?.trim()
	if (!disputeId) throw new Response('Not Found', { status: 404 })

	const [dispute] = await db
		.select()
		.from(PaymentDispute)
		.where(
			and(
				eq(PaymentDispute.id, disputeId),
				eq(PaymentDispute.organizationId, organization.id),
			),
		)
		.limit(1)
	if (!dispute) throw new Response('Not Found', { status: 404 })

	const userId = await requireUserId(request)
	const canAnswer = await userHasOrganizationPermission(
		userId,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)

	return {
		organization: {
			id: organization.id,
			slug: organization.slug,
			dataRegion: organization.dataRegion || 'us',
		},
		canAnswer,
		dispute: {
			id: dispute.id,
			provider: dispute.provider,
			providerDisputeId: dispute.providerDisputeId,
			orderKind: dispute.orderKind,
			orderRef: dispute.orderRef,
			amountMinor: dispute.amountMinor,
			feeMinor: dispute.feeMinor,
			currency: dispute.currency,
			reason: dispute.reason,
			status: dispute.status,
			alreadyRefunded: dispute.alreadyRefunded,
			dueAt: dispute.dueAt ? dispute.dueAt.toISOString() : null,
			submittedAt: dispute.submittedAt
				? dispute.submittedAt.toISOString()
				: null,
			closedAt: dispute.closedAt ? dispute.closedAt.toISOString() : null,
		},
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)

	const disputeId = params.disputeId?.trim()
	if (!disputeId) throw new Response('Not Found', { status: 404 })

	const formData = await request.formData()
	const intent = String(formData.get('intent') ?? '')

	if (intent === 'accept') {
		await acceptDisputeForOrg({ organizationId: organization.id, disputeId })
		return { ok: true, action: 'accepted' as const }
	}

	if (intent === 'submit-evidence') {
		const explanation = String(formData.get('explanation') ?? '').trim()
		if (explanation.length < 5) {
			return Response.json(
				{
					ok: false,
					error: 'Please provide a short explanation (at least 5 characters).',
				},
				{ status: 400 },
			)
		}
		const attachmentsRaw = String(formData.get('attachmentNames') ?? '')
		const attachmentNames = attachmentsRaw
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
		const refundReference = String(formData.get('refundReference') ?? '').trim()

		await submitDisputeEvidenceForOrg({
			organizationId: organization.id,
			disputeId,
			evidence: {
				explanation,
				attachmentNames,
				refundReference: refundReference || null,
			},
		})
		return { ok: true, action: 'submitted' as const }
	}

	return Response.json({ ok: false, error: 'Invalid intent' }, { status: 400 })
}

type RegionalOrderDetail = {
	id: string
	number: string
	fulfillment: string
	status: string
	totalCents: number
	refundedCents: number
	currency: string
	createdAt: string | null
}

function formatMoney(cents: number, currency: string, locale: string) {
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency: currency || 'USD',
	}).format(cents / 100)
}

export default function OrderDisputeDetailRoute() {
	const { organization, canAnswer, dispute } = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>() as
		{ ok?: boolean; error?: string; action?: string } | undefined
	const navigation = useNavigation()
	const { i18n } = useLingui()
	const [orderDetail, setOrderDetail] = useState<RegionalOrderDetail | null>(
		null,
	)

	const isKsa = organization.dataRegion.toLowerCase() === 'ksa'
	const isReadOnly =
		Boolean(dispute.submittedAt) || dispute.status !== 'needs_response'

	// Browser-direct regional order fetch for non-KSA orgs; KSA organizations
	// keep all order details regional and operators attach evidence by hand (#187).
	useEffect(() => {
		if (isKsa || dispute.orderKind !== 'restaurant_order') return
		let cancelled = false
		void (async () => {
			try {
				const tokenRes = await fetch(`/${organization.slug}/orders-token`)
				if (!tokenRes.ok) return
				const { jwt, tenantApiUrl } = (await tokenRes.json()) as {
					jwt: string
					tenantApiUrl: string
				}
				const res = await fetch(
					`${tenantApiUrl}/operator/orders/${encodeURIComponent(dispute.orderRef)}`,
					{ headers: { Authorization: `Bearer ${jwt}` } },
				)
				if (!res.ok || cancelled) return
				const payload = (await res.json()) as { order?: RegionalOrderDetail }
				if (!cancelled && payload.order) {
					setOrderDetail(payload.order)
				}
			} catch {
				// Non-fatal
			}
		})()
		return () => {
			cancelled = true
		}
	}, [isKsa, dispute.orderKind, dispute.orderRef, organization.slug])

	const money = (cents: number, currency = dispute.currency) =>
		formatMoney(cents, currency, i18n.locale)
	const orderNumber = orderDetail?.number ?? ''
	const submittedAtLabel = dispute.submittedAt
		? new Date(dispute.submittedAt).toLocaleString(i18n.locale)
		: ''
	const disputeStatusLabel = dispute.status

	return (
		<AnnotatedLayout>
			<AnnotatedSection>
				<div className="flex flex-col gap-6" data-testid="dispute-detail-page">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div>
							<p className="text-muted-foreground text-xs">
								<Link
									to={`/${organization.slug}/orders/disputes`}
									className="hover:underline"
								>
									<Trans>Payment disputes</Trans>
								</Link>
							</p>
							<h1 className="text-2xl font-semibold">
								<bdi dir="ltr">
									{orderDetail ? `#${orderDetail.number}` : dispute.orderRef}
								</bdi>{' '}
								· <bdi>{money(dispute.amountMinor)}</bdi>
							</h1>
						</div>
						<Badge
							variant={
								dispute.status === 'won'
									? 'default'
									: dispute.status === 'lost' || dispute.status === 'accepted'
										? 'destructive'
										: dispute.status === 'needs_response'
											? 'warning'
											: 'secondary'
							}
							data-testid="dispute-status-badge"
						>
							{dispute.status}
						</Badge>
					</div>

					{dispute.alreadyRefunded ? (
						<Card data-testid="dispute-already-refunded-banner">
							<CardHeader>
								<CardTitle>
									<Trans>Already refunded</Trans>
								</CardTitle>
								<CardDescription>
									<Trans>
										This order was already fully refunded. The refund record
										will be attached automatically when you submit evidence.
									</Trans>
								</CardDescription>
							</CardHeader>
						</Card>
					) : null}

					<Card>
						<CardHeader>
							<CardTitle>
								<Trans>Dispute details</Trans>
							</CardTitle>
						</CardHeader>
						<CardContent>
							<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
								<dt className="text-muted-foreground">
									<Trans>Reason</Trans>
								</dt>
								<dd className="capitalize">
									{dispute.reason.replaceAll('_', ' ')}
								</dd>
								<dt className="text-muted-foreground">
									<Trans>Answer by</Trans>
								</dt>
								<dd>
									{dispute.dueAt
										? new Date(dispute.dueAt).toLocaleDateString(i18n.locale)
										: '—'}
								</dd>
								<dt className="text-muted-foreground">
									<Trans>Dispute fee</Trans>
								</dt>
								<dd className="tabular-nums">
									<bdi>{money(dispute.feeMinor)}</bdi>
								</dd>
								{orderDetail ? (
									<>
										<dt className="text-muted-foreground">
											<Trans>Fulfillment</Trans>
										</dt>
										<dd className="capitalize">{orderDetail.fulfillment}</dd>
										<dt className="text-muted-foreground">
											<Trans>Order link</Trans>
										</dt>
										<dd>
											<Link
												to={`/${organization.slug}/orders/${encodeURIComponent(orderDetail.id)}`}
												className="text-primary underline-offset-4 hover:underline"
											>
												<Trans>Open order #{orderNumber}</Trans>
											</Link>
										</dd>
									</>
								) : null}
							</dl>
						</CardContent>
					</Card>

					{isKsa ? (
						<Card data-testid="dispute-ksa-residency-note">
							<CardHeader>
								<CardTitle>
									<Trans>Regional data residency (KSA)</Trans>
								</CardTitle>
								<CardDescription>
									<Trans>
										Order and guest details stay in Saudi Arabia and are never
										routed through the US App. Attach any receipt or delivery
										proof by hand when answering this dispute.
									</Trans>
								</CardDescription>
							</CardHeader>
						</Card>
					) : null}

					<Card data-testid="dispute-response-card">
						<CardHeader>
							<CardTitle>
								<Trans>Response</Trans>
							</CardTitle>
							<CardDescription>
								{isReadOnly ? (
									<Trans>
										This dispute is read-only because an answer has already been
										submitted or the dispute is closed.
									</Trans>
								) : (
									<Trans>
										You can submit evidence once. After submission, this page
										becomes read-only.
									</Trans>
								)}
							</CardDescription>
						</CardHeader>
						<CardContent>
							{actionData?.error ? (
								<p className="text-destructive mb-3 text-sm">
									{actionData.error}
								</p>
							) : null}
							{isReadOnly ? (
								<p
									className="text-muted-foreground text-sm"
									data-testid="dispute-readonly-notice"
								>
									{dispute.submittedAt ? (
										<Trans>Submitted on {submittedAtLabel}.</Trans>
									) : (
										<Trans>Dispute status: {disputeStatusLabel}.</Trans>
									)}
								</p>
							) : !canAnswer ? (
								<p className="text-muted-foreground text-sm">
									<Trans>
										You need settings update permission to answer or accept a
										dispute.
									</Trans>
								</p>
							) : (
								<div className="space-y-4">
									<Form method="post" className="space-y-4">
										<input
											type="hidden"
											name="intent"
											value="submit-evidence"
										/>
										{dispute.alreadyRefunded ? (
											<input
												type="hidden"
												name="refundReference"
												value={`Full refund issued for ${dispute.orderRef}`}
											/>
										) : null}
										<div className="space-y-1.5">
											<Label htmlFor="dispute-explanation">
												<Trans>Short explanation</Trans>
											</Label>
											<Textarea
												id="dispute-explanation"
												name="explanation"
												rows={4}
												required
												placeholder="Explain why the charge is valid (pickup/delivery time, confirmation, refund details)..."
											/>
										</div>
										<div className="space-y-1.5">
											<Label htmlFor="dispute-attachments">
												<Trans>
													Optional evidence file names (comma-separated)
												</Trans>
											</Label>
											<Input
												id="dispute-attachments"
												name="attachmentNames"
												placeholder="receipt.pdf, delivery-proof.jpg"
											/>
										</div>
										<div className="flex flex-wrap gap-3">
											<Button
												type="submit"
												disabled={navigation.state !== 'idle'}
											>
												<Trans>Submit evidence</Trans>
											</Button>
										</div>
									</Form>

									<Form method="post">
										<input type="hidden" name="intent" value="accept" />
										<Button
											type="submit"
											variant="outline"
											disabled={navigation.state !== 'idle'}
										>
											<Trans>Accept the dispute</Trans>
										</Button>
									</Form>
								</div>
							)}
						</CardContent>
					</Card>
				</div>
			</AnnotatedSection>
		</AnnotatedLayout>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
