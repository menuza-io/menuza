import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	GUEST_PHOTO_MAX_BYTES,
	guestPhotoSubmissionSchema,
} from '@repo/common/guest-photos'
import { parseMenuItemImageKeys } from '@repo/common/menu-types'
import { brand } from '@repo/config/brand'
import {
	and,
	db,
	eq,
	like,
	OrganizationMediaAsset,
	OrganizationMenuItem,
} from '@repo/database'
import { assertSecretNotPlaceholder } from '@repo/security'
import { detectRasterImage } from '@repo/storage'
import { SignJWT } from 'jose'
import { ENV } from 'varlock/env'
import { z } from 'zod'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import {
	deleteOrganizationStorageObject,
	uploadOrganizationMediaImage,
} from '#app/utils/storage.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'
import { isMenuFlagOn } from './menu-flags.ts'
import { recordMenuChange } from './menu-updates.server.ts'

export const MENU_GUEST_PHOTOS_FLAG_KEY = 'menu.guest_photos'
export const GUEST_PHOTO_TOKEN_AUDIENCE = 'tenant-api-guest-photos'
export const GUEST_PHOTO_TOKEN_TYP = 'pho+jwt'
export const GUEST_PHOTO_MAX_DISH_PHOTOS = 5

const GUEST_PHOTO_TTL_SECONDS = 900
const GUEST_PHOTO_IMPERSONATED_TTL_SECONDS = 300

/**
 * Single helper enforcing both the `menu.guest_photos` flag (default off) and
 * the KSA forced-off rule (KSA organizations never move guest photos into the
 * US control-plane media library).
 */
export async function isGuestPhotosEnabledForOrganization(organization: {
	id: string
	dataRegion: string | null | undefined
}): Promise<boolean> {
	if ((organization.dataRegion || '').toLowerCase() === 'ksa') {
		return false
	}
	return isMenuFlagOn(
		await getFeatureFlag(MENU_GUEST_PHOTOS_FLAG_KEY, {
			organizationId: organization.id,
		}),
	)
}

/**
 * Permission + feature-flag + region guard for every Guest Photos loader and
 * action. Checks `update:guest_photo:any` first so `route-guards.test.ts` and
 * `token-routes.access.test.ts` enforce authorization before touching DB/storage.
 */
export async function requireMenuGuestPhotosAccess(
	request: Request,
	organization: { id: string; dataRegion: string | null | undefined },
): Promise<string> {
	const userId = await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_GUEST_PHOTO_ANY,
	)
	const enabled = await isGuestPhotosEnabledForOrganization(organization)
	if (!enabled) {
		throw new Response('Not Found', { status: 404 })
	}
	return userId
}

export type MintGuestPhotosTokenInput = {
	organizationId: string
	userId: string
	dataRegion: string | null | undefined
	impersonated: boolean
	nowSeconds?: number
	secret?: string
}

export type MintedGuestPhotosToken = {
	jwt: string
	tenantApiUrl: string
	expiresAt: number
	ttlSeconds: number
	impersonated: boolean
}

/**
 * Mints a short-lived `pho+jwt` token for browser-direct and server-to-region
 * calls to `/operator/photos/*` on the regional tenant-api.
 */
export async function mintGuestPhotosToken(
	input: MintGuestPhotosTokenInput,
): Promise<MintedGuestPhotosToken> {
	const region =
		(input.dataRegion || 'us').toLowerCase() === 'ksa' ? 'ksa' : 'us'
	if (region === 'ksa') {
		throw new Response('Guest dish photos are disabled for KSA organizations', {
			status: 403,
		})
	}

	const operatorSecret = input.secret ?? ENV.TENANT_OPERATOR_TOKEN
	assertSecretNotPlaceholder('TENANT_OPERATOR_TOKEN', operatorSecret ?? '')
	if (!operatorSecret || operatorSecret.length < 16) {
		throw new Response(
			'TENANT_OPERATOR_TOKEN must be configured with >= 16 chars',
			{ status: 500 },
		)
	}

	const ttlSeconds = input.impersonated
		? GUEST_PHOTO_IMPERSONATED_TTL_SECONDS
		: GUEST_PHOTO_TTL_SECONDS
	const issuedAt = input.nowSeconds ?? Math.floor(Date.now() / 1000)
	const expSeconds = issuedAt + ttlSeconds

	const grants = input.impersonated
		? []
		: [ORG_PERMISSIONS.UPDATE_GUEST_PHOTO_ANY]

	const jwt = await new SignJWT({
		role: 'operator',
		region,
		orgId: input.organizationId,
		grants,
		impersonated: input.impersonated,
	})
		.setProtectedHeader({ alg: 'HS256', typ: GUEST_PHOTO_TOKEN_TYP })
		.setAudience(GUEST_PHOTO_TOKEN_AUDIENCE)
		.setIssuer(brand.shortName)
		.setSubject(input.userId)
		.setIssuedAt(issuedAt)
		.setExpirationTime(expSeconds)
		.sign(new TextEncoder().encode(operatorSecret))

	const { tenantApiUrl } = resolveRegionalTenantApiUrls(region)
	return {
		jwt,
		tenantApiUrl,
		expiresAt: expSeconds * 1000,
		ttlSeconds,
		impersonated: input.impersonated,
	}
}

// ---------------------------------------------------------------------------
// Defense-in-depth EXIF/metadata stripper in App before media library ingest
// ---------------------------------------------------------------------------

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_STRIP_MARKERS = new Set([
	0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed,
	0xef, 0xfe,
])
const PNG_KEEP_CHUNKS = new Set([
	'IHDR',
	'PLTE',
	'tRNS',
	'gAMA',
	'cHRM',
	'sRGB',
	'bKGD',
	'IDAT',
	'IEND',
])

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
	const out = new Uint8Array(total)
	let offset = 0
	for (const part of parts) {
		out.set(part, offset)
		offset += part.byteLength
	}
	return out
}

function readU16BE(bytes: Uint8Array, o: number) {
	return ((bytes[o] ?? 0) << 8) | (bytes[o + 1] ?? 0)
}

function readU32BE(bytes: Uint8Array, o: number) {
	return (
		(((bytes[o] ?? 0) << 24) |
			((bytes[o + 1] ?? 0) << 16) |
			((bytes[o + 2] ?? 0) << 8) |
			(bytes[o + 3] ?? 0)) >>>
		0
	)
}

function readU32LE(bytes: Uint8Array, o: number) {
	return (
		((bytes[o] ?? 0) |
			((bytes[o + 1] ?? 0) << 8) |
			((bytes[o + 2] ?? 0) << 16) |
			((bytes[o + 3] ?? 0) << 24)) >>>
		0
	)
}

function readFourCC(bytes: Uint8Array, o: number) {
	return String.fromCharCode(
		bytes[o] ?? 0,
		bytes[o + 1] ?? 0,
		bytes[o + 2] ?? 0,
		bytes[o + 3] ?? 0,
	)
}

function stripJpegSegments(bytes: Uint8Array): Uint8Array | null {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
	const kept: Uint8Array[] = [new Uint8Array([0xff, 0xd8])]
	let offset = 2
	while (offset < bytes.length) {
		if (bytes[offset] !== 0xff) return null
		while (offset < bytes.length && bytes[offset] === 0xff) offset++
		if (offset >= bytes.length) return null
		const marker = bytes[offset++]!
		if (marker === 0xd9) {
			kept.push(new Uint8Array([0xff, 0xd9]))
			return offset === bytes.length ? concatBytes(kept) : null
		}
		if (marker === 0x00) return null
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			kept.push(new Uint8Array([0xff, marker]))
			continue
		}
		if (offset + 2 > bytes.length) return null
		const len = readU16BE(bytes, offset)
		if (len < 2 || offset + len > bytes.length) return null
		const segmentEnd = offset + len
		if (!JPEG_STRIP_MARKERS.has(marker)) {
			kept.push(new Uint8Array([0xff, marker]))
			kept.push(bytes.subarray(offset, segmentEnd))
		}
		offset = segmentEnd
		if (marker !== 0xda) continue
		const scanStart = offset
		let found = false
		while (offset < bytes.length) {
			if (bytes[offset] !== 0xff) {
				offset++
				continue
			}
			const markerOffset = offset
			while (offset < bytes.length && bytes[offset] === 0xff) offset++
			if (offset >= bytes.length) return null
			const scanMarker = bytes[offset]!
			if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
				offset++
				continue
			}
			kept.push(bytes.subarray(scanStart, markerOffset))
			offset = markerOffset
			found = true
			break
		}
		if (!found) return null
	}
	return null
}

function stripPngChunks(bytes: Uint8Array): Uint8Array | null {
	if (bytes.length < 45 || !PNG_SIG.every((b, i) => bytes[i] === b)) {
		return null
	}
	const kept: Uint8Array[] = [new Uint8Array(PNG_SIG)]
	let offset = PNG_SIG.length
	while (offset + 12 <= bytes.length) {
		const len = readU32BE(bytes, offset)
		const chunkEnd = offset + 12 + len
		if (chunkEnd > bytes.length) return null
		const type = readFourCC(bytes, offset + 4)
		if (PNG_KEEP_CHUNKS.has(type)) {
			kept.push(bytes.subarray(offset, chunkEnd))
		}
		offset = chunkEnd
		if (type === 'IEND')
			return offset === bytes.length ? concatBytes(kept) : null
	}
	return null
}

function stripWebpChunks(bytes: Uint8Array): Uint8Array | null {
	if (
		bytes.length < 20 ||
		readFourCC(bytes, 0) !== 'RIFF' ||
		readFourCC(bytes, 8) !== 'WEBP'
	) {
		return null
	}
	const parts: Uint8Array[] = [new Uint8Array(12)]
	let offset = 12
	while (offset + 8 <= bytes.length) {
		const type = readFourCC(bytes, offset)
		const len = readU32LE(bytes, offset + 4)
		const dataStart = offset + 8
		const dataEnd = dataStart + len
		const chunkEnd = dataEnd + (len % 2)
		if (chunkEnd > bytes.length) return null
		if (
			type === 'VP8 ' ||
			type === 'VP8L' ||
			type === 'ALPH' ||
			type === 'ANIM' ||
			type === 'ANMF'
		) {
			parts.push(bytes.subarray(offset, chunkEnd))
		} else if (type === 'VP8X' && len === 10) {
			const chunkCopy = new Uint8Array(bytes.subarray(offset, chunkEnd))
			chunkCopy[8] = (chunkCopy[8] ?? 0) & ~(0x20 | 0x08 | 0x04)
			parts.push(chunkCopy)
		}
		offset = chunkEnd
	}
	const out = concatBytes(parts)
	out.set([0x52, 0x49, 0x46, 0x46], 0)
	const riffLen = out.byteLength - 8
	out[4] = riffLen & 0xff
	out[5] = (riffLen >>> 8) & 0xff
	out[6] = (riffLen >>> 16) & 0xff
	out[7] = (riffLen >>> 24) & 0xff
	out.set([0x57, 0x45, 0x42, 0x50], 8)
	return out
}

export function sanitizeCleanDishImageBytes(bytes: Uint8Array): {
	bytes: Uint8Array
	mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
	extension: 'jpg' | 'png' | 'webp'
} | null {
	const copy = new Uint8Array(bytes.byteLength)
	copy.set(bytes)
	const detected = detectRasterImage(copy.buffer)
	if (!detected) return null
	if (detected.mimeType === 'image/jpeg') {
		const clean = stripJpegSegments(bytes)
		return clean
			? { bytes: clean, mimeType: 'image/jpeg', extension: 'jpg' }
			: null
	}
	if (detected.mimeType === 'image/png') {
		const clean = stripPngChunks(bytes)
		return clean
			? { bytes: clean, mimeType: 'image/png', extension: 'png' }
			: null
	}
	if (detected.mimeType === 'image/webp') {
		const clean = stripWebpChunks(bytes)
		return clean
			? { bytes: clean, mimeType: 'image/webp', extension: 'webp' }
			: null
	}
	return null
}

// ---------------------------------------------------------------------------
// App-side Add to dish & Remove from dish orchestration
// ---------------------------------------------------------------------------

export type GuestPhotoTenantFetch = (
	path: string,
	init: RequestInit & { token: string },
) => Promise<Response>

async function defaultTenantFetch(
	tenantApiUrl: string,
	path: string,
	init: RequestInit & { token: string },
): Promise<Response> {
	const headers = new Headers(init.headers)
	headers.set('Authorization', `Bearer ${init.token}`)
	if (init.body && !headers.has('Content-Type')) {
		headers.set('Content-Type', 'application/json')
	}
	return fetch(`${tenantApiUrl}${path}`, { ...init, headers })
}

const signedUrlResponseSchema = z.object({
	url: z.string().url(),
	contentType: z.string().optional(),
	itemId: z.string().optional(),
})

export type AddGuestPhotoToDishResult =
	| { ok: true; objectKey: string; imageKeys: string[] }
	| { ok: false; status: number; error: string }

export async function addGuestPhotoToDish(input: {
	organization: {
		id: string
		slug: string
		dataRegion: string | null | undefined
	}
	userId: string
	impersonated: boolean
	submissionId: string
	itemId: string
	makePrimary?: boolean
	request?: Request
	deps?: {
		fetchTenant?: GuestPhotoTenantFetch
		fetchSignedImage?: (url: string) => Promise<Response>
		uploadMedia?: typeof uploadOrganizationMediaImage
		deleteStorageObject?: typeof deleteOrganizationStorageObject
	}
}): Promise<AddGuestPhotoToDishResult> {
	if (input.impersonated) {
		return { ok: false, status: 403, error: 'impersonated_read_only' }
	}

	const [item] = await db
		.select({
			id: OrganizationMenuItem.id,
			imageKey: OrganizationMenuItem.imageKey,
			imageUrl: OrganizationMenuItem.imageUrl,
			imageKeys: OrganizationMenuItem.imageKeys,
		})
		.from(OrganizationMenuItem)
		.where(
			and(
				eq(OrganizationMenuItem.id, input.itemId),
				eq(OrganizationMenuItem.organizationId, input.organization.id),
			),
		)
		.limit(1)

	if (!item) {
		return { ok: false, status: 404, error: 'item_not_found' }
	}

	const currentKeys = parseMenuItemImageKeys(item.imageKeys, item.imageKey)
	if (currentKeys.length >= GUEST_PHOTO_MAX_DISH_PHOTOS) {
		return { ok: false, status: 409, error: 'dish_photos_full' }
	}

	const minted = await mintGuestPhotosToken({
		organizationId: input.organization.id,
		userId: input.userId,
		dataRegion: input.organization.dataRegion,
		impersonated: false,
	})
	const callTenant =
		input.deps?.fetchTenant ??
		((path, init) => defaultTenantFetch(minted.tenantApiUrl, path, init))

	// Verify the submission on the region is approved and belongs to this item.
	const statusRes = await callTenant(
		`/operator/photos/${encodeURIComponent(input.submissionId)}`,
		{ method: 'GET', token: minted.jwt },
	)
	if (!statusRes.ok) {
		return {
			ok: false,
			status: statusRes.status,
			error: statusRes.status === 404 ? 'submission_not_found' : 'region_error',
		}
	}
	const statusJson = (await statusRes.json().catch(() => null)) as {
		submission?: unknown
	} | null
	const parsedSub = guestPhotoSubmissionSchema.safeParse(statusJson?.submission)
	if (!parsedSub.success) {
		return { ok: false, status: 502, error: 'invalid_region_response' }
	}
	if (parsedSub.data.status !== 'approved') {
		return { ok: false, status: 409, error: 'not_approved' }
	}
	if (parsedSub.data.itemId !== input.itemId) {
		return { ok: false, status: 400, error: 'item_mismatch' }
	}

	// Fetch the cleaned image server-side via a short-lived signed URL from the
	// region instead of trusting browser-posted bytes.
	const signedRes = await callTenant(
		`/operator/photos/${encodeURIComponent(input.submissionId)}/signed-url`,
		{ method: 'GET', token: minted.jwt },
	)
	if (!signedRes.ok) {
		const errBody = (await signedRes.json().catch(() => null)) as {
			error?: string
		} | null
		return {
			ok: false,
			status: signedRes.status,
			error:
				errBody?.error ??
				(signedRes.status === 404 ? 'submission_not_found' : 'region_error'),
		}
	}
	const signedJson = await signedRes.json().catch(() => null)
	const parsedSigned = signedUrlResponseSchema.safeParse(signedJson)
	if (!parsedSigned.success) {
		return { ok: false, status: 502, error: 'invalid_region_response' }
	}
	if (parsedSigned.data.itemId && parsedSigned.data.itemId !== input.itemId) {
		return { ok: false, status: 400, error: 'item_mismatch' }
	}
	const signedUrl = new URL(parsedSigned.data.url)
	if (signedUrl.protocol !== 'https:' && signedUrl.protocol !== 'http:') {
		return { ok: false, status: 502, error: 'invalid_region_response' }
	}

	const fetchSignedImage =
		input.deps?.fetchSignedImage ?? ((url: string) => fetch(url))
	const imgRes = await fetchSignedImage(signedUrl.toString())
	if (!imgRes.ok) {
		return { ok: false, status: 502, error: 'image_fetch_failed' }
	}
	const contentLength = imgRes.headers.get('Content-Length')
	if (contentLength) {
		const declared = Number(contentLength)
		if (Number.isFinite(declared) && declared > GUEST_PHOTO_MAX_BYTES) {
			return { ok: false, status: 400, error: 'invalid_image_size' }
		}
	}
	const rawBytes = new Uint8Array(await imgRes.arrayBuffer())
	if (rawBytes.byteLength <= 0 || rawBytes.byteLength > GUEST_PHOTO_MAX_BYTES) {
		return { ok: false, status: 400, error: 'invalid_image_size' }
	}
	const clean = sanitizeCleanDishImageBytes(rawBytes)
	if (!clean) {
		return { ok: false, status: 400, error: 'invalid_image_data' }
	}

	// Copy ONLY the cleaned image into the App media library with an opaque name
	// (zero guest PII / customer ID).
	const cleanCopy = new Uint8Array(clean.bytes.byteLength)
	cleanCopy.set(clean.bytes)
	const cleanFile = new File(
		[cleanCopy.buffer],
		`guest-photo-${input.submissionId}.${clean.extension}`,
		{ type: clean.mimeType },
	)

	const uploadMedia = input.deps?.uploadMedia ?? uploadOrganizationMediaImage
	const newObjectKey = await uploadMedia(
		input.organization.id,
		cleanFile,
		input.userId,
		'library',
	)

	const [asset] = await db
		.select({ id: OrganizationMediaAsset.id })
		.from(OrganizationMediaAsset)
		.where(
			and(
				eq(OrganizationMediaAsset.organizationId, input.organization.id),
				eq(OrganizationMediaAsset.objectKey, newObjectKey),
			),
		)
		.limit(1)

	const nextKeys = (
		input.makePrimary
			? [newObjectKey, ...currentKeys]
			: [...currentKeys, newObjectKey]
	).slice(0, GUEST_PHOTO_MAX_DISH_PHOTOS)

	await db
		.update(OrganizationMenuItem)
		.set({
			imageKeys: JSON.stringify(nextKeys),
			imageKey: nextKeys[0] ?? null,
			...(input.makePrimary || !item.imageKey ? { imageUrl: null } : {}),
		})
		.where(
			and(
				eq(OrganizationMenuItem.id, input.itemId),
				eq(OrganizationMenuItem.organizationId, input.organization.id),
			),
		)

	const markRes = await callTenant(
		`/operator/photos/${encodeURIComponent(input.submissionId)}/added`,
		{
			method: 'POST',
			token: minted.jwt,
			body: JSON.stringify(asset ? { mediaAssetId: asset.id } : {}),
		},
	)

	if (!markRes.ok) {
		// Roll back dish images and media asset if the region refused `added`.
		await db
			.update(OrganizationMenuItem)
			.set({
				imageKeys: JSON.stringify(currentKeys),
				imageKey: item.imageKey,
				imageUrl: item.imageUrl,
			})
			.where(
				and(
					eq(OrganizationMenuItem.id, input.itemId),
					eq(OrganizationMenuItem.organizationId, input.organization.id),
				),
			)
		if (asset) {
			await db
				.delete(OrganizationMediaAsset)
				.where(eq(OrganizationMediaAsset.id, asset.id))
		}
		const deleteStorage =
			input.deps?.deleteStorageObject ?? deleteOrganizationStorageObject
		await deleteStorage(input.organization.id, newObjectKey).catch(() => {})

		const errBody = (await markRes.json().catch(() => null)) as {
			error?: string
		} | null
		return {
			ok: false,
			status: markRes.status,
			error: errBody?.error ?? 'not_approved',
		}
	}

	await recordMenuChange({
		organization: input.organization,
		userId: input.userId,
		request: input.request,
		resourceType: 'menu_item',
		resourceId: input.itemId,
		details: `Added approved guest photo ${input.submissionId} to dish`,
	})

	return { ok: true, objectKey: newObjectKey, imageKeys: nextKeys }
}

export type RemoveGuestPhotoFromDishResult =
	| { ok: true; imageKeys: string[] }
	| { ok: false; status: number; error: string }

export async function removeGuestPhotoFromDish(input: {
	organization: {
		id: string
		slug: string
		dataRegion: string | null | undefined
	}
	userId: string
	impersonated: boolean
	submissionId: string
	itemId: string
	request?: Request
	deps?: {
		fetchTenant?: GuestPhotoTenantFetch
	}
}): Promise<RemoveGuestPhotoFromDishResult> {
	if (input.impersonated) {
		return { ok: false, status: 403, error: 'impersonated_read_only' }
	}

	const [item] = await db
		.select({
			id: OrganizationMenuItem.id,
			imageKey: OrganizationMenuItem.imageKey,
			imageKeys: OrganizationMenuItem.imageKeys,
		})
		.from(OrganizationMenuItem)
		.where(
			and(
				eq(OrganizationMenuItem.id, input.itemId),
				eq(OrganizationMenuItem.organizationId, input.organization.id),
			),
		)
		.limit(1)

	if (!item) {
		return { ok: false, status: 404, error: 'item_not_found' }
	}

	const minted = await mintGuestPhotosToken({
		organizationId: input.organization.id,
		userId: input.userId,
		dataRegion: input.organization.dataRegion,
		impersonated: false,
	})
	const callTenant =
		input.deps?.fetchTenant ??
		((path, init) => defaultTenantFetch(minted.tenantApiUrl, path, init))

	const removeRes = await callTenant(
		`/operator/photos/${encodeURIComponent(input.submissionId)}/remove`,
		{ method: 'POST', token: minted.jwt },
	)
	if (!removeRes.ok) {
		const errBody = (await removeRes.json().catch(() => null)) as {
			error?: string
		} | null
		return {
			ok: false,
			status: removeRes.status,
			error: errBody?.error ?? 'remove_failed',
		}
	}

	const matchingAssets = await db
		.select({ objectKey: OrganizationMediaAsset.objectKey })
		.from(OrganizationMediaAsset)
		.where(
			and(
				eq(OrganizationMediaAsset.organizationId, input.organization.id),
				like(
					OrganizationMediaAsset.fileName,
					`guest-photo-${input.submissionId}.%`,
				),
			),
		)
	const keysToRemove = new Set(matchingAssets.map((a) => a.objectKey))
	const currentKeys = parseMenuItemImageKeys(item.imageKeys, item.imageKey)
	const nextKeys = currentKeys.filter((key) => !keysToRemove.has(key))

	if (nextKeys.length !== currentKeys.length) {
		await db
			.update(OrganizationMenuItem)
			.set({
				imageKeys: JSON.stringify(nextKeys),
				imageKey: nextKeys[0] ?? null,
			})
			.where(
				and(
					eq(OrganizationMenuItem.id, input.itemId),
					eq(OrganizationMenuItem.organizationId, input.organization.id),
				),
			)
		await recordMenuChange({
			organization: input.organization,
			userId: input.userId,
			request: input.request,
			resourceType: 'menu_item',
			resourceId: input.itemId,
			details: `Removed guest photo ${input.submissionId} from dish`,
		})
	}

	return { ok: true, imageKeys: nextKeys }
}
