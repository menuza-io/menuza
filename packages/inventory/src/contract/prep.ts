import { z } from 'zod'
import { inventoryLocationIdSchema } from '../token.ts'
import { inventoryBaseUnitSchema } from '../units.ts'
import {
	clientIdSchema,
	expectedVersionSchema,
	inventoryIdSchema,
	inventoryNoteSchema,
	isoDateSchema,
	nonNegativeQuantitySchema,
	typedAmountSchema,
	unitRefSchema,
} from './common.ts'
import { itemUnitSchema } from './items.ts'

/**
 * Prep (phase 4, behind `inventory.prep`): what to make today, from "fill up
 * to" levels per weekday, what is on hand and how busy the weekday usually is.
 *
 * Operators: `GET /prep`, `POST /prep/generate`, `GET|PUT /prep/levels`,
 * `POST /prep/tasks/:id/start|done|skip`. Stations: the same plan and the same
 * three task actions under `/pos/inventory/prep` (online only; the Kitchen
 * rules apply: a write is read back after an uncertain answer and never
 * replayed blindly). No money anywhere: a prep list is quantities.
 *
 * Quantities are base thousandths of the made item. Marking a task done
 * records a batch (the made item goes into stock and its ingredients come
 * out), so it needs a recipe for the item (409 `recipe_empty` otherwise).
 */

export const PREP_STATUSES = ['todo', 'in_progress', 'done', 'skipped'] as const
export type PrepStatus = (typeof PREP_STATUSES)[number]
export const prepStatusSchema = z.enum(PREP_STATUSES)

/** How far from today a plan can be asked for (yesterday for a late check, tomorrow to plan ahead). */
export const PREP_DAYS_BEHIND = 1
export const PREP_DAYS_AHEAD = 1

export const prepStationSchema = z.object({
	id: z.string(),
	name: z.string(),
})

/** What the plan was worked out from, so every number can explain itself. */
export const prepExplainSchema = z.object({
	/** Fill up to for this weekday, base thousandths, before the weekday factor. */
	fillUpTo: z.number().int(),
	/** After the weekday factor: what the kitchen should have by service. */
	target: z.number().int(),
	onHand: z.number().int(),
	/** 10000 is a normal day; 12000 sells 20% more. */
	demandBp: z.number().int(),
	/** What branches have asked this place for and not yet taken (a central kitchen), base thousandths. */
	committed: z.number().int().optional(),
})

export const prepTaskSchema = z.object({
	id: z.string(),
	itemId: z.string(),
	itemName: z.string(),
	baseUnit: inventoryBaseUnitSchema,
	countUnit: unitRefSchema,
	units: z.array(itemUnitSchema),
	stationId: z.string().nullable(),
	businessDate: isoDateSchema,
	/** What to make, base thousandths. */
	plannedQuantity: z.number().int(),
	/** One batch of the recipe, base thousandths (the plan rounds up to whole batches). */
	batchSize: z.number().int().nullable(),
	batches: z.number().int().nullable(),
	explain: prepExplainSchema,
	status: prepStatusSchema,
	startedAt: z.number().int().nullable(),
	doneAt: z.number().int().nullable(),
	madeQuantity: z.number().int().nullable(),
	version: z.number().int(),
})
export type PrepTask = z.infer<typeof prepTaskSchema>

export const prepDemandSchema = z.object({
	bp: z.number().int(),
	/** A pattern was found; false leaves the plan at the fill-up level. */
	known: z.boolean(),
	ramadan: z.boolean(),
	samples: z.number().int(),
})

/** `GET /prep?locationId=&date=`. */
export const prepQuerySchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		date: isoDateSchema.optional(),
		/** Only tasks of this kitchen station (and tasks with none). */
		stationId: z.string().min(1).max(100).optional(),
	})
	.strict()

export const prepPlanSchema = z.object({
	locationId: z.string(),
	date: isoDateSchema,
	stations: z.array(prepStationSchema),
	demand: prepDemandSchema,
	/** The plan has been made for this day (it has tasks, or nothing needed making). */
	generated: z.boolean(),
	/** Some made item has a fill-up level, so a plan can be made. */
	canGenerate: z.boolean(),
	tasks: z.array(prepTaskSchema),
})
export type PrepPlan = z.infer<typeof prepPlanSchema>

/** `POST /prep/generate`: makes (or refreshes, for tasks not yet started) the day's plan. */
export const generatePrepSchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		date: isoDateSchema.optional(),
	})
	.strict()

export const prepLevelItemSchema = z.object({
	itemId: z.string(),
	name: z.string(),
	baseUnit: inventoryBaseUnitSchema,
	countUnit: unitRefSchema,
	units: z.array(itemUnitSchema),
	stationId: z.string().nullable(),
	/** Fill up to per weekday (0 Sunday ... 6 Saturday), `null` meaning "the item's usual level". */
	weekdays: z.array(z.number().int().nullable()).length(7),
	/** The item's usual "fill up to" at this location. */
	usual: z.number().int().nullable(),
	batchSize: z.number().int().nullable(),
	version: z.number().int(),
})
export type PrepLevelItem = z.infer<typeof prepLevelItemSchema>

/** `GET /prep/levels?locationId=`: every made item with its weekday levels. */
export const prepLevelsSchema = z.object({
	locationId: z.string(),
	stations: z.array(prepStationSchema),
	items: z.array(prepLevelItemSchema),
})
export type PrepLevels = z.infer<typeof prepLevelsSchema>

/** `PUT /prep/levels` (`update:inventory:any`): one made item's levels and station at a location. */
export const putPrepLevelsSchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		itemId: inventoryIdSchema,
		stationId: z.string().min(1).max(100).nullable(),
		weekdays: z.array(nonNegativeQuantitySchema.nullable()).length(7),
		expectedVersion: expectedVersionSchema,
	})
	.strict()

export type PutPrepLevels = z.infer<typeof putPrepLevelsSchema>

/** Start and skip carry the version the screen read (409 `stale_version`). */
export const prepTaskActionSchema = z
	.object({ expectedVersion: expectedVersionSchema })
	.strict()

/** `POST /prep/tasks/:id/done`: how much came out, as in "Record a batch". */
export const doneTaskSchema = z
	.object({
		expectedVersion: expectedVersionSchema,
		clientId: clientIdSchema,
		made: z.discriminatedUnion('kind', [
			z
				.object({
					kind: z.literal('batches'),
					count: z.number().finite().positive().max(1000),
				})
				.strict(),
			z
				.object({
					kind: z.literal('amount'),
					amount: typedAmountSchema.refine((a) => a > 0, 'Must be above zero'),
					unit: unitRefSchema,
				})
				.strict(),
		]),
		note: inventoryNoteSchema.optional(),
	})
	.strict()
export type DoneTask = z.infer<typeof doneTaskSchema>

/** Station paths, for clients and tests. */
export const PREP_POS_PATHS = {
	plan: '/pos/inventory/prep',
	generate: '/pos/inventory/prep/generate',
	start: (id: string) => `/pos/inventory/prep/tasks/${id}/start`,
	done: (id: string) => `/pos/inventory/prep/tasks/${id}/done`,
	skip: (id: string) => `/pos/inventory/prep/tasks/${id}/skip`,
} as const
