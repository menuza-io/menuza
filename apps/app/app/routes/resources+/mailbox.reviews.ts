import { listUnifiedReviews, replyToUnifiedReview } from '@repo/integrations'
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'

const pageTokensSchema = z
	.record(z.string(), z.string().max(2048).nullable())
	.default({})

async function authorizeMailbox(request: Request, orgSlug: string) {
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)
	return organization
}

export async function loader({ request }: LoaderFunctionArgs) {
	const url = new URL(request.url)
	const orgSlug = z
		.string()
		.min(1)
		.max(100)
		.parse(url.searchParams.get('orgSlug'))
	const provider = url.searchParams.get('provider') || undefined
	const organization = await authorizeMailbox(request, orgSlug)
	let rawTokens: unknown = {}
	try {
		rawTokens = JSON.parse(url.searchParams.get('pageTokens') ?? '{}')
	} catch {
		return Response.json(
			{ error: 'Invalid review page cursor.' },
			{ status: 400 },
		)
	}
	const parsedTokens = pageTokensSchema.safeParse(rawTokens)
	if (!parsedTokens.success) {
		return Response.json(
			{ error: 'Invalid review page cursor.' },
			{ status: 400 },
		)
	}
	try {
		const result = await listUnifiedReviews(
			organization.id,
			parsedTokens.data,
			provider,
		)
		return Response.json(result, {
			headers: { 'Cache-Control': 'private, no-store' },
		})
	} catch (error) {
		return Response.json(
			{
				error:
					error instanceof Error ? error.message : 'Unable to load reviews.',
			},
			{ status: 502, headers: { 'Cache-Control': 'private, no-store' } },
		)
	}
}

const replySchema = z.object({
	orgSlug: z.string().min(1).max(100),
	locationId: z.string().min(1).max(100),
	provider: z.string().default('google-business-profile'),
	reviewName: z.string().min(1).max(500),
	comment: z.string().trim().min(1).max(4096),
})

export async function action({ request }: ActionFunctionArgs) {
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return Response.json({ error: 'Invalid reply request.' }, { status: 400 })
	}
	const parsed = replySchema.safeParse(body)
	if (!parsed.success) {
		return Response.json(
			{ error: parsed.error.issues[0]?.message ?? 'Invalid reply.' },
			{ status: 400 },
		)
	}
	const organization = await authorizeMailbox(request, parsed.data.orgSlug)
	try {
		const reply = await replyToUnifiedReview(
			organization.id,
			parsed.data.locationId,
			parsed.data.provider,
			parsed.data.reviewName,
			parsed.data.comment,
		)
		return Response.json(reply, {
			headers: { 'Cache-Control': 'private, no-store' },
		})
	} catch (error) {
		return Response.json(
			{
				error:
					error instanceof Error
						? error.message
						: 'Could not save the review reply.',
			},
			{ status: 400, headers: { 'Cache-Control': 'private, no-store' } },
		)
	}
}
