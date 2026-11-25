import { z } from 'zod'
import { inventoryLocationIdSchema } from '../token.ts'
import { inventoryBaseUnitSchema } from '../units.ts'
import { inventoryCurrencySchema, inventoryMinorSchema } from '../money.ts'
import {
	clientIdSchema,
	currencyOut,
	expectedVersionSchema,
	inventoryIdSchema,
	inventoryNoteSchema,
	isoDateSchema,
	minorOut,
	typedAmountSchema,
	unitRefSchema,
} from './common.ts'
import { itemUnitSchema } from './items.ts'

/**
 * Transfers between locations and branch requests to a central kitchen
 * (phase 5, behind `inventory.transfers`).
 *
 * Two ways in, one record:
 * - a **request** (`kind: 'request'`) is made by the place that needs stock
 *   (a branch asks the central kitchen) and starts as `requested`;
 * - a **transfer** (`kind: 'transfer'`) is made by the place that has the
 *   stock and starts as `draft`.
 *
 * Either goes `sent` (the sending place confirms what it really sends: stock
 * leaves it then, as `transfer_out`) and `received` (the receiving place
 * confirms what arrived: stock enters it, as `transfer_in`). Whatever was sent
 * and not received is "missing in transit" and shows on the record. A transfer
 * that has not been sent can be `cancelled`; once stock has left, it is
 * received. Open requests to a central kitchen also feed its prep list.
 *
 * Needs `update:inventory:any`; the sender's location must be one the token
 * may use to send, the receiver's to receive, and anyone with either may read.
 * Quantities are base thousandths; money (the value moved, at average cost)
 * needs `read:inventory_cost:any` and is left out without it.
 */

export const TRANSFER_KINDS = ['transfer', 'request'] as const
export type TransferKind = (typeof TRANSFER_KINDS)[number]
export const transferKindSchema = z.enum(TRANSFER_KINDS)

export const TRANSFER_STATUSES = [
	'requested',
	'draft',
	'sent',
	'received',
	'cancelled',
] as const
export type TransferStatus = (typeof TRANSFER_STATUSES)[number]
export const transferStatusSchema = z.enum(TRANSFER_STATUSES)

export const MAX_TRANSFER_LINES = 100
export const MAX_OPEN_TRANSFERS_PER_LOCATION = 100

/** A line as a person typed it: an item and an amount in a unit. */
export const transferLineInputSchema = z
	.object({
		itemId: inventoryIdSchema,
		amount: typedAmountSchema.refine((a) => a > 0, 'Must be above zero'),
		unit: unitRefSchema,
	})
	.strict()
export type TransferLineInput = z.infer<typeof transferLineInputSchema>

const linesSchema = z
	.array(transferLineInputSchema)
	.min(1)
	.max(MAX_TRANSFER_LINES)
	.superRefine((lines, ctx) => {
		const seen = new Set<string>()
		lines.forEach((line, index) => {
			if (seen.has(line.itemId)) {
				ctx.addIssue({
					code: 'custom',
					path: [index, 'itemId'],
					message: 'Each item once',
				})
			}
			seen.add(line.itemId)
		})
	})

/**
 * `POST /transfers`. A request names the place that needs stock as `toLocationId`
 * and the place asked as `fromLocationId`; a transfer is the other way round in
 * who creates it. The caller's token must cover the creating place (the
 * receiver of a request, the sender of a transfer). A replayed `clientId`
 * answers the first record.
 */
export const createTransferSchema = z
	.object({
		clientId: clientIdSchema,
		kind: transferKindSchema,
		fromLocationId: inventoryLocationIdSchema,
		toLocationId: inventoryLocationIdSchema,
		lines: linesSchema,
		note: inventoryNoteSchema.optional(),
	})
	.strict()
	.refine((body) => body.fromLocationId !== body.toLocationId, {
		message: 'A transfer needs two different places',
		path: ['toLocationId'],
	})
export type CreateTransfer = z.infer<typeof createTransferSchema>

/** `PATCH /transfers/:id`: change the lines or note while it is `requested` or `draft`. */
export const patchTransferSchema = z
	.object({
		expectedVersion: expectedVersionSchema,
		lines: linesSchema.optional(),
		note: inventoryNoteSchema.nullable().optional(),
		/**
		 * The place editing, when the token covers both ends (the place that made
		 * the record, or for a request the place it was made to).
		 */
		locationId: inventoryLocationIdSchema.optional(),
	})
	.strict()
	.refine((body) => body.lines !== undefined || body.note !== undefined, {
		message: 'Nothing to change',
	})

/**
 * `POST /transfers/:id/send` (sender's place): `lines` are the amounts really
 * sent (default: what was asked for, or typed). An item left out is sent as 0
 * and an item not on the record is refused; sending less than asked is fine.
 */
export const sendTransferSchema = z
	.object({
		expectedVersion: expectedVersionSchema,
		lines: z
			.array(
				z
					.object({
						itemId: inventoryIdSchema,
						amount: typedAmountSchema,
						unit: unitRefSchema,
					})
					.strict(),
			)
			.max(MAX_TRANSFER_LINES)
			.optional(),
	})
	.strict()

/** `POST /transfers/:id/receive` (receiver's place): `lines` are the amounts that arrived (default: what was sent). */
export const receiveTransferSchema = sendTransferSchema

/** `POST /transfers/:id/cancel`. */
export const cancelTransferSchema = z
	.object({ expectedVersion: expectedVersionSchema })
	.strict()

/** Where a sent line's price came from (#526): the item's fixed price, its cost plus a percentage, or its cost. */
export const TRANSFER_PRICE_SOURCES = ['fixed', 'cost_plus', 'cost'] as const
export const transferPriceSourceSchema = z.enum(TRANSFER_PRICE_SOURCES)
export type TransferPriceSource = z.infer<typeof transferPriceSourceSchema>

export const transferLineSchema = z.object({
	itemId: z.string(),
	itemName: z.string(),
	baseUnit: inventoryBaseUnitSchema,
	countUnit: unitRefSchema,
	units: z.array(itemUnitSchema),
	/** What was asked for or planned. */
	requestedQuantity: z.number().int(),
	sentQuantity: z.number().int().nullable(),
	receivedQuantity: z.number().int().nullable(),
	/** Sent and not received (only once received). */
	missingQuantity: z.number().int().nullable(),
	/** What is on hand at the sending place now, to help fill the send. */
	onHandAtSender: z.number().int(),
	/**
	 * What this line asked for before the other place changed it (#477):
	 * present only on a line that was changed or added since (0: added).
	 */
	askedQuantity: z.number().int().nullable().optional(),
	/** The price per base unit (micro-minor) fixed when it was sent (#526). Cost grant. */
	unitPriceMicro: z.number().int().optional(),
	/** Where that price came from (#526). Cost grant. */
	priceSource: transferPriceSourceSchema.optional(),
	valueMinor: minorOut,
})
export type TransferLine = z.infer<typeof transferLineSchema>

export const transferSummarySchema = z.object({
	id: z.string(),
	number: z.number().int(),
	kind: transferKindSchema,
	status: transferStatusSchema,
	fromLocationId: z.string(),
	toLocationId: z.string(),
	lineCount: z.number().int(),
	note: z.string().nullable(),
	createdAt: z.number().int(),
	sentAt: z.number().int().nullable(),
	receivedAt: z.number().int().nullable(),
	/** Sent and not received, over every line (only once received). */
	missingLines: z.number().int(),
	/** When an open transfer's lines were last edited (#477), or null. */
	editedAt: z.number().int().nullable().optional(),
	/** A request whose lines the sending place changed: the branch sees it as changed (#477). */
	changedBySender: z.boolean().optional(),
	/** The value moved: at the transfer price where one was fixed, else at cost. Cost grant. */
	valueMinor: minorOut,
	currency: currencyOut,
	version: z.number().int(),
})
export type TransferSummary = z.infer<typeof transferSummarySchema>

export const transferDetailSchema = transferSummarySchema.extend({
	lines: z.array(transferLineSchema),
})
export type TransferDetail = z.infer<typeof transferDetailSchema>

/**
 * `GET /transfers?locationId=&direction=&status=`: transfers touching a
 * location (`direction`: `in` for those it receives, `out` for those it sends,
 * `all`), newest first. `status=open` is requested, draft and sent.
 */
export const listTransfersQuerySchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		direction: z.enum(['in', 'out', 'all']).default('all'),
		status: z.enum(['open', ...TRANSFER_STATUSES, 'all']).default('open'),
		limit: z.coerce.number().int().min(1).max(100).default(30),
	})
	.strict()

export const listTransfersResultSchema = z.object({
	transfers: z.array(transferSummarySchema),
})
export type ListTransfersResult = z.infer<typeof listTransfersResultSchema>

/** Statuses a transfer can still change in. */
export const EDITABLE_TRANSFER_STATUSES = [
	'requested',
	'draft',
] as const satisfies readonly TransferStatus[]

// ── Location comparison ─────────────────────────────────────────────────────

export const MAX_COMPARE_LOCATIONS = 20

/** `GET /compare?locationIds=a,b,c`: the locations the token covers among those named (the App sends its own list). */
export const compareQuerySchema = z
	.object({
		locationIds: z
			.string()
			.min(1)
			.max(1500)
			.transform((value) =>
				[...new Set(value.split(',').map((part) => part.trim()))].filter(
					(part) => part !== '',
				),
			)
			.pipe(
				z.array(inventoryLocationIdSchema).min(1).max(MAX_COMPARE_LOCATIONS),
			),
	})
	.strict()

/**
 * One row of the comparison: the same few numbers for every location, so an
 * owner can see which branch is off. Money (stock value, waste cost, food
 * cost) needs the cost grant and is left out without it.
 */
export const compareRowSchema = z.object({
	locationId: z.string(),
	lowItems: z.number().int(),
	outItems: z.number().int(),
	lastCountAt: z.number().int().nullable(),
	wasteWeekCount: z.number().int(),
	/** Transfers waiting to be received here / waiting to leave here. */
	incomingTransfers: z.number().int(),
	outgoingTransfers: z.number().int(),
	stockValueMinor: minorOut,
	wasteWeekMinor: minorOut,
	foodCost: z
		.object({
			state: z.enum(['ok', 'need_two_counts', 'no_sales']),
			bp: z.number().int().nullable().optional(),
			targetBp: z.number().int(),
		})
		.optional(),
	currency: currencyOut,
})
export type CompareRow = z.infer<typeof compareRowSchema>

export const compareSchema = z.object({
	date: z.string(),
	rows: z.array(compareRowSchema),
})
export type Compare = z.infer<typeof compareSchema>

// ── Transfer prices and what branches can request (#526) ────────────────────

/**
 * Per item at the SENDING location: the transfer price a branch is charged
 * (`fixed` per unit, or the item's cost plus `markupBp`, or `none`: the
 * receiver is charged cost) and whether branches may ask for it
 * (`branchRequestable`, on unless an owner turns it off).
 *
 * The price in force is read when a transfer is SENT and copied onto its lines
 * (`unitPriceMicro`); a later change never touches a sent transfer. Prices are
 * money and need `read:inventory_cost:any` to read and to set; the
 * requestable switch needs only `update:inventory:any`. Station never gets
 * either (its catalogue lists only which items are NOT requestable).
 */
export const TRANSFER_PRICE_MODES = ['none', 'fixed', 'cost_plus'] as const
export const transferPriceModeSchema = z.enum(TRANSFER_PRICE_MODES)
export type TransferPriceMode = z.infer<typeof transferPriceModeSchema>

/** Highest markup: cost + 1000% (basis points). */
export const MAX_TRANSFER_MARKUP_BP = 100_000

/** `GET /transfer-terms?locationId=` (the sending place; read grant). */
export const transferTermsQuerySchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		/** Only items a branch cannot request or that have a price. */
		onlySet: z.enum(['true', 'false']).default('false'),
		search: z.string().trim().max(100).optional(),
	})
	.strict()

export const transferTermSchema = z.object({
	itemId: z.string(),
	itemName: z.string(),
	baseUnit: inventoryBaseUnitSchema,
	branchRequestable: z.boolean(),
	/** Money fields below need the cost grant and are left out without it. */
	priceMode: transferPriceModeSchema.optional(),
	fixedPriceMicro: z.number().int().nullable().optional(),
	markupBp: z.number().int().nullable().optional(),
	currency: currencyOut,
	/** The item's cost per base unit now. */
	costMicro: z.number().int().nullable().optional(),
	/** What a send would charge per base unit now (null: cost is unknown). */
	effectivePriceMicro: z.number().int().nullable().optional(),
	/** 0 when nothing was ever set. */
	version: z.number().int(),
})
export type TransferTerm = z.infer<typeof transferTermSchema>

export const transferTermsResultSchema = z.object({
	terms: z.array(transferTermSchema),
})

/**
 * `PUT /transfer-terms/:itemId`. `fixedPrice` is a price per ONE `per` unit
 * ("12.00 per kg"); setting any price needs the cost grant (403 otherwise),
 * `branchRequestable` alone does not. `expectedVersion` is the version read
 * (0 when never set): another value is 409 `stale_version`.
 */
export const putTransferTermsSchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		expectedVersion: expectedVersionSchema,
		branchRequestable: z.boolean().optional(),
		priceMode: transferPriceModeSchema.optional(),
		fixedPrice: z
			.object({
				priceMinor: inventoryMinorSchema,
				per: unitRefSchema,
				currency: inventoryCurrencySchema,
			})
			.strict()
			.optional(),
		markupBp: z.number().int().min(0).max(MAX_TRANSFER_MARKUP_BP).optional(),
	})
	.strict()
	.superRefine((body, ctx) => {
		if (body.priceMode === 'fixed' && !body.fixedPrice) {
			ctx.addIssue({ code: 'custom', path: ['fixedPrice'], message: 'Required' })
		}
		if (body.priceMode === 'cost_plus' && body.markupBp === undefined) {
			ctx.addIssue({ code: 'custom', path: ['markupBp'], message: 'Required' })
		}
		if (
			body.branchRequestable === undefined &&
			body.priceMode === undefined
		) {
			ctx.addIssue({ code: 'custom', message: 'Nothing to change' })
		}
	})
export type PutTransferTerms = z.infer<typeof putTransferTermsSchema>

/**
 * `GET /transfers/owed?locationId=&from=&to=`: what each branch owes the
 * sending place for transfers SENT in the period (business dates), at the
 * price fixed on each line, with the cost it left at. Cost grant: without it
 * only counts are returned.
 */
export const transfersOwedQuerySchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		from: isoDateSchema,
		to: isoDateSchema,
	})
	.strict()

export const transferOwedRowSchema = z.object({
	toLocationId: z.string(),
	transfers: z.number().int(),
	lines: z.number().int(),
	/** Value at the transfer price (cost where no price was set). */
	owedMinor: minorOut,
	/** The same stock at cost, so the place sees its margin. */
	costMinor: minorOut,
	currency: currencyOut,
})

export const transfersOwedSchema = z.object({
	from: isoDateSchema,
	to: isoDateSchema,
	rows: z.array(transferOwedRowSchema),
	owedMinor: minorOut,
	costMinor: minorOut,
	currency: currencyOut,
})
export type TransfersOwed = z.infer<typeof transfersOwedSchema>

/**
 * `GET /transfers/not-offered?fromLocationId=`: the items a place does NOT
 * offer to branches, as ids only, so a branch's request form leaves them out.
 * Any token that may read inventory may ask (it names no price and no stock);
 * the region refuses such a request anyway (409 `item_not_requestable`).
 */
export const transfersNotOfferedQuerySchema = z
	.object({ fromLocationId: inventoryLocationIdSchema })
	.strict()
export const transfersNotOfferedSchema = z.object({
	itemIds: z.array(z.string()),
})
export type TransfersNotOffered = z.infer<typeof transfersNotOfferedSchema>
