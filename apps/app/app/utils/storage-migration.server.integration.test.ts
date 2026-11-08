import {
	db,
	eq,
	NoteComment,
	NoteCommentImage,
	OrganizationMediaAsset,
	OrganizationNote,
	OrganizationNoteUpload,
	type OrganizationS3Config,
	StorageMigration,
	StorageMigrationItem,
} from '@repo/database'
import { encrypt, getSSOMasterKey } from '@repo/security'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import {
	buildMigrationItemInsert,
	collectOrgMediaObjects,
	countOrgMediaObjectKeys,
	createAndStartStorageMigration,
	ITEM_INSERT_CHUNK,
	processStorageMigrationBatch,
	reportStorageMigrationProgress,
	resolveStorageMigrationPlan,
	STORAGE_MIGRATION_PROBE_DIR,
} from './storage-migration.server.ts'

function isProbeRequest(url: unknown) {
	return String(url).includes(`/${STORAGE_MIGRATION_PROBE_DIR}/`)
}

/** Answers the same-bucket probe the way two separate buckets would. */
function separateBucketsProbeResponse(url: unknown, method: string) {
	if (!isProbeRequest(url)) return null
	// The marker was written to the destination: the source cannot see it.
	if (method === 'HEAD') return new Response(null, { status: 404 })
	return new Response(null, { status: 200 })
}

/**
 * One bucket reached through two different endpoint hostnames: objects are
 * keyed by path only, so a write through either host is visible through both.
 */
function mockOneBucketBehindTwoHosts(initialKeys: string[]) {
	const objects = new Set(initialKeys)
	const deletedKeys: string[] = []
	const spy = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (url, init) => {
			const method = init?.method ?? 'GET'
			const path = decodeURIComponent(new URL(String(url)).pathname)
			if (method === 'PUT') {
				objects.add(path)
				return new Response(null, { status: 200 })
			}
			if (method === 'DELETE') {
				objects.delete(path)
				deletedKeys.push(path)
				return new Response(null, { status: 204 })
			}
			if (!objects.has(path)) return new Response(null, { status: 404 })
			return new Response(method === 'HEAD' ? null : 'bytes', { status: 200 })
		})
	return { objects, deletedKeys, spy }
}

describe('migration item inserts', () => {
	it('binds at most 100 parameters per statement, the D1 limit', () => {
		const rows = Array.from({ length: ITEM_INSERT_CHUNK }, (_, i) => ({
			objectKey: `orgs/org/media/${i}.png`,
			contentType: 'image/png',
		}))
		const { params } = buildMigrationItemInsert('migration', rows).toSQL()

		expect(ITEM_INSERT_CHUNK).toBeGreaterThan(1)
		expect(params.length).toBeLessThanOrEqual(100)
		// The chunk is as large as the limit allows: one more row would not fit.
		expect(
			(params.length / ITEM_INSERT_CHUNK) * (ITEM_INSERT_CHUNK + 1),
		).toBeGreaterThan(100)
	})
})

describe('countOrgMediaObjectKeys', () => {
	it('counts distinct media keys without loading the object list', async () => {
		const user = await createTestUser()
		const organization = await createTestOrganization(user.id, 'admin')
		const [note] = await db
			.insert(OrganizationNote)
			.values({
				title: 'Media note',
				content: 'Contains media',
				organizationId: organization.id,
				createdById: user.id,
			})
			.returning()

		await db.insert(OrganizationNoteUpload).values([
			{
				type: 'image',
				objectKey: 'media/photo.jpg',
				thumbnailKey: 'media/photo-thumb.jpg',
				noteId: note!.id,
			},
			{
				type: 'image',
				objectKey: 'media/photo.jpg',
				noteId: note!.id,
			},
		])
		const [comment] = await db
			.insert(NoteComment)
			.values({
				content: 'Media comment',
				noteId: note!.id,
				userId: user.id,
			})
			.returning()
		await db.insert(NoteCommentImage).values({
			objectKey: 'media/photo-thumb.jpg',
			commentId: comment!.id,
		})
		await db.insert(OrganizationMediaAsset).values({
			organizationId: organization.id,
			objectKey: 'media/library-image.png',
			mimeType: 'image/png',
			fileName: 'library-image.png',
			fileSize: 512,
			source: 'library',
			createdById: user.id,
		})
		await db.insert(OrganizationMediaAsset).values({
			organizationId: organization.id,
			objectKey: 'media/photo-thumb.jpg',
			mimeType: 'image/png',
			fileName: 'reused-library-image.png',
			fileSize: 256,
			source: 'library',
			createdById: user.id,
		})

		await expect(countOrgMediaObjectKeys(organization.id)).resolves.toBe(3)
		await expect(
			collectOrgMediaObjects(organization.id),
		).resolves.toContainEqual({
			objectKey: 'media/photo-thumb.jpg',
			contentType: 'image/png',
		})
	})
})

describe('saving S3 settings for the bucket the media already lives in', () => {
	beforeEach(() => {
		vi.stubEnv('SSO_ENCRYPTION_KEY', 'a'.repeat(64))
	})
	afterEach(() => {
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
	})

	function enabledConfig(): typeof OrganizationS3Config.$inferSelect {
		return {
			id: 'cfg',
			organizationId: 'org',
			isEnabled: true,
			endpoint: 'https://s3.example.com',
			bucketName: 'org-media',
			accessKeyId: 'OLD-KEY',
			secretAccessKey: encrypt('old-secret', getSSOMasterKey()),
			region: 'us-east-1',
			previousEndpoint: null,
			previousBucketName: null,
			previousAccessKeyId: null,
			previousSecretAccessKey: null,
			previousRegion: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		}
	}

	it('plans no migration when only the key, region or endpoint spelling changes', () => {
		expect(
			resolveStorageMigrationPlan({
				existingConfig: enabledConfig(),
				dest: {
					endpoint: 'https://S3.example.com/',
					bucketName: 'org-media',
					accessKeyId: 'NEW-KEY',
					secretAccessKey: 'new-secret',
					region: 'eu-west-1',
				},
			}),
		).toBeNull()
	})

	it('still moves media when the bucket really changes', () => {
		const plan = resolveStorageMigrationPlan({
			existingConfig: enabledConfig(),
			dest: {
				endpoint: 'https://s3.example.com',
				bucketName: 'org-media-2',
				accessKeyId: 'NEW-KEY',
				secretAccessKey: 'new-secret',
				region: 'us-east-1',
			},
		})
		expect(plan).toMatchObject({
			sourceType: 'custom',
			source: { bucketName: 'org-media' },
			destType: 'custom',
			dest: { bucketName: 'org-media-2' },
		})
	})

	it('touches no object when a stored migration names the same bucket on both sides', async () => {
		const user = await createTestUser()
		const organization = await createTestOrganization(user.id, 'admin')
		await db.insert(OrganizationMediaAsset).values({
			organizationId: organization.id,
			objectKey: `orgs/${organization.id}/media/only-copy.png`,
			mimeType: 'image/png',
			fileName: 'only-copy.png',
			fileSize: 512,
			source: 'library',
			createdById: user.id,
		})
		const side = (accessKeyId: string, region: string) => ({
			Endpoint: 'https://s3.example.com',
			BucketName: 'org-media',
			AccessKeyId: accessKeyId,
			SecretAccessKey: encrypt('secret', getSSOMasterKey()),
			Region: region,
		})
		const source = side('OLD-KEY', 'us-east-1')
		const dest = side('NEW-KEY', 'eu-west-1')
		const [migration] = await db
			.insert(StorageMigration)
			.values({
				organizationId: organization.id,
				status: 'running',
				sourceType: 'custom',
				sourceEndpoint: source.Endpoint,
				sourceBucketName: source.BucketName,
				sourceAccessKeyId: source.AccessKeyId,
				sourceSecretAccessKey: source.SecretAccessKey,
				sourceRegion: source.Region,
				destType: 'custom',
				destEndpoint: dest.Endpoint,
				destBucketName: dest.BucketName,
				destAccessKeyId: dest.AccessKeyId,
				destSecretAccessKey: dest.SecretAccessKey,
				destRegion: dest.Region,
				totalObjects: 1,
			})
			.returning()
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () => new Response('bytes', { status: 200 }))

		const result = await processStorageMigrationBatch(migration!.id)

		const objectRequests = fetchSpy.mock.calls.map(([url, init]) => ({
			method: init?.method ?? 'GET',
			url: String(url),
		}))
		expect(objectRequests).toEqual([])
		expect(result.done).toBe(true)
		const [stored] = await db
			.select()
			.from(StorageMigration)
			.where(eq(StorageMigration.id, migration!.id))
		expect(stored).toMatchObject({
			status: 'failed',
			lastError: 'Source and destination are the same bucket',
			processedObjects: 0,
		})
	})
})

describe('retried and overlapping migration steps', () => {
	beforeEach(() => {
		vi.stubEnv('SSO_ENCRYPTION_KEY', 'a'.repeat(64))
	})
	afterEach(() => {
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
	})
	async function setupMigration() {
		const user = await createTestUser()
		const organization = await createTestOrganization(user.id, 'admin')
		await db.insert(OrganizationMediaAsset).values({
			organizationId: organization.id,
			objectKey: `orgs/${organization.id}/media/moved.png`,
			mimeType: 'image/png',
			fileName: 'moved.png',
			fileSize: 512,
			source: 'library',
			createdById: user.id,
		})
		const side = (bucket: string) => ({
			Endpoint: 'https://s3.example.com',
			BucketName: bucket,
			AccessKeyId: 'KEY',
			SecretAccessKey: encrypt('secret', getSSOMasterKey()),
			Region: 'us-east-1',
		})
		const source = side('old-media')
		const dest = side('new-media')
		const [migration] = await db
			.insert(StorageMigration)
			.values({
				organizationId: organization.id,
				status: 'running',
				sourceType: 'custom',
				sourceEndpoint: source.Endpoint,
				sourceBucketName: source.BucketName,
				sourceAccessKeyId: source.AccessKeyId,
				sourceSecretAccessKey: source.SecretAccessKey,
				sourceRegion: source.Region,
				destType: 'custom',
				destEndpoint: dest.Endpoint,
				destBucketName: dest.BucketName,
				destAccessKeyId: dest.AccessKeyId,
				destSecretAccessKey: dest.SecretAccessKey,
				destRegion: dest.Region,
				totalObjects: 1,
			})
			.returning()
		return migration!
	}

	it('counts an object already moved by an earlier attempt as done, not failed', async () => {
		const migration = await setupMigration()
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
			const method = init?.method ?? 'GET'
			const probe = separateBucketsProbeResponse(url, method)
			if (probe) return probe
			// Gone from the source, present at the destination.
			if (method === 'GET') return new Response('missing', { status: 404 })
			if (method === 'HEAD' && String(url).includes('new-media'))
				return new Response(null, { status: 200 })
			return new Response('unexpected', { status: 500 })
		})

		await processStorageMigrationBatch(migration.id)

		const [stored] = await db
			.select()
			.from(StorageMigration)
			.where(eq(StorageMigration.id, migration.id))
		expect(stored).toMatchObject({ processedObjects: 1, failedObjects: 0 })
	})

	it('moves every listed object when media is deleted between batches', async () => {
		const migration = await setupMigration()
		const [first] = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(
				eq(OrganizationMediaAsset.organizationId, migration.organizationId),
			)
		// 15 objects in all: two batches of up to 10.
		for (let i = 0; i < 14; i++) {
			await db.insert(OrganizationMediaAsset).values({
				organizationId: migration.organizationId,
				objectKey: `orgs/${migration.organizationId}/media/a-${String(i).padStart(2, '0')}.png`,
				mimeType: 'image/png',
				fileName: `a-${i}.png`,
				fileSize: 512,
				source: 'library',
				createdById: first!.createdById,
			})
		}
		const allKeys = (await collectOrgMediaObjects(migration.organizationId))
			.map((o) => o.objectKey)
			.sort()
		const putKeys: string[] = []
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
			const method = init?.method ?? 'GET'
			const probe = separateBucketsProbeResponse(url, method)
			if (probe) return probe
			if (method === 'PUT') {
				putKeys.push(new URL(String(url)).pathname.split('/media/')[1]!)
			}
			return new Response(method === 'GET' ? 'bytes' : null, { status: 200 })
		})

		const firstBatch = await processStorageMigrationBatch(migration.id)
		expect(firstBatch.done).toBe(false)
		// An object the first batch already moved is deleted from the library.
		await db
			.delete(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.objectKey, allKeys[0]!))
		const second = await processStorageMigrationBatch(migration.id)

		expect(second.done).toBe(true)
		expect(putKeys.sort()).toEqual(
			allKeys.map((key) => key.split('/media/')[1]!),
		)
		const [stored] = await db
			.select()
			.from(StorageMigration)
			.where(eq(StorageMigration.id, migration.id))
		expect(stored).toMatchObject({
			status: 'completed',
			totalObjects: 15,
			processedObjects: 15,
			failedObjects: 0,
		})
	})

	it('applies a progress report for a cursor only once', async () => {
		const migration = await setupMigration()
		const report = () =>
			reportStorageMigrationProgress({
				migrationId: migration.id,
				processedCount: 3,
				failedCount: 0,
				expectedCursor: 0,
			})
		await Promise.all([report(), report()])

		const [stored] = await db
			.select()
			.from(StorageMigration)
			.where(eq(StorageMigration.id, migration.id))
		expect(stored).toMatchObject({ cursor: 3, processedObjects: 3 })
	})
})

describe('one bucket behind two endpoint hostnames', () => {
	beforeEach(() => {
		vi.stubEnv('SSO_ENCRYPTION_KEY', 'a'.repeat(64))
	})
	afterEach(() => {
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
	})

	const GLOBAL_ENDPOINT = 'https://s3.amazonaws.com'
	const REGIONAL_ENDPOINT = 'https://s3.us-east-1.amazonaws.com'

	async function setupOrgWithMedia(count = 1) {
		const user = await createTestUser()
		const organization = await createTestOrganization(user.id, 'admin')
		const keys: string[] = []
		for (let i = 0; i < count; i++) {
			const objectKey = `orgs/${organization.id}/media/only-copy-${String(i).padStart(2, '0')}.png`
			keys.push(objectKey)
			await db.insert(OrganizationMediaAsset).values({
				organizationId: organization.id,
				objectKey,
				mimeType: 'image/png',
				fileName: `only-copy-${i}.png`,
				fileSize: 512,
				source: 'library',
				createdById: user.id,
			})
		}
		return { organization, keys }
	}

	const snapshot = (endpoint: string, bucketName = 'org-media') => ({
		endpoint,
		bucketName,
		accessKeyId: 'KEY',
		secretAccessKey: 'secret',
		region: 'us-east-1',
	})

	it('refuses to start a migration when the source can see what the destination wrote', async () => {
		const { organization, keys } = await setupOrgWithMedia()
		const bucket = mockOneBucketBehindTwoHosts(
			keys.map((key) => `/org-media/${key}`),
		)

		await expect(
			createAndStartStorageMigration({
				organizationId: organization.id,
				sourceType: 'custom',
				source: snapshot(GLOBAL_ENDPOINT),
				destType: 'custom',
				dest: snapshot(REGIONAL_ENDPOINT),
			}),
		).rejects.toThrow('Source and destination are the same bucket')

		const migrations = await db
			.select()
			.from(StorageMigration)
			.where(eq(StorageMigration.organizationId, organization.id))
		expect(migrations).toEqual([])
		// The media is untouched and the marker is gone.
		expect([...bucket.objects]).toEqual(keys.map((key) => `/org-media/${key}`))
		expect(bucket.deletedKeys.every(isProbeRequest)).toBe(true)
	})

	it('starts a migration between separate buckets and lists every object', async () => {
		// More objects than one item insert holds.
		const { organization } = await setupOrgWithMedia(ITEM_INSERT_CHUNK + 1)
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
			const probe = separateBucketsProbeResponse(url, init?.method ?? 'GET')
			if (probe) return probe
			if (String(url).endsWith('/workflows/storage-migration/start')) {
				return Response.json({ instanceId: 'workflow-1' })
			}
			return new Response('unexpected', { status: 500 })
		})

		const migration = await createAndStartStorageMigration({
			organizationId: organization.id,
			sourceType: 'custom',
			source: snapshot(GLOBAL_ENDPOINT, 'old-media'),
			destType: 'custom',
			dest: snapshot(GLOBAL_ENDPOINT, 'new-media'),
		})

		const [stored] = await db
			.select()
			.from(StorageMigration)
			.where(eq(StorageMigration.id, migration.id))
		expect(stored).toMatchObject({
			status: 'running',
			workflowInstanceId: 'workflow-1',
		})
		const items = await db
			.select()
			.from(StorageMigrationItem)
			.where(eq(StorageMigrationItem.migrationId, migration.id))
		expect(items).toHaveLength(ITEM_INSERT_CHUNK + 1)
	})

	it('fails a stored migration before its first batch deletes anything', async () => {
		const { organization, keys } = await setupOrgWithMedia()
		const side = (endpoint: string) => ({
			Endpoint: endpoint,
			BucketName: 'org-media',
			AccessKeyId: 'KEY',
			SecretAccessKey: encrypt('secret', getSSOMasterKey()),
			Region: 'us-east-1',
		})
		const source = side(GLOBAL_ENDPOINT)
		const dest = side(REGIONAL_ENDPOINT)
		const [migration] = await db
			.insert(StorageMigration)
			.values({
				organizationId: organization.id,
				status: 'running',
				sourceType: 'custom',
				sourceEndpoint: source.Endpoint,
				sourceBucketName: source.BucketName,
				sourceAccessKeyId: source.AccessKeyId,
				sourceSecretAccessKey: source.SecretAccessKey,
				sourceRegion: source.Region,
				destType: 'custom',
				destEndpoint: dest.Endpoint,
				destBucketName: dest.BucketName,
				destAccessKeyId: dest.AccessKeyId,
				destSecretAccessKey: dest.SecretAccessKey,
				destRegion: dest.Region,
				totalObjects: 1,
			})
			.returning()
		const bucket = mockOneBucketBehindTwoHosts(
			keys.map((key) => `/org-media/${key}`),
		)

		const result = await processStorageMigrationBatch(migration!.id)

		expect(result.done).toBe(true)
		expect([...bucket.objects]).toEqual(keys.map((key) => `/org-media/${key}`))
		expect(bucket.deletedKeys.every(isProbeRequest)).toBe(true)
		const [stored] = await db
			.select()
			.from(StorageMigration)
			.where(eq(StorageMigration.id, migration!.id))
		expect(stored).toMatchObject({
			status: 'failed',
			lastError: 'Source and destination are the same bucket',
			processedObjects: 0,
		})
	})
})
