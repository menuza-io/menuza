import crypto from 'node:crypto'
import {
	LOYALTY_OTP_TTL_MS,
	LoyaltyDomainError,
	type LoyaltyFeatures,
} from '@repo/loyalty'
import { sendSms } from '@repo/sms'
import { customers, getTenantDb } from '@repo/tenant-db'
import { and, eq, sql } from 'drizzle-orm'
import { errorLogFields } from '../lib/error-log.ts'
import { enforceLoyaltyLimit } from '../lib/loyalty-rate-limit.ts'
import { withLoyaltyWrite } from '../lib/loyalty-write.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { isValidPhone, normalizePhone } from '../lib/phone.ts'
import { checkGlobalSendCap } from '../lib/rate-limit.ts'
import { hmacHash, timingSafeEqualString } from '../lib/secrets.ts'
import { evaluateAndSpawnTriggers } from './journey-service.ts'
import { findCustomerByPhone } from './customer-phone.ts'
import {
	activeProgramInTx,
	issueTillIdentificationInTx,
	type TillDevice,
	type TillIdentification,
} from './loyalty-code-service.ts'
import {
	ensureMemberForCustomerInTx,
	memberForCustomerInTx,
} from './loyalty-member-service.ts'
import { linkVerifiedCustomerToGuest } from './rsv-customer-link.ts'

/**
 * Joining the points program at the till.
 *
 * A guest with no account gives the cashier a phone number. A one-time code
 * goes to that phone, and reading it back proves the guest owns it. Only then
 * is the phone verified, the points account opened and a binding issued, the
 * same binding reading a member code gives. A number typed at the till links
 * nothing on its own: the verified phone is the whole proof, exactly as it is
 * when the guest signs in on the website or in the app.
 *
 * The one-time code lives where the sign-in code lives (the customer row, as a
 * keyed hash), so a guest who then signs in on the website with the same phone
 * is the same customer. Joining never sets marketing consent, and a suspended
 * or erased account is never reopened.
 */

export type TillJoinSent = { sent: true; expiresAt: number }

export type TillJoinResult = TillIdentification & { joined: boolean }

function requireEnabled(features: LoyaltyFeatures): void {
	if (!features.enabled) throw new LoyaltyDomainError('loyalty_disabled')
}

function normalizeJoinPhone(raw: string): string {
	const phone = normalizePhone(raw)
	// The answer never echoes the number: an unreadable one is a bad request.
	if (!isValidPhone(phone)) throw new LoyaltyDomainError('invalid_request')
	return phone
}

/**
 * The stored hash of a join code. The website sign-in code is `hmacHash(code)`
 * in the same column; the `join:` prefix binds a till code to its purpose, so
 * neither flow can consume the other's code even on the same row.
 */
function joinCodeHash(code: string): string {
	return hmacHash(`join:${code}`)
}

function joinCodeMessage(programName: string, code: string): string {
	return `${programName}: ${code} is your code to join. Share it only with the cashier. It expires in 5 minutes.`
}

function hasLiveCode(
	row:
		| {
				phoneVerificationCode: string | null
				phoneVerificationExpiresAt: Date | null
		  }
		| undefined
		| null,
	now: number,
): boolean {
	return Boolean(
		row?.phoneVerificationCode &&
		row.phoneVerificationExpiresAt &&
		row.phoneVerificationExpiresAt.getTime() > now,
	)
}

/**
 * Sends the join code. Counted per terminal and per number before anything is
 * sent, so a refusal is not free. Nothing is sent while the program is not
 * active: the code could not be used.
 */
export async function sendTillJoinCode(
	orgId: string,
	input: {
		phone: string
		device: TillDevice
		features: LoyaltyFeatures
		now?: number
	},
): Promise<TillJoinSent> {
	requireEnabled(input.features)
	const phone = normalizeJoinPhone(input.phone)
	const now = input.now ?? Date.now()
	const db = await getTenantDb(orgId)
	await enforceLoyaltyLimit(db, 'joinSend', input.device.id, now)
	await enforceLoyaltyLimit(db, 'joinSendPhone', phone, now)
	await enforceLoyaltyLimit(db, 'joinSendOrg', 'org', now)
	const program = await withLoyaltyWrite({ orgId, now }, (tx) =>
		activeProgramInTx(tx),
	)

	let existing = await findCustomerByPhone(db, phone)
	// Any row's live code may be a sign-in in flight (website or a till
	// elsewhere): overwriting it would kill that sign-in. Answer as if sent,
	// without sending, so the answer never says what the number is.
	if (hasLiveCode(existing, now)) {
		return { sent: true, expiresAt: now + LOYALTY_OTP_TTL_MS }
	}

	// Each text costs money: the node-wide cap applies like website sign-in.
	if (checkGlobalSendCap().limited) {
		throw new LoyaltyDomainError('rate_limited')
	}

	const code = crypto.randomInt(100000, 1_000_000).toString()
	const hashedCode = joinCodeHash(code)
	const expiresAt = now + LOYALTY_OTP_TTL_MS
	const codeFields = {
		phoneVerificationCode: hashedCode,
		phoneVerificationExpiresAt: new Date(expiresAt),
	}
	let createdId: string | null = null
	if (!existing) {
		// Insert-or-ignore: two sends for a new number at once cannot both
		// insert (UNIQUE phone). The loser re-reads the winner's row. The row
		// is nameless and unverified until the code is read back; the tick
		// purges one that never was (`purgeUnverifiedJoinRows`).
		const [inserted] = await retryOnSqliteBusy(() =>
			db
				.insert(customers)
				.values({ name: '', phone, ...codeFields })
				.onConflictDoNothing()
				.returning({ id: customers.id }),
		)
		if (inserted) createdId = inserted.id
		else existing = await findCustomerByPhone(db, phone)
		if (!createdId && !existing) throw new LoyaltyDomainError('otp_unavailable')
	}
	if (existing) {
		// Only write while the row still holds no live code (a concurrent send
		// may have just set one).
		const updated = await db
			.update(customers)
			.set(codeFields)
			.where(
				and(
					eq(customers.id, existing.id),
					sql`(${customers.phoneVerificationCode} is null or ${customers.phoneVerificationExpiresAt} is null or ${customers.phoneVerificationExpiresAt} <= ${Math.floor(now / 1000)})`,
				),
			)
			.returning({ id: customers.id })
		if (updated.length === 0) {
			return { sent: true, expiresAt: now + LOYALTY_OTP_TTL_MS }
		}
	}
	try {
		await sendSms({
			to: phone,
			message: joinCodeMessage(program.current.config.name, code),
		})
	} catch (error) {
		// Nothing was sent: undo what this call wrote (only while the row still
		// holds this call's code), so no unverified nameless row or dead code
		// is left behind.
		const ours = and(
			eq(customers.id, (createdId ?? existing?.id)!),
			eq(customers.phoneVerificationCode, hashedCode),
		)
		try {
			if (createdId) {
				await db
					.delete(customers)
					.where(and(ours, eq(customers.phoneVerified, false)))
					.run()
			} else {
				await db
					.update(customers)
					.set({
						phoneVerificationCode: null,
						phoneVerificationExpiresAt: null,
					})
					.where(ours)
					.run()
			}
		} catch (cleanupError) {
			console.error('Loyalty could not undo a till join code', {
				orgId,
				...errorLogFields(cleanupError),
			})
		}
		// Error codes only: never the number or the message, which holds the code.
		console.error('Loyalty could not send a till join code', {
			orgId,
			deviceId: input.device.id,
			...errorLogFields(error),
		})
		throw new LoyaltyDomainError('otp_unavailable')
	}
	return { sent: true, expiresAt }
}

/**
 * The cashier types the code the guest reads out. A right code verifies the
 * phone, opens the points account (or finds the one that exists) and binds the
 * member to this terminal. A wrong, expired or already used code, and a number
 * that was never sent a code, all answer the same `otp_invalid`.
 */
export async function verifyTillJoinCode(
	orgId: string,
	input: {
		phone: string
		code: string
		device: TillDevice
		features: LoyaltyFeatures
		now?: number
	},
): Promise<TillJoinResult> {
	requireEnabled(input.features)
	const phone = normalizeJoinPhone(input.phone)
	const now = input.now ?? Date.now()
	const db = await getTenantDb(orgId)
	await enforceLoyaltyLimit(db, 'joinVerify', phone, now)

	const customer = await findCustomerByPhone(db, phone)
	const expected = customer?.phoneVerificationCode
	if (
		!customer ||
		!expected ||
		!customer.phoneVerificationExpiresAt ||
		customer.phoneVerificationExpiresAt.getTime() <= now ||
		!timingSafeEqualString(joinCodeHash(input.code), expected)
	) {
		throw new LoyaltyDomainError('otp_invalid')
	}

	// One transaction: the code is consumed, the phone verified, the points
	// account opened and the binding issued together. Any refusal (a
	// suspended or erased account, a program that stopped) rolls all of it
	// back, so the phone is never left verified without a binding and the
	// code is not burned for nothing.
	const result = await withLoyaltyWrite({ orgId, now }, async (tx, ctx) => {
		const program = await activeProgramInTx(tx)
		const before = await memberForCustomerInTx(tx, customer.id)
		if (before && before.status !== 'active') {
			throw new LoyaltyDomainError('member_inactive')
		}
		// Consume the code atomically: two terminals reading the same code
		// back cannot both succeed.
		const [consumed] = await tx
			.update(customers)
			.set({
				phoneVerified: true,
				phoneVerificationCode: null,
				phoneVerificationExpiresAt: null,
			})
			.where(
				and(
					eq(customers.id, customer.id),
					eq(customers.phoneVerificationCode, expected),
				),
			)
			.returning({ id: customers.id })
		if (!consumed) throw new LoyaltyDomainError('otp_invalid')

		const member = await ensureMemberForCustomerInTx(tx, customer.id, ctx.now)
		// A suspended or erased account is never reopened.
		if (!member || member.status !== 'active') {
			throw new LoyaltyDomainError('member_inactive')
		}
		ctx.linkMember(member.id)
		const identification = await issueTillIdentificationInTx(tx, orgId, {
			member,
			program,
			device: input.device,
			features: input.features,
			now: ctx.now,
		})
		return { ...identification, joined: before === null }
	})

	// After the binding exists: the rest is best-effort follow-up.
	await linkVerifiedCustomerToGuest(db, customer.id, { orgId, now })
	if (!customer.phoneVerified) {
		void evaluateAndSpawnTriggers(orgId, 'phone_verified', customer.id).catch(
			(error) => {
				console.error(
					'Failed to evaluate phone_verified journey triggers:',
					errorLogFields(error),
				)
			},
		)
	}
	return result
}

/** Unverified, nameless join rows are kept this long past their code's expiry. */
const JOIN_ROW_GRACE_MS = 60 * 60_000
const JOIN_PURGE_BATCH = 100

/**
 * The tick's part: deletes the nameless, unverified rows a till join left
 * behind when the guest never read the code back. A row is deleted only when
 * its code has expired (past a grace period) and nothing at all refers to it:
 * every table with a foreign key to `customers` is checked, so a customer with
 * an order, a booking, a member account or any other data is never touched.
 * If the foreign keys cannot be listed nothing is deleted.
 */
export async function purgeUnverifiedJoinRows(
	orgId: string,
	now = Date.now(),
): Promise<{ purged: number }> {
	try {
		const db = await getTenantDb(orgId)
		const refs = (await db.all(
			sql`select m.name as tbl, f."from" as col from sqlite_master m, pragma_foreign_key_list(m.name) f where m.type = 'table' and f."table" = 'customers'`,
		)) as Array<{ tbl: string; col: string }>
		const ident = /^[A-Za-z_][A-Za-z0-9_]*$/
		if (refs.length === 0 || refs.some((r) => !ident.test(r.tbl + r.col))) {
			return { purged: 0 }
		}
		const unreferenced = refs.map(
			(r) =>
				sql`not exists (select 1 from ${sql.raw(`"${r.tbl}"`)} where ${sql.raw(`"${r.col}"`)} = ${customers.id})`,
		)
		const cutoff = Math.floor((now - JOIN_ROW_GRACE_MS) / 1000)
		const deleted = await db
			.delete(customers)
			.where(
				and(
					sql`${customers.id} in (select id from customers where name = '' and (phone_verified is null or phone_verified = 0) and email is null and refresh_token_hash is null and stripe_customer_id is null and phone_verification_expires_at is not null and phone_verification_expires_at < ${cutoff} limit ${JOIN_PURGE_BATCH})`,
					...unreferenced,
				),
			)
			.returning({ id: customers.id })
		return { purged: deleted.length }
	} catch (error) {
		console.error('Loyalty could not purge unverified join rows', {
			orgId,
			...errorLogFields(error),
		})
		return { purged: 0 }
	}
}
