import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { userHasOrganizationPermission } from '@repo/auth'
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
import { OrderDetail } from '#app/components/orders/order-detail.tsx'
import { useOrdersClient } from '#app/hooks/use-orders-client.ts'
import { requireMenuRead } from '#app/utils/menu/access.server.ts'
import { getOrderCustomerLinkAccess } from '#app/utils/orders/customer-link.server.ts'
import { type Order, orderSchema } from '#app/utils/orders/order-model.ts'
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
	const link = await getOrderCustomerLinkAccess(request, orgSlug)
	return data(
		{
			orgSlug,
			orderId: params.orderId || '',
			canWrite,
			canViewCustomers: link.linkCustomers || link.linkGuests,
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}

type State = 'loading' | 'ready' | 'missing' | 'failed'

export default function OrderPage() {
	const { orgSlug, orderId, canWrite, canViewCustomers } =
		useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const request = useOrdersClient(orgSlug)
	const [order, setOrder] = useState<Order | null>(null)
	const [state, setState] = useState<State>('loading')
	const [busy, setBusy] = useState(false)
	const [actionError, setActionError] = useState<string | null>(null)

	const load = useCallback(
		async (signal?: AbortSignal) => {
			try {
				const payload = z
					.object({ order: orderSchema })
					.parse(await request(`/${encodeURIComponent(orderId)}`, { signal }))
				if (signal?.aborted) return
				setOrder(payload.order)
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

	const update = async (status: string, markPaid: boolean) => {
		if (!order || busy || !canWrite) return
		setBusy(true)
		setActionError(null)
		try {
			await request(`/${encodeURIComponent(order.id)}`, {
				method: 'PATCH',
				body: JSON.stringify({ status, markPaid }),
			})
			await load()
		} catch {
			setActionError(
				_(msg`Unable to update this order. Refresh and try again.`),
			)
		} finally {
			setBusy(false)
		}
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
				orgSlug={orgSlug}
				canWrite={canWrite}
				canViewCustomers={canViewCustomers}
				busy={busy}
				onUpdate={(status, markPaid) => void update(status, markPaid)}
				backHref={backHref}
			/>
		</div>
	)
}
