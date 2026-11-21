import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { processMenuImportJob } from '#app/utils/menu/import/service.server.ts'

/**
 * Continues an AI menu import (#73). `jobs-cron`'s `MenuImportWorkflow` posts
 * only `importId`. `processMenuImportJob` claims the row atomically and runs
 * SSRF-guarded fetching and structured extraction.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const body = (await request.json().catch(() => null)) as {
		importId?: unknown
	} | null
	const importId =
		typeof body?.importId === 'string' ? body.importId.trim() : ''
	if (!importId) {
		return Response.json({ success: false }, { status: 400 })
	}
	const result = await processMenuImportJob(importId)
	if (result.error === 'menu_import_disabled') {
		return Response.json(
			{ success: false, importId, error: result.error },
			{ status: 503 },
		)
	}
	return Response.json({
		success: result.ok,
		importId,
		status: result.status,
		error: result.error,
		skipped: result.skipped,
	})
}
