import { randomUUID } from 'node:crypto'
import {
	type CredentialStatus,
	credentialStatuses,
	type CustomerAppCredentialKind,
	parseCredentialUpload,
} from '@repo/common/customer-app'
import { and, CustomerAppCredential, db, eq } from '@repo/database'
import { decryptAsync, encryptAsync, getEncryptionKey } from '@repo/security'

/**
 * Push credentials of one app: the APNs key and the Firebase service account.
 *
 * Write-only. `ciphertext` is encrypted with INTEGRATION_ENCRYPTION_KEY (the
 * integration pattern) and is selected by exactly one function here,
 * `checkStoredCredential`, which proves the blob still decrypts and parses and
 * answers a boolean. No loader, route or API returns it; every reader of
 * "what is set" goes through `listCredentialStatuses`, which never selects it.
 */

const key = () => getEncryptionKey('INTEGRATION_ENCRYPTION_KEY')

export type UploadResult =
	| { ok: true; status: CredentialStatus }
	| { ok: false; code: 'invalid'; message: string }

export async function storeCredential(input: {
	appId: string
	kind: CustomerAppCredentialKind
	payload: unknown
	uploadedById: string | null
}): Promise<UploadResult> {
	const parsed = parseCredentialUpload(input.kind, input.payload)
	if (!parsed.ok) return { ok: false, code: 'invalid', message: parsed.message }
	const ciphertext = await encryptAsync(parsed.secret, key())
	const uploadedAt = new Date()
	await db
		.insert(CustomerAppCredential)
		.values({
			id: randomUUID(),
			appId: input.appId,
			kind: input.kind,
			ciphertext,
			uploadedById: input.uploadedById,
			uploadedAt,
		})
		.onConflictDoUpdate({
			target: [CustomerAppCredential.appId, CustomerAppCredential.kind],
			set: { ciphertext, uploadedById: input.uploadedById, uploadedAt },
		})
	return {
		ok: true,
		status: {
			kind: input.kind,
			set: true,
			uploadedAt: uploadedAt.toISOString(),
		},
	}
}

/** Set or not, and when. The ciphertext column is never selected. */
export async function listCredentialStatuses(
	appId: string,
): Promise<CredentialStatus[]> {
	const rows = await db
		.select({
			kind: CustomerAppCredential.kind,
			uploadedAt: CustomerAppCredential.uploadedAt,
		})
		.from(CustomerAppCredential)
		.where(eq(CustomerAppCredential.appId, appId))
	return credentialStatuses(rows)
}

export async function removeCredential(
	appId: string,
	kind: CustomerAppCredentialKind,
) {
	await db
		.delete(CustomerAppCredential)
		.where(
			and(
				eq(CustomerAppCredential.appId, appId),
				eq(CustomerAppCredential.kind, kind),
			),
		)
}

/**
 * Whether the stored credential still decrypts and has the shape of its kind.
 * The secret never leaves this function.
 */
export async function checkStoredCredential(
	appId: string,
	kind: CustomerAppCredentialKind,
): Promise<boolean> {
	const [row] = await db
		.select({ ciphertext: CustomerAppCredential.ciphertext })
		.from(CustomerAppCredential)
		.where(
			and(
				eq(CustomerAppCredential.appId, appId),
				eq(CustomerAppCredential.kind, kind),
			),
		)
		.limit(1)
	if (!row) return false
	try {
		const plain = await decryptAsync(row.ciphertext, key())
		return parseCredentialUpload(kind, JSON.parse(plain)).ok
	} catch {
		return false
	}
}
