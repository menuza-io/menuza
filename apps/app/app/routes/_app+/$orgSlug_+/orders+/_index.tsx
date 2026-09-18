import { parseWithZod } from '@conform-to/zod'
import { requireUserId } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import { PageTitle } from '@repo/ui/page-title'
import { Button } from '@repo/ui/button'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	Form,
	useLoaderData,
} from 'react-router'
import { z } from 'zod'

import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	kitchenStatusSchema,
	listKitchenOrders,
	updateKitchenOrderStatus,
} from '#app/utils/orders-board.server.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'

const OrderStatusActionSchema = z.object({
	orderId: z.string().min(1),
	kitchenStatus: kitchenStatusSchema,
})

const NEXT_STATUS: Record<
	z.infer<typeof kitchenStatusSchema>,
	z.infer<typeof kitchenStatusSchema> | null
> = {
	placed: 'accepted',
	accepted: 'ready',
	ready: 'completed',
	completed: null,
	cancelled: null,
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
		hasProvisionedDb: true,
		dataRegion: true,
	})

	const orders =
		organization.hasProvisionedDb && organization.dataRegion === 'us'
			? await listKitchenOrders(organization.id)
			: []

	return { organization, orders }
}

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserWithOrganizationPermission(
		request,
		params.orgSlug,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
		{ id: true },
	)

	const formData = await request.formData()
	const submission = parseWithZod(formData, { schema: OrderStatusActionSchema })
	if (submission.status !== 'success') {
		return submission.reply()
	}

	const updated = await updateKitchenOrderStatus(
		organization.id,
		submission.value.orderId,
		submission.value.kitchenStatus,
	)

	if (!updated) {
		return redirectWithToast(`/${organization.slug}/orders`, {
			type: 'error',
			title: 'Order not found',
		})
	}

	return redirectWithToast(`/${organization.slug}/orders`, {
		type: 'success',
		title: 'Order updated',
	})
}

export default function RestaurantOrdersBoard() {
	const { orders } = useLoaderData<typeof loader>()

	return (
		<div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-4 py-8 md:px-6 lg:px-8">
			<PageTitle
				title="Orders"
				description="Live food orders for your restaurant. Payment capture and Stripe checkout for multi-item carts are follow-up work."
			/>
			<div className="overflow-hidden rounded-lg border">
				<table className="w-full text-sm">
					<thead className="bg-muted/50 text-left">
						<tr>
							<th className="p-3">Order</th>
							<th className="p-3">Customer</th>
							<th className="p-3">Fulfillment</th>
							<th className="p-3">Kitchen</th>
							<th className="p-3">Total</th>
							<th className="p-3">Actions</th>
						</tr>
					</thead>
					<tbody>
						{orders.length === 0 ? (
							<tr>
								<td className="text-muted-foreground p-4" colSpan={6}>
									No orders yet.
								</td>
							</tr>
						) : (
							orders.map((order) => {
								const next =
									NEXT_STATUS[order.kitchenStatus as keyof typeof NEXT_STATUS]
								return (
									<tr key={order.id} className="border-t">
										<td className="p-3">
											<div className="font-medium">{order.productName}</div>
											<div className="text-muted-foreground text-xs">
												{order.status} · {order.id.slice(0, 8)}
											</div>
										</td>
										<td className="p-3">
											{order.customerName ?? 'Guest'}
											{order.customerPhone ? (
												<div className="text-muted-foreground text-xs">
													{order.customerPhone}
												</div>
											) : null}
										</td>
										<td className="p-3 capitalize">{order.fulfillmentType}</td>
										<td className="p-3 capitalize">{order.kitchenStatus}</td>
										<td className="p-3">
											${(order.amountCents / 100).toFixed(2)}
										</td>
										<td className="p-3">
											{next ? (
												<Form method="post" className="inline">
													<input
														type="hidden"
														name="orderId"
														value={order.id}
													/>
													<input
														type="hidden"
														name="kitchenStatus"
														value={next}
													/>
													<Button type="submit" size="sm" variant="secondary">
														Mark {next}
													</Button>
												</Form>
											) : null}
										</td>
									</tr>
								)
							})
						)}
					</tbody>
				</table>
			</div>
		</div>
	)
}
