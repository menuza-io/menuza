import {
	CHAT_LIMITS,
	type ChatChannelDetail,
	type ChatChannelInput,
	type ChatChannelSummary,
} from '@repo/common/chat'
import { decorateChannelSummaries } from './conversations.server.ts'
import {
	and,
	asc,
	db,
	eq,
	inArray,
	or,
	OrganizationChatChannel,
	OrganizationChatChannelMember,
	OrganizationChatChannelRole,
	OrganizationRole,
	User,
	UserOrganization,
} from '@repo/database'
import { BUILT_IN_ORG_ROLE_IDS } from '#app/routes/_app+/$orgSlug_+/settings+/roles.server.ts'

/** Rows inserted per statement; D1 allows 100 bound parameters. */
const INSERT_CHUNK = 40

/** A validation failure the manage form can show next to a field. */
export class ChatChannelError extends Error {
	constructor(
		message: string,
		readonly field: 'name' | 'roleIds' | 'memberIds' | 'form' = 'form',
	) {
		super(message)
		this.name = 'ChatChannelError'
	}
}

function chunk<T>(items: T[], size: number) {
	const chunks: T[][] = []
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size))
	}
	return chunks
}

/**
 * Channels the user may open: every `everyone` channel plus restricted ones
 * that list their role or name them. Must agree with
 * `resolveChannelAudiences`, which is what the realtime path enforces.
 */
export async function listChannelsForUser(
	organizationId: string,
	userId: string,
): Promise<ChatChannelSummary[]> {
	const [membership] = await db
		.select({ roleId: UserOrganization.organizationRoleId })
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.active, true),
			),
		)
		.limit(1)
	if (!membership) return []

	const [viaRole, viaMember] = await Promise.all([
		db
			.select({ channelId: OrganizationChatChannelRole.channelId })
			.from(OrganizationChatChannelRole)
			.where(
				eq(OrganizationChatChannelRole.organizationRoleId, membership.roleId),
			),
		db
			.select({ channelId: OrganizationChatChannelMember.channelId })
			.from(OrganizationChatChannelMember)
			.where(eq(OrganizationChatChannelMember.userId, userId)),
	])
	const allowed = new Set([
		...viaRole.map((row) => row.channelId),
		...viaMember.map((row) => row.channelId),
	])

	type ChannelRow = {
		id: string
		name: string
		description: string
		access: 'everyone' | 'restricted'
		kind: 'channel' | 'dm' | 'group'
		createdById: string | null
		showHistoryToNewMembers: boolean
	}
	const byId = new Map<string, ChannelRow>()

	const publicTeamChannels = await db
		.select({
			id: OrganizationChatChannel.id,
			name: OrganizationChatChannel.name,
			description: OrganizationChatChannel.description,
			access: OrganizationChatChannel.access,
			kind: OrganizationChatChannel.kind,
			createdById: OrganizationChatChannel.createdById,
			showHistoryToNewMembers: OrganizationChatChannel.showHistoryToNewMembers,
		})
		.from(OrganizationChatChannel)
		.where(
			and(
				eq(OrganizationChatChannel.organizationId, organizationId),
				eq(OrganizationChatChannel.kind, 'channel'),
				eq(OrganizationChatChannel.access, 'everyone'),
			),
		)
	for (const row of publicTeamChannels) byId.set(row.id, row)

	for (const ids of chunk([...allowed], 50)) {
		if (ids.length === 0) continue
		const memberChannels = await db
			.select({
				id: OrganizationChatChannel.id,
				name: OrganizationChatChannel.name,
				description: OrganizationChatChannel.description,
				access: OrganizationChatChannel.access,
				kind: OrganizationChatChannel.kind,
				createdById: OrganizationChatChannel.createdById,
				showHistoryToNewMembers:
					OrganizationChatChannel.showHistoryToNewMembers,
			})
			.from(OrganizationChatChannel)
			.where(
				and(
					eq(OrganizationChatChannel.organizationId, organizationId),
					inArray(OrganizationChatChannel.id, ids),
				),
			)
		for (const row of memberChannels) byId.set(row.id, row)
	}

	const all = [...byId.values()]
	const conversations = all.filter(
		(channel) => channel.kind === 'dm' || channel.kind === 'group',
	)
	const teamChannels = all
		.filter((channel) => channel.kind === 'channel')
		.sort((a, b) => a.name.localeCompare(b.name))
		.slice(0, CHAT_LIMITS.syncChannelsMax)
	const visible = [...conversations, ...teamChannels].sort((a, b) =>
		a.name.localeCompare(b.name),
	)
	return decorateChannelSummaries(organizationId, userId, visible)
}

/** Every channel in the org with its roles and members, for the manage page. */
export async function listChannelsForManager(
	organizationId: string,
): Promise<ChatChannelDetail[]> {
	const channels = await db
		.select({
			id: OrganizationChatChannel.id,
			name: OrganizationChatChannel.name,
			description: OrganizationChatChannel.description,
			access: OrganizationChatChannel.access,
			kind: OrganizationChatChannel.kind,
			createdById: OrganizationChatChannel.createdById,
			showHistoryToNewMembers: OrganizationChatChannel.showHistoryToNewMembers,
		})
		.from(OrganizationChatChannel)
		.where(
			and(
				eq(OrganizationChatChannel.organizationId, organizationId),
				eq(OrganizationChatChannel.kind, 'channel'),
			),
		)
		.orderBy(asc(OrganizationChatChannel.name))
		.limit(CHAT_LIMITS.syncChannelsMax)
	if (channels.length === 0) return []

	const roleIds = new Map<string, string[]>()
	const memberIds = new Map<string, string[]>()
	for (const ids of chunk(
		channels.map((channel) => channel.id),
		50,
	)) {
		const [roleRows, memberRows] = await Promise.all([
			db
				.select({
					channelId: OrganizationChatChannelRole.channelId,
					roleId: OrganizationChatChannelRole.organizationRoleId,
				})
				.from(OrganizationChatChannelRole)
				.where(inArray(OrganizationChatChannelRole.channelId, ids)),
			db
				.select({
					channelId: OrganizationChatChannelMember.channelId,
					userId: OrganizationChatChannelMember.userId,
				})
				.from(OrganizationChatChannelMember)
				.where(inArray(OrganizationChatChannelMember.channelId, ids)),
		])
		for (const row of roleRows) {
			roleIds.set(row.channelId, [
				...(roleIds.get(row.channelId) ?? []),
				row.roleId,
			])
		}
		for (const row of memberRows) {
			memberIds.set(row.channelId, [
				...(memberIds.get(row.channelId) ?? []),
				row.userId,
			])
		}
	}
	return channels.map((channel) => ({
		...channel,
		roleIds: roleIds.get(channel.id) ?? [],
		memberIds: memberIds.get(channel.id) ?? [],
	}))
}

/** Active members who can be named on a restricted channel. */
export async function listChatAssignableMembers(organizationId: string) {
	return db
		.select({
			id: User.id,
			name: User.name,
			username: User.username,
		})
		.from(UserOrganization)
		.innerJoin(User, eq(User.id, UserOrganization.userId))
		.where(
			and(
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.active, true),
			),
		)
		.orderBy(asc(User.name), asc(User.username))
}

export async function getChannelInOrganization(
	organizationId: string,
	channelId: string,
) {
	const [channel] = await db
		.select()
		.from(OrganizationChatChannel)
		.where(
			and(
				eq(OrganizationChatChannel.id, channelId),
				eq(OrganizationChatChannel.organizationId, organizationId),
			),
		)
		.limit(1)
	return channel ?? null
}

/**
 * Roles and members named on a channel must belong to this organization.
 * Without this a crafted form could reference another tenant's role id, and a
 * restricted channel would silently match nobody (or the wrong people).
 */
async function assertAudienceBelongsToOrganization(
	organizationId: string,
	input: ChatChannelInput,
) {
	for (const ids of chunk(input.roleIds, 50)) {
		const found = await db
			.select({ id: OrganizationRole.id })
			.from(OrganizationRole)
			.where(
				and(
					inArray(OrganizationRole.id, ids),
					or(
						inArray(OrganizationRole.id, [...BUILT_IN_ORG_ROLE_IDS]),
						eq(OrganizationRole.organizationId, organizationId),
					),
				),
			)
		if (found.length !== ids.length) {
			throw new ChatChannelError(
				'One of the selected roles is not available.',
				'roleIds',
			)
		}
	}
	for (const ids of chunk(input.memberIds, 50)) {
		const found = await db
			.select({ userId: UserOrganization.userId })
			.from(UserOrganization)
			.where(
				and(
					eq(UserOrganization.organizationId, organizationId),
					eq(UserOrganization.active, true),
					inArray(UserOrganization.userId, ids),
				),
			)
		if (found.length !== ids.length) {
			throw new ChatChannelError(
				'One of the selected members is not an active member of this team.',
				'memberIds',
			)
		}
	}
}

async function assertNameAvailable(
	organizationId: string,
	name: string,
	exceptChannelId?: string,
) {
	const rows = await db
		.select({
			id: OrganizationChatChannel.id,
			name: OrganizationChatChannel.name,
		})
		.from(OrganizationChatChannel)
		.where(
			and(
				eq(OrganizationChatChannel.organizationId, organizationId),
				eq(OrganizationChatChannel.kind, 'channel'),
			),
		)
	const taken = rows.some(
		(row) =>
			row.id !== exceptChannelId &&
			row.name.toLowerCase() === name.toLowerCase(),
	)
	if (taken) {
		throw new ChatChannelError(
			'A channel with this name already exists.',
			'name',
		)
	}
}

function isUniqueViolation(error: unknown) {
	return /unique/i.test(error instanceof Error ? error.message : String(error))
}

async function insertAudience(channelId: string, input: ChatChannelInput) {
	for (const ids of chunk(input.roleIds, INSERT_CHUNK)) {
		await db
			.insert(OrganizationChatChannelRole)
			.values(
				ids.map((organizationRoleId) => ({ channelId, organizationRoleId })),
			)
			.onConflictDoNothing()
	}
	for (const ids of chunk(input.memberIds, INSERT_CHUNK)) {
		await db
			.insert(OrganizationChatChannelMember)
			.values(ids.map((userId) => ({ channelId, userId })))
			.onConflictDoNothing()
	}
}

export async function createChannel(
	organizationId: string,
	creatorId: string,
	input: ChatChannelInput,
) {
	const existing = await db
		.select({ id: OrganizationChatChannel.id })
		.from(OrganizationChatChannel)
		.where(
			and(
				eq(OrganizationChatChannel.organizationId, organizationId),
				eq(OrganizationChatChannel.kind, 'channel'),
			),
		)
		.limit(CHAT_LIMITS.syncChannelsMax)
	if (existing.length >= CHAT_LIMITS.syncChannelsMax) {
		throw new ChatChannelError(
			`A team can have at most ${CHAT_LIMITS.syncChannelsMax} channels.`,
		)
	}
	await assertNameAvailable(organizationId, input.name)

	// The creator is always named on a restricted channel so they cannot lock
	// themselves out of what they just made.
	const audience: ChatChannelInput =
		input.access === 'restricted' && !input.memberIds.includes(creatorId)
			? { ...input, memberIds: [...input.memberIds, creatorId] }
			: input
	await assertAudienceBelongsToOrganization(organizationId, audience)

	let channel: { id: string }
	try {
		;[channel] = await db
			.insert(OrganizationChatChannel)
			.values({
				organizationId,
				name: input.name,
				description: input.description,
				access: input.access,
				kind: 'channel',
				createdById: creatorId,
			})
			.returning({ id: OrganizationChatChannel.id })
			.then((rows) => rows as [{ id: string }])
	} catch (error) {
		if (isUniqueViolation(error)) {
			throw new ChatChannelError(
				'A channel with this name already exists.',
				'name',
			)
		}
		throw error
	}
	// Channel row exists with no audience rows yet: a restricted channel admits
	// nobody until they land, so a failure here fails closed.
	await insertAudience(channel.id, audience)
	return channel.id
}

export async function updateChannel(
	organizationId: string,
	channelId: string,
	input: ChatChannelInput,
) {
	const channel = await getChannelInOrganization(organizationId, channelId)
	if (!channel) throw new ChatChannelError('Channel not found.')
	if (channel.kind !== 'channel') {
		throw new ChatChannelError('Channel not found.')
	}
	await assertNameAvailable(organizationId, input.name, channelId)
	await assertAudienceBelongsToOrganization(organizationId, input)

	// Add the new audience before touching access or removing old rows so a
	// restricted channel never passes through an empty (or wrongly open) state.
	await insertAudience(channelId, input)
	try {
		await db
			.update(OrganizationChatChannel)
			.set({
				name: input.name,
				description: input.description,
				access: input.access,
			})
			.where(
				and(
					eq(OrganizationChatChannel.id, channelId),
					eq(OrganizationChatChannel.organizationId, organizationId),
				),
			)
	} catch (error) {
		if (isUniqueViolation(error)) {
			throw new ChatChannelError(
				'A channel with this name already exists.',
				'name',
			)
		}
		throw error
	}
	// Diff in code and delete in chunks: `NOT IN (...)` over a large selection
	// would exceed D1's bound-parameter limit.
	const keepRoles = new Set(input.roleIds)
	const currentRoles = await db
		.select({ id: OrganizationChatChannelRole.organizationRoleId })
		.from(OrganizationChatChannelRole)
		.where(eq(OrganizationChatChannelRole.channelId, channelId))
	for (const ids of chunk(
		currentRoles.map((row) => row.id).filter((id) => !keepRoles.has(id)),
		50,
	)) {
		await db
			.delete(OrganizationChatChannelRole)
			.where(
				and(
					eq(OrganizationChatChannelRole.channelId, channelId),
					inArray(OrganizationChatChannelRole.organizationRoleId, ids),
				),
			)
	}
	const keepMembers = new Set(input.memberIds)
	const currentMembers = await db
		.select({ id: OrganizationChatChannelMember.userId })
		.from(OrganizationChatChannelMember)
		.where(eq(OrganizationChatChannelMember.channelId, channelId))
	for (const ids of chunk(
		currentMembers.map((row) => row.id).filter((id) => !keepMembers.has(id)),
		50,
	)) {
		await db
			.delete(OrganizationChatChannelMember)
			.where(
				and(
					eq(OrganizationChatChannelMember.channelId, channelId),
					inArray(OrganizationChatChannelMember.userId, ids),
				),
			)
	}
}

export async function deleteChannel(organizationId: string, channelId: string) {
	const channel = await getChannelInOrganization(organizationId, channelId)
	if (!channel || channel.kind !== 'channel') {
		throw new ChatChannelError('Channel not found.')
	}
	// Role and member rows go with it via ON DELETE CASCADE.
	await db
		.delete(OrganizationChatChannel)
		.where(
			and(
				eq(OrganizationChatChannel.id, channelId),
				eq(OrganizationChatChannel.organizationId, organizationId),
			),
		)
}
