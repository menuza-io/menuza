import { AuditAction, auditService } from '@repo/audit'
import { and, AuditLog, db, desc, eq, inArray, User } from '@repo/database'
import { type PhoneAgentSettings } from '@repo/phone-agent'

export const PHONE_AGENT_HISTORY_ACTIONS = [
	AuditAction.PHONE_AGENT_SETTINGS_UPDATED,
	AuditAction.PHONE_AGENT_TRAINING_UPDATED,
	AuditAction.PHONE_AGENT_FLOW_PUBLISHED,
] as const

export type PhoneAgentHistoryKind = 'settings' | 'training' | 'flow'

const KIND_BY_ACTION: Record<string, PhoneAgentHistoryKind> = {
	[AuditAction.PHONE_AGENT_SETTINGS_UPDATED]: 'settings',
	[AuditAction.PHONE_AGENT_TRAINING_UPDATED]: 'training',
	[AuditAction.PHONE_AGENT_FLOW_PUBLISHED]: 'flow',
}

/** Top-level settings keys whose values differ, in schema order. */
export function changedSettingKeys(
	before: PhoneAgentSettings,
	after: PhoneAgentSettings,
) {
	return (Object.keys(after) as Array<keyof PhoneAgentSettings>).filter(
		(key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
	)
}

type HistoryInput = {
	organizationId: string
	userId: string
	request?: Request
}

export async function recordSettingsChange(
	input: HistoryInput & {
		before: PhoneAgentSettings
		after: PhoneAgentSettings
	},
) {
	const keys = changedSettingKeys(input.before, input.after)
	if (!keys.length) return
	await auditService.log({
		action: AuditAction.PHONE_AGENT_SETTINGS_UPDATED,
		userId: input.userId,
		organizationId: input.organizationId,
		details: `Phone agent settings changed: ${keys.join(', ')}`,
		// Only key names: values can hold staff phone numbers and emails.
		metadata: { keys },
		request: input.request,
		resourceType: 'phone_agent',
		resourceId: input.organizationId,
	})
}

export async function recordTrainingChange(
	input: HistoryInput & {
		change: 'saved' | 'deleted' | 'activated' | 'deactivated'
		ruleId: string
		title?: string
	},
) {
	await auditService.log({
		action: AuditAction.PHONE_AGENT_TRAINING_UPDATED,
		userId: input.userId,
		organizationId: input.organizationId,
		details: `Phone agent training rule ${input.change}`,
		metadata: {
			change: input.change,
			ruleId: input.ruleId,
			title: input.title?.slice(0, 120),
		},
		request: input.request,
		resourceType: 'phone_agent',
		resourceId: input.organizationId,
	})
}

export async function recordFlowPublished(
	input: HistoryInput & { versionId: string; version: number },
) {
	await auditService.log({
		action: AuditAction.PHONE_AGENT_FLOW_PUBLISHED,
		userId: input.userId,
		organizationId: input.organizationId,
		details: `Phone menu version ${input.version} published`,
		metadata: { versionId: input.versionId, version: input.version },
		request: input.request,
		resourceType: 'phone_agent',
		resourceId: input.organizationId,
	})
}

export type PhoneAgentHistoryEntry = {
	id: string
	kind: PhoneAgentHistoryKind
	createdAt: string
	userName: string | null
	keys: string[]
	change: string | null
	title: string | null
	version: number | null
}

function parseMetadata(raw: string | null): Record<string, unknown> {
	if (!raw) return {}
	try {
		const value: unknown = JSON.parse(raw)
		return value && typeof value === 'object'
			? (value as Record<string, unknown>)
			: {}
	} catch {
		return {}
	}
}

export async function listPhoneAgentHistory(
	organizationId: string,
	limit = 50,
): Promise<PhoneAgentHistoryEntry[]> {
	const rows = await db
		.select({
			id: AuditLog.id,
			action: AuditLog.action,
			metadata: AuditLog.metadata,
			createdAt: AuditLog.createdAt,
			userName: User.name,
			userEmail: User.email,
		})
		.from(AuditLog)
		.leftJoin(User, eq(User.id, AuditLog.userId))
		.where(
			and(
				eq(AuditLog.organizationId, organizationId),
				inArray(AuditLog.action, [...PHONE_AGENT_HISTORY_ACTIONS]),
			),
		)
		.orderBy(desc(AuditLog.createdAt))
		.limit(Math.min(Math.max(limit, 1), 200))

	return rows.map((row) => {
		const metadata = parseMetadata(row.metadata)
		const keys = Array.isArray(metadata.keys)
			? metadata.keys.filter((key): key is string => typeof key === 'string')
			: []
		return {
			id: row.id,
			kind: KIND_BY_ACTION[row.action] ?? 'settings',
			createdAt: row.createdAt.toISOString(),
			userName: row.userName ?? row.userEmail ?? null,
			keys,
			change: typeof metadata.change === 'string' ? metadata.change : null,
			title: typeof metadata.title === 'string' ? metadata.title : null,
			version: typeof metadata.version === 'number' ? metadata.version : null,
		}
	})
}
