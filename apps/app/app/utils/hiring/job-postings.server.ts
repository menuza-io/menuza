import { AuditAction, auditService } from '@repo/audit'
import {
	canTransitionJobPosting,
	closesOnToDate,
	dateToClosesOn,
	effectiveJobPostingStatus,
	GENERAL_APPLICATION_DEFAULTS,
	GENERAL_APPLICATION_SLUG,
	getJobPostingPublishErrors,
	JOB_POSTING_LIMITS,
	jobPostingContentSchema,
	normalizePay,
	parseScreenerQuestions,
	stripMarkup,
	toPublicQuestion,
	uniqueJobPostingSlug,
	type JobEmploymentType,
	type JobPayType,
	type JobPostingContent,
	type PublicJobLocation,
	type PublicJobPosting,
	type PublicJobPostingListItem,
	type ScreenerQuestion,
	localizeJobPosting,
	parseJobPostingTranslations,
	type JobPostingTranslations,
} from '@repo/common/job-posting'
import { getLocationCurrency } from '@repo/common/location-currency'
import {
	and,
	asc,
	db,
	desc,
	eq,
	inArray,
	JobPosting,
	lte,
	OrganizationLocation,
} from '@repo/database'
import { DEFAULT_SCOPE_ID } from '@repo/staffing'
import {
	displayLocationName,
	orgDefaultLocale,
} from '#app/utils/location-name.server.ts'
import { sanitizeJobDescription } from './job-description-sanitize.server.ts'
import {
	type PostingDetail,
	type PostingFailure,
	type PostingSummary,
} from './job-posting-types.ts'

export type { PostingDetail, PostingFailure, PostingSummary }

/**
 * Job postings (staffing.hiring), control plane. Public content only: nothing
 * in here is a person. Every function takes the organization id from the
 * caller's verified membership, never from the request, and every row lookup
 * is filtered by it, so one organization can never read or change another's
 * postings by guessing an id.
 *
 * `scopeIds` is the member's staffing scope, a location for a restaurant
 * (`null` is every location). A member limited to some locations sees and manages only the
 * postings for those locations; organization-wide postings stay with members
 * who hold every location.
 */

export type PostingActorScope = {
	organizationId: string
	userId: string
	/**
	 * The member's scopes (locations for a restaurant); `null` is every scope,
	 * like the staffing token claim.
	 */
	scopeIds: string[] | null
	request?: Request
}

export type PostingResult<T> = { ok: true; value: T } | PostingFailure

type PostingRow = typeof JobPosting.$inferSelect

/** Whether a member with this scope may touch a posting at `locationId`. */
export function canAccessPostingLocation(
	locationIds: string[] | null,
	locationId: string | null,
): boolean {
	if (locationIds === null) return true
	if (locationId === null) return false
	return locationIds.includes(locationId)
}

/** Whether a member may touch a posting open at `postingLocationIds` (empty = every location). */
export function canAccessPostingLocations(
	scopeLocationIds: string[] | null,
	postingLocationIds: string[],
): boolean {
	if (scopeLocationIds === null) return true
	// A posting for every location, or for one the member does not manage, is
	// outside a scoped member's reach.
	if (postingLocationIds.length === 0) return false
	return postingLocationIds.every((id) => scopeLocationIds.includes(id))
}

/** The ids a posting names, defensively read (empty means every location). */
export function locationIdsOf(row: Pick<PostingRow, 'locationIds'>): string[] {
	const value: unknown = row.locationIds
	if (!Array.isArray(value)) return []
	return [
		...new Set(
			value.filter((id): id is string => typeof id === 'string' && id !== ''),
		),
	]
}

function toSummary(
	row: PostingRow,
	names: Map<string, string>,
	now: Date,
): PostingSummary {
	const ids = locationIdsOf(row)
	return {
		id: row.id,
		slug: row.slug,
		title: row.title,
		positionName: row.positionName,
		status: effectiveJobPostingStatus(row, now),
		employmentType: row.employmentType as JobEmploymentType,
		locationIds: ids,
		locationNames: ids.flatMap((id) => names.get(id) ?? []),
		isGeneral: row.isGeneral,
		payType: row.payType as JobPayType,
		payMinMinor: row.payMinMinor,
		payMaxMinor: row.payMaxMinor,
		currency: row.currency,
		publishedAt: row.publishedAt?.toISOString() ?? null,
		expiresAt: row.expiresAt?.toISOString() ?? null,
		updatedAt: row.updatedAt.toISOString(),
	}
}

function toDetail(
	row: PostingRow,
	names: Map<string, string>,
	now: Date,
): PostingDetail {
	return {
		...toSummary(row, names, now),
		descriptionHtml: row.descriptionHtml,
		questions: parseScreenerQuestions(row.questions),
		translations: parseJobPostingTranslations(row.translations),
		closesOn: dateToClosesOn(row.expiresAt),
	}
}

async function locationNames(organizationId: string) {
	const [rows, defaultLocale] = await Promise.all([
		db
			.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.organizationId, organizationId)),
		orgDefaultLocale(organizationId),
	])
	return new Map(
		rows.map((row) => [
			row.id,
			displayLocationName(row.name, defaultLocale, defaultLocale),
		]),
	)
}

async function safeAudit(
	action: AuditAction,
	scope: PostingActorScope,
	posting: { id: string; slug: string },
	details: string,
	metadata: Record<string, string | number | boolean | null> = {},
) {
	try {
		await auditService.log({
			action,
			userId: scope.userId,
			organizationId: scope.organizationId,
			resourceType: 'job_posting',
			resourceId: posting.id,
			details,
			// Ids and states only: the title and text are public content, but an
			// audit row never needs them.
			metadata: { slug: posting.slug, ...metadata },
			request: scope.request,
		})
	} catch (error) {
		// Auditing must never undo a posting change that already happened.
		console.error(`Failed to write audit log ${action}:`, error)
	}
}

export async function listJobPostings(
	scope: Pick<PostingActorScope, 'organizationId' | 'scopeIds'>,
	now: Date = new Date(),
): Promise<PostingSummary[]> {
	const [rows, names] = await Promise.all([
		db
			.select()
			.from(JobPosting)
			.where(eq(JobPosting.organizationId, scope.organizationId))
			.orderBy(
				desc(JobPosting.isGeneral),
				desc(JobPosting.updatedAt),
				asc(JobPosting.title),
			),
		locationNames(scope.organizationId),
	])
	return rows
		.filter((row) =>
			canAccessPostingLocations(scope.scopeIds, locationIdsOf(row)),
		)
		.map((row) => toSummary(row, names, now))
}

async function findRow(
	scope: Pick<PostingActorScope, 'organizationId' | 'scopeIds'>,
	id: string,
): Promise<PostingRow | null> {
	if (!id || id.length > 64) return null
	const [row] = await db
		.select()
		.from(JobPosting)
		.where(
			and(
				eq(JobPosting.id, id),
				eq(JobPosting.organizationId, scope.organizationId),
			),
		)
		.limit(1)
	if (!row) return null
	// A posting outside the member's locations looks like it does not exist.
	if (!canAccessPostingLocations(scope.scopeIds, locationIdsOf(row))) {
		return null
	}
	return row
}

export async function getJobPosting(
	scope: Pick<PostingActorScope, 'organizationId' | 'scopeIds'>,
	id: string,
	now: Date = new Date(),
): Promise<PostingDetail | null> {
	const row = await findRow(scope, id)
	if (!row) return null
	return toDetail(row, await locationNames(scope.organizationId), now)
}

/** Which of these ids are locations the organization owns and still uses. */
async function activeLocationIds(organizationId: string, ids: string[]) {
	if (ids.length === 0) return new Set<string>()
	const rows = await db
		.select({ id: OrganizationLocation.id })
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organizationId),
				eq(OrganizationLocation.isActive, true),
				inArray(OrganizationLocation.id, ids),
			),
		)
	return new Set(rows.map((row) => row.id))
}

type PreparedContent = {
	title: string
	positionName: string
	locationIds: string[]
	/** Mirror of `locationIds` when exactly one is chosen. */
	locationId: string | null
	employmentType: JobEmploymentType
	payType: JobPayType
	payMinMinor: number | null
	payMaxMinor: number | null
	currency: string
	descriptionHtml: string
	questions: ScreenerQuestion[]
	translations: JobPostingTranslations
	expiresAt: Date | null
}

/**
 * The same cleaning the default copy gets, for every other language: markup
 * stripped from titles and prompts, descriptions sanitized, prompts kept only
 * for questions that exist, and anything left empty dropped.
 */
function cleanTranslations(
	content: JobPostingContent,
): JobPostingTranslations | 'too_long' {
	const questionIds = new Set(content.questions.map((question) => question.id))
	const cleaned: JobPostingTranslations = {}
	for (const [locale, entry] of Object.entries(content.translations)) {
		const title = entry.title ? stripMarkup(entry.title) : ''
		const descriptionHtml = entry.descriptionHtml
			? sanitizeJobDescription(entry.descriptionHtml)
			: ''
		if (descriptionHtml.length > JOB_POSTING_LIMITS.descriptionHtml) {
			return 'too_long'
		}
		const prompts: Record<string, string> = {}
		for (const [id, text] of Object.entries(entry.prompts ?? {})) {
			const value = stripMarkup(text)
			if (value && questionIds.has(id)) prompts[id] = value
		}
		const translation = {
			...(title ? { title } : {}),
			...(descriptionHtml ? { descriptionHtml } : {}),
			...(Object.keys(prompts).length > 0 ? { prompts } : {}),
		}
		if (Object.keys(translation).length > 0) cleaned[locale] = translation
	}
	return cleaned
}

/** Validates, cleans and checks scope for a content payload from the editor. */
async function prepareContent(
	scope: PostingActorScope,
	input: unknown,
	options: { isGeneral: boolean },
): Promise<PostingResult<PreparedContent>> {
	const parsed = jobPostingContentSchema.safeParse(input)
	if (!parsed.success) {
		return {
			ok: false,
			error: 'invalid_input',
			fields: [
				...new Set(
					parsed.error.issues.map((issue) => String(issue.path[0] ?? '')),
				),
			].filter(Boolean),
		}
	}
	const content: JobPostingContent = normalizePay(parsed.data)

	// The legacy single `locationId` folds into the list.
	const locationIds = [
		...new Set([
			...content.locationIds,
			...(content.locationId ? [content.locationId] : []),
		]),
	]
	if (!canAccessPostingLocations(scope.scopeIds, locationIds)) {
		return { ok: false, error: 'location_not_allowed' }
	}
	if (locationIds.length > 0) {
		const owned = await activeLocationIds(scope.organizationId, locationIds)
		// An id from another organization is refused, not stored.
		if (locationIds.some((id) => !owned.has(id))) {
			return { ok: false, error: 'location_not_allowed' }
		}
	}

	const descriptionHtml = sanitizeJobDescription(content.descriptionHtml)
	if (descriptionHtml.length > JOB_POSTING_LIMITS.descriptionHtml) {
		return { ok: false, error: 'description_too_long' }
	}

	const translations = cleanTranslations(content)
	if (translations === 'too_long') {
		return { ok: false, error: 'description_too_long' }
	}

	return {
		ok: true,
		value: {
			title: stripMarkup(content.title),
			positionName: stripMarkup(content.positionName),
			locationIds,
			locationId: locationIds.length === 1 ? locationIds[0]! : null,
			employmentType: content.employmentType,
			payType: content.payType,
			payMinMinor: content.payMinMinor,
			payMaxMinor: content.payMaxMinor,
			currency: content.currency,
			descriptionHtml,
			questions: content.questions.map((question) => ({
				...question,
				prompt: stripMarkup(question.prompt),
			})),
			translations,
			// The standing application never ends on its own.
			expiresAt: options.isGeneral ? null : closesOnToDate(content.closesOn),
		},
	}
}

async function takenSlugs(organizationId: string, exceptId?: string) {
	const rows = await db
		.select({ id: JobPosting.id, slug: JobPosting.slug })
		.from(JobPosting)
		.where(eq(JobPosting.organizationId, organizationId))
	return new Set(
		rows.filter((row) => row.id !== exceptId).map((row) => row.slug),
	)
}

function isUniqueViolation(error: unknown) {
	const text = `${(error as Error)?.message ?? ''} ${(error as { cause?: Error })?.cause?.message ?? ''}`
	return /UNIQUE constraint|SQLITE_CONSTRAINT/i.test(text)
}

export async function createJobPosting(
	scope: PostingActorScope,
	input: unknown,
	options: { general?: boolean } = {},
): Promise<PostingResult<PostingDetail>> {
	const isGeneral = options.general === true
	const prepared = await prepareContent(scope, input, { isGeneral })
	if (!prepared.ok) return prepared

	if (isGeneral) {
		const [existing] = await db
			.select({ id: JobPosting.id })
			.from(JobPosting)
			.where(
				and(
					eq(JobPosting.organizationId, scope.organizationId),
					eq(JobPosting.isGeneral, true),
				),
			)
			.limit(1)
		if (existing) return { ok: false, error: 'invalid_transition' }
	}

	let slugBase = isGeneral ? GENERAL_APPLICATION_SLUG : prepared.value.title
	let row: PostingRow | undefined
	for (let attempt = 0; attempt < 3 && !row; attempt += 1) {
		const slug = uniqueJobPostingSlug(
			slugBase,
			await takenSlugs(scope.organizationId),
		)
		try {
			;[row] = await db
				.insert(JobPosting)
				.values({
					organizationId: scope.organizationId,
					createdByUserId: scope.userId,
					slug,
					isGeneral,
					status: 'draft',
					...prepared.value,
				})
				.returning()
		} catch (error) {
			if (!isUniqueViolation(error)) throw error
			// A concurrent create took the slug: try the next free one.
			slugBase = `${slugBase}-${attempt + 2}`
		}
	}
	if (!row) return { ok: false, error: 'invalid_input', fields: ['title'] }

	await safeAudit(
		AuditAction.JOB_POSTING_CREATED,
		scope,
		row,
		'Job posting created',
		{ general: isGeneral },
	)
	const detail = await getJobPosting(scope, row.id)
	return detail
		? { ok: true, value: detail }
		: { ok: false, error: 'not_found' }
}

/** Fields shaping the General application, the evergreen starting point. */
export function generalApplicationInput(
	currency: string,
): Record<string, unknown> {
	return {
		title: GENERAL_APPLICATION_DEFAULTS.title,
		positionName: GENERAL_APPLICATION_DEFAULTS.positionName,
		employmentType: GENERAL_APPLICATION_DEFAULTS.employmentType,
		descriptionHtml: GENERAL_APPLICATION_DEFAULTS.descriptionHtml,
		questions: GENERAL_APPLICATION_DEFAULTS.questions,
		currency,
	}
}

export async function updateJobPosting(
	scope: PostingActorScope,
	id: string,
	input: unknown,
): Promise<PostingResult<PostingDetail>> {
	const row = await findRow(scope, id)
	if (!row) return { ok: false, error: 'not_found' }

	const prepared = await prepareContent(scope, input, {
		isGeneral: row.isGeneral,
	})
	if (!prepared.ok) return prepared

	// Editing a live posting must leave it publishable.
	if (row.status === 'published') {
		const reasons = getJobPostingPublishErrors(prepared.value)
		if (reasons.length > 0)
			return { ok: false, error: 'cannot_publish', reasons }
	}

	// A posting that was never live may still change its address; once it has
	// been shared, the link stays put.
	const slug =
		row.publishedAt || row.isGeneral
			? row.slug
			: uniqueJobPostingSlug(
					prepared.value.title,
					await takenSlugs(scope.organizationId, row.id),
				)

	const [updated] = await db
		.update(JobPosting)
		.set({ ...prepared.value, slug })
		.where(
			and(
				eq(JobPosting.id, row.id),
				eq(JobPosting.organizationId, scope.organizationId),
			),
		)
		.returning()
	if (!updated) return { ok: false, error: 'not_found' }

	await safeAudit(
		AuditAction.JOB_POSTING_UPDATED,
		scope,
		updated,
		'Job posting updated',
		{ status: updated.status },
	)
	const detail = await getJobPosting(scope, updated.id)
	return detail
		? { ok: true, value: detail }
		: { ok: false, error: 'not_found' }
}

/**
 * Moves a posting through its lifecycle. `closesOn` replaces the closing date
 * when reopening a posting whose old date has passed.
 */
export async function changeJobPostingStatus(
	scope: PostingActorScope,
	id: string,
	to: 'published' | 'closed',
	options: { closesOn?: string | null; now?: Date } = {},
): Promise<PostingResult<PostingDetail>> {
	const now = options.now ?? new Date()
	const row = await findRow(scope, id)
	if (!row) return { ok: false, error: 'not_found' }

	const from = effectiveJobPostingStatus(row, now)
	if (!canTransitionJobPosting(from, to)) {
		return { ok: false, error: 'invalid_transition' }
	}

	let expiresAt = row.expiresAt
	if (to === 'published' && options.closesOn !== undefined) {
		expiresAt = row.isGeneral ? null : closesOnToDate(options.closesOn)
	}

	if (to === 'published') {
		const reasons = getJobPostingPublishErrors(
			{
				title: row.title,
				descriptionHtml: row.descriptionHtml,
				payType: row.payType as JobPayType,
				payMinMinor: row.payMinMinor,
				payMaxMinor: row.payMaxMinor,
				expiresAt,
			},
			now,
		)
		if (reasons.length > 0)
			return { ok: false, error: 'cannot_publish', reasons }
	}

	const [updated] = await db
		.update(JobPosting)
		.set(
			to === 'published'
				? { status: 'published', publishedAt: now, closedAt: null, expiresAt }
				: { status: 'closed', closedAt: now },
		)
		.where(
			and(
				eq(JobPosting.id, row.id),
				eq(JobPosting.organizationId, scope.organizationId),
			),
		)
		.returning()
	if (!updated) return { ok: false, error: 'not_found' }

	await safeAudit(
		to === 'published'
			? AuditAction.JOB_POSTING_PUBLISHED
			: AuditAction.JOB_POSTING_CLOSED,
		scope,
		updated,
		to === 'published' ? 'Job posting published' : 'Job posting closed',
		{ from },
	)
	const detail = await getJobPosting(scope, updated.id, now)
	return detail
		? { ok: true, value: detail }
		: { ok: false, error: 'not_found' }
}

/** A live posting must be closed first: its link may already be shared. */
export async function deleteJobPosting(
	scope: PostingActorScope,
	id: string,
	now: Date = new Date(),
): Promise<PostingResult<{ id: string }>> {
	const row = await findRow(scope, id)
	if (!row) return { ok: false, error: 'not_found' }
	if (effectiveJobPostingStatus(row, now) === 'published') {
		return { ok: false, error: 'not_deletable' }
	}
	await db
		.delete(JobPosting)
		.where(
			and(
				eq(JobPosting.id, row.id),
				eq(JobPosting.organizationId, scope.organizationId),
			),
		)
	await safeAudit(
		AuditAction.JOB_POSTING_DELETED,
		scope,
		row,
		'Job posting deleted',
		{ status: row.status },
	)
	return { ok: true, value: { id: row.id } }
}

/**
 * Flips every published posting whose closing date has passed to `expired`.
 * Runs daily on the existing `0 3` trigger. Idempotent, and it returns a count
 * only: a retry or an overlapping run changes nothing.
 */
export async function expireJobPostings(now: Date = new Date()) {
	const expired = await db
		.update(JobPosting)
		.set({ status: 'expired', closedAt: now })
		.where(
			and(eq(JobPosting.status, 'published'), lte(JobPosting.expiresAt, now)),
		)
		.returning({ id: JobPosting.id })
	return { expired: expired.length }
}

// ---------------------------------------------------------------------------
// Public projection
// ---------------------------------------------------------------------------

function parseLocation(
	name: string,
	address: string | null,
): Omit<PublicJobLocation, 'id'> {
	let parsed: Record<string, unknown> = {}
	if (address) {
		try {
			const value = JSON.parse(address) as unknown
			if (value && typeof value === 'object') {
				parsed = value as Record<string, unknown>
			}
		} catch {
			// An address stored as plain text carries no structured parts.
		}
	}
	const text = (key: string) => {
		const value = parsed[key]
		return typeof value === 'string' && value.trim() ? value.trim() : null
	}
	const street = [text('streetNumber'), text('streetName')]
		.filter(Boolean)
		.join(' ')
	return {
		name,
		city: text('city'),
		region: text('state'),
		postalCode: text('postalCode'),
		country: text('country'),
		streetAddress: street || null,
	}
}

type PublicRow = {
	posting: PostingRow
	/**
	 * Where the job is, active locations only. For a posting open to every
	 * location this is all of them, so an applicant can pick one.
	 */
	locations: { id: string; name: string; address: string | null }[]
	allLocations: boolean
}

/** The language a visitor reads, and the organization's default fallback. */
export type PublicLocale = { locale?: string | null; defaultLocale?: string }

function toPublic(
	entry: PublicRow,
	language: PublicLocale = {},
): PublicJobPosting {
	const { posting, locations, allLocations } = entry
	const localized = localizeJobPosting(
		{
			title: posting.title,
			descriptionHtml: posting.descriptionHtml,
			questions: parseScreenerQuestions(posting.questions),
		},
		parseJobPostingTranslations(posting.translations),
		language.locale,
		language.defaultLocale ?? 'en',
	)
	return {
		slug: posting.slug,
		title: localized.title,
		positionName: posting.positionName,
		employmentType: posting.employmentType as JobEmploymentType,
		payType: posting.payType as JobPayType,
		payMinMinor: posting.payMinMinor,
		payMaxMinor: posting.payMaxMinor,
		currency: posting.currency,
		// Sanitized on write and again by every renderer; never trusted raw.
		descriptionHtml: sanitizeJobDescription(localized.descriptionHtml),
		questions: localized.questions.map(toPublicQuestion),
		locations: locations.map((place) => ({
			id: place.id,
			...parseLocation(
				displayLocationName(
					place.name,
					language.locale,
					language.defaultLocale ?? 'en',
				),
				place.address,
			),
		})),
		allLocations,
		isGeneral: posting.isGeneral,
		datePosted: (posting.publishedAt ?? posting.createdAt).toISOString(),
		validThrough: posting.expiresAt?.toISOString() ?? null,
	}
}

async function publicRows(
	organizationId: string,
	now: Date,
	slug?: string,
): Promise<PublicRow[]> {
	const [postings, active] = await Promise.all([
		db
			.select()
			.from(JobPosting)
			.where(
				and(
					eq(JobPosting.organizationId, organizationId),
					eq(JobPosting.status, 'published'),
					...(slug ? [eq(JobPosting.slug, slug)] : []),
				),
			)
			.orderBy(desc(JobPosting.isGeneral), desc(JobPosting.publishedAt))
			.limit(slug ? 1 : 100),
		db
			.select({
				id: OrganizationLocation.id,
				name: OrganizationLocation.name,
				address: OrganizationLocation.address,
			})
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.organizationId, organizationId),
					eq(OrganizationLocation.isActive, true),
				),
			)
			.orderBy(asc(OrganizationLocation.name)),
	])
	const rows: PublicRow[] = []
	for (const posting of postings) {
		// The job may not have run yet: an ended posting is never served.
		if (posting.expiresAt && posting.expiresAt.getTime() <= now.getTime()) {
			continue
		}
		const named = locationIdsOf(posting)
		const allLocations = named.length === 0
		const locations = allLocations
			? active
			: active.filter((place) => named.includes(place.id))
		// A posting whose every named location has been turned off is hidden.
		if (!allLocations && locations.length === 0) continue
		rows.push({ posting, locations, allLocations })
	}
	return rows
}

/** Published, unexpired postings for the careers listing (no description). */
export async function listPublicJobPostings(
	organizationId: string,
	now: Date = new Date(),
	language: PublicLocale = {},
): Promise<PublicJobPostingListItem[]> {
	const rows = await publicRows(organizationId, now)
	return rows.map((entry) => {
		const {
			descriptionHtml: ignoredDescription,
			questions: ignoredQuestions,
			...item
		} = toPublic(entry, language)
		return item
	})
}

export async function getPublicJobPosting(
	organizationId: string,
	slug: string,
	now: Date = new Date(),
	language: PublicLocale = {},
): Promise<PublicJobPosting | null> {
	if (!slug || slug.length > JOB_POSTING_LIMITS.slug) return null
	const [entry] = await publicRows(organizationId, now, slug)
	return entry ? toPublic(entry, language) : null
}

/**
 * What tenant-api needs to accept an application for a live posting: its opaque
 * id, the title to snapshot, the location (an applicant is visible only to
 * managers who can see that location), and the full questions including which
 * answer is a dealbreaker. Server to server only: the public page never gets
 * the dealbreaker settings. A posting that is not live is `null`.
 */
export async function getIntakePosting(
	organizationId: string,
	slug: string,
	now: Date = new Date(),
) {
	if (!slug || slug.length > JOB_POSTING_LIMITS.slug) return null
	const [entry] = await publicRows(organizationId, now, slug)
	if (!entry) return null
	const { posting } = entry
	return {
		id: posting.id,
		slug: posting.slug,
		title: posting.title,
		positionName: posting.positionName,
		// Where an applicant may say they are applying (a location is a scope for
		// a restaurant): the named locations, or every active one for a posting
		// open everywhere. A business without locations has one implicit scope.
		scopeIds: entry.locations.length
			? entry.locations.map((place) => place.id)
			: [DEFAULT_SCOPE_ID],
		questions: parseScreenerQuestions(posting.questions),
	}
}

/** Locations for the editor's picker, limited to what the member may use. */
export async function listPostingLocations(
	organizationId: string,
	locationIds: string[] | null,
) {
	const defaultLocale = await orgDefaultLocale(organizationId)
	const rows = await db
		.select({
			id: OrganizationLocation.id,
			name: OrganizationLocation.name,
			address: OrganizationLocation.address,
		})
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organizationId),
				eq(OrganizationLocation.isActive, true),
				...(locationIds ? [inArray(OrganizationLocation.id, locationIds)] : []),
			),
		)
		.orderBy(asc(OrganizationLocation.name))
	return rows.map((row) => ({
		id: row.id,
		name: displayLocationName(row.name, defaultLocale, defaultLocale),
		currency: getLocationCurrency(row.address),
	}))
}
