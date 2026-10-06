import { requireUserId, userHasOrganizationPermission } from '@repo/auth'
import { CHAT_LIMITS } from '@repo/common/chat'
import {
	data,
	useLoaderData,
	useParams,
	useSearchParams,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	type ShouldRevalidateFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import { ChatUnavailable } from '#app/components/chat/chat-unavailable.tsx'
import { ChatView } from '#app/components/chat/chat-view.tsx'
import {
	listChannelsForUser,
	listChatAssignableMembers,
	ChatChannelError,
} from '#app/utils/chat/channels.server.ts'
import {
	addGroupMembers,
	createGroupChat,
	findOrCreateDirectMessage,
	listGroupMemberIdsByChannel,
	updateGroupHistorySetting,
} from '#app/utils/chat/conversations.server.ts'
import {
	notifyChat,
	isChatAvailable,
} from '#app/utils/chat/namespace.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(
		request,
		params.orgSlug || '',
		{ id: true },
	)
	const [channels, canManage, canCreateGroup, members] = await Promise.all([
		listChannelsForUser(organization.id, userId),
		userHasOrganizationPermission(
			userId,
			organization.id,
			ORG_PERMISSIONS.UPDATE_CHAT_ANY,
		),
		userHasOrganizationPermission(
			userId,
			organization.id,
			ORG_PERMISSIONS.CREATE_CHAT_GROUP,
		),
		listChatAssignableMembers(organization.id),
	])
	const groupIds = channels
		.filter((channel) => channel.kind === 'group')
		.map((channel) => channel.id)
	const groupMemberIds = await listGroupMemberIdsByChannel(groupIds)
	return data(
		{
			channels,
			canManage,
			canCreateGroup,
			members: members.map((member) => ({
				id: member.id,
				label: member.name?.trim() || member.username,
			})),
			groupMemberIds,
			available: isChatAvailable(),
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}

/**
 * Switching channels only changes `?channel=`; the channel list is the same, so
 * skip the loader. An explicit revalidation (channels changed) keeps the same
 * URL and still runs it.
 */
const composeIntentSchema = z.discriminatedUnion('intent', [
	z.object({
		intent: z.literal('dm'),
		targetUserId: z.string().min(1),
	}),
	z.object({
		intent: z.literal('createGroup'),
		name: z.string().trim().min(1).max(CHAT_LIMITS.nameMax),
		memberIds: z.array(z.string().min(1)).default([]),
		showHistoryToNewMembers: z.boolean().default(false),
	}),
	z.object({
		intent: z.literal('addGroupMembers'),
		channelId: z.string().min(1),
		memberIds: z.array(z.string().min(1)).min(1),
	}),
	z.object({
		intent: z.literal('updateGroupHistory'),
		channelId: z.string().min(1),
		showHistoryToNewMembers: z.boolean(),
	}),
])

export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(
		request,
		params.orgSlug || '',
		{ id: true },
	)
	const body: unknown = await request.json().catch(() => null)
	const parsed = composeIntentSchema.safeParse(body)
	if (!parsed.success) {
		return { ok: false as const, error: 'Invalid request.' }
	}
	try {
		if (parsed.data.intent === 'dm') {
			const channelId = await findOrCreateDirectMessage(
				organization.id,
				userId,
				parsed.data.targetUserId,
			)
			await notifyChat(organization.id, (room) => room.channelsChanged())
			return { ok: true as const, channelId }
		}
		if (parsed.data.intent === 'createGroup') {
			const allowed = await userHasOrganizationPermission(
				userId,
				organization.id,
				ORG_PERMISSIONS.CREATE_CHAT_GROUP,
			)
			if (!allowed) {
				return { ok: false as const, error: 'You cannot create group chats.' }
			}
			const channelId = await createGroupChat(organization.id, userId, {
				name: parsed.data.name,
				memberIds: parsed.data.memberIds,
				showHistoryToNewMembers: parsed.data.showHistoryToNewMembers,
			})
			await notifyChat(organization.id, (room) => room.channelsChanged())
			return { ok: true as const, channelId }
		}
		if (parsed.data.intent === 'addGroupMembers') {
			await addGroupMembers(
				organization.id,
				userId,
				parsed.data.channelId,
				parsed.data.memberIds,
			)
			await notifyChat(organization.id, (room) => room.channelsChanged())
			return { ok: true as const, channelId: parsed.data.channelId }
		}
		await updateGroupHistorySetting(
			organization.id,
			userId,
			parsed.data.channelId,
			parsed.data.showHistoryToNewMembers,
		)
		return { ok: true as const, channelId: parsed.data.channelId }
	} catch (error) {
		if (error instanceof ChatChannelError) {
			return { ok: false as const, error: error.message }
		}
		throw error
	}
}

export function shouldRevalidate({
	currentUrl,
	nextUrl,
	defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
	if (
		currentUrl.pathname === nextUrl.pathname &&
		currentUrl.search !== nextUrl.search
	) {
		return false
	}
	return defaultShouldRevalidate
}

export default function ChatRoute() {
	const { orgSlug = '' } = useParams()
	const {
		channels,
		canManage,
		canCreateGroup,
		members,
		groupMemberIds,
		available,
	} = useLoaderData<typeof loader>()
	const [searchParams] = useSearchParams()
	const requested = searchParams.get('channel')
	const activeChannelId = requested
		? (channels.find((channel) => channel.id === requested)?.id ?? null)
		: null

	return (
		<div className="-mx-4 flex min-h-0 flex-1 flex-col overflow-hidden md:-mx-2">
			{available ? (
				<ChatView
					// A fresh socket and state per organization.
					key={orgSlug}
					orgSlug={orgSlug}
					channels={channels}
					activeChannelId={activeChannelId}
					canManage={canManage}
					canCreateGroup={canCreateGroup}
					members={members}
					groupMemberIds={groupMemberIds}
				/>
			) : (
				<ChatUnavailable orgSlug={orgSlug} canManageChannels={canManage} />
			)}
		</div>
	)
}
