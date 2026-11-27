import { z } from 'zod'
import { orderStatusSchema } from '../records.ts'
import { inventoryLocationIdSchema } from '../token.ts'
import {
	clientIdSchema,
	currencyOut,
	expectedVersionSchema,
	inventoryIdSchema,
	isoDateSchema,
	listQuerySchema,
	minorOut,
} from './common.ts'

/**
 * Supplier invoices that arrive without a delivery (#503), behind
 * `inventory.invoice_inbox`: emailed to the location's invoice address,
 * uploaded in the App (several files at once) or photographed on Station.
 * Files and the mail's words go straight to the region's storage; the control
 * plane keeps only the location's code. Nothing here is recorded as stock: a
 * person matches an invoice to an order or a delivery, or makes a delivery from
 * it (the ordinary receive screen, prefilled).
 */

/** Largest email (all attachments together) the node accepts: 25 MB. */
export const INVOICE_MAIL_MAX_BYTES = 25 * 1024 * 1024
/** Attachments kept from one email or one upload. */
export const INVOICE_INBOX_MAX_FILES = 10
export const INVOICE_INBOX_FILE_TYPES = [
	'application/pdf',
	'image/jpeg',
	'image/png',
	'image/webp',
] as const
export type InvoiceInboxFileType = (typeof INVOICE_INBOX_FILE_TYPES)[number]

export const INVOICE_INBOX_STATUSES = [
	'new',
	'matched',
	'delivered',
	'dismissed',
] as const
export const INVOICE_SENDER_STATES = ['known', 'allowed', 'unknown'] as const
export const INVOICE_READ_STATES = [
	'pending',
	'read',
	'failed',
	'not_configured',
] as const

/** `GET /invoice-inbox/config?locationId=`: whether to show the address, and its domain. */
export const invoiceInboxConfigSchema = z.object({
	/** The flag is on and this node receives mail for the address. */
	enabled: z.boolean(),
	/** The part after `invoices+<code>@`; null while the node has none. */
	domain: z.string().nullable(),
})

export const invoiceInboxQuerySchema = listQuerySchema
	.extend({
		locationId: inventoryLocationIdSchema,
		/** `open` is new and matched; the default. */
		status: z
			.enum(['open', 'all', ...INVOICE_INBOX_STATUSES])
			.default('open'),
	})
	.strict()

export const invoiceFileSchema = z.object({
	id: z.string(),
	fileName: z.string().nullable(),
	contentType: z.string(),
	sizeBytes: z.number().int(),
})

export const invoiceInboxReadLineSchema = z.object({
	description: z.string(),
	itemId: z.string().nullable(),
	quantity: z.number().nullable(),
	unit: z.string().nullable(),
	lineTotalMinor: minorOut,
})

export const invoiceInboxItemSchema = z.object({
	id: z.string(),
	locationId: z.string(),
	source: z.enum(['email', 'upload', 'station']),
	receivedAt: z.number().int(),
	fromAddress: z.string().nullable(),
	subject: z.string().nullable(),
	/** `unknown`: nobody has allowed this sender (listed and marked). */
	senderState: z.enum(INVOICE_SENDER_STATES),
	status: z.enum(INVOICE_INBOX_STATUSES),
	readState: z.enum(INVOICE_READ_STATES),
	supplierId: z.string().nullable(),
	supplierName: z.string().nullable(),
	invoiceNumber: z.string().nullable(),
	invoiceDate: isoDateSchema.nullable(),
	totalMinor: minorOut,
	currency: currencyOut,
	lineCount: z.number().int(),
	files: z.array(invoiceFileSchema),
	/** Another inbox invoice (or a delivery) with the same supplier and number. */
	duplicateOfId: z.string().nullable(),
	duplicateDeliveryId: z.string().nullable(),
	orderId: z.string().nullable(),
	deliveryId: z.string().nullable(),
	version: z.number().int(),
})
export type InvoiceInboxItem = z.infer<typeof invoiceInboxItemSchema>

export const invoiceInboxListSchema = z.object({
	items: z.array(invoiceInboxItemSchema),
	nextCursor: z.string().nullable(),
	/** Invoices still to match at the location (new and matched). */
	openCount: z.number().int(),
})

export const suggestedOrderSchema = z.object({
	id: z.string(),
	number: z.number().int(),
	status: orderStatusSchema,
	expectedDate: isoDateSchema.nullable(),
	lineCount: z.number().int(),
	totalMinor: minorOut,
})

export const suggestedDeliverySchema = z.object({
	id: z.string(),
	receivedAt: z.number().int().nullable(),
	lineCount: z.number().int(),
	invoiceNumber: z.string().nullable(),
})

/** `GET /invoice-inbox/:id?locationId=`: the invoice, its files with read links, and where it could go. */
export const invoiceInboxDetailSchema = invoiceInboxItemSchema.extend({
	files: z.array(
		invoiceFileSchema.extend({
			/** A short-lived link the browser opens directly; null without storage. */
			url: z.string().nullable(),
		}),
	),
	/** What the reader found, for a person to check. */
	lines: z.array(invoiceInboxReadLineSchema),
	suggestedOrders: z.array(suggestedOrderSchema),
	suggestedDeliveries: z.array(suggestedDeliverySchema),
})
export type InvoiceInboxDetail = z.infer<typeof invoiceInboxDetailSchema>

/**
 * `POST /invoice-inbox/:id/match`: matches the invoice to an open order (the
 * delivery screen opens prefilled from `prefill`) or to a delivery already
 * recorded. Exactly one of `orderId` and `deliveryId`; both null clears the
 * match. Matching to a delivery marks the invoice delivered.
 */
export const matchInvoiceSchema = z
	.object({
		expectedVersion: expectedVersionSchema,
		orderId: inventoryIdSchema.nullable().optional(),
		deliveryId: inventoryIdSchema.nullable().optional(),
	})
	.strict()
	.refine((body) => !(body.orderId && body.deliveryId), {
		message: 'Choose an order or a delivery',
	})

export const matchInvoiceResultSchema = z.object({
	invoice: invoiceInboxItemSchema,
	/** What the receive screen starts from. Absent when nothing was matched to an order. */
	prefill: z
		.object({
			orderId: z.string(),
			supplierId: z.string().nullable(),
			invoiceNumber: z.string().nullable(),
			invoiceDate: isoDateSchema.nullable(),
			totalMinor: minorOut,
			currency: currencyOut,
			inboxId: z.string(),
		})
		.nullable(),
})

/** `POST /invoice-inbox/:id/allow-sender`: no fields; the invoice names the sender. */
export const allowSenderSchema = z.object({}).strict()

export const dismissInvoiceSchema = z
	.object({ expectedVersion: expectedVersionSchema })
	.strict()

/** `POST /invoice-inbox/:id/read`: ask the reader again (needs a reader on this node). */
export const readInvoiceInboxSchema = z.object({}).strict()

/** `POST /pos/inventory/invoice-inbox`: a photo taken on Station, with no delivery. */
export const stationInvoiceInboxSchema = z
	.object({
		clientId: clientIdSchema,
		locationId: inventoryLocationIdSchema,
		fileName: z.string().trim().max(120).optional(),
		contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
		contentBase64: z.string().min(1),
	})
	.strict()

export const invoiceInboxUploadResultSchema = z.object({
	invoices: z.array(invoiceInboxItemSchema),
	/** Files that were not an invoice type, or too many, and were left out. */
	ignored: z.number().int(),
})

/** The normalized message an inbound mail provider's webhook posts (see `POST /webhooks/invoice-mail`). */
export const inboundMailSchema = z.object({
	messageId: z.string().trim().min(1).max(300),
	from: z.object({
		address: z.string().trim().min(3).max(320),
		name: z.string().trim().max(200).optional(),
	}),
	to: z.array(z.string().trim().min(3).max(320)).min(1).max(50),
	subject: z.string().max(500).optional(),
	text: z.string().max(200_000).optional(),
	receivedAt: z.number().int().optional(),
	attachments: z
		.array(
			z.object({
				filename: z.string().max(300).optional(),
				contentType: z.string().max(100),
				contentBase64: z.string(),
			}),
		)
		.max(50),
})
export type InboundMail = z.infer<typeof inboundMailSchema>
