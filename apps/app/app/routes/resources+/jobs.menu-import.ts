import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import {
	processMenuImportJob,
	sweepStaleMenuImports,
} from '#app/utils/menu/import/service.server.ts'

/**
 * Continues an AI menu import (#73) or sweeps stale imports on the hourly
 * `jobs-cron` fallback trigger:
 * - When called with `{ importId }`, `processMenuImportJob` claims and runs it.
 * - When called with an empty body (hourly `0 * * * *` sweep), resets stale
 *   `applying` rows (> 5 min) and re-drives stale `queued`/`running` rows.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)

	const rawText = await request.text().catch(() => '')
	if (!rawText.trim()) {
		const swept = await sweepStaleMenuImports()
		return Response.json({ success: true, swept })
	}

	let body: { importId?: unknown } | null = null
	try {
		body = JSON.parse(rawText) as { importId?: unknown } | null
	} catch {
		return Response.json({ success: false }, { status: 400 })
	}

	if (body && typeof body === 'object' && body.importId === undefined) {
		const swept = await sweepStaleMenuImports()
		return Response.json({ success: true, swept })
	}

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
