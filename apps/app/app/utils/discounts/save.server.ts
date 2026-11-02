import { DISCOUNT_NAME_MAX, withCanonicalDiscountCopy } from '@repo/discounts'
import { data, redirect } from 'react-router'
import { z } from 'zod'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { type DiscountsAccess } from './access.server.ts'
import {
	createDiscount,
	duplicateDiscount,
	getDiscount,
	getDiscountApplication,
	setDiscountStatus,
	updateDiscount,
} from './discounts.server.ts'
import {
	loadDiscountLocations,
	loadDiscountSiteLocales,
	loadOrganizationDiscountIds,
} from './editor-data.server.ts'
import {
	type EditorErrors,
	resolveDiscountCurrency,
	stateToDefinition,
} from './editor-model.ts'
import {
	keepOrganizationIds,
	parseEditorStateField,
} from './editor-state-schema.ts'
import {
	changedDiscountKeys,
	recordDiscountCreated,
	recordDiscountStatus,
	recordDiscountUpdated,
} from './history.server.ts'
import { type DiscountLimit } from './limits.ts'
import {
	discountEditableInScope,
	discountLocationsAllowedInScope,
	discountVisibleInScope,
} from './location-scope.server.ts'

const statusSchema = z.enum(['active', 'paused', 'archived'])
const saveStatusSchema = z.enum(['active', 'paused'])
/** Versions start at 1, so an empty or missing field is refused. */
const expectedVersionSchema = z.coerce.number().int().min(1)

/** The word added to a copy's name when the form sends none. */
const DEFAULT_COPY_WORD = 'copy'

/**
 * Create, update, pause, resume or archive. The route awaits
 * `requireDiscountsAccess` before calling this. The editor state is validated
 * with the same function the form uses, then checked against the
 * organization's discount flags.
 */
export async function saveDiscountEditor({
	request,
	params,
	access,
}: {
	request: Request
	params: { orgSlug?: string; discountId?: string }
	access: DiscountsAccess
}) {
	const form = await request.formData()
	const intent = String(form.get('intent') ?? 'save')
	const discountId =
		params.discountId ??
		(intent === 'set-status' || intent === 'duplicate'
			? String(form.get('discountId') ?? '')
			: undefined)

	// Every change to a stored discount checks the member's locations first,
	// whatever the intent: out of sight is not found, and a discount shared
	// with locations outside theirs is read-only (`discountEditableInScope`).
	let stored: Awaited<ReturnType<typeof getDiscountApplication>> = null
	if (discountId !== undefined) {
		if (!discountId) {
			return data({ formError: 'missing' as const }, { status: 400 })
		}
		stored = await getDiscountApplication(access.organization.id, discountId)
		if (
			!stored ||
			!discountVisibleInScope(stored.locationIds, access.locationIds)
		) {
			throw new Response('Not Found', { status: 404 })
		}
		if (!discountEditableInScope(stored.locationIds, access.locationIds)) {
			return data({ scope: true as const }, { status: 403 })
		}
	}

	if (intent === 'duplicate') {
		if (!discountId) {
			return data({ formError: 'missing' as const }, { status: 400 })
		}
		const copyWord =
			String(form.get('copyWord') ?? '')
				.trim()
				.slice(0, 20) || DEFAULT_COPY_WORD
		const { defaultLocale } = await loadDiscountSiteLocales(
			access.organization.id,
		)
		const copy = await duplicateDiscount({
			organizationId: access.organization.id,
			defaultLocale,
			userId: access.userId,
			discountId,
			// The form sends the word in the operator's language.
			// Cut the original name, not the word, so a long name keeps its suffix.
			copyName: (name) =>
				`${name.slice(0, DISCOUNT_NAME_MAX - copyWord.length - 1)} ${copyWord}`,
		})
		if (!copy.ok) return saveFailure(copy, { field: false })
		await recordDiscountCreated({
			organizationId: access.organization.id,
			userId: access.userId,
			discountId: copy.id,
			request,
		})
		await purgeDiscountSiteCache(access)
		return redirect(`/${access.organization.slug}/discounts/${copy.id}?saved=1`)
	}

	if (intent === 'set-status') {
		if (!discountId) {
			return data({ formError: 'missing' as const }, { status: 400 })
		}
		const status = statusSchema.safeParse(form.get('status'))
		const expectedVersion = expectedVersionSchema.safeParse(
			form.get('expectedVersion'),
		)
		if (!status.success || !expectedVersion.success) {
			return data({ formError: 'invalid' as const }, { status: 400 })
		}
		const saved = await setDiscountStatus({
			organizationId: access.organization.id,
			discountId,
			expectedVersion: expectedVersion.data,
			status: status.data,
		})
		if (!saved.ok) {
			if (saved.reason === 'not_found') {
				throw new Response('Not Found', { status: 404 })
			}
			if (saved.reason === 'no_codes') {
				return data({ noCodes: true as const }, { status: 409 })
			}
			if (saved.reason === 'too_many_discounts') {
				return data({ limit: 'discounts' as const }, { status: 409 })
			}
			return data({ stale: true as const }, { status: 409 })
		}
		await recordDiscountStatus({
			organizationId: access.organization.id,
			userId: access.userId,
			discountId,
			status: status.data,
			request,
		})
		await purgeDiscountSiteCache(access)
		if (!params.discountId) return data({ ok: true as const })
		return redirect(`/${access.organization.slug}/discounts/${discountId}`)
	}

	const status = saveStatusSchema.safeParse(form.get('status'))
	const posted = parseEditorStateField(form.get('state'))
	if (!posted || !status.success) {
		return data({ formError: 'invalid' as const }, { status: 400 })
	}
	// Ids from another organization, or deleted since the editor opened, are
	// dropped before anything reads them (`keepOrganizationIds`).
	const state = keepOrganizationIds(
		posted,
		await loadOrganizationDiscountIds(access.organization.id),
	)

	// Amounts are in the currency of the locations the discount applies to
	// (orders price in their location's currency and the engine never converts).
	// A discount with no location to read one from (an organization without
	// locations) keeps the currency it was entered in, or takes the region's.
	const [locations, siteLocales] = await Promise.all([
		loadDiscountLocations(access.organization.id),
		loadDiscountSiteLocales(access.organization.id),
	])
	let built: ReturnType<typeof stateToDefinition>
	try {
		const { currency } = resolveDiscountCurrency(
			state,
			locations,
			stored?.currency ?? access.currency,
		)
		built = stateToDefinition(state, {
			// null: the locations use several currencies, which refuses any amount.
			currency,
			// New discounts start paused so nothing goes live until the operator resumes.
			status: discountId ? status.data : 'paused',
			// The name and description keep the website's languages only.
			locales: siteLocales,
		})
	} catch {
		// A hand-made payload of the wrong shape is a bad request, not a crash.
		return data({ formError: 'invalid' as const }, { status: 400 })
	}
	if (!built.ok) return data({ errors: built.errors }, { status: 400 })
	// One source of truth for the default language (see withCanonicalDiscountCopy).
	built.definition = withCanonicalDiscountCopy(
		built.definition,
		siteLocales.defaultLocale,
	)

	if (
		!discountLocationsAllowedInScope(
			built.definition.locationIds,
			state.allLocations,
			access.locationIds,
		)
	) {
		return data({ errors: { locations: 'location_scope' } }, { status: 403 })
	}

	// A switched-off way of applying blocks choosing it, not editing a discount
	// that already uses it.
	const flagError =
		stored?.application === built.definition.application
			? null
			: applicationFlagError(built.definition.application, access.features)
	if (flagError) {
		return data({ errors: { application: flagError } }, { status: 400 })
	}

	if (discountId) {
		const expectedVersion = expectedVersionSchema.safeParse(
			form.get('expectedVersion'),
		)
		if (!expectedVersion.success) {
			return data({ formError: 'invalid' as const }, { status: 400 })
		}
		const before = await getDiscount(access.organization.id, discountId)
		const saved = await updateDiscount({
			organizationId: access.organization.id,
			discountId,
			expectedVersion: expectedVersion.data,
			definition: built.definition,
			codes: built.codes,
		})
		if (!saved.ok) return saveFailure(saved)
		const codeKey = (
			codes: readonly { code: string; maxUses: number | null }[],
		) =>
			JSON.stringify(
				codes
					.map((code) => [code.code.trim().toUpperCase(), code.maxUses])
					.sort(),
			)
		await recordDiscountUpdated({
			organizationId: access.organization.id,
			userId: access.userId,
			discountId,
			keys: before?.stored
				? changedDiscountKeys(before.stored.definition, built.definition)
				: [],
			codesChanged: before
				? codeKey(before.codes) !== codeKey(built.codes)
				: false,
			request,
		})
		await purgeDiscountSiteCache(access)
		return redirect(
			`/${access.organization.slug}/discounts/${discountId}?saved=1`,
		)
	}

	const saved = await createDiscount({
		organizationId: access.organization.id,
		userId: access.userId,
		definition: built.definition,
		codes: built.codes,
	})
	if (!saved.ok) return saveFailure(saved)
	await recordDiscountCreated({
		organizationId: access.organization.id,
		userId: access.userId,
		discountId: saved.id,
		request,
	})
	await purgeDiscountSiteCache(access)
	return redirect(`/${access.organization.slug}/discounts/${saved.id}?saved=1`)
}

async function purgeDiscountSiteCache(access: DiscountsAccess) {
	await purgeOrganizationSiteCache(
		access.organization.id,
		access.organization.slug,
	)
}

function applicationFlagError(
	application: 'automatic' | 'code' | 'manual',
	features: { automatic: boolean; coupons: boolean },
): EditorErrors[string] | null {
	if (application === 'automatic' && !features.automatic) {
		return 'application_off'
	}
	if (application === 'code' && !features.coupons) return 'application_off'
	return null
}

function saveFailure(
	saved:
		| { ok: false; reason: 'stale' }
		| { ok: false; reason: 'not_found' }
		| { ok: false; reason: 'code_taken'; codeIndexes: number[] }
		| { ok: false; reason: 'no_codes' }
		| { ok: false; reason: 'archived' }
		| { ok: false; reason: 'too_many_discounts' }
		| { ok: false; reason: 'too_many_codes' },
	/** `field`: the save has a codes field to mark; a duplicate does not. */
	options: { field: boolean } = { field: true },
) {
	if (saved.reason === 'not_found') {
		throw new Response('Not Found', { status: 404 })
	}
	if (saved.reason === 'stale') {
		// The form keeps what the operator typed (see the discount route).
		return data(
			{ stale: true as const, keepEdits: true as const },
			{ status: 409 },
		)
	}
	if (saved.reason === 'archived') {
		return data({ archived: true as const }, { status: 409 })
	}
	if (saved.reason === 'no_codes') {
		return data({ noCodes: true as const }, { status: 409 })
	}
	// An organization-wide cap. `limit` names it so the page words it: a save
	// also marks the codes field, but a restore or duplicate has no field to
	// mark and shows the message at page level.
	if (saved.reason === 'too_many_discounts') {
		return data({ limit: 'discounts' as const }, { status: 409 })
	}
	if (saved.reason === 'too_many_codes') {
		return data(
			{
				...(options.field
					? { errors: { codes: 'org_codes_limit' } as EditorErrors }
					: {}),
				limit: 'codes' as const,
			},
			{ status: 409 },
		)
	}
	const errors: EditorErrors = {}
	if (saved.codeIndexes.length === 0) errors.codes = 'code_taken'
	for (const index of saved.codeIndexes) {
		errors[`codes.${index}.code`] = 'code_taken'
	}
	return data({ errors }, { status: 409 })
}

export type DiscountEditorActionData = {
	errors?: EditorErrors
	stale?: true
	/** A stale save: the operator's edits stay in the form. */
	keepEdits?: true
	archived?: true
	noCodes?: true
	/** The organization is at its cap of discounts or of codes (see `MAX_*_PER_ORG`). */
	limit?: DiscountLimit
	formError?: 'invalid' | 'missing'
	/**
	 * The discount also runs at locations outside the member's own, so they
	 * can view it but not change it (`discountEditableInScope`).
	 */
	scope?: true
}
