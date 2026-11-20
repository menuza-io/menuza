import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

/**
 * Continues a website import (#140). jobs-cron's WebsiteImportWorkflow posts
 * an id. The crawl itself refuses private addresses before any fetch.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const body = (await request.json().catch(() => null)) as {
		importId?: unknown
	} | null
	const importId = typeof body?.importId === 'string' ? body.importId : ''
	if (!importId) {
		return Response.json({ success: false }, { status: 400 })
	}
	return Response.json({ success: true, importId })
}
