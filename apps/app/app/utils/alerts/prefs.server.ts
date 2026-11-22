import {
	defaultAlertChannels,
	defaultPushEnabled,
	isOrderAlertKind,
	PUSH_CATEGORY_WORKFLOW,
	type OrderAlertKind,
	type PushCategory,
} from '@repo/common/operator-alerts'
import { and, db, eq, inArray, NotificationPreference } from '@repo/database'

export type MemberChannelPrefs = {
	inApp: boolean
	email: boolean
	push: boolean
}

type Row = {
	userId: string
	workflow: string
	email: boolean
	inApp: boolean
	push: boolean | null
}

/** Every preference row of these members for these workflows, in one query. */
async function loadRows(input: {
	organizationId: string
	userIds: readonly string[]
	workflows: readonly string[]
}): Promise<Row[]> {
	if (input.userIds.length === 0 || input.workflows.length === 0) return []
	return db
		.select({
			userId: NotificationPreference.userId,
			workflow: NotificationPreference.workflow,
			email: NotificationPreference.email,
			inApp: NotificationPreference.inApp,
			push: NotificationPreference.push,
		})
		.from(NotificationPreference)
		.where(
			and(
				eq(NotificationPreference.organizationId, input.organizationId),
				inArray(NotificationPreference.userId, [...input.userIds]),
				inArray(NotificationPreference.workflow, [...input.workflows]),
			),
		)
}

/**
 * The channels each member gets an order or tablet alert on: their own row
 * when they chose, else the defaults (`defaultAlertChannels`, and
 * `defaultPushEnabled` for the member's role).
 */
export async function loadOrderAlertPrefs(input: {
	organizationId: string
	kind: OrderAlertKind
	members: ReadonlyArray<{ userId: string; isManager: boolean }>
	category: PushCategory
}): Promise<Map<string, MemberChannelPrefs>> {
	const workflow = PUSH_CATEGORY_WORKFLOW[input.category]
	const rows = await loadRows({
		organizationId: input.organizationId,
		userIds: input.members.map((member) => member.userId),
		workflows: [input.kind, workflow],
	})
	const defaults = defaultAlertChannels(input.kind)
	const out = new Map<string, MemberChannelPrefs>()
	for (const member of input.members) {
		const own = rows.find(
			(row) => row.userId === member.userId && row.workflow === input.kind,
		)
		const pushRow = rows.find(
			(row) => row.userId === member.userId && row.workflow === workflow,
		)
		out.set(member.userId, {
			inApp: own?.inApp ?? defaults.inApp,
			email: own?.email ?? defaults.email,
			push:
				pushRow?.push ?? defaultPushEnabled(input.category, member.isManager),
		})
	}
	return out
}

/** Whether one member has the push for a category on (their choice, else the default). */
export async function loadPushPreference(input: {
	organizationId: string
	userId: string
	category: PushCategory
	isManager: boolean
}): Promise<boolean> {
	const workflow = PUSH_CATEGORY_WORKFLOW[input.category]
	const [row] = await db
		.select({ push: NotificationPreference.push })
		.from(NotificationPreference)
		.where(
			and(
				eq(NotificationPreference.userId, input.userId),
				eq(NotificationPreference.organizationId, input.organizationId),
				eq(NotificationPreference.workflow, workflow),
			),
		)
		.limit(1)
	return row?.push ?? defaultPushEnabled(input.category, input.isManager)
}

export { isOrderAlertKind }
