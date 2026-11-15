import { z } from 'zod'

const stepSchema = z.object({
	key: z.string(),
	optional: z.boolean(),
	state: z.enum(['done', 'todo', 'optional', 'skipped']),
	completedAt: z.string().nullable(),
	skippedAt: z.string().nullable(),
})

/** What the App answers: state and dates only, never a guest field. */
export const launchStatusSchema = z.object({
	enabled: z.boolean(),
	createdAt: z.string(),
	daysSinceSignup: z.number().int(),
	firstOrderAt: z.string().nullable(),
	regionAnswered: z.boolean(),
	locations: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			live: z.boolean(),
			liveAt: z.string().nullable(),
			requiredDone: z.number().int(),
			requiredTotal: z.number().int(),
			steps: z.array(stepSchema),
		}),
	),
})
export type LaunchStatus = z.infer<typeof launchStatusSchema>

export type LaunchStatusResult =
	{ status: 'ok'; launch: LaunchStatus } | { status: 'unavailable' }
