import { AuditAction, auditService } from '@repo/audit'
import { chatChannelInputSchema } from '@repo/common/chat'
import {
	data,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import {
	ChatChannelError,
	createChannel,
	deleteChannel,
	listChannelsForManager,
	listChatAssignableMembers,
	updateChannel,
} from '#app/utils/chat/channels.server.ts'
import { type ChatSettingsActionResult } from '#app/utils/chat/chat-settings.ts'
import { notifyChat } from '#app/utils/chat/namespace.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { listOrganizationRoles } from './roles.server.ts'

export type { ChatSettingsActionResult } from '#app/utils/chat/chat-settings.ts'

const intentSchema = z.discriminatedUnion('intent', [
	z.object({
		intent: z.literal('save'),
		id: z.string().min(1).max(64).optional(),
	}),
	z.object({
		intent: z.literal('delete'),
		id: z.string().min(1).max(64),
	}),
])

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(
		request,
		params.orgSlug || '',
		{ id: true },
	)
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_CHAT_ANY,
	)
	const [channels, roles, members] = await Promise.all([
		listChannelsForManager(organization.id),
		listOrganizationRoles(organization.id),
		listChatAssignableMembers(organization.id),
	])
	return data(
		{
			channels,
			roles: roles.map((role) => ({ id: role.id, name: role.name })),
			members,
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}

export async function action({
	request,
	params,
}: ActionFunctionArgs): Promise<ChatSettingsActionResult> {
	const organization = await requireUserOrganization(
		request,
		params.orgSlug || '',
		{ id: true },
	)
	const userId = await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_CHAT_ANY,
	)

	const body: unknown = await request.json().catch(() => null)
	const parsedIntent = intentSchema.safeParse(body)
	if (!parsedIntent.success) {
		return { ok: false, error: 'Invalid request.' }
	}

	try {
		if (parsedIntent.data.intent === 'delete') {
			const { id } = parsedIntent.data
			await deleteChannel(organization.id, id)
			await notifyChat(organization.id, (room) => room.deleteChannel(id))
			await auditService.log({
				action: AuditAction.CHAT_CHANNEL_DELETED,
				userId,
				organizationId: organization.id,
				resourceType: 'chat_channel',
				resourceId: id,
				details: 'Chat channel deleted.',
				request,
			})
			return { ok: true }
		}

		const { id } = parsedIntent.data
		const parsed = chatChannelInputSchema.safeParse(body)
		if (!parsed.success) {
			const fieldErrors: NonNullable<
				Extract<ChatSettingsActionResult, { ok: false }>['fieldErrors']
			> = {}
			for (const issue of parsed.error.issues) {
				const field = issue.path[0]
				if (
					(field === 'name' || field === 'roleIds' || field === 'memberIds') &&
					!fieldErrors[field]
				) {
					fieldErrors[field] = issue.message
				}
			}
			return { ok: false, fieldErrors }
		}

		if (id) {
			await updateChannel(organization.id, id, parsed.data)
			await auditService.log({
				action: AuditAction.CHAT_CHANNEL_UPDATED,
				userId,
				organizationId: organization.id,
				resourceType: 'chat_channel',
				resourceId: id,
				details: `Chat channel "${parsed.data.name}" updated.`,
				request,
			})
		} else {
			const channelId = await createChannel(
				organization.id,
				userId,
				parsed.data,
			)
			await auditService.log({
				action: AuditAction.CHAT_CHANNEL_CREATED,
				userId,
				organizationId: organization.id,
				resourceType: 'chat_channel',
				resourceId: channelId,
				details: `Chat channel "${parsed.data.name}" created.`,
				request,
			})
		}
		await notifyChat(organization.id, (room) => room.channelsChanged())
		return { ok: true }
	} catch (error) {
		if (error instanceof ChatChannelError) {
			return {
				ok: false,
				...(error.field === 'form'
					? { error: error.message }
					: { fieldErrors: { [error.field]: error.message } }),
			}
		}
		throw error
	}
}
