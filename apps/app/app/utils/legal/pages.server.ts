import { AuditAction } from '@repo/audit'
import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	buildLegalDocument,
	diffLines,
	EMPTY_LEGAL_FEATURES,
	LEGAL_KINDS,
	LEGAL_TEMPLATE_VERSION,
	legalDocumentText,
	legalRegionFor,
	type DiffLine,
	type LegalContext,
	type LegalDocument,
	type LegalKind,
	type PaymentProvider,
	type TrackingTag,
} from '@repo/common/legal'
import {
	parseLocalizedString,
	parseSiteLocalesConfig,
	serializeLocalizedString,
	type LocalizedString,
} from '@repo/common/site-locales'
import {
	and,
	db,
	desc,
	eq,
	like,
	Organization,
	OrganizationLocation,
	User,
	UserOrganization,
	WebsitePage,
	WebsitePageSection,
} from '@repo/database'
import { isLoyaltyFeatureEnabled } from '#app/utils/loyalty/access.server.ts'
import { getReservationsFeatureState } from '#app/utils/reservations/access.server.ts'
import { isStaffingFeatureEnabled } from '#app/utils/staffing/access.server.ts'
import { logWebsiteActivity } from '#app/utils/website/activity.server.ts'
import { getDefaultConfig } from '#app/utils/website/block-types.ts'
import {
	loadDraftSections,
	replaceDraftSectionsStatements,
} from '#app/utils/website/versions.server.ts'
import { hashSections } from '#app/utils/website/versions.ts'
import { parseLegalContact, type LegalContact } from './contact.server.ts'

/**
 * Generated legal pages (#89) and the accessibility statement (#260): ONE
 * generator. A legal page is an ordinary website page (so it is edited, saved,
 * versioned and published like any other) with `legalKind` set. Its text is a
 * stack of Content blocks, one per section, holding every site language in the
 * block's own locale map.
 *
 * Regenerate never overwrites what the operator edited without showing the
 * difference and being confirmed: the hash of the sections as generated is
 * stored, and a page whose sections hash differently was edited.
 */

export const LEGAL_SLUGS: Record<LegalKind, string> = {
	privacy: 'privacy',
	terms: 'terms',
	cookies: 'cookies',
	accessibility: 'accessibility',
}

/** Marketing and accessibility are asked for by their own screens. */
export const LEGAL_PAGE_KINDS: readonly LegalKind[] = LEGAL_KINDS

function deliveryOn(raw: unknown): boolean {
	let value: unknown = raw
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw)
		} catch {
			return false
		}
	}
	if (!value || typeof value !== 'object') return false
	const delivery = (value as Record<string, unknown>).delivery
	if (delivery === true) return true
	return Boolean(
		delivery &&
		typeof delivery === 'object' &&
		(delivery as Record<string, unknown>).enabled === true,
	)
}

/** Everything a generated text is filled with, read from the organization. */
export async function buildLegalContextFor(
	organizationId: string,
	today = new Date(),
) {
	const [org] = await db
		.select({
			name: Organization.name,
			dataRegion: Organization.dataRegion,
			siteLocales: Organization.siteLocales,
			siteDefaultLocale: Organization.siteDefaultLocale,
			legalContact: Organization.legalContact,
			facebookPixelId: Organization.facebookPixelId,
			googleTagManagerId: Organization.googleTagManagerId,
			googleAnalyticsId: Organization.googleAnalyticsId,
			tiktokPixelId: Organization.tiktokPixelId,
			stripeConnectChargesEnabled: Organization.stripeConnectChargesEnabled,
			checkoutChargesEnabled: Organization.checkoutChargesEnabled,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	if (!org) throw new Error('Organization not found')
	const contact = parseLegalContact(org.legalContact)

	const locations = await db
		.select({
			phone: OrganizationLocation.phone,
			address: OrganizationLocation.address,
			fulfillmentOptions: OrganizationLocation.fulfillmentOptions,
		})
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organizationId),
				eq(OrganizationLocation.isActive, true),
			),
		)
	const firstLocation = locations[0]
	const fallbackAddress = (() => {
		const raw = firstLocation?.address
		if (!raw) return ''
		if (typeof raw === 'string') {
			try {
				const parsed = JSON.parse(raw) as Record<string, unknown>
				return [
					parsed.line1 ?? parsed.street ?? parsed.address1,
					parsed.city,
					parsed.postalCode ?? parsed.zip,
					parsed.country,
				]
					.filter((part) => typeof part === 'string' && part.trim())
					.join(', ')
			} catch {
				return raw
			}
		}
		return ''
	})()

	const [reservations, loyalty, careers, giftCards, sectionRows] =
		await Promise.all([
			getReservationsFeatureState(organizationId),
			isLoyaltyFeatureEnabled(organizationId),
			isStaffingFeatureEnabled(organizationId, 'hiring'),
			getFeatureFlag('gift_cards.enabled', { organizationId }),
			db
				.select({
					type: WebsitePageSection.type,
					config: WebsitePageSection.config,
				})
				.from(WebsitePageSection)
				.innerJoin(WebsitePage, eq(WebsitePage.id, WebsitePageSection.pageId))
				.where(
					and(
						eq(WebsitePage.organizationId, organizationId),
						like(WebsitePageSection.config, '%.pdf%'),
					),
				)
				.limit(1),
		])
	const embedRows = await db
		.select({ id: WebsitePageSection.id })
		.from(WebsitePageSection)
		.innerJoin(WebsitePage, eq(WebsitePage.id, WebsitePageSection.pageId))
		.where(
			and(
				eq(WebsitePage.organizationId, organizationId),
				eq(WebsitePageSection.type, 'embed'),
			),
		)
		.limit(1)

	const trackingTags: TrackingTag[] = []
	if (org.googleAnalyticsId?.trim()) trackingTags.push('google_analytics')
	if (org.googleTagManagerId?.trim()) trackingTags.push('google_tag_manager')
	if (org.facebookPixelId?.trim()) trackingTags.push('meta_pixel')
	if (org.tiktokPixelId?.trim()) trackingTags.push('tiktok_pixel')
	const paymentProviders: PaymentProvider[] = []
	if (org.stripeConnectChargesEnabled) paymentProviders.push('stripe')
	if (org.checkoutChargesEnabled) paymentProviders.push('checkout')

	const localesConfig = parseSiteLocalesConfig(
		org.siteLocales,
		org.siteDefaultLocale,
	)
	const address = contact.address || fallbackAddress
	const region = legalRegionFor({
		country: contact.country,
		dataRegion: org.dataRegion,
		defaultLocale: localesConfig.defaultLocale,
		address,
	})
	const context: LegalContext = {
		name: org.name,
		legalName: contact.legalName || org.name,
		email: contact.email,
		phone: contact.phone || firstLocation?.phone || '',
		address,
		region,
		date: today.toISOString().slice(0, 10),
		features: {
			...EMPTY_LEGAL_FEATURES,
			ordering: true,
			delivery: locations.some((location) =>
				deliveryOn(location.fulfillmentOptions),
			),
			reservations: reservations.enabled && reservations.online,
			reservationDeposits:
				reservations.enabled && reservations.online && reservations.payments,
			loyalty,
			giftCards: giftCards === true,
			careers,
			accounts: true,
			marketing: true,
		},
		trackingTags,
		paymentProviders,
		refundText: contact.refundText,
		reservationText: contact.reservationText,
		hasEmbeds: embedRows.length > 0,
		hasPdfMenu: sectionRows.length > 0,
	}
	return { context, contact, localesConfig, region }
}

/** The ordered blocks of a document: one Content block per section. */
export function documentsToSections(
	documents: LegalDocument[],
): Array<{ type: 'content'; config: string }> {
	const [first] = documents
	if (!first) return []
	return first.sections.map((section, index) => {
		const title: LocalizedString = {}
		const body: LocalizedString = {}
		for (const document of documents) {
			const localized = document.sections[index]
			if (!localized) continue
			title[document.locale] = localized.heading
			body[document.locale] = localized.paragraphs.join('\n\n')
		}
		return {
			type: 'content' as const,
			config: JSON.stringify({
				...getDefaultConfig('content'),
				title: serializeLocalizedString(title),
				body: serializeLocalizedString(body),
				layout: 'text',
				background: 'none',
			}),
		}
	})
}

export type GenerateOutcome =
	| { ok: true; documents: LegalDocument[]; titleMap: LocalizedString }
	| { ok: false; missing: Array<'email' | 'phone'> }

/** The document of one kind in every site language. */
export function generateDocuments(
	kind: LegalKind,
	locales: readonly string[],
	context: LegalContext,
): GenerateOutcome {
	const documents: LegalDocument[] = []
	const titleMap: LocalizedString = {}
	for (const locale of locales) {
		const result = buildLegalDocument(kind, locale, context)
		if (!result.ok) return result
		documents.push(result.document)
		titleMap[locale] = result.document.title
	}
	return { ok: true, documents, titleMap }
}

async function freeSlug(
	organizationId: string,
	wanted: string,
	ownPageId?: string,
) {
	const rows = await db
		.select({ id: WebsitePage.id, slug: WebsitePage.slug })
		.from(WebsitePage)
		.where(eq(WebsitePage.organizationId, organizationId))
	const taken = new Set(
		rows.filter((row) => row.id !== ownPageId).map((row) => row.slug),
	)
	if (!taken.has(wanted)) return wanted
	for (const candidate of [`${wanted}-policy`, `legal-${wanted}`]) {
		if (!taken.has(candidate)) return candidate
	}
	let n = 2
	while (taken.has(`${wanted}-${n}`)) n++
	return `${wanted}-${n}`
}

export type LegalPageSummary = {
	kind: LegalKind
	pageId: string | null
	slug: string | null
	status: 'missing' | 'draft' | 'published'
	/** The operator changed the generated text. */
	edited: boolean
	/** Generated from an older template than the one now in force. */
	outdated: boolean
}

/** Which legal pages exist and whether they were edited (for the screen). */
export async function listLegalPages(
	organizationId: string,
): Promise<LegalPageSummary[]> {
	const pages = await db
		.select({
			id: WebsitePage.id,
			slug: WebsitePage.slug,
			status: WebsitePage.status,
			legalKind: WebsitePage.legalKind,
			legalTemplateVersion: WebsitePage.legalTemplateVersion,
			legalGeneratedHash: WebsitePage.legalGeneratedHash,
		})
		.from(WebsitePage)
		.where(eq(WebsitePage.organizationId, organizationId))
	const out: LegalPageSummary[] = []
	for (const kind of LEGAL_PAGE_KINDS) {
		const page = pages.find((candidate) => candidate.legalKind === kind)
		if (!page) {
			out.push({
				kind,
				pageId: null,
				slug: null,
				status: 'missing',
				edited: false,
				outdated: false,
			})
			continue
		}
		const sections = await loadDraftSections(page.id)
		out.push({
			kind,
			pageId: page.id,
			slug: page.slug,
			status: page.status === 'published' ? 'published' : 'draft',
			edited:
				page.legalGeneratedHash !== null &&
				(await hashSections(sections)) !== page.legalGeneratedHash,
			outdated: (page.legalTemplateVersion ?? 0) < LEGAL_TEMPLATE_VERSION,
		})
	}
	return out
}

/**
 * Generates the pages of the given kinds that do not exist yet, as drafts the
 * operator can edit and publish. A kind that already has a page is left alone
 * (that is Regenerate's business). Needs an email (and for the accessibility
 * statement a phone number): `missing` says what is lacking.
 */
export async function generateLegalPages(input: {
	organizationId: string
	userId: string
	kinds: readonly LegalKind[]
	request?: Request
	today?: Date
}): Promise<
	| { ok: true; created: LegalKind[]; skipped: LegalKind[] }
	| { ok: false; missing: Array<'email' | 'phone'> }
> {
	const { context, localesConfig } = await buildLegalContextFor(
		input.organizationId,
		input.today,
	)
	const existing = await listLegalPages(input.organizationId)
	const created: LegalKind[] = []
	const skipped: LegalKind[] = []
	for (const kind of input.kinds) {
		if (existing.find((page) => page.kind === kind)?.pageId) {
			skipped.push(kind)
			continue
		}
		const generated = generateDocuments(kind, localesConfig.locales, context)
		if (!generated.ok) return generated
		const sections = documentsToSections(generated.documents)
		const slug = await freeSlug(input.organizationId, LEGAL_SLUGS[kind])
		const [lastPage] = await db
			.select({ position: WebsitePage.position })
			.from(WebsitePage)
			.where(eq(WebsitePage.organizationId, input.organizationId))
			.orderBy(desc(WebsitePage.position))
			.limit(1)
		const [page] = await db
			.insert(WebsitePage)
			.values({
				organizationId: input.organizationId,
				createdById: input.userId,
				title: serializeLocalizedString(generated.titleMap),
				slug,
				status: 'draft',
				template: 'blank',
				legalKind: kind,
				legalTemplateVersion: LEGAL_TEMPLATE_VERSION,
				position: (lastPage?.position ?? 0) + 1,
				legalGeneratedHash: await hashSections(
					sections.map((section) => ({
						type: section.type,
						config: section.config,
					})),
				),
			})
			.returning({ id: WebsitePage.id })
		if (!page) throw new Error('Failed to create the legal page')
		await db.batch(
			replaceDraftSectionsStatements(
				page.id,
				sections.map((section, index) => ({
					type: section.type,
					config: section.config,
					position: index,
				})),
			) as unknown as Parameters<typeof db.batch>[0],
		)
		created.push(kind)
	}
	if (created.length > 0) {
		await logWebsiteActivity({
			action: AuditAction.WEBSITE_LEGAL_PAGES_GENERATED,
			organizationId: input.organizationId,
			userId: input.userId,
			details: `Generated the ${created.join(', ')} page${created.length === 1 ? '' : 's'}.`,
			metadata: { kinds: created, templateVersion: LEGAL_TEMPLATE_VERSION },
			request: input.request,
		})
	}
	return { ok: true, created, skipped }
}

type LocaleText = Record<string, string>

function textOfSections(
	sections: Array<{ type: string; config: string }>,
	locales: readonly string[],
): LocaleText {
	const out: LocaleText = {}
	for (const locale of locales) {
		out[locale] = sections
			.map((section) => {
				let config: Record<string, unknown> = {}
				try {
					config = JSON.parse(section.config) as Record<string, unknown>
				} catch {
					config = {}
				}
				const pick = (value: unknown) =>
					typeof value === 'string'
						? (parseLocalizedString(value, 'en')[locale] ?? '')
						: ''
				return `${pick(config.title)}\n${pick(config.body)}`
			})
			.join('\n\n')
	}
	return out
}

export type RegeneratePlan =
	| {
			ok: false
			error: 'not_found' | 'missing'
			missing?: Array<'email' | 'phone'>
	  }
	| {
			ok: true
			pageId: string
			edited: boolean
			unchanged: boolean
			/** Per language, what would change (only computed for an edited page). */
			diffs: Record<string, DiffLine[]>
	  }

/** What Regenerate would do, and what it would overwrite. Writes nothing. */
export async function planRegenerate(input: {
	organizationId: string
	kind: LegalKind
	today?: Date
}): Promise<RegeneratePlan> {
	const [page] = await db
		.select({
			id: WebsitePage.id,
			legalGeneratedHash: WebsitePage.legalGeneratedHash,
		})
		.from(WebsitePage)
		.where(
			and(
				eq(WebsitePage.organizationId, input.organizationId),
				eq(WebsitePage.legalKind, input.kind),
			),
		)
		.limit(1)
	if (!page) return { ok: false, error: 'not_found' }
	const { context, localesConfig } = await buildLegalContextFor(
		input.organizationId,
		input.today,
	)
	const generated = generateDocuments(
		input.kind,
		localesConfig.locales,
		context,
	)
	if (!generated.ok)
		return { ok: false, error: 'missing', missing: generated.missing }
	const next = documentsToSections(generated.documents)
	const current = await loadDraftSections(page.id)
	const currentHash = await hashSections(current)
	const edited =
		page.legalGeneratedHash !== null && currentHash !== page.legalGeneratedHash
	const nextHash = await hashSections(
		next.map((section) => ({ type: section.type, config: section.config })),
	)
	const diffs: Record<string, DiffLine[]> = {}
	if (edited) {
		const before = textOfSections(current, localesConfig.locales)
		const after = textOfSections(next, localesConfig.locales)
		for (const locale of localesConfig.locales) {
			diffs[locale] = diffLines(before[locale] ?? '', after[locale] ?? '')
		}
	}
	return {
		ok: true,
		pageId: page.id,
		edited,
		unchanged: nextHash === currentHash,
		diffs,
	}
}

export type RegenerateResult =
	| { ok: true; pageId: string }
	| {
			ok: false
			error: 'not_found' | 'missing' | 'edited_needs_confirm'
			missing?: Array<'email' | 'phone'>
	  }

/**
 * Rewrites the page's text from the current template and details, as a draft
 * (nothing is published). A page the operator edited is only overwritten after
 * `confirm`, which the screen sends once it has shown the difference.
 */
export async function regenerateLegalPage(input: {
	organizationId: string
	userId: string
	kind: LegalKind
	confirm: boolean
	request?: Request
	today?: Date
}): Promise<RegenerateResult> {
	const plan = await planRegenerate(input)
	if (!plan.ok) return plan
	if (plan.edited && !input.confirm) {
		return { ok: false, error: 'edited_needs_confirm' }
	}
	const { context, localesConfig } = await buildLegalContextFor(
		input.organizationId,
		input.today,
	)
	const generated = generateDocuments(
		input.kind,
		localesConfig.locales,
		context,
	)
	if (!generated.ok)
		return { ok: false, error: 'missing', missing: generated.missing }
	const sections = documentsToSections(generated.documents)
	await db.batch([
		...replaceDraftSectionsStatements(
			plan.pageId,
			sections.map((section, index) => ({
				type: section.type,
				config: section.config,
				position: index,
			})),
		),
		db
			.update(WebsitePage)
			.set({
				title: serializeLocalizedString(generated.titleMap),
				legalTemplateVersion: LEGAL_TEMPLATE_VERSION,
				legalGeneratedHash: await hashSections(
					sections.map((section) => ({
						type: section.type,
						config: section.config,
					})),
				),
			})
			.where(eq(WebsitePage.id, plan.pageId)),
	] as unknown as Parameters<typeof db.batch>[0])
	await logWebsiteActivity({
		action: AuditAction.WEBSITE_LEGAL_PAGE_REGENERATED,
		organizationId: input.organizationId,
		userId: input.userId,
		details: `Regenerated the ${input.kind} page${plan.edited ? ' (replacing the edited text)' : ''}.`,
		metadata: {
			kind: input.kind,
			pageId: plan.pageId,
			replacedEdits: plan.edited,
		},
		request: input.request,
	})
	return { ok: true, pageId: plan.pageId }
}

/** The owner's email, to suggest as the contact address before one is saved. */
export async function suggestContactEmail(organizationId: string) {
	const [row] = await db
		.select({ email: User.email })
		.from(UserOrganization)
		.innerJoin(User, eq(User.id, UserOrganization.userId))
		.where(
			and(
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.active, true),
			),
		)
		.limit(1)
	return row?.email ?? ''
}

export type { LegalContact }
export { legalDocumentText }
