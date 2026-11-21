import { createId } from '@paralleldrive/cuid2'
import {
	and,
	asc,
	db,
	desc,
	eq,
	inArray,
	lte,
	MenuImport,
	or,
	Organization,
} from '@repo/database'
import { ENV } from 'varlock/env'
import {
	checkRateLimit,
	MENU_IMPORT_ORGANIZATION_RATE_LIMIT,
	MENU_IMPORT_USER_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import {
	deleteMenuImportObject,
	readMenuImportDraftJson,
	readMenuImportSource,
	uploadMenuImportDraftJson,
	uploadMenuImportSource,
} from '#app/utils/storage.server.ts'
import { isMenuImportKillSwitchOn } from './access.server.ts'
import {
	detectUploadedSourceFile,
	extractMenuFromSource,
	type ExtractMenuDeps,
} from './extract.server.ts'
import {
	fetchMenuSource,
	type FetchSourceDeps,
	validateMenuImportUrl,
} from './fetch-source.server.ts'
import {
	MENU_IMPORT_STALE_MS,
	type MenuImportDraft,
	menuImportDraftSchema,
	type MenuImportErrorCode,
} from './schema.ts'

export const ACTIVE_MENU_IMPORT_STATUSES = [
	'queued',
	'running',
	'applying',
] as const

export type MenuImportServiceDeps = FetchSourceDeps &
	ExtractMenuDeps & {
		uploadSource?: typeof uploadMenuImportSource
		readSource?: typeof readMenuImportSource
		writeDraft?: typeof uploadMenuImportDraftJson
		readDraft?: typeof readMenuImportDraftJson
		deleteObject?: typeof deleteMenuImportObject
		wakeWorkflow?: (importId: string) => Promise<boolean>
	}

function isUniqueConstraintError(error: unknown): boolean {
	let current: unknown = error
	for (let depth = 0; depth < 5 && current; depth += 1) {
		const message = current instanceof Error ? current.message : String(current)
		if (/unique constraint|constraint failed/i.test(message)) return true
		current = (current as { cause?: unknown }).cause
	}
	return false
}

/**
 * Asks jobs-cron to run `MenuImportWorkflow` (#73). Best effort: the payload
 * carries only the import ID (no credentials, no PII, no source content).
 */
export async function wakeMenuImportWorkflow(
	importId: string,
): Promise<boolean> {
	const workerUrl =
		typeof ENV.JOBS_CRON_WORKER_URL === 'string'
			? ENV.JOBS_CRON_WORKER_URL.trim()
			: ''
	if (!workerUrl) return false
	try {
		const response = await fetch(
			`${workerUrl.replace(/\/$/, '')}/workflows/menu-import/start`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ importId }),
				signal: AbortSignal.timeout(5_000),
			},
		)
		if (!response.ok) {
			console.error('Menu import wake-up refused', {
				importId,
				status: response.status,
			})
			return false
		}
		return true
	} catch {
		console.error('Menu import wake-up failed', { importId })
		return false
	}
}

export type StartMenuImportInput =
	| {
			kind: 'url'
			organizationId: string
			userId: string
			sourceUrl: string
			confirmedOwnership: boolean
	  }
	| {
			kind: 'file'
			organizationId: string
			userId: string
			filename: string
			mimeType: string | null
			bytes: Uint8Array<ArrayBuffer>
	  }

export type StartMenuImportResult =
	| { ok: true; importId: string }
	| {
			ok: false
			status: number
			error: MenuImportErrorCode
			activeImportId?: string
			retryAfter?: number
	  }

export async function startMenuImport(
	input: StartMenuImportInput,
	deps: MenuImportServiceDeps = {},
): Promise<StartMenuImportResult> {
	if (isMenuImportKillSwitchOn()) {
		return { ok: false, status: 503, error: 'menu_import_disabled' }
	}

	const [existingActive] = await db
		.select({ id: MenuImport.id })
		.from(MenuImport)
		.where(
			and(
				eq(MenuImport.organizationId, input.organizationId),
				inArray(MenuImport.status, [...ACTIVE_MENU_IMPORT_STATUSES]),
			),
		)
		.limit(1)

	if (existingActive) {
		return {
			ok: false,
			status: 409,
			error: 'import_in_progress',
			activeImportId: existingActive.id,
		}
	}

	let sourceKind: 'url' | 'pdf' | 'image' | 'spreadsheet'
	let sourceUrl: string | null = null
	let confirmedOwnership = false
	let detectedFile: {
		sourceKind: 'pdf' | 'image' | 'spreadsheet'
		ext: string
		contentType: string
	} | null = null

	if (input.kind === 'url') {
		if (!input.confirmedOwnership) {
			return { ok: false, status: 400, error: 'ownership_not_confirmed' }
		}
		const urlCheck = await validateMenuImportUrl(input.sourceUrl, deps.resolve)
		if (!urlCheck.ok) {
			return { ok: false, status: 400, error: urlCheck.error }
		}
		sourceKind = 'url'
		sourceUrl = urlCheck.url
		confirmedOwnership = true
	} else {
		const detected = detectUploadedSourceFile(
			input.bytes,
			input.filename,
			input.mimeType,
		)
		if (!detected.ok) {
			return { ok: false, status: 400, error: detected.error }
		}
		sourceKind = detected.sourceKind
		detectedFile = {
			sourceKind: detected.sourceKind,
			ext: detected.ext,
			contentType: detected.contentType,
		}
	}

	const userLimit = await checkRateLimit(
		{ type: 'user', value: input.userId },
		MENU_IMPORT_USER_RATE_LIMIT,
	)
	if (!userLimit.allowed) {
		return {
			ok: false,
			status: 429,
			error: 'rate_limited',
			retryAfter: Math.max(
				1,
				Math.ceil((userLimit.resetAt.getTime() - Date.now()) / 1000),
			),
		}
	}

	const orgLimit = await checkRateLimit(
		{ type: 'org', value: input.organizationId },
		MENU_IMPORT_ORGANIZATION_RATE_LIMIT,
	)
	if (!orgLimit.allowed) {
		return {
			ok: false,
			status: 429,
			error: 'rate_limited',
			retryAfter: Math.max(
				1,
				Math.ceil((orgLimit.resetAt.getTime() - Date.now()) / 1000),
			),
		}
	}

	const importId = createId()
	const uploadSourceFn = deps.uploadSource ?? uploadMenuImportSource
	const deleteObjectFn = deps.deleteObject ?? deleteMenuImportObject
	let sourceKey: string | null = null

	if (input.kind === 'file' && detectedFile) {
		sourceKey = await uploadSourceFn(
			input.organizationId,
			importId,
			detectedFile.ext,
			input.bytes,
			detectedFile.contentType,
		)
	}

	const now = new Date()
	try {
		await db.insert(MenuImport).values({
			id: importId,
			organizationId: input.organizationId,
			sourceKind,
			sourceUrl,
			sourceKey,
			status: 'queued',
			confirmedOwnership,
			createdById: input.userId,
			createdAt: now,
			updatedAt: now,
		})
	} catch (error) {
		if (sourceKey) {
			await deleteObjectFn(sourceKey).catch(() => {})
		}
		if (isUniqueConstraintError(error)) {
			return { ok: false, status: 409, error: 'import_in_progress' }
		}
		throw error
	}

	const wakeFn = deps.wakeWorkflow ?? wakeMenuImportWorkflow
	await wakeFn(importId)

	return { ok: true, importId }
}

async function isImportStillRunning(importId: string): Promise<boolean> {
	const [row] = await db
		.select({ status: MenuImport.status })
		.from(MenuImport)
		.where(eq(MenuImport.id, importId))
		.limit(1)
	return row?.status === 'running'
}

export async function processMenuImportJob(
	importId: string,
	deps: MenuImportServiceDeps = {},
): Promise<{
	ok: boolean
	skipped?: boolean
	status?: string
	error?: string
}> {
	if (isMenuImportKillSwitchOn()) {
		return { ok: false, error: 'menu_import_disabled' }
	}

	const claimNow = new Date()
	const staleRunningBefore = new Date(claimNow.getTime() - MENU_IMPORT_STALE_MS)
	const [claimed] = await db
		.update(MenuImport)
		.set({ status: 'running', updatedAt: claimNow })
		.where(
			and(
				eq(MenuImport.id, importId),
				or(
					eq(MenuImport.status, 'queued'),
					and(
						eq(MenuImport.status, 'running'),
						lte(MenuImport.updatedAt, staleRunningBefore),
					),
				),
			),
		)
		.returning()

	if (!claimed) {
		return { ok: true, skipped: true }
	}

	try {
		const [org] = await db
			.select({
				id: Organization.id,
				siteLocales: Organization.siteLocales,
				siteDefaultLocale: Organization.siteDefaultLocale,
			})
			.from(Organization)
			.where(eq(Organization.id, claimed.organizationId))
			.limit(1)

		if (!org) {
			await db
				.update(MenuImport)
				.set({
					status: 'failed',
					error: 'extract_failed',
					updatedAt: new Date(),
				})
				.where(
					and(eq(MenuImport.id, importId), eq(MenuImport.status, 'running')),
				)
			return { ok: false, status: 'failed', error: 'extract_failed' }
		}

		let extractResult: Awaited<ReturnType<typeof extractMenuFromSource>>

		if (claimed.sourceKind === 'url') {
			if (!claimed.sourceUrl) {
				await db
					.update(MenuImport)
					.set({
						status: 'failed',
						error: 'url_not_allowed',
						updatedAt: new Date(),
					})
					.where(
						and(eq(MenuImport.id, importId), eq(MenuImport.status, 'running')),
					)
				return { ok: false, status: 'failed', error: 'url_not_allowed' }
			}

			const fetched = await fetchMenuSource(claimed.sourceUrl, deps)
			if (!(await isImportStillRunning(importId))) {
				return { ok: true, skipped: true }
			}
			if (!fetched.ok) {
				await db
					.update(MenuImport)
					.set({
						status: 'failed',
						error: fetched.error,
						updatedAt: new Date(),
					})
					.where(
						and(eq(MenuImport.id, importId), eq(MenuImport.status, 'running')),
					)
				return { ok: false, status: 'failed', error: fetched.error }
			}

			extractResult = await extractMenuFromSource(
				{
					sourceKind: 'url',
					fetched,
					siteLocales: org.siteLocales,
					siteDefaultLocale: org.siteDefaultLocale,
				},
				deps,
			)
		} else {
			if (!claimed.sourceKey) {
				await db
					.update(MenuImport)
					.set({
						status: 'failed',
						error: 'fetch_failed',
						updatedAt: new Date(),
					})
					.where(
						and(eq(MenuImport.id, importId), eq(MenuImport.status, 'running')),
					)
				return { ok: false, status: 'failed', error: 'fetch_failed' }
			}

			const readSourceFn = deps.readSource ?? readMenuImportSource
			const bytes = await readSourceFn(claimed.sourceKey)
			if (!(await isImportStillRunning(importId))) {
				return { ok: true, skipped: true }
			}
			if (!bytes) {
				await db
					.update(MenuImport)
					.set({
						status: 'failed',
						error: 'fetch_failed',
						updatedAt: new Date(),
					})
					.where(
						and(eq(MenuImport.id, importId), eq(MenuImport.status, 'running')),
					)
				return { ok: false, status: 'failed', error: 'fetch_failed' }
			}

			const filename = claimed.sourceKey.split('/').pop() || 'upload'
			extractResult = await extractMenuFromSource(
				{
					sourceKind: claimed.sourceKind as 'pdf' | 'image' | 'spreadsheet',
					bytes,
					filename,
					contentType: '',
					siteLocales: org.siteLocales,
					siteDefaultLocale: org.siteDefaultLocale,
				},
				deps,
			)
		}

		if (!(await isImportStillRunning(importId))) {
			return { ok: true, skipped: true }
		}

		if (!extractResult.ok) {
			await db
				.update(MenuImport)
				.set({
					status: 'failed',
					error: extractResult.error,
					updatedAt: new Date(),
				})
				.where(
					and(eq(MenuImport.id, importId), eq(MenuImport.status, 'running')),
				)
			return { ok: false, status: 'failed', error: extractResult.error }
		}

		const writeDraftFn = deps.writeDraft ?? uploadMenuImportDraftJson
		const draftKey = await writeDraftFn(
			claimed.organizationId,
			importId,
			JSON.stringify(extractResult.draft),
		)

		const finalized = await db
			.update(MenuImport)
			.set({
				status: 'ready',
				draftKey,
				error: null,
				updatedAt: new Date(),
			})
			.where(and(eq(MenuImport.id, importId), eq(MenuImport.status, 'running')))
			.returning({ id: MenuImport.id })

		if (finalized.length === 0) {
			const deleteObjectFn = deps.deleteObject ?? deleteMenuImportObject
			await deleteObjectFn(draftKey).catch(() => {})
			if (claimed.sourceKey) {
				await deleteObjectFn(claimed.sourceKey).catch(() => {})
			}
			return { ok: true, skipped: true }
		}

		return { ok: true, status: 'ready' }
	} catch (error) {
		console.error('Menu import processing failed', {
			importId,
			error: error instanceof Error ? error.message : String(error),
		})
		await db
			.update(MenuImport)
			.set({
				status: 'failed',
				error: 'extract_failed',
				updatedAt: new Date(),
			})
			.where(and(eq(MenuImport.id, importId), eq(MenuImport.status, 'running')))
			.catch(() => {})
		return { ok: false, status: 'failed', error: 'extract_failed' }
	}
}

export async function cancelMenuImport(
	{
		importId,
		organizationId,
	}: {
		importId: string
		organizationId: string
	},
	deps: Pick<MenuImportServiceDeps, 'deleteObject'> = {},
): Promise<
	| { ok: true }
	| { ok: false; status: 404 | 409; error: 'not_found' | 'invalid_state' }
> {
	const [existing] = await db
		.select({
			id: MenuImport.id,
			status: MenuImport.status,
			sourceKey: MenuImport.sourceKey,
			draftKey: MenuImport.draftKey,
		})
		.from(MenuImport)
		.where(
			and(
				eq(MenuImport.id, importId),
				eq(MenuImport.organizationId, organizationId),
			),
		)
		.limit(1)

	if (!existing) {
		return { ok: false, status: 404, error: 'not_found' }
	}

	const cancelNow = new Date()
	const staleApplyingBefore = new Date(
		cancelNow.getTime() - MENU_IMPORT_STALE_MS,
	)
	const updated = await db
		.update(MenuImport)
		.set({ status: 'cancelled', updatedAt: cancelNow })
		.where(
			and(
				eq(MenuImport.id, importId),
				eq(MenuImport.organizationId, organizationId),
				or(
					inArray(MenuImport.status, ['queued', 'running', 'ready']),
					and(
						eq(MenuImport.status, 'applying'),
						lte(MenuImport.updatedAt, staleApplyingBefore),
					),
				),
			),
		)
		.returning({ id: MenuImport.id })

	if (updated.length === 0) {
		return { ok: false, status: 409, error: 'invalid_state' }
	}

	const deleteObjectFn = deps.deleteObject ?? deleteMenuImportObject
	if (existing.sourceKey) {
		await deleteObjectFn(existing.sourceKey).catch(() => {})
	}
	if (existing.draftKey) {
		await deleteObjectFn(existing.draftKey).catch(() => {})
	}

	return { ok: true }
}

export async function saveMenuImportDraft(
	{
		importId,
		organizationId,
		draft,
	}: {
		importId: string
		organizationId: string
		draft: unknown
	},
	deps: Pick<MenuImportServiceDeps, 'writeDraft'> = {},
): Promise<
	| { ok: true; draft: MenuImportDraft }
	| {
			ok: false
			status: 400 | 404 | 409
			error: 'not_found' | 'invalid_state' | 'invalid_draft'
	  }
> {
	const parsed = menuImportDraftSchema.safeParse(draft)
	if (!parsed.success) {
		return { ok: false, status: 400, error: 'invalid_draft' }
	}

	const [existing] = await db
		.select({ id: MenuImport.id, status: MenuImport.status })
		.from(MenuImport)
		.where(
			and(
				eq(MenuImport.id, importId),
				eq(MenuImport.organizationId, organizationId),
			),
		)
		.limit(1)

	if (!existing) {
		return { ok: false, status: 404, error: 'not_found' }
	}
	if (existing.status !== 'ready') {
		return { ok: false, status: 409, error: 'invalid_state' }
	}

	const writeDraftFn = deps.writeDraft ?? uploadMenuImportDraftJson
	const draftKey = await writeDraftFn(
		organizationId,
		importId,
		JSON.stringify(parsed.data),
	)

	await db
		.update(MenuImport)
		.set({ draftKey, updatedAt: new Date() })
		.where(
			and(
				eq(MenuImport.id, importId),
				eq(MenuImport.organizationId, organizationId),
				eq(MenuImport.status, 'ready'),
			),
		)

	return { ok: true, draft: parsed.data }
}

export async function loadMenuImportForOrg(
	{
		importId,
		organizationId,
	}: {
		importId: string
		organizationId: string
	},
	deps: Pick<MenuImportServiceDeps, 'readDraft'> = {},
): Promise<{
	record: typeof MenuImport.$inferSelect
	draft: MenuImportDraft | null
} | null> {
	const [record] = await db
		.select()
		.from(MenuImport)
		.where(
			and(
				eq(MenuImport.id, importId),
				eq(MenuImport.organizationId, organizationId),
			),
		)
		.limit(1)

	if (!record) return null

	let draft: MenuImportDraft | null = null
	if (record.draftKey) {
		const readDraftFn = deps.readDraft ?? readMenuImportDraftJson
		const rawJson = await readDraftFn(record.draftKey)
		if (rawJson) {
			try {
				const parsed = menuImportDraftSchema.safeParse(JSON.parse(rawJson))
				if (parsed.success) draft = parsed.data
			} catch {
				draft = null
			}
		}
	}

	return { record, draft }
}

export async function listMenuImportsForOrg(organizationId: string) {
	return db
		.select({
			id: MenuImport.id,
			sourceKind: MenuImport.sourceKind,
			sourceUrl: MenuImport.sourceUrl,
			status: MenuImport.status,
			error: MenuImport.error,
			appliedAt: MenuImport.appliedAt,
			createdAt: MenuImport.createdAt,
			updatedAt: MenuImport.updatedAt,
		})
		.from(MenuImport)
		.where(eq(MenuImport.organizationId, organizationId))
		.orderBy(desc(MenuImport.createdAt))
		.limit(20)
}

/**
 * Hourly fallback sweep for stale `queued`, `running`, and `applying` menu
 * imports (#73):
 * - Resets stale `applying` rows (> 5 min) back to `ready` (or `failed` if no
 *   draft exists) so the organization is never permanently locked out.
 * - Re-drives stale `queued` and `running` rows (> 5 min) via
 *   `processMenuImportJob`.
 */
export async function sweepStaleMenuImports(
	now = new Date(),
	deps: MenuImportServiceDeps = {},
): Promise<{ resetApplying: number; retried: number }> {
	const staleBefore = new Date(now.getTime() - MENU_IMPORT_STALE_MS)

	const staleApplying = await db
		.select({ id: MenuImport.id, draftKey: MenuImport.draftKey })
		.from(MenuImport)
		.where(
			and(
				eq(MenuImport.status, 'applying'),
				lte(MenuImport.updatedAt, staleBefore),
			),
		)
		.orderBy(asc(MenuImport.updatedAt))
		.limit(25)

	let resetApplying = 0
	for (const row of staleApplying) {
		const updated = await db
			.update(MenuImport)
			.set(
				row.draftKey
					? { status: 'ready', updatedAt: now }
					: { status: 'failed', error: 'apply_failed', updatedAt: now },
			)
			.where(
				and(
					eq(MenuImport.id, row.id),
					eq(MenuImport.status, 'applying'),
					lte(MenuImport.updatedAt, staleBefore),
				),
			)
			.returning({ id: MenuImport.id })
		if (updated.length > 0) resetApplying += 1
	}

	let retried = 0
	if (!isMenuImportKillSwitchOn()) {
		const staleProcessing = await db
			.select({ id: MenuImport.id })
			.from(MenuImport)
			.where(
				and(
					inArray(MenuImport.status, ['queued', 'running']),
					lte(MenuImport.updatedAt, staleBefore),
				),
			)
			.orderBy(asc(MenuImport.updatedAt))
			.limit(10)

		for (const row of staleProcessing) {
			try {
				const res = await processMenuImportJob(row.id, deps)
				if (!res.skipped) retried += 1
			} catch (error) {
				console.error('Menu import sweep item failed', {
					importId: row.id,
					error: error instanceof Error ? error.message : String(error),
				})
			}
		}
	}

	return { resetApplying, retried }
}
