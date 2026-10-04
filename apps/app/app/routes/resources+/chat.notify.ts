import { eq, Organization } from '@repo/database'
import { db } from '@repo/database'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { chatMessageSchema } from '#app/utils/chat/notify-schemas.server.ts'
import { notifyChatMessage } from '#app/utils/chat/notifications.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

const bodySchema = z.object({
	organizationId: z.string().min(1),
	authorId: z.string().min(1),
	message: chatMessageSchema,
})

export async function action({ request }: ActionFunctionArgs) {
	await requireInternalCommandAuth(request)
	const parsed = bodySchema.safeParse(await request.json().catch(() => null))
	if (!parsed.success) {
		return new Response('Bad request', { status: 400 })
	}
	const [organization] = await db
		.select({ slug: Organization.slug })
		.from(Organization)
		.where(eq(Organization.id, parsed.data.organizationId))
		.limit(1)
	if (!organization) {
		return new Response('Not found', { status: 404 })
	}
	await notifyChatMessage({
		organizationId: parsed.data.organizationId,
		organizationSlug: organization.slug,
		authorId: parsed.data.authorId,
		message: parsed.data.message,
	})
	return new Response(null, { status: 204 })
}
