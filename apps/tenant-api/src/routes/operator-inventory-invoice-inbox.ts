import {
	allowSenderSchema,
	dismissInvoiceSchema,
	INVENTORY_PERMISSIONS,
	invoiceInboxConfigSchema,
	invoiceInboxDetailSchema,
	invoiceInboxListSchema,
	invoiceInboxQuerySchema,
	invoiceInboxUploadResultSchema,
	locationQuerySchema,
	matchInvoiceResultSchema,
	matchInvoiceSchema,
	readInvoiceInboxSchema,
	INVOICE_MAIL_MAX_BYTES,
} from '@repo/inventory'
import { getTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import {
	getInventoryAuth,
	inventoryGuard,
	requireInventoryLocation,
} from '../lib/inventory-guard.ts'
import { inventoryDeny, inventoryErrorResponse } from '../lib/inventory-http.ts'
import {
	idParam,
	inventoryCaller,
	parseBody,
	parseQuery,
	respond,
} from '../lib/inventory-route.ts'
import {
	addInvoiceFiles,
	allowInvoiceSender,
	dismissInvoice,
	getInboxDetail,
	inboxConfig,
	listInbox,
	matchInvoice,
	rereadInboxInvoice,
} from '../services/inventory-invoice-inbox-service.ts'

/**
 * Supplier invoices that arrive without a delivery (#503), under
 * `/operator/inventory/invoice-inbox`, behind `inventory.invoice_inbox`. Mail
 * itself arrives at `POST /webhooks/invoice-mail`, not here.
 */
export const operatorInventoryInvoiceInboxRoutes = new Hono()

const READ = INVENTORY_PERMISSIONS.READ_INVENTORY
const UPDATE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY
const PURCHASING = INVENTORY_PERMISSIONS.UPDATE_INVENTORY_PURCHASING
const FEATURE = 'invoiceInbox' as const

/** `GET /invoice-inbox/config`: whether to show the address. Never gated: it answers `enabled: false`. */
operatorInventoryInvoiceInboxRoutes.get(
	'/invoice-inbox/config',
	inventoryGuard({ scope: ['read', 'write'], grant: READ }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const query = parseQuery(c, locationQuerySchema)
			if ('error' in query) return query.error
			const location = requireInventoryLocation(ctx, query.data.locationId)
			if (!location.ok) return location.response
			return respond(
				ctx,
				invoiceInboxConfigSchema.parse(inboxConfig(inventoryCaller(ctx))),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryInvoiceInboxRoutes.get(
	'/invoice-inbox',
	inventoryGuard({ scope: ['read', 'write'], grant: READ, feature: FEATURE }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const query = parseQuery(c, invoiceInboxQuerySchema)
			if ('error' in query) return query.error
			const location = requireInventoryLocation(ctx, query.data.locationId)
			if (!location.ok) return location.response
			return respond(
				ctx,
				invoiceInboxListSchema.parse(
					await listInbox(await getTenantDb(ctx.orgId), {
						caller: inventoryCaller(ctx),
						locationId: location.locationId,
						status: query.data.status,
						limit: query.data.limit,
						cursor: query.data.cursor,
					}),
				),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryInvoiceInboxRoutes.get(
	'/invoice-inbox/:id',
	inventoryGuard({ scope: ['read', 'write'], grant: READ, feature: FEATURE }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			return respond(
				ctx,
				invoiceInboxDetailSchema.parse(
					await getInboxDetail(await getTenantDb(ctx.orgId), {
						caller: inventoryCaller(ctx),
						id: idParam(c),
					}),
				),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

/** `POST /invoice-inbox/upload?locationId=`: several invoice files at once (multipart, field `files`). */
operatorInventoryInvoiceInboxRoutes.post(
	'/invoice-inbox/upload',
	inventoryGuard({ scope: 'write', grant: UPDATE, feature: FEATURE }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const query = parseQuery(c, locationQuerySchema)
			if ('error' in query) return query.error
			const location = requireInventoryLocation(ctx, query.data.locationId)
			if (!location.ok) return location.response
			const declared = Number(c.req.header('content-length') ?? 0)
			if (declared > INVOICE_MAIL_MAX_BYTES + 1024 * 1024) {
				return inventoryDeny(413, 'invalid_request', { reason: 'uploads_too_large' })
			}
			let form: FormData
			try {
				form = await c.req.formData()
			} catch {
				return inventoryDeny(400, 'invalid_request', { reason: 'form' })
			}
			const files = await Promise.all(
				form
					.getAll('files')
					.filter((entry): entry is File => typeof entry !== 'string')
					.map(async (file) => ({
						fileName: file.name || null,
						contentType: file.type || 'application/octet-stream',
						bytes: new Uint8Array(await file.arrayBuffer()),
					})),
			)
			return respond(
				ctx,
				invoiceInboxUploadResultSchema.parse(
					await addInvoiceFiles(inventoryCaller(ctx), {
						locationId: location.locationId,
						files,
						source: 'upload',
					}),
				),
				201,
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryInvoiceInboxRoutes.post(
	'/invoice-inbox/:id/match',
	inventoryGuard({ scope: 'write', grant: UPDATE, feature: FEATURE }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const body = await parseBody(c, matchInvoiceSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				matchInvoiceResultSchema.parse(
					await matchInvoice(inventoryCaller(ctx), {
						id: idParam(c),
						body: body.data,
					}),
				),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryInvoiceInboxRoutes.post(
	'/invoice-inbox/:id/dismiss',
	inventoryGuard({ scope: 'write', grant: UPDATE, feature: FEATURE }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const body = await parseBody(c, dismissInvoiceSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await dismissInvoice(inventoryCaller(ctx), {
					id: idParam(c),
					expectedVersion: body.data.expectedVersion,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

/** The owner allows the sender of this invoice (`update:settings:any` or an owner). */
operatorInventoryInvoiceInboxRoutes.post(
	'/invoice-inbox/:id/allow-sender',
	inventoryGuard({ scope: 'write', grant: UPDATE, feature: FEATURE }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const body = await parseBody(c, allowSenderSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await allowInvoiceSender(inventoryCaller(ctx), { id: idParam(c) }),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryInvoiceInboxRoutes.post(
	'/invoice-inbox/:id/read',
	inventoryGuard({ scope: 'write', grant: PURCHASING, feature: FEATURE }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const body = await parseBody(c, readInvoiceInboxSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await rereadInboxInvoice(inventoryCaller(ctx), { id: idParam(c) }),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)
