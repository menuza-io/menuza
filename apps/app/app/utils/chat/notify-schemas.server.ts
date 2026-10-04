import { z } from 'zod'

export const chatMessageSchema = z.object({
	id: z.number().int().positive(),
	channel: z.string().min(1),
	parent: z.number().int().positive().nullable(),
	author: z.string().min(1),
	body: z.string(),
	attachments: z.array(z.object({ objectKey: z.string().min(1) })).default([]),
	createdAt: z.number().int(),
	editedAt: z.number().int().nullable(),
	deleted: z.boolean(),
	replyCount: z.number().int().nonnegative(),
	lastReplyAt: z.number().int().nullable(),
	reactions: z.array(
		z.object({
			emoji: z.string(),
			userIds: z.array(z.string()),
		}),
	),
})
