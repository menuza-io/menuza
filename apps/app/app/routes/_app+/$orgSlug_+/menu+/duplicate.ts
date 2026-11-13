import { requireUserId } from '@repo/auth'
import { type ActionFunctionArgs } from 'react-router'
import { handleMenuDuplicate } from '#app/utils/menu/duplicate-actions.server.ts'

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const orgSlug = params.orgSlug
	if (!orgSlug) throw new Response('Not Found', { status: 404 })
	return handleMenuDuplicate(request, orgSlug)
}
