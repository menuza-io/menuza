import { handleGenerateContent } from '@repo/ai/route-handlers'
import { generateNoteContent } from '@repo/ai/server'
import { requireUserId } from '@repo/auth'
import { type ActionFunctionArgs } from 'react-router'
import {
	AI_REQUEST_RATE_LIMIT,
	checkRateLimit,
} from '#app/utils/rate-limit.server.ts'

export async function action(args: ActionFunctionArgs) {
	const userId = await requireUserId(args.request)
	const limit = await checkRateLimit(
		{ type: 'user', value: userId },
		AI_REQUEST_RATE_LIMIT,
	)
	if (!limit.allowed) {
		return new Response('Too many requests', { status: 429 })
	}
	return handleGenerateContent(args, {
		requireUserId,
		generateNoteContent,
	})
}
