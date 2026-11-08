import {
	and,
	desc,
	db,
	eq,
	inArray,
	isNotNull,
	NoteComment,
	NoteCommentImage,
	OrganizationMediaAsset,
	OrganizationNote,
	OrganizationNoteUpload,
	OrganizationS3Config,
	sql,
	StorageMigration,
	StorageMigrationItem,
} from '@repo/database'
import { decrypt, encrypt, getSSOMasterKey } from '@repo/security'
import {
	deleteFromStorage,
	getSignedDeleteRequestInfo,
	getSignedGetRequestInfo,
	getSignedHeadRequestInfo,
	getSignedPutRequestInfoForKey,
	type StorageConfig,
	uploadToStorage,
} from '@repo/storage'
import { ENV } from 'varlock/env'

export const STORAGE_MIGRATION_BATCH_SIZE = 10

export type StorageMigrationSideType = 'platform' | 'custom'

export type CustomStorageSnapshot = {
	endpoint: string
	bucketName: string
	accessKeyId: string
	secretAccessKey: string
	region: string
}

function getPlatformStorageConfig(): StorageConfig {
	return {
		endpoint: process.env.AWS_ENDPOINT_URL_S3!,
		bucket: process.env.BUCKET_NAME!,
		accessKey: process.env.AWS_ACCESS_KEY_ID!,
		secretKey: process.env.AWS_SECRET_ACCESS_KEY!,
		region: process.env.AWS_REGION!,
	}
}

function snapshotFromS3ConfigRow(
	config: typeof OrganizationS3Config.$inferSelect,
): CustomStorageSnapshot {
	return {
		endpoint: config.endpoint,
		bucketName: config.bucketName,
		accessKeyId: config.accessKeyId,
		secretAccessKey: decrypt(config.secretAccessKey, getSSOMasterKey()),
		region: config.region,
	}
}

function encryptSnapshotSecret(secretAccessKey: string) {
	return encrypt(secretAccessKey, getSSOMasterKey())
}

function previousSnapshotFromS3ConfigRow(
	config: typeof OrganizationS3Config.$inferSelect,
): CustomStorageSnapshot | null {
	if (
		!config.previousEndpoint ||
		!config.previousBucketName ||
		!config.previousAccessKeyId ||
		!config.previousSecretAccessKey ||
		!config.previousRegion
	) {
		return null
	}

	return {
		endpoint: config.previousEndpoint,
		bucketName: config.previousBucketName,
		accessKeyId: config.previousAccessKeyId,
		secretAccessKey: decrypt(config.previousSecretAccessKey, getSSOMasterKey()),
		region: config.previousRegion,
	}
}

export function s3BucketSettingsChanged(
	existing: typeof OrganizationS3Config.$inferSelect,
	next: {
		endpoint: string
		bucketName: string
		accessKeyId: string
		region: string
	},
) {
	return (
		existing.bucketName !== next.bucketName ||
		existing.endpoint !== next.endpoint ||
		existing.accessKeyId !== next.accessKeyId ||
		existing.region !== next.region
	)
}

export function previousSnapshotFieldsFromConfig(
	config: typeof OrganizationS3Config.$inferSelect,
) {
	return {
		previousEndpoint: config.endpoint,
		previousBucketName: config.bucketName,
		previousAccessKeyId: config.accessKeyId,
		previousSecretAccessKey: config.secretAccessKey,
		previousRegion: config.region,
	}
}

export type StorageMigrationPlan = {
	sourceType: StorageMigrationSideType
	source?: CustomStorageSnapshot
	destType: StorageMigrationSideType
	dest: CustomStorageSnapshot
}

function normalizeStorageEndpoint(endpoint: string) {
	const trimmed = endpoint.trim()
	try {
		const url = new URL(trimmed)
		return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`.toLowerCase()
	} catch {
		return trimmed.replace(/\/+$/, '').toLowerCase()
	}
}

/**
 * Two storage sides are the same place when they name the same bucket on the
 * same endpoint, whatever credentials or region string reach it. Moving media
 * between them would copy each object onto itself and then delete it.
 */
export function isSameStorageLocation(
	a: { endpoint: string; bucket: string },
	b: { endpoint: string; bucket: string },
) {
	return (
		a.bucket.trim() === b.bucket.trim() &&
		normalizeStorageEndpoint(a.endpoint) ===
			normalizeStorageEndpoint(b.endpoint)
	)
}

export const STORAGE_MIGRATION_PROBE_DIR = 'storage-migration-probe'

/**
 * Different endpoint strings can still reach one bucket: a regional and a
 * global S3 hostname, an IP and a hostname for MinIO, a CNAME in front of R2.
 * Only the buckets themselves can tell, so this writes a random marker through
 * the destination settings and looks for it through the source settings. The
 * marker sits under the organization's own prefix, where its media lives, so
 * credentials limited to that prefix can still see it.
 *
 * Returns true when the source sees the marker: the two sides are one bucket.
 * Throws when the answer is unclear, because copying and then deleting the
 * "source" would destroy the only copy.
 */
export async function storageSidesShareBucket({
	organizationId,
	source,
	dest,
}: {
	organizationId: string
	source: StorageConfig
	dest: StorageConfig
}) {
	const key = `orgs/${organizationId}/${STORAGE_MIGRATION_PROBE_DIR}/${crypto.randomUUID()}.txt`
	await uploadToStorage(
		new File(['storage migration probe'], 'probe.txt', { type: 'text/plain' }),
		key,
		dest,
	)
	try {
		const { url, headers } = getSignedHeadRequestInfo(key, source)
		const response = await fetch(url, {
			method: 'HEAD',
			headers,
			redirect: 'manual',
		})
		if (response.ok) return true
		if (response.status === 404) return false
		throw new Error(
			`Could not confirm that the source and destination are different buckets: the source answered ${response.status}`,
		)
	} finally {
		// One delete is enough when they are the same bucket; the other is a
		// harmless 404. Neither may hide the probe's answer.
		await Promise.allSettled([
			deleteFromStorage(key, dest),
			deleteFromStorage(key, source),
		])
	}
}

function storageConfigFromSnapshot(
	snapshot: CustomStorageSnapshot,
): StorageConfig {
	return {
		endpoint: snapshot.endpoint,
		bucket: snapshot.bucketName,
		accessKey: snapshot.accessKeyId,
		secretKey: snapshot.secretAccessKey,
		region: snapshot.region,
	}
}

/**
 * Returns null when nothing has to move: the new settings only change how the
 * same bucket is reached (access key, secret, region).
 */
export function resolveStorageMigrationPlan({
	existingConfig,
	dest,
}: {
	existingConfig?: typeof OrganizationS3Config.$inferSelect | null
	dest: CustomStorageSnapshot
}): StorageMigrationPlan | null {
	if (
		existingConfig?.isEnabled &&
		s3BucketSettingsChanged(existingConfig, dest)
	) {
		if (
			isSameStorageLocation(
				{
					endpoint: existingConfig.endpoint,
					bucket: existingConfig.bucketName,
				},
				{ endpoint: dest.endpoint, bucket: dest.bucketName },
			)
		) {
			return null
		}
		return {
			sourceType: 'custom',
			source: snapshotFromS3ConfigRow(existingConfig),
			destType: 'custom',
			dest,
		}
	}

	const previousSource = existingConfig
		? previousSnapshotFromS3ConfigRow(existingConfig)
		: null
	if (
		previousSource &&
		existingConfig?.isEnabled &&
		previousSource.bucketName !== dest.bucketName
	) {
		return {
			sourceType: 'custom',
			source: previousSource,
			destType: 'custom',
			dest,
		}
	}

	return {
		sourceType: 'platform',
		destType: 'custom',
		dest,
	}
}

async function clearPreviousS3BucketSnapshot(organizationId: string) {
	await db
		.update(OrganizationS3Config)
		.set({
			previousEndpoint: null,
			previousBucketName: null,
			previousAccessKeyId: null,
			previousSecretAccessKey: null,
			previousRegion: null,
		})
		.where(eq(OrganizationS3Config.organizationId, organizationId))
}

function resolveSideConfig(
	migration: typeof StorageMigration.$inferSelect,
	side: 'source' | 'dest',
): StorageConfig {
	const type = side === 'source' ? migration.sourceType : migration.destType
	if (type === 'platform') {
		return getPlatformStorageConfig()
	}

	const endpoint =
		side === 'source' ? migration.sourceEndpoint : migration.destEndpoint
	const bucketName =
		side === 'source' ? migration.sourceBucketName : migration.destBucketName
	const accessKeyId =
		side === 'source' ? migration.sourceAccessKeyId : migration.destAccessKeyId
	const secretAccessKeyEncrypted =
		side === 'source'
			? migration.sourceSecretAccessKey
			: migration.destSecretAccessKey
	const region =
		side === 'source' ? migration.sourceRegion : migration.destRegion

	if (
		!endpoint ||
		!bucketName ||
		!accessKeyId ||
		!secretAccessKeyEncrypted ||
		!region
	) {
		throw new Error(`Missing ${side} storage configuration on migration`)
	}

	return {
		endpoint,
		bucket: bucketName,
		accessKey: accessKeyId,
		secretKey: decrypt(secretAccessKeyEncrypted, getSSOMasterKey()),
		region,
	}
}

type CollectOrgMediaOptions = {
	/** When migrating from platform storage, skip uploads created after custom S3 was first enabled. */
	onlyUploadedBefore?: Date
}

async function getPlatformMigrationCutoff(organizationId: string) {
	const [s3Config] = await db
		.select({
			createdAt: OrganizationS3Config.createdAt,
			isEnabled: OrganizationS3Config.isEnabled,
		})
		.from(OrganizationS3Config)
		.where(eq(OrganizationS3Config.organizationId, organizationId))
		.limit(1)

	if (s3Config?.isEnabled) {
		return s3Config.createdAt
	}

	return undefined
}

async function collectOptionsForMigration(
	organizationId: string,
	sourceType: StorageMigrationSideType,
) {
	if (sourceType !== 'platform') {
		return undefined
	}

	const cutoff = await getPlatformMigrationCutoff(organizationId)
	return cutoff ? { onlyUploadedBefore: cutoff } : undefined
}

export async function collectOrgMediaObjects(
	organizationId: string,
	options?: CollectOrgMediaOptions,
) {
	const objects = new Map<string, string>()

	const libraryAssets = await db
		.select({
			objectKey: OrganizationMediaAsset.objectKey,
			mimeType: OrganizationMediaAsset.mimeType,
			createdAt: OrganizationMediaAsset.createdAt,
		})
		.from(OrganizationMediaAsset)
		.where(
			and(
				eq(OrganizationMediaAsset.organizationId, organizationId),
				eq(OrganizationMediaAsset.storageScope, 'organization'),
			),
		)

	for (const asset of libraryAssets) {
		if (
			options?.onlyUploadedBefore &&
			asset.createdAt >= options.onlyUploadedBefore
		) {
			continue
		}
		objects.set(asset.objectKey, asset.mimeType)
	}

	const uploads = await db
		.select({
			objectKey: OrganizationNoteUpload.objectKey,
			thumbnailKey: OrganizationNoteUpload.thumbnailKey,
			mimeType: OrganizationNoteUpload.mimeType,
			createdAt: OrganizationNoteUpload.createdAt,
		})
		.from(OrganizationNoteUpload)
		.innerJoin(
			OrganizationNote,
			eq(OrganizationNoteUpload.noteId, OrganizationNote.id),
		)
		.where(eq(OrganizationNote.organizationId, organizationId))

	for (const upload of uploads) {
		if (
			options?.onlyUploadedBefore &&
			upload.createdAt >= options.onlyUploadedBefore
		) {
			continue
		}

		if (!objects.has(upload.objectKey)) {
			objects.set(
				upload.objectKey,
				upload.mimeType ?? 'application/octet-stream',
			)
		}
		if (upload.thumbnailKey) {
			if (!objects.has(upload.thumbnailKey)) {
				objects.set(upload.thumbnailKey, 'image/jpeg')
			}
		}
	}

	const commentImages = await db
		.select({
			objectKey: NoteCommentImage.objectKey,
			createdAt: NoteCommentImage.createdAt,
		})
		.from(NoteCommentImage)
		.innerJoin(NoteComment, eq(NoteCommentImage.commentId, NoteComment.id))
		.innerJoin(OrganizationNote, eq(NoteComment.noteId, OrganizationNote.id))
		.where(eq(OrganizationNote.organizationId, organizationId))

	for (const image of commentImages) {
		if (
			options?.onlyUploadedBefore &&
			image.createdAt >= options.onlyUploadedBefore
		) {
			continue
		}

		if (!objects.has(image.objectKey)) {
			objects.set(image.objectKey, 'image/jpeg')
		}
	}

	return [...objects.entries()]
		.map(([objectKey, contentType]) => ({ objectKey, contentType }))
		.sort((a, b) => a.objectKey.localeCompare(b.objectKey))
}

export async function collectOrgMediaObjectKeys(
	organizationId: string,
	options?: CollectOrgMediaOptions,
) {
	const objects = await collectOrgMediaObjects(organizationId, options)
	return objects.map((entry) => entry.objectKey)
}

/**
 * Counts the distinct media keys without loading every key into the settings
 * page process. The migration path still uses collectOrgMediaObjectKeys because
 * it needs the actual key list.
 */
export async function countOrgMediaObjectKeys(organizationId: string) {
	const libraryKeys = db
		.select({ objectKey: OrganizationMediaAsset.objectKey })
		.from(OrganizationMediaAsset)
		.where(
			and(
				eq(OrganizationMediaAsset.organizationId, organizationId),
				eq(OrganizationMediaAsset.storageScope, 'organization'),
			),
		)

	const uploadKeys = db
		.select({ objectKey: OrganizationNoteUpload.objectKey })
		.from(OrganizationNoteUpload)
		.innerJoin(
			OrganizationNote,
			eq(OrganizationNoteUpload.noteId, OrganizationNote.id),
		)
		.where(eq(OrganizationNote.organizationId, organizationId))

	const thumbnailKeys = db
		.select({ objectKey: sql<string>`${OrganizationNoteUpload.thumbnailKey}` })
		.from(OrganizationNoteUpload)
		.innerJoin(
			OrganizationNote,
			eq(OrganizationNoteUpload.noteId, OrganizationNote.id),
		)
		.where(
			and(
				eq(OrganizationNote.organizationId, organizationId),
				isNotNull(OrganizationNoteUpload.thumbnailKey),
			),
		)

	const commentImageKeys = db
		.select({ objectKey: NoteCommentImage.objectKey })
		.from(NoteCommentImage)
		.innerJoin(NoteComment, eq(NoteCommentImage.commentId, NoteComment.id))
		.innerJoin(OrganizationNote, eq(NoteComment.noteId, OrganizationNote.id))
		.where(eq(OrganizationNote.organizationId, organizationId))

	const mediaKeys = libraryKeys
		.union(uploadKeys)
		.union(thumbnailKeys)
		.union(commentImageKeys)
	const [result] = await db
		.select({ count: sql<number>`count(*)` })
		.from(mediaKeys.as('media_keys'))

	return Number(result?.count ?? 0)
}

export async function getActiveStorageMigration(organizationId: string) {
	const [migration] = await db
		.select()
		.from(StorageMigration)
		.where(
			and(
				eq(StorageMigration.organizationId, organizationId),
				inArray(StorageMigration.status, ['pending', 'running']),
			),
		)
		.limit(1)

	return migration ?? null
}

async function triggerStorageMigrationWorkflow(migrationId: string) {
	const workerUrl =
		typeof ENV.JOBS_CRON_WORKER_URL === 'string'
			? ENV.JOBS_CRON_WORKER_URL.trim()
			: ''
	if (!workerUrl) {
		throw new Error('JOBS_CRON_WORKER_URL is not configured')
	}

	const response = await fetch(
		`${workerUrl.replace(/\/$/, '')}/workflows/storage-migration/start`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ migrationId }),
		},
	)

	if (!response.ok) {
		const body = await response.text().catch(() => '')
		throw new Error(
			`Failed to start storage migration workflow: ${response.status} ${response.statusText}${body ? `\n${body}` : ''}`,
		)
	}

	const data = (await response.json()) as { instanceId?: string }
	return data.instanceId ?? null
}

export async function createAndStartStorageMigration({
	organizationId,
	sourceType,
	source,
	destType,
	dest,
}: {
	organizationId: string
	sourceType: StorageMigrationSideType
	source?: CustomStorageSnapshot
	destType: StorageMigrationSideType
	dest?: CustomStorageSnapshot
}) {
	const activeMigration = await getActiveStorageMigration(organizationId)
	if (activeMigration) {
		throw new Error(
			'A storage migration is already in progress for this organization',
		)
	}

	const collectOptions = await collectOptionsForMigration(
		organizationId,
		sourceType,
	)
	const objects = await collectOrgMediaObjects(organizationId, collectOptions)
	if (objects.length === 0) {
		throw new Error('No org media files found to migrate')
	}

	if (sourceType === 'custom' && !source) {
		throw new Error('Custom source storage configuration is required')
	}
	if (destType === 'custom' && !dest) {
		throw new Error('Custom destination storage configuration is required')
	}
	if (
		source &&
		dest &&
		isSameStorageLocation(
			{ endpoint: source.endpoint, bucket: source.bucketName },
			{ endpoint: dest.endpoint, bucket: dest.bucketName },
		)
	) {
		throw new Error('Source and destination are the same bucket')
	}
	if (
		await storageSidesShareBucket({
			organizationId,
			source: source
				? storageConfigFromSnapshot(source)
				: getPlatformStorageConfig(),
			dest: dest ? storageConfigFromSnapshot(dest) : getPlatformStorageConfig(),
		})
	) {
		throw new Error('Source and destination are the same bucket')
	}

	const [migration] = await db
		.insert(StorageMigration)
		.values({
			organizationId,
			status: 'pending',
			sourceType,
			sourceEndpoint: source?.endpoint,
			sourceBucketName: source?.bucketName,
			sourceAccessKeyId: source?.accessKeyId,
			sourceSecretAccessKey: source
				? encryptSnapshotSecret(source.secretAccessKey)
				: null,
			sourceRegion: source?.region,
			destType,
			destEndpoint: dest?.endpoint,
			destBucketName: dest?.bucketName,
			destAccessKeyId: dest?.accessKeyId,
			destSecretAccessKey: dest
				? encryptSnapshotSecret(dest.secretAccessKey)
				: null,
			destRegion: dest?.region,
			totalObjects: objects.length,
		})
		.returning()

	if (!migration) {
		throw new Error('Failed to create storage migration record')
	}

	try {
		// The list is fixed here: later batches work through it, whatever media
		// is added or removed meanwhile. A failure here must mark the row failed
		// too, or the `pending` row would block every later migration.
		await insertMigrationItems(migration.id, objects)
		const instanceId = await triggerStorageMigrationWorkflow(migration.id)
		await db
			.update(StorageMigration)
			.set({
				status: 'running',
				workflowInstanceId: instanceId,
			})
			.where(eq(StorageMigration.id, migration.id))
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		await db
			.update(StorageMigration)
			.set({
				status: 'failed',
				lastError: message,
				completedAt: new Date(),
			})
			.where(eq(StorageMigration.id, migration.id))
		throw error
	}

	return migration
}

/** The object is in neither bucket: nothing to move (or it was lost). */
class SourceObjectMissingError extends Error {
	constructor(status: number) {
		super(`Source fetch failed: ${status}`)
	}
}

/** D1 rejects a statement that binds more than 100 parameters. */
const D1_MAX_BOUND_PARAMETERS = 100
/**
 * Drizzle binds every column it sends, defaults included: id and updatedAt
 * ($defaultFn), status and attempts (literal defaults), plus migrationId,
 * objectKey and contentType. Only lastError goes inline as `null`. The test
 * builds a full chunk with `toSQL()` and fails if this count goes stale.
 */
const ITEM_INSERT_PARAMS_PER_ROW = 7
/** 14 rows, 98 parameters. LibSQL in tests allows far more, so it hides this. */
export const ITEM_INSERT_CHUNK = Math.floor(
	D1_MAX_BOUND_PARAMETERS / ITEM_INSERT_PARAMS_PER_ROW,
)

export function buildMigrationItemInsert(
	migrationId: string,
	objects: ReadonlyArray<{ objectKey: string; contentType: string }>,
) {
	return db
		.insert(StorageMigrationItem)
		.values(
			objects.map((object) => ({
				migrationId,
				objectKey: object.objectKey,
				contentType: object.contentType,
			})),
		)
		.onConflictDoNothing()
}

async function insertMigrationItems(
	migrationId: string,
	objects: ReadonlyArray<{ objectKey: string; contentType: string }>,
) {
	for (let i = 0; i < objects.length; i += ITEM_INSERT_CHUNK) {
		await buildMigrationItemInsert(
			migrationId,
			objects.slice(i, i + ITEM_INSERT_CHUNK),
		)
	}
}

async function countMigrationItems(migrationId: string) {
	const rows = await db
		.select({
			status: StorageMigrationItem.status,
			count: sql<number>`count(*)`,
		})
		.from(StorageMigrationItem)
		.where(eq(StorageMigrationItem.migrationId, migrationId))
		.groupBy(StorageMigrationItem.status)
	const by = new Map(rows.map((row) => [row.status, Number(row.count)]))
	const done = by.get('done') ?? 0
	const failed = by.get('failed') ?? 0
	const pending = by.get('pending') ?? 0
	return { total: done + failed + pending, done, failed, pending }
}

/** Progress columns follow the item counts, so they never drift. */
async function syncMigrationProgress(migrationId: string) {
	const counts = await countMigrationItems(migrationId)
	await db
		.update(StorageMigration)
		.set({
			totalObjects: counts.total,
			processedObjects: counts.done,
			failedObjects: counts.failed,
			cursor: counts.done + counts.failed,
		})
		.where(eq(StorageMigration.id, migrationId))
	return counts
}

/** Marks a pending item; an item another batch already settled is left alone. */
async function settleMigrationItem(
	itemId: string,
	outcome: { status: 'done' } | { status: 'failed'; error: string },
) {
	await db
		.update(StorageMigrationItem)
		.set({
			status: outcome.status,
			attempts: sql`${StorageMigrationItem.attempts} + 1`,
			lastError: outcome.status === 'failed' ? outcome.error : null,
		})
		.where(
			and(
				eq(StorageMigrationItem.id, itemId),
				eq(StorageMigrationItem.status, 'pending'),
			),
		)
}

async function copyStorageObject({
	objectKey,
	contentType,
	sourceConfig,
	destConfig,
}: {
	objectKey: string
	contentType: string
	sourceConfig: StorageConfig
	destConfig: StorageConfig
}) {
	const { url: sourceUrl, headers: sourceHeaders } = getSignedGetRequestInfo(
		objectKey,
		sourceConfig,
	)
	// Org endpoints are validated when saved, not their redirect targets.
	const sourceResponse = await fetch(sourceUrl, {
		headers: sourceHeaders,
		redirect: 'manual',
	})
	if (sourceResponse.status === 404) {
		// A retried step (or an overlapping run) may already have moved this
		// object: it is gone from the source and present at the destination.
		// That is a finished move, not a failure.
		const { url: headUrl, headers: headHeaders } = getSignedHeadRequestInfo(
			objectKey,
			destConfig,
		)
		const headResponse = await fetch(headUrl, {
			method: 'HEAD',
			headers: headHeaders,
			redirect: 'manual',
		}).catch(() => null)
		if (headResponse?.ok) return
		throw new SourceObjectMissingError(sourceResponse.status)
	}
	if (!sourceResponse.ok) {
		throw new Error(`Source fetch failed: ${sourceResponse.status}`)
	}

	const sourceBody = Buffer.from(await sourceResponse.arrayBuffer())

	const { url: destUrl, headers: destHeaders } = getSignedPutRequestInfoForKey(
		objectKey,
		destConfig,
		contentType,
	)
	const putResponse = await fetch(destUrl, {
		method: 'PUT',
		headers: {
			...destHeaders,
			'Content-Length': String(sourceBody.byteLength),
		},
		body: sourceBody,
		redirect: 'manual',
	})

	if (!putResponse.ok) {
		throw new Error(`Destination upload failed: ${putResponse.status}`)
	}

	const { url: deleteUrl, headers: deleteHeaders } = getSignedDeleteRequestInfo(
		objectKey,
		sourceConfig,
	)
	const deleteResponse = await fetch(deleteUrl, {
		method: 'DELETE',
		headers: deleteHeaders,
		redirect: 'manual',
	})
	if (!deleteResponse.ok && deleteResponse.status !== 404) {
		throw new Error(`Source delete failed: ${deleteResponse.status}`)
	}
}

export async function processStorageMigrationBatch(migrationId: string) {
	const [migration] = await db
		.select()
		.from(StorageMigration)
		.where(eq(StorageMigration.id, migrationId))
		.limit(1)

	if (!migration) {
		throw new Error('Storage migration not found')
	}

	if (migration.status === 'completed' || migration.status === 'failed') {
		return {
			done: true,
			totalObjects: migration.totalObjects,
			processedObjects: migration.processedObjects,
			failedObjects: migration.failedObjects,
		}
	}

	if (migration.status === 'pending') {
		await db
			.update(StorageMigration)
			.set({ status: 'running' })
			.where(eq(StorageMigration.id, migrationId))
	}

	const sourceConfig = resolveSideConfig(migration, 'source')
	const destConfig = resolveSideConfig(migration, 'dest')

	// Copying an object onto itself and then deleting the "source" destroys
	// the only copy. Refuse before touching any object. The endpoint strings
	// are a cheap first check; before the first batch moves (and deletes)
	// anything, the buckets themselves are asked as well. A probe that cannot
	// answer throws, so the workflow retries the step without moving anything.
	if (
		isSameStorageLocation(sourceConfig, destConfig) ||
		(migration.cursor === 0 &&
			(await storageSidesShareBucket({
				organizationId: migration.organizationId,
				source: sourceConfig,
				dest: destConfig,
			})))
	) {
		await completeStorageMigration({
			migrationId,
			failed: true,
			error: 'Source and destination are the same bucket',
		})
		return {
			done: true,
			totalObjects: migration.totalObjects,
			processedObjects: migration.processedObjects,
			failedObjects: migration.failedObjects,
		}
	}

	// A migration started before items existed lists its objects now, once.
	const [anyItem] = await db
		.select({ id: StorageMigrationItem.id })
		.from(StorageMigrationItem)
		.where(eq(StorageMigrationItem.migrationId, migrationId))
		.limit(1)
	if (!anyItem) {
		await insertMigrationItems(
			migrationId,
			await collectOrgMediaObjects(
				migration.organizationId,
				await collectOptionsForMigration(
					migration.organizationId,
					migration.sourceType as StorageMigrationSideType,
				),
			),
		)
	}

	const batchItems = await db
		.select({
			id: StorageMigrationItem.id,
			objectKey: StorageMigrationItem.objectKey,
			contentType: StorageMigrationItem.contentType,
		})
		.from(StorageMigrationItem)
		.where(
			and(
				eq(StorageMigrationItem.migrationId, migrationId),
				eq(StorageMigrationItem.status, 'pending'),
			),
		)
		.orderBy(StorageMigrationItem.objectKey)
		.limit(STORAGE_MIGRATION_BATCH_SIZE)

	let processedCount = 0
	let failedCount = 0
	const errors: Array<{ objectKey: string; error: string }> = []
	// Read only when an object is missing from both buckets.
	let stillReferenced: Set<string> | null = null

	for (const item of batchItems) {
		try {
			await copyStorageObject({
				objectKey: item.objectKey,
				contentType: item.contentType,
				sourceConfig,
				destConfig,
			})
			await settleMigrationItem(item.id, { status: 'done' })
			processedCount++
		} catch (error) {
			if (error instanceof SourceObjectMissingError) {
				// Deleted from the organization since the list was made: there is
				// nothing to move, which is not a failure.
				stillReferenced ??= new Set(
					await collectOrgMediaObjectKeys(migration.organizationId),
				)
				if (!stillReferenced.has(item.objectKey)) {
					await settleMigrationItem(item.id, { status: 'done' })
					processedCount++
					continue
				}
			}
			const message = error instanceof Error ? error.message : String(error)
			await settleMigrationItem(item.id, { status: 'failed', error: message })
			failedCount++
			errors.push({ objectKey: item.objectKey, error: message })
		}
	}

	const counts = await syncMigrationProgress(migrationId)
	if (errors.length > 0) {
		await db
			.update(StorageMigration)
			.set({
				lastError: errors
					.map((entry) => `${entry.objectKey}: ${entry.error}`)
					.join('\n'),
			})
			.where(eq(StorageMigration.id, migrationId))
	}

	const result = {
		cursor: counts.done + counts.failed,
		totalObjects: counts.total,
		processedObjects: counts.done,
		failedObjects: counts.failed,
		batchProcessed: processedCount,
		batchFailed: failedCount,
	}

	if (counts.pending === 0) {
		await completeStorageMigration({
			migrationId,
			failed: counts.failed > 0,
		})
		return { done: true, ...result }
	}

	return { done: false, ...result }
}

export async function reportStorageMigrationProgress({
	migrationId,
	processedCount,
	failedCount,
	errors,
	expectedCursor,
}: {
	migrationId: string
	processedCount: number
	failedCount: number
	errors?: Array<{ objectKey: string; error: string }>
	/**
	 * The cursor the batch started from. When given, the update applies only if
	 * the cursor is still there, so a batch that overlapped another one (or a
	 * replayed report) does not advance the cursor or the counters twice.
	 */
	expectedCursor?: number
}) {
	const step = processedCount + failedCount
	const lastError =
		errors && errors.length > 0
			? errors.map((entry) => `${entry.objectKey}: ${entry.error}`).join('\n')
			: undefined

	// One conditional statement: the increments happen in SQL, so concurrent
	// reports cannot overwrite each other with values read earlier.
	const [updated] = await db
		.update(StorageMigration)
		.set({
			cursor: sql`${StorageMigration.cursor} + ${step}`,
			processedObjects: sql`${StorageMigration.processedObjects} + ${processedCount}`,
			failedObjects: sql`${StorageMigration.failedObjects} + ${failedCount}`,
			...(lastError !== undefined ? { lastError } : {}),
		})
		.where(
			and(
				eq(StorageMigration.id, migrationId),
				expectedCursor !== undefined
					? eq(StorageMigration.cursor, expectedCursor)
					: undefined,
			),
		)
		.returning({ cursor: StorageMigration.cursor })
	if (updated) return { cursor: updated.cursor }

	const [current] = await db
		.select({ cursor: StorageMigration.cursor })
		.from(StorageMigration)
		.where(eq(StorageMigration.id, migrationId))
		.limit(1)
	if (!current) {
		throw new Error('Storage migration not found')
	}
	return { cursor: current.cursor }
}

export async function completeStorageMigration({
	migrationId,
	failed,
	error,
}: {
	migrationId: string
	failed?: boolean
	error?: string
}) {
	const [migration] = await db
		.select()
		.from(StorageMigration)
		.where(eq(StorageMigration.id, migrationId))
		.limit(1)

	if (!migration) {
		throw new Error('Storage migration not found')
	}

	if (migration.status === 'completed' || migration.status === 'failed') {
		return
	}

	await db
		.update(StorageMigration)
		.set({
			status: failed ? 'failed' : 'completed',
			lastError: failed ? (error ?? migration.lastError) : null,
			completedAt: new Date(),
		})
		.where(eq(StorageMigration.id, migrationId))

	if (
		!failed &&
		migration.sourceType === 'custom' &&
		migration.destType === 'custom'
	) {
		await clearPreviousS3BucketSnapshot(migration.organizationId)
	}
}

export function customSnapshotFromS3ConfigRow(
	config: typeof OrganizationS3Config.$inferSelect,
) {
	return snapshotFromS3ConfigRow(config)
}

export async function getLatestStorageMigration(organizationId: string) {
	const [migration] = await db
		.select()
		.from(StorageMigration)
		.where(eq(StorageMigration.organizationId, organizationId))
		.orderBy(desc(StorageMigration.createdAt))
		.limit(1)

	return migration ?? null
}
