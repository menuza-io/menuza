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
} from '@repo/database'
import { decrypt, encrypt, getSSOMasterKey } from '@repo/security'
import {
	getSignedDeleteRequestInfo,
	getSignedGetRequestInfo,
	getSignedPutRequestInfoForKey,
	type StorageConfig,
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

export function resolveStorageMigrationPlan({
	existingConfig,
	dest,
}: {
	existingConfig?: typeof OrganizationS3Config.$inferSelect | null
	dest: CustomStorageSnapshot
}): StorageMigrationPlan {
	if (
		existingConfig?.isEnabled &&
		s3BucketSettingsChanged(existingConfig, dest)
	) {
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
	const objectKeys = await collectOrgMediaObjectKeys(
		organizationId,
		collectOptions,
	)
	if (objectKeys.length === 0) {
		throw new Error('No org media files found to migrate')
	}

	if (sourceType === 'custom' && !source) {
		throw new Error('Custom source storage configuration is required')
	}
	if (destType === 'custom' && !dest) {
		throw new Error('Custom destination storage configuration is required')
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
			totalObjects: objectKeys.length,
		})
		.returning()

	if (!migration) {
		throw new Error('Failed to create storage migration record')
	}

	try {
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
	const sourceResponse = await fetch(sourceUrl, { headers: sourceHeaders })
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

	const allObjects = await collectOrgMediaObjects(
		migration.organizationId,
		await collectOptionsForMigration(
			migration.organizationId,
			migration.sourceType as StorageMigrationSideType,
		),
	)
	const batchObjects = allObjects.slice(
		migration.cursor,
		migration.cursor + STORAGE_MIGRATION_BATCH_SIZE,
	)

	if (batchObjects.length === 0) {
		await completeStorageMigration({
			migrationId,
			failed: migration.failedObjects > 0,
		})

		return {
			done: true,
			totalObjects: migration.totalObjects,
			processedObjects: migration.processedObjects,
			failedObjects: migration.failedObjects,
		}
	}

	const sourceConfig = resolveSideConfig(migration, 'source')
	const destConfig = resolveSideConfig(migration, 'dest')

	let processedCount = 0
	let failedCount = 0
	const errors: Array<{ objectKey: string; error: string }> = []

	for (const { objectKey, contentType } of batchObjects) {
		try {
			await copyStorageObject({
				objectKey,
				contentType,
				sourceConfig,
				destConfig,
			})
			processedCount++
		} catch (error) {
			failedCount++
			errors.push({
				objectKey,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	const progress = await reportStorageMigrationProgress({
		migrationId,
		processedCount,
		failedCount,
		errors,
	})

	const [updatedMigration] = await db
		.select({
			totalObjects: StorageMigration.totalObjects,
			processedObjects: StorageMigration.processedObjects,
			failedObjects: StorageMigration.failedObjects,
		})
		.from(StorageMigration)
		.where(eq(StorageMigration.id, migrationId))
		.limit(1)

	const failedObjects =
		updatedMigration?.failedObjects ?? migration.failedObjects
	const processedObjects =
		updatedMigration?.processedObjects ?? migration.processedObjects
	const totalObjects = updatedMigration?.totalObjects ?? migration.totalObjects

	if (progress.cursor >= allObjects.length) {
		await completeStorageMigration({
			migrationId,
			failed: failedObjects > 0,
		})

		return {
			done: true,
			cursor: progress.cursor,
			totalObjects,
			processedObjects,
			failedObjects,
			batchProcessed: processedCount,
			batchFailed: failedCount,
		}
	}

	return {
		done: false,
		cursor: progress.cursor,
		totalObjects,
		processedObjects,
		failedObjects,
		batchProcessed: processedCount,
		batchFailed: failedCount,
	}
}

export async function reportStorageMigrationProgress({
	migrationId,
	processedCount,
	failedCount,
	errors,
}: {
	migrationId: string
	processedCount: number
	failedCount: number
	errors?: Array<{ objectKey: string; error: string }>
}) {
	const [migration] = await db
		.select()
		.from(StorageMigration)
		.where(eq(StorageMigration.id, migrationId))
		.limit(1)

	if (!migration) {
		throw new Error('Storage migration not found')
	}

	const nextCursor = migration.cursor + processedCount + failedCount
	const lastError =
		errors && errors.length > 0
			? errors.map((entry) => `${entry.objectKey}: ${entry.error}`).join('\n')
			: migration.lastError

	await db
		.update(StorageMigration)
		.set({
			cursor: nextCursor,
			processedObjects: migration.processedObjects + processedCount,
			failedObjects: migration.failedObjects + failedCount,
			lastError,
		})
		.where(eq(StorageMigration.id, migrationId))

	return { cursor: nextCursor }
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
