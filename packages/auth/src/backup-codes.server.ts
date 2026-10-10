import crypto from 'node:crypto'
import { and, BackupCode, count, db, eq, isNull } from '@repo/database'
import bcrypt from 'bcryptjs'

const BACKUP_CODE_LENGTH = 8
const BACKUP_CODE_COUNT = 10
// Project-wide floor for bcrypt cost (see AGENTS.md). Existing hashes keep
// verifying: bcrypt reads the cost from the stored hash.
const BACKUP_CODE_BCRYPT_COST = 12
const BACKUP_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // No ambiguous chars (0, O, I, 1)

/**
 * Generate a single random backup code using unbiased random selection
 */
function generateSingleCode(): string {
	let code = ''
	const charsetLength = BACKUP_CODE_CHARSET.length
	const maxValid = Math.floor(256 / charsetLength) * charsetLength

	for (let i = 0; i < BACKUP_CODE_LENGTH; i++) {
		let randomByte: number
		do {
			randomByte = crypto.randomBytes(1)[0]!
		} while (randomByte >= maxValid)

		code += BACKUP_CODE_CHARSET[randomByte % charsetLength]
	}
	return `${code.slice(0, 4)}-${code.slice(4)}`
}

/**
 * Hash a backup code using bcrypt
 */
export async function hashBackupCode(code: string): Promise<string> {
	const normalizedCode = code.replace(/-/g, '').toUpperCase()
	return bcrypt.hash(normalizedCode, BACKUP_CODE_BCRYPT_COST)
}

/**
 * Verify a backup code against its hash
 */
export async function verifyBackupCode(
	code: string,
	hash: string,
): Promise<boolean> {
	const normalizedCode = code.replace(/-/g, '').toUpperCase()
	return bcrypt.compare(normalizedCode, hash)
}

/**
 * Generate a set of backup codes for a user
 * Returns the plain text codes (to show to user) and stores hashes in DB
 */
export async function generateBackupCodes(
	userId: string,
	countCodes: number = BACKUP_CODE_COUNT,
): Promise<string[]> {
	const codes: string[] = []
	const codeHashes: string[] = []

	for (let i = 0; i < countCodes; i++) {
		const code = generateSingleCode()
		codes.push(code)
		codeHashes.push(await hashBackupCode(code))
	}

	await db.delete(BackupCode).where(eq(BackupCode.userId, userId))
	await db.insert(BackupCode).values(
		codeHashes.map((codeHash) => ({
			userId,
			codeHash,
		})),
	)

	return codes
}

/**
 * Get the count of unused backup codes for a user
 */
export async function getUnusedBackupCodeCount(
	userId: string,
): Promise<number> {
	const [row] = await db
		.select({ value: count() })
		.from(BackupCode)
		.where(and(eq(BackupCode.userId, userId), isNull(BackupCode.usedAt)))
	return row?.value ?? 0
}

/**
 * Check if a user has any backup codes (used or unused)
 */
export async function hasBackupCodes(userId: string): Promise<boolean> {
	const [row] = await db
		.select({ value: count() })
		.from(BackupCode)
		.where(eq(BackupCode.userId, userId))
	return (row?.value ?? 0) > 0
}

/**
 * Validate a backup code and consume it if valid
 * Returns true if code was valid and consumed, false otherwise
 */
export async function validateAndConsumeBackupCode(
	userId: string,
	code: string,
): Promise<boolean> {
	const unusedCodes = await db
		.select({
			id: BackupCode.id,
			codeHash: BackupCode.codeHash,
		})
		.from(BackupCode)
		.where(and(eq(BackupCode.userId, userId), isNull(BackupCode.usedAt)))

	for (const backupCode of unusedCodes) {
		const isValid = await verifyBackupCode(code, backupCode.codeHash)
		if (isValid) {
			// Consume with a conditional update so a code replayed concurrently
			// across two requests only succeeds once.
			const consumed = await db
				.update(BackupCode)
				.set({ usedAt: new Date() })
				.where(and(eq(BackupCode.id, backupCode.id), isNull(BackupCode.usedAt)))
				.returning({ id: BackupCode.id })
			return consumed.length > 0
		}
	}

	return false
}

/**
 * Delete all backup codes for a user (e.g., when disabling 2FA)
 */
export async function deleteBackupCodes(userId: string): Promise<void> {
	await db.delete(BackupCode).where(eq(BackupCode.userId, userId))
}
