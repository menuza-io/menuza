import { db, eq, PlatformMarketingMessage } from '@repo/database'
import {
	getMarketingEmailTagValue,
	isPlatformMarketingEmailScope,
} from '@repo/config/marketing-email'
import { z } from 'zod'

export { MARKETING_EMAIL_PLATFORM_SCOPE } from '@repo/config/marketing-email'

const resendTagsSchema = z.record(z.string(), z.string())

const resendEngagementEventSchema = z.object({
	type: z.enum(['email.opened', 'email.clicked']),
	created_at: z.string(),
	data: z.object({
		email_id: z.string(),
		created_at: z.string().optional(),
		tags: resendTagsSchema.optional(),
		click: z
			.object({
				timestamp: z.string(),
			})
			.optional(),
	}),
})

export type PlatformResendWebhookResult =
	| { handled: true; messageId: string; action: 'open' | 'click' }
	| { handled: false; reason: string }

function resolveOccurredAt(
	event: z.infer<typeof resendEngagementEventSchema>,
): Date {
	if (event.type === 'email.clicked' && event.data.click?.timestamp) {
		return new Date(event.data.click.timestamp)
	}
	if (event.data.created_at) {
		return new Date(event.data.created_at)
	}
	return new Date(event.created_at)
}

export function getPlatformResendEngagementUpdates(
	existing: typeof PlatformMarketingMessage.$inferSelect,
	action: 'open' | 'click',
	occurredAt: Date,
) {
	const updates: Partial<typeof PlatformMarketingMessage.$inferInsert> = {}

	if (action === 'open') {
		if (!existing.openedAt) {
			updates.openedAt = occurredAt
		}
		if (existing.status === 'Sent' || existing.status === 'Processing') {
			updates.status = 'Opened'
		}
	}

	if (action === 'click') {
		if (!existing.clickedAt || occurredAt > existing.clickedAt) {
			updates.clickedAt = occurredAt
		}
		if (!existing.openedAt) {
			updates.openedAt = occurredAt
		}
		updates.status = 'Clicked'
	}

	return updates
}

async function findPlatformMessage(
	event: z.infer<typeof resendEngagementEventSchema>,
) {
	const tags = event.data.tags ?? {}
	if (!isPlatformMarketingEmailScope(tags)) {
		return null
	}

	const messageId = getMarketingEmailTagValue(tags, 'messageId')
	if (messageId) {
		const [byTag] = await db
			.select()
			.from(PlatformMarketingMessage)
			.where(eq(PlatformMarketingMessage.id, messageId))
		if (byTag) return byTag
	}

	const [byProvider] = await db
		.select()
		.from(PlatformMarketingMessage)
		.where(eq(PlatformMarketingMessage.providerMessageId, event.data.email_id))

	return byProvider ?? null
}

export async function handlePlatformResendWebhook(
	payload: unknown,
): Promise<PlatformResendWebhookResult> {
	const parsed = resendEngagementEventSchema.safeParse(payload)
	if (!parsed.success) {
		return { handled: false, reason: 'unsupported_event' }
	}

	const event = parsed.data
	const action = event.type === 'email.opened' ? 'open' : 'click'
	const message = await findPlatformMessage(event)

	if (!message) {
		return { handled: false, reason: 'message_not_found' }
	}

	const updates = getPlatformResendEngagementUpdates(
		message,
		action,
		resolveOccurredAt(event),
	)
	if (Object.keys(updates).length === 0) {
		return { handled: true, messageId: message.id, action }
	}

	await db
		.update(PlatformMarketingMessage)
		.set(updates)
		.where(eq(PlatformMarketingMessage.id, message.id))

	return { handled: true, messageId: message.id, action }
}
