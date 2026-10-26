import { z } from 'zod'

/** Kitchen-only contract. No contacts, prices, payment credentials or staff names. */
const id = z.string().min(1).max(100)
export const kdsStageSchema = z.enum(['new', 'preparing', 'ready'])
export type KdsStage = z.infer<typeof kdsStageSchema>
export const kdsSourceSchema = z.enum(['pos', 'online'])
export type KdsSource = z.infer<typeof kdsSourceSchema>
export const kdsConfigSchema = z
	.strictObject({
		stations: z
			.array(
				z.strictObject({
					id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
					name: z.string().trim().min(1).max(60),
					itemIds: z.array(id).max(1000),
				}),
			)
			.min(1)
			.max(12),
		defaultStationId: id,
		workflow: z.enum(['ticket', 'item']),
		showPreparing: z.boolean(),
		warningMinutes: z.number().int().min(1).max(180),
		lateMinutes: z.number().int().min(2).max(240),
		fireAheadMinutes: z.number().int().min(0).max(240),
	})
	.superRefine((config, ctx) => {
		const ids = config.stations.map((station) => station.id)
		if (
			new Set(ids).size !== ids.length ||
			!ids.includes(config.defaultStationId)
		)
			ctx.addIssue({
				code: 'custom',
				message: 'Choose unique stations and a default station.',
			})
		const items = config.stations.flatMap((station) => station.itemIds)
		if (new Set(items).size !== items.length)
			ctx.addIssue({
				code: 'custom',
				message: 'Route each item to one station only.',
			})
		if (config.lateMinutes <= config.warningMinutes)
			ctx.addIssue({
				code: 'custom',
				message: 'The late threshold must follow the warning threshold.',
			})
	})
export type KdsConfig = z.infer<typeof kdsConfigSchema>
export const DEFAULT_KDS_CONFIG: KdsConfig = {
	stations: [{ id: 'kitchen', name: 'Kitchen', itemIds: [] }],
	defaultStationId: 'kitchen',
	workflow: 'ticket',
	showPreparing: true,
	warningMinutes: 10,
	lateMinutes: 20,
	fireAheadMinutes: 30,
}

export const kdsConfigRequestSchema = z.strictObject({
	expectedVersion: z.number().int().nonnegative(),
	config: kdsConfigSchema,
})
export const kdsCommandSchema = z
	.strictObject({
		source: kdsSourceSchema,
		orderId: id,
		expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
		action: z.enum(['stage', 'done', 'recall']),
		stationId: id.nullable().default(null),
		lineId: id.nullable().default(null),
		stage: kdsStageSchema.optional(),
	})
	.superRefine((command, ctx) => {
		if (command.action === 'stage' && !command.stage)
			ctx.addIssue({ code: 'custom', message: 'Choose a preparation stage.' })
		if (
			command.action !== 'stage' &&
			(command.lineId || command.stationId || command.stage)
		)
			ctx.addIssue({
				code: 'custom',
				message: 'Done and recall apply to the entire ticket.',
			})
	})
export type KdsCommand = z.infer<typeof kdsCommandSchema>

export const kdsLineSchema = z.object({
	id,
	itemId: id,
	name: z.string(),
	quantity: z.number().int().positive(),
	variant: z.string().nullable(),
	variantId: z.string().nullable(),
	options: z.array(
		z.object({
			name: z.string(),
			quantity: z.number().int().positive(),
			half: z.enum(['whole', 'left', 'right']).nullable(),
		}),
	),
	instructions: z.string(),
	stationId: id,
	stage: kdsStageSchema,
	/**
	 * When the till sent this dish (its round). Optional: a feed that does not
	 * know it leaves it out, and the kitchen then tells added dishes by their stage.
	 */
	firedAt: z.number().nullable().optional(),
	/**
	 * When the dish left the pass: the ticket was cleared while it was ready.
	 * Shown on a tab that ordered more since, so the kitchen sees what went out.
	 */
	servedAt: z.number().nullable().optional(),
})
export type KdsLine = z.infer<typeof kdsLineSchema>
export const kdsTicketSchema = z.object({
	id,
	source: kdsSourceSchema,
	number: z.string(),
	channel: z.enum(['counter', 'phone', 'online']),
	fulfillment: z.enum(['dine_in', 'takeaway', 'delivery']),
	tableLabel: z.string().nullable(),
	createdAt: z.number(),
	dueAt: z.number().nullable(),
	version: z.string(),
	completedAt: z.number().nullable(),
	cancelled: z.boolean(),
	lines: z.array(kdsLineSchema),
})
export type KdsTicket = z.infer<typeof kdsTicketSchema>
export const kdsFeedSchema = z.object({
	config: kdsConfigSchema,
	configVersion: z.number().int(),
	tickets: z.array(kdsTicketSchema),
	serverNow: z.number(),
	truncated: z.boolean(),
})
export type KdsFeed = z.infer<typeof kdsFeedSchema>

export function kdsStationFor(config: KdsConfig, itemId: string): string {
	return (
		config.stations.find((station) => station.itemIds.includes(itemId))?.id ??
		config.defaultStationId
	)
}

export function kdsTicketStage(
	lines: readonly Pick<KdsLine, 'stage'>[],
): KdsStage {
	if (lines.length && lines.every((line) => line.stage === 'ready'))
		return 'ready'
	if (lines.some((line) => line.stage !== 'new')) return 'preparing'
	return 'new'
}

/** Scheduled food starts aging when it is released, not when it was ordered. */
export function kdsFireAt(
	ticket: Pick<KdsTicket, 'createdAt' | 'dueAt'>,
	config: KdsConfig,
): number {
	return Math.max(
		ticket.createdAt,
		(ticket.dueAt ?? ticket.createdAt) - config.fireAheadMinutes * 60_000,
	)
}
