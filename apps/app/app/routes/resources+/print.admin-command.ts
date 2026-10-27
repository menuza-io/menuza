import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import {
	adminRecordVendorOrder,
	adminRefundPrintOrder,
	adminRetryPrintOrder,
	PrintOrderError,
} from '#app/utils/print/orders.server.ts'

const CommandSchema = z.discriminatedUnion('action', [
	z.strictObject({
		action: z.literal('refund'),
		orderId: z.string().min(1).max(100),
		/** Refund in full although a vendor keeps printing (defect claims). */
		keepPrinting: z.boolean().optional(),
		/** Refund only this much (what was cancelled after a partial cancel). */
		amountCents: z.number().int().positive().max(100_000_00).optional(),
		/** Admin searched the vendor for an order we never recorded. */
		checkedVendor: z.boolean().optional(),
	}),
	z.strictObject({
		action: z.literal('record-vendor-order'),
		orderId: z.string().min(1).max(100),
		vendorOrders: z
			.array(
				z.strictObject({
					id: z.string().min(1).max(100),
					vendorOrderId: z.string().trim().min(1).max(200),
				}),
			)
			.min(1)
			.max(10),
	}),
	z.strictObject({
		action: z.literal('retry'),
		orderId: z.string().min(1).max(100),
		acceptPrice: z.boolean(),
		/** Admin searched the vendor for these references and found nothing. */
		checkedVendor: z.boolean().optional(),
	}),
])

/**
 * Admin's print shop commands (refund, retry a held order). Admin owns the
 * console; Stripe and the vendors are called from here so the keys live in one
 * app. Machine-to-machine only (INTERNAL_COMMAND_TOKEN).
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		if (error instanceof Response && error.status === 302) {
			return new Response('Forbidden', { status: 403 })
		}
		throw error
	}
	const parsed = CommandSchema.safeParse(await request.json().catch(() => null))
	if (!parsed.success) {
		return Response.json({ error: 'invalid_request' }, { status: 400 })
	}
	try {
		if (parsed.data.action === 'refund') {
			await adminRefundPrintOrder(parsed.data.orderId, {
				keepPrinting: parsed.data.keepPrinting,
				amountCents: parsed.data.amountCents,
				checkedVendor: parsed.data.checkedVendor,
			})
		} else if (parsed.data.action === 'record-vendor-order') {
			await adminRecordVendorOrder(
				parsed.data.orderId,
				parsed.data.vendorOrders,
			)
		} else {
			await adminRetryPrintOrder(parsed.data.orderId, parsed.data.acceptPrice, {
				checkedVendor: parsed.data.checkedVendor,
			})
		}
		return Response.json({ ok: true })
	} catch (error) {
		if (error instanceof PrintOrderError) {
			return Response.json(
				{ error: error.code, message: error.message },
				{ status: error.status },
			)
		}
		if (error instanceof Response) return error
		throw error
	}
}
