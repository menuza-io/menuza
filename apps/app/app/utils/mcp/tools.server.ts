import { ORG_PERMISSIONS } from '@repo/auth'
import {
	and,
	db,
	eq,
	like,
	or,
	User,
	UserImage,
	UserOrganization,
} from '@repo/database'
import { logger } from '@repo/observability'
import { getAccessibleNotes } from '../organization/note-access.server'
import { getSignedGetRequestInfo } from '../storage.server'
import { registerTool, type MCPContext } from './server.server'

/**
 * MCP Tools Service
 *
 * This module registers and implements MCP tools for the Epic Stack:
 * - find_user: Search for users in the authorized organization
 * - get_user_notes: Retrieve notes for a specific user
 *
 * All tools are scoped to the authenticated organization, and each declares
 * the organization permission it needs (checked live by `executeTool`).
 */

/**
 * Helper to get user image as base64
 *
 * @param imageObjectKey - S3 object key for the image
 * @returns Base64-encoded image data
 */
async function getUserBase64Image(imageObjectKey: string): Promise<string> {
	try {
		const { url: signedUrl, headers: signedHeaders } =
			getSignedGetRequestInfo(imageObjectKey)
		const response = await fetch(signedUrl, { headers: signedHeaders })
		const blob = await response.blob()
		const buffer = await blob.arrayBuffer()
		return Buffer.from(buffer).toString('base64')
	} catch (error) {
		console.error('Error fetching user image:', error)
		return ''
	}
}

/**
 * Register find_user tool
 *
 * Searches for users in the authorized organization by name or username.
 * Results are limited to 10 users and only include users in the same organization.
 */
registerTool({
	name: 'find_user',
	// The member list page requires it too.
	permission: ORG_PERMISSIONS.READ_MEMBER_ANY,
	description:
		'Search for users in your organization by their name or username',
	inputSchema: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: 'Search query for user name or username',
			},
		},
		required: ['query'],
	},
	handler: async (args: any, context: MCPContext) => {
		const { query } = args

		if (!query || typeof query !== 'string') {
			return {
				content: [
					{
						type: 'text' as const,
						text: 'Error: query parameter is required and must be a string',
					},
				],
			}
		}

		try {
			// Property 19: Organization-scoped user search
			// All returned users should belong to the organization associated with the access token
			const users = await db
				.select({
					name: User.name,
					username: User.username,
					image: { objectKey: UserImage.objectKey },
				})
				.from(User)
				.innerJoin(UserOrganization, eq(UserOrganization.userId, User.id))
				.leftJoin(UserImage, eq(UserImage.userId, User.id))
				.where(
					and(
						eq(UserOrganization.organizationId, context.organization.id),
						eq(UserOrganization.active, true),
						or(
							like(User.name, `%${query}%`),
							like(User.username, `%${query}%`),
						)!,
					),
				)
				.limit(10)

			const content: Array<{
				type: 'text' | 'image'
				text?: string
				data?: string
				mimeType?: string
			}> = []

			if (users.length === 0) {
				content.push({
					type: 'text',
					text: 'No users found in your organization matching the query',
				})
			} else {
				for (const user of users) {
					content.push({
						type: 'text',
						text: `${user.name} (${user.username})`,
					})

					if (user.image?.objectKey) {
						try {
							const imageData = await getUserBase64Image(user.image.objectKey)
							if (imageData) {
								content.push({
									type: 'image',
									data: imageData,
									mimeType: 'image/png',
								})
							}
						} catch (error) {
							console.error('Error processing user image:', error)
						}
					}
				}
			}

			return { content }
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error'
			logger.error(errorMessage)
			return {
				content: [
					{
						type: 'text',
						text: 'Error searching for users: An internal error occurred',
					},
				],
			}
		}
	},
})

/**
 * Register get_user_notes tool
 *
 * Retrieves up to 10 most recent notes for a user in the authorized organization.
 * Only returns notes that the authenticated user has access to (public notes,
 * notes they created, or notes shared with them).
 */
registerTool({
	name: 'get_user_notes',
	// The notes pages require it too.
	permission: ORG_PERMISSIONS.READ_NOTE_OWN,
	description: 'Get the notes for a user in your organization',
	inputSchema: {
		type: 'object',
		properties: {
			username: {
				type: 'string',
				description: 'Username of the user whose notes to retrieve',
			},
		},
		required: ['username'],
	},
	handler: async (args: any, context: MCPContext) => {
		const { username } = args

		if (!username || typeof username !== 'string') {
			return {
				content: [
					{
						type: 'text' as const,
						text: 'Error: username parameter is required and must be a string',
					},
				],
			}
		}

		try {
			// Property 21: Organization access control
			// The system should only return data from the organization associated with the access token
			const [user] = await db
				.select({ id: User.id, name: User.name, username: User.username })
				.from(User)
				.innerJoin(UserOrganization, eq(UserOrganization.userId, User.id))
				.where(
					and(
						eq(User.username, username),
						eq(UserOrganization.organizationId, context.organization.id),
						eq(UserOrganization.active, true),
					),
				)
				.limit(1)

			if (!user) {
				return {
					content: [
						{
							type: 'text' as const,
							text: 'User not found in your organization',
						},
					],
				}
			}

			// Property 20: Note retrieval limits and ordering
			// The system should return at most 10 notes, ordered by creation date (most recent first)
			// Uses centralized permission system via getAccessibleNotes for consistent authorization
			const notes = await getAccessibleNotes(
				context.user.id,
				context.organization.id,
				{
					targetUserId: user.id,
					take: 10,
					orderBy: { createdAt: 'desc' },
				},
			)

			const content: Array<{
				type: 'text'
				text: string
			}> = []

			if (!notes || notes.length === 0) {
				content.push({
					type: 'text',
					text: `No accessible notes found for ${user.name}`,
				})
			} else {
				for (const note of notes) {
					const accessLabel = note.isPublic ? '' : ' (Private)'
					content.push({
						type: 'text',
						text: `${note.title}\n\n${note.content}\n\n---\nCreated: ${note.createdAt.toLocaleDateString()}${accessLabel}`,
					})
				}
			}

			return { content }
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error'
			logger.error(errorMessage)
			return {
				content: [
					{
						type: 'text',
						text: 'Error retrieving notes: An internal error occurred',
					},
				],
			}
		}
	},
})
