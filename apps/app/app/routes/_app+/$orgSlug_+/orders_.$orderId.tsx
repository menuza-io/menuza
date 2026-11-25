import { getFeatureFlag } from '@repo/common/feature-flags'
import { PRINTING_FLAG_KEY } from '@repo/common/print-devices'
import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { isImpersonating, userHasOrganizationPermission } from '@repo/auth'
import { db, eq, User, UserOrganization } from '@repo/database'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { useCallback, useEffect, useState } from 'react'
import {
	data,
	Link,
	type LoaderFunctionArgs,
	useLoaderData,
} from 'react-router'
import { z } from 'zod'
import {
	type CancelOptions,
	OrderDetail,
} from '#app/components/orders/order-detail.tsx'
import { useOrdersClient } from '#app/hooks/use-orders-client.ts'
import { requireMenuRead } from '#app/utils/menu/access.server.ts'
import {
	decideOrder,
	decisionErrorMessage,
	type OrderDecision,
	rejectNotice,
} from '#app/utils/orders/acceptance.ts'
import { getOrderCustomerLinkAccess } from '#app/utils/orders/customer-link.server.ts'
import {
	type Order,
	type OrderRefundBody,
	orderSchema,
	orderTimelineEntrySchema,
	type OrderTimelineEntry,
	type PushBackMinutes,
} from '#app/utils/orders/order-model.ts'
import { ordersHref } from '#app/utils/orders/orders-link.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'

/**
 * One order as its own page. The shell (permissions, flags) loads here; the
 * order itself loads in the browser from the regional API with the orders
 * token, so customer data never transits this server.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
	})
	const userId = await requireMenuRead(request, organization.id)
	const canWrite = await userHasOrganizationPermission(
		userId,
		organization.id,
		ORG_PERMISSIONS.UPDATE_MENU_ANY,
	)
	// Provider refunds (and cancelling a paid order with a refund) need their
	// own permission and are never offered while impersonating. The action
	// and the region check again; this only shows or hides the entry points.
	const canRefund =
		!(await isImpersonating(request)) &&
		(await userHasOrganizationPermission(
			userId,
			organization.id,
			ORG_PERMISSIONS.UPDATE_ORDER_REFUND_ANY,
		))
	const link = await getOrderCustomerLinkAccess(request, orgSlug)
	// Who did each step (#243): the region keeps an opaque member id, so the
	// names come from the organization's own members, here.
	const members = await db
		.select({ id: User.id, name: User.name, username: User.username })
		.from(UserOrganization)
		.innerJoin(User, eq(User.id, UserOrganization.userId))
		.where(eq(UserOrganization.organizationId, organization.id))
		.limit(500)
	const memberNames: Record<string, string> = {}
	for (const member of members) {
		memberNames[member.id] = member.name ?? member.username
	}
	return data(
		{
			memberNames,
			orgSlug,
			orderId: params.orderId || '',
			canWrite,
			canRefund,
			canViewCustomers: link.linkCustomers || link.linkGuests,
			// Cloud printers (#117): Reprint is offered where they are on.
			printersEnabled:
				canWrite &&
				(await getFeatureFlag(PRINTING_FLAG_KEY, {
					organizationId: organization.id,
				})) === true,
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}

type State = 'loading' | 'ready' | 'missing' | 'failed'

export default function OrderPage() {
	const {
		orgSlug,
		orderId,
		canWrite,
		canRefund,
		canViewCustomers,
		memberNames,
		printersEnabled,
	} = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const request = useOrdersClient(orgSlug)
	const [order, setOrder] = useState<Order | null>(null)
	const [timeline, setTimeline] = useState<OrderTimelineEntry[]>([])
	const [state, setState] = useState<State>('loading')
	const [busy, setBusy] = useState(false)
	const [actionError, setActionError] = useState<string | null>(null)
	const [notice, setNotice] = useState<string | null>(null)

	const load = useCallback(
		async (signal?: AbortSignal) => {
			try {
				const payload = z
					.object({
						order: orderSchema,
						timeline: z.array(orderTimelineEntrySchema).default([]),
					})
					.parse(await request(`/${encodeURIComponent(orderId)}`, { signal }))
				if (signal?.aborted) return
				setOrder(payload.order)
				setTimeline(payload.timeline)
				setState('ready')
			} catch (error) {
				if (signal?.aborted) return
				const status = (error as { status?: number }).status
				setState(status === 404 ? 'missing' : 'failed')
			}
		},
		[request, orderId],
	)

	useEffect(() => {
		const controller = new AbortController()
		setState('loading')
		setOrder(null)
		void load(controller.signal)
		return () => controller.abort()
	}, [load])

	const update = async (
		status: string,
		markPaid: boolean,
		cancel?: CancelOptions,
	) => {
		if (!order || busy || !canWrite) return
		setBusy(true)
		setActionError(null)
		setNotice(null)
		try {
			const response = await request(`/${encodeURIComponent(order.id)}`, {
				method: 'PATCH',
				body: JSON.stringify({
					status,
					markPaid,
					...(cancel
						? {
								cancelReason: cancel.cancelReason,
								// Without the permission there is no refund choice.
								refund: canRefund ? cancel.refund : 'none',
							}
						: {}),
				}),
			})
			if (cancel?.refund === 'full' && canRefund) {
				setNotice(cancelRefundNotice(response))
			}
			await load()
		} catch {
			setActionError(
				_(msg`Unable to update this order. Refresh and try again.`),
			)
		} finally {
			setBusy(false)
		}
	}

	/** What happened to the refund that was asked for with the cancellation. */
	const cancelRefundNotice = (response: unknown): string | null => {
		const parsed = z
			.object({
				refundIntent: z.unknown().nullable().optional(),
				refundError: z.string().nullable().optional(),
			})
			.safeParse(response)
		if (!parsed.success) return null
		const { refundIntent, refundError } = parsed.data
		if (refundIntent) {
			return _(
				msg`Order cancelled. Refund pending: it is being sent to the guest's card.`,
			)
		}
		switch (refundError) {
			case undefined:
			case null:
				return null
			case 'payment_disputed':
				return _(
					msg`Order cancelled. It was not refunded because the payment is disputed.`,
				)
			case 'refund_pending':
				return _(
					msg`Order cancelled. Another refund is still being processed, so none was started.`,
				)
			case 'refund_complete':
				return _(msg`Order cancelled. It was already fully refunded.`)
			default:
				return _(
					msg`Order cancelled, but the refund could not be started. Refund it from this order.`,
				)
		}
	}

	/**
	 * A record only: the money goes back in the payment provider. The region
	 * answers with the order, so its refunded total shows at once.
	 */
	const recordRefund = async (
		body: OrderRefundBody,
		idempotencyKey: string,
	) => {
		const response = await request(`/${encodeURIComponent(orderId)}/refunds`, {
			method: 'POST',
			body: JSON.stringify(body),
			headers: { 'Idempotency-Key': idempotencyKey },
		})
		setOrder(z.object({ order: orderSchema }).parse(response).order)
	}

	/**
	 * Pushes the promised time back. The region checks the version we saw, so a
	 * second screen cannot silently stack another delay; errors reach the
	 * detail, which words them.
	 */
	const pushBack = async (delayMinutes: PushBackMinutes) => {
		if (!order || !canWrite) return
		const response = await request(`/${encodeURIComponent(order.id)}`, {
			method: 'PATCH',
			body: JSON.stringify({
				delayMinutes,
				expectedPromisedVersion: order.promisedVersion,
			}),
		})
		setOrder(z.object({ order: orderSchema }).parse(response).order)
	}

	/** Accept or reject a waiting order (manual acceptance). */
	const decide = async (decision: OrderDecision) => {
		if (!order || busy || !canWrite) return
		setBusy(true)
		setActionError(null)
		setNotice(null)
		try {
			const response = await decideOrder(request, order.id, decision)
			setNotice(
				decision.kind === 'reject'
					? rejectNotice(response, _)
					: _(msg`Order accepted.`),
			)
		} catch (error) {
			setActionError(decisionErrorMessage(error, _))
		} finally {
			setBusy(false)
		}
		await load()
	}

	const shell = 'mx-auto w-full max-w-5xl py-8 md:px-6 lg:px-8'
	const backHref = ordersHref(orgSlug)

	if (state === 'loading')
		return (
			<div
				className={`${shell} flex flex-col gap-6`}
				role="status"
				aria-busy="true"
				data-testid="order-loading"
			>
				<span className="sr-only">
					<Trans>Loading order…</Trans>
				</span>
				<Skeleton className="h-4 w-40" />
				<Skeleton className="h-9 w-72" />
				<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
					<Skeleton className="h-72 w-full rounded-lg lg:col-start-1 lg:row-start-1" />
					<Skeleton className="h-56 w-full rounded-lg lg:col-start-2 lg:row-start-1" />
				</div>
			</div>
		)

	if (state === 'missing' || state === 'failed' || !order)
		return (
			<div className={`${shell} flex flex-col gap-4`} data-testid="order-error">
				<Alert variant="destructive">
					<Icon name="alert-triangle" />
					<AlertDescription>
						{state === 'missing' ? (
							<Trans>This order does not exist or was removed.</Trans>
						) : (
							<Trans>This order could not be loaded.</Trans>
						)}
					</AlertDescription>
				</Alert>
				<div className="flex gap-2">
					<Button variant="outline" render={<Link to={backHref} />}>
						<Trans>Back to orders</Trans>
					</Button>
					{state === 'failed' ? (
						<Button
							onClick={() => {
								setState('loading')
								void load()
							}}
						>
							<Trans>Retry</Trans>
						</Button>
					) : null}
				</div>
			</div>
		)

	return (
		<div className={shell}>
			{actionError ? (
				<p role="alert" className="text-destructive mb-4 text-sm">
					{actionError}
				</p>
			) : null}
			<OrderDetail
				order={order}
				steps={timeline}
				memberNames={memberNames}
				orgSlug={orgSlug}
				canWrite={canWrite}
				canViewCustomers={canViewCustomers}
				canRefund={canRefund}
				reprint={printersEnabled}
				busy={busy}
				notice={notice}
				onUpdate={(status, markPaid, cancel) =>
					void update(status, markPaid, cancel)
				}
				onAccept={() => void decide({ kind: 'accept' })}
				onReject={(reason) => void decide({ kind: 'reject', reason })}
				onRecordRefund={canWrite ? recordRefund : undefined}
				onPushBack={canWrite ? pushBack : undefined}
				onReload={() => void load()}
				backHref={backHref}
			/>
		</div>
	)
}
