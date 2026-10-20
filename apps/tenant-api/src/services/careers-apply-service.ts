import { and, count, eq, gte, or } from 'drizzle-orm'
import {
	buildAnswerSnapshots,
	dedupeKeys,
	HIRING_LIMITS,
	managerOutboxKind,
	scoreScreener,
	type AnswerProblem,
	type CareersApplyInput,
} from '@repo/staffing'
import {
	hiringApplications,
	hiringEvents,
	notificationOutbox,
	type TenantDatabase,
	runTenantTransaction,
} from '@repo/tenant-db'
import { type LivePosting } from '../lib/job-posting-context.ts'
import { hmacHash } from '../lib/secrets.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'

/**
 * Stores a public application. The caller (the `/careers/apply` route) has
 * already resolved the organization from the browser's Origin, checked the
 * challenge, and fetched the live posting from the control plane; nothing here
 * trusts the client about what the posting asks.
 *
 * Abuse limits are stored in the organization's own database so they hold on
 * every runtime (the in-process limiter resets per isolate): a ceiling on how
 * many applications one organization accepts per hour, and a ceiling per
 * keyed hash of the caller's address per hour and per day. A repeat application
 * from the same person to the same posting is not an error and not a second
 * record: the answer is the same "received" as for a new one, so the form cannot
 * be used to learn who has applied.
 */

export type ApplyOutcome =
	| { status: 'received'; duplicate: boolean }
	| { status: 'invalid_answers'; problems: AnswerProblem[] }
	| { status: 'invalid_scope' }
	| { status: 'rate_limited'; scope: 'organization' | 'address' }

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

function isUniqueViolation(error: unknown): boolean {
	let root: unknown = error
	while (root instanceof Error && (root as { cause?: unknown }).cause) {
		root = (root as { cause?: unknown }).cause
	}
	return (
		root instanceof Error &&
		/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(root.message)
	)
}

/** Keyed, per organization and posting: never reversible without the secret. */
export function applicantContactHash(
	kind: 'email' | 'phone',
	orgId: string,
	postingId: string,
	value: string,
): string {
	return hmacHash(`applicant-${kind}:${orgId}:${postingId}:${value}`)
}

/**
 * Where the person would work. A job at one scope is always that scope;
 * at several, the person names one or more of them. The browser's word is
 * checked against the posting's own list, never trusted. The first chosen
 * scope, in the posting's order, is the application's primary one.
 */
export function resolveApplicantScopes(
	allowed: readonly string[],
	chosen: readonly string[],
): { ok: true; scopeId: string | null; scopeIds: string[] } | { ok: false } {
	if (allowed.length === 0) return { ok: true, scopeId: null, scopeIds: [] }
	const picked = new Set(chosen)
	if (picked.size === 0) {
		return allowed.length === 1
			? { ok: true, scopeId: allowed[0]!, scopeIds: [allowed[0]!] }
			: { ok: false }
	}
	if ([...picked].some((id) => !allowed.includes(id))) return { ok: false }
	const ordered = allowed.filter((id) => picked.has(id))
	return { ok: true, scopeId: ordered[0]!, scopeIds: ordered }
}

export async function submitApplication(
	db: TenantDatabase,
	input: {
		orgId: string
		posting: LivePosting
		body: CareersApplyInput
		ipHash: string | null
		now: number
	},
): Promise<ApplyOutcome> {
	const { orgId, posting, body, ipHash, now } = input

	const place = resolveApplicantScopes(posting.scopeIds, [
		...(body.scopeIds ?? []),
		...(body.scopeId ? [body.scopeId] : []),
	])
	if (!place.ok) return { status: 'invalid_scope' }

	const built = buildAnswerSnapshots(posting.questions, body.answers)
	if (!built.ok) return { status: 'invalid_answers', problems: built.problems }
	const result = scoreScreener(built.snapshots)

	const emailHash = body.email
		? applicantContactHash('email', orgId, posting.id, body.email)
		: null
	const phoneHash = body.phone
		? applicantContactHash('phone', orgId, posting.id, body.phone)
		: null

	// Same person, same posting, still in the pipeline: nothing to add.
	const contact = [
		emailHash ? eq(hiringApplications.emailHash, emailHash) : undefined,
		phoneHash ? eq(hiringApplications.phoneHash, phoneHash) : undefined,
	].filter((clause) => clause !== undefined)
	if (contact.length > 0) {
		const matches = await db
			.select({ stage: hiringApplications.stage })
			.from(hiringApplications)
			.where(and(eq(hiringApplications.postingId, posting.id), or(...contact)))
			.limit(10)
		if (matches.some((match) => match.stage !== 'declined')) {
			return { status: 'received', duplicate: true }
		}
	}

	const [orgRecent] = await db
		.select({ total: count() })
		.from(hiringApplications)
		.where(gte(hiringApplications.createdAt, now - HOUR_MS))
	if ((orgRecent?.total ?? 0) >= HIRING_LIMITS.perOrgPerHour) {
		return { status: 'rate_limited', scope: 'organization' }
	}
	if (ipHash) {
		const [hour, day] = await Promise.all([
			db
				.select({ total: count() })
				.from(hiringApplications)
				.where(
					and(
						eq(hiringApplications.ipHash, ipHash),
						gte(hiringApplications.createdAt, now - HOUR_MS),
					),
				),
			db
				.select({ total: count() })
				.from(hiringApplications)
				.where(
					and(
						eq(hiringApplications.ipHash, ipHash),
						gte(hiringApplications.createdAt, now - DAY_MS),
					),
				),
		])
		if (
			(hour[0]?.total ?? 0) >= HIRING_LIMITS.perIpPerHour ||
			(day[0]?.total ?? 0) >= HIRING_LIMITS.perIpPerDay
		) {
			return { status: 'rate_limited', scope: 'address' }
		}
	}

	try {
		await retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx) => {
				const [created] = await tx
					.insert(hiringApplications)
					.values({
						postingId: posting.id,
						postingSlug: posting.slug,
						postingTitle: posting.title,
						positionName: posting.positionName || null,
						scopeId: place.scopeId,
						source: body.source,
						firstName: body.firstName,
						lastName: body.lastName,
						email: body.email ?? null,
						phone: body.phone ?? null,
						emailHash,
						phoneHash,
						locale: body.locale,
						answers: built.snapshots,
						screenerScore: result.score,
						screenerFlags: result.flags,
						// The server's clock, never the browser's.
						consentAt: now,
						consentVersion: body.consentVersion,
						ipHash,
						stageChangedAt: now,
						createdAt: now,
						updatedAt: now,
					})
					.returning({ id: hiringApplications.id })
				const applicationId = created!.id
				await tx.insert(hiringEvents).values({
					applicationId,
					kind: 'applied',
					actorId: null,
					toStage: 'new',
					at: now,
				})
				// The generic "new applicant" event for managers: an id and a count,
				// never a name. The tick delivers it to the App.
				await tx
					.insert(notificationOutbox)
					.values({
						kind: managerOutboxKind('new_applicant'),
						staffId: 'system',
						scopeId: place.scopeId,
						dedupeKey: dedupeKeys.newApplicant(applicationId),
						payload: {},
						nextAttemptAt: now,
						createdAt: now,
					})
					.onConflictDoNothing()
			}),
		)
	} catch (error) {
		// Two submissions raced: the unique index let one through.
		if (isUniqueViolation(error)) return { status: 'received', duplicate: true }
		throw error
	}
	return { status: 'received', duplicate: false }
}
