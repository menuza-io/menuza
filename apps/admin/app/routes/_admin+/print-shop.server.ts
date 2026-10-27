import { requireUserWithRole } from '@repo/auth'
import { PRINT_PRODUCT_KEYS, PRINT_PRODUCTS } from '@repo/common/print-shop'
import {
	and,
	asc,
	db,
	desc,
	eq,
	Organization,
	PrintOrder,
	PrintSettings,
	PrintVendorProduct,
} from '@repo/database'
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { ENV } from 'varlock/env'
import { z } from 'zod'

export const PRINT_ADMIN_VENDORS = ['gelato', 'prodigi'] as const

const MARGIN_STATUSES = new Set([
	'paid',
	'submitting',
	'submitted',
	'in_production',
	'shipped',
	'delivered',
	'held',
])

export async function loader({ request }: LoaderFunctionArgs) {
	await requireUserWithRole(request, 'admin')
	const [settings] = await db
		.select()
		.from(PrintSettings)
		.where(eq(PrintSettings.id, 'default'))
		.limit(1)
	const catalog = await db
		.select()
		.from(PrintVendorProduct)
		.where(eq(PrintVendorProduct.active, true))
		.orderBy(asc(PrintVendorProduct.product), asc(PrintVendorProduct.sizeKey))
	const orders = await db
		.select({
			id: PrintOrder.id,
			status: PrintOrder.status,
			totalCents: PrintOrder.totalCents,
			taxCents: PrintOrder.taxCents,
			wholesaleCents: PrintOrder.wholesaleCents,
			refundCents: PrintOrder.refundCents,
			holdReason: PrintOrder.holdReason,
			failureReason: PrintOrder.failureReason,
			createdAt: PrintOrder.createdAt,
			organization: Organization.name,
		})
		.from(PrintOrder)
		.innerJoin(Organization, eq(Organization.id, PrintOrder.organizationId))
		.orderBy(desc(PrintOrder.createdAt))
		.limit(100)
	const sizes = PRINT_PRODUCT_KEYS.filter(
		(key) => PRINT_PRODUCTS[key].shippable,
	).flatMap((key) =>
		PRINT_PRODUCTS[key].sizes.map((size) => ({
			product: key,
			sizeKey: size.key,
			label: size.label,
		})),
	)
	return {
		settings: {
			markupBp: settings?.markupBp ?? 3000,
			driftHoldBp: settings?.driftHoldBp ?? 1000,
			quoteTtlMinutes: settings?.quoteTtlMinutes ?? 30,
		},
		sizes,
		catalog: catalog.map((row) => ({
			id: row.id,
			product: row.product,
			sizeKey: row.sizeKey,
			vendor: row.vendor,
			vendorSku: row.vendorSku,
			bleedMm: row.bleedMm,
		})),
		orders: orders.map((order) => ({
			...order,
			createdAt: order.createdAt.toISOString(),
			// Kept after tax: what Menuza earns over the vendor's wholesale.
			// Only money actually collected and kept counts.
			marginCents: MARGIN_STATUSES.has(order.status)
				? order.totalCents - order.taxCents - order.wholesaleCents
				: 0,
		})),
	}
}

const ActionSchema = z.discriminatedUnion('_action', [
	z.object({
		_action: z.literal('settings'),
		markupPercent: z.coerce.number().min(0).max(300),
		driftPercent: z.coerce.number().min(0).max(100),
		quoteTtlMinutes: z.coerce.number().int().min(5).max(120),
	}),
	z.object({
		_action: z.literal('catalog'),
		product: z.enum(PRINT_PRODUCT_KEYS),
		sizeKey: z.string().trim().min(1).max(20),
		vendor: z.enum(PRINT_ADMIN_VENDORS),
		vendorSku: z.string().trim().min(1).max(200),
		bleedMm: z.coerce.number().int().min(0).max(10),
	}),
	z.object({
		_action: z.literal('catalog-remove'),
		id: z.string().min(1).max(100),
	}),
	z.object({
		_action: z.enum(['refund', 'retry', 'retry-accept']),
		orderId: z.string().min(1).max(100),
	}),
])

export type PrintAdminResult = { ok: true } | { ok: false; message: string }

async function appCommand(
	body: Record<string, unknown>,
): Promise<PrintAdminResult> {
	const base = ENV.APP_URL?.replace(/\/$/, '')
	const token = ENV.INTERNAL_COMMAND_TOKEN
	if (!base || !token)
		return {
			ok: false,
			message: 'APP_URL or INTERNAL_COMMAND_TOKEN is not set.',
		}
	const response = await fetch(`${base}/resources/print/admin-command`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	}).catch(() => null)
	if (!response) return { ok: false, message: 'The App did not answer.' }
	if (response.ok) return { ok: true }
	const error = (await response.json().catch(() => null)) as {
		message?: string
	} | null
	return {
		ok: false,
		message: error?.message ?? `The App answered ${response.status}.`,
	}
}

export async function action({
	request,
}: ActionFunctionArgs): Promise<PrintAdminResult> {
	await requireUserWithRole(request, 'admin')
	const parsed = ActionSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) return { ok: false, message: 'Check the form values.' }
	const input = parsed.data
	switch (input._action) {
		case 'settings': {
			const values = {
				markupBp: Math.round(input.markupPercent * 100),
				driftHoldBp: Math.round(input.driftPercent * 100),
				quoteTtlMinutes: input.quoteTtlMinutes,
			}
			await db
				.insert(PrintSettings)
				.values({ id: 'default', ...values })
				.onConflictDoUpdate({ target: PrintSettings.id, set: values })
			return { ok: true }
		}
		case 'catalog': {
			const product = PRINT_PRODUCTS[input.product]
			if (
				!product.shippable ||
				!product.sizes.some((size) => size.key === input.sizeKey)
			) {
				return { ok: false, message: 'That product and size cannot ship.' }
			}
			// One active vendor per product and size: the new mapping replaces it.
			await db
				.update(PrintVendorProduct)
				.set({ active: false })
				.where(
					and(
						eq(PrintVendorProduct.product, input.product),
						eq(PrintVendorProduct.sizeKey, input.sizeKey),
						eq(PrintVendorProduct.active, true),
					),
				)
			await db.insert(PrintVendorProduct).values({
				product: input.product,
				sizeKey: input.sizeKey,
				vendor: input.vendor,
				vendorSku: input.vendorSku,
				bleedMm: input.bleedMm,
				active: true,
			})
			return { ok: true }
		}
		case 'catalog-remove':
			await db
				.update(PrintVendorProduct)
				.set({ active: false })
				.where(eq(PrintVendorProduct.id, input.id))
			return { ok: true }
		case 'refund':
			return appCommand({ action: 'refund', orderId: input.orderId })
		default:
			return appCommand({
				action: 'retry',
				orderId: input.orderId,
				acceptPrice: input._action === 'retry-accept',
			})
	}
}
