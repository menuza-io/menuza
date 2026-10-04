import {
	CHAT_RETENTION_DAY_OPTIONS,
	type ChatRetentionDays,
} from '@repo/common/chat'
import { db, eq, Organization } from '@repo/database'

export { CHAT_RETENTION_DAY_OPTIONS, type ChatRetentionDays }

export async function getChatRetentionDays(
	organizationId: string,
): Promise<ChatRetentionDays> {
	const [row] = await db
		.select({ chatRetentionDays: Organization.chatRetentionDays })
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	const days = row?.chatRetentionDays
	if (days === null || days === undefined) return null
	return CHAT_RETENTION_DAY_OPTIONS.includes(
		days as (typeof CHAT_RETENTION_DAY_OPTIONS)[number],
	)
		? (days as (typeof CHAT_RETENTION_DAY_OPTIONS)[number])
		: null
}

export async function setChatRetentionDays(
	organizationId: string,
	days: ChatRetentionDays,
) {
	await db
		.update(Organization)
		.set({ chatRetentionDays: days, updatedAt: new Date() })
		.where(eq(Organization.id, organizationId))
}
