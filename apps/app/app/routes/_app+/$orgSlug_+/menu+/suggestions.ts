import { auditService, AuditAction } from '@repo/audit'
import { requireUserId } from '@repo/auth'
import { AVAILABILITY_STATUSES } from '@repo/common/menu-types'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireMenuWrite } from '#app/utils/menu/access.server.ts'
import { setMenuAutoTranslate } from '#app/utils/menu/menu-auto-translate.server.ts'
import {
	generateMenuSuggestions,
	menuLocales,
} from '#app/utils/menu/menu-suggestions.server.ts'
import {
	MENU_SUGGESTION_LIMITS,
	MENU_SUGGESTION_SEEN_MAX,
	MenuTextChangeSchema,
	sanitizeSuggestionText,
	type MenuTextChange,
} from '#app/utils/menu/menu-suggestions.ts'
import {
	MenuUpdateError,
	setMenuCategoryAvailability,
	setMenuItemAvailability,
	updateMenuItemText,
} from '#app/utils/menu/menu-updates.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

/**
 * `POST /:orgSlug/menu/suggestions`: the Menu health "Review suggestions"
 * stack. One action, JSON body, `intent`:
 *
 *  - `generate`: the next batch (about 10). AI calls happen only here, so
 *    nothing is generated until someone opens the stack.
 *  - `set-text` / `set-text-bulk`: accept a translation or a description, or
 *    undo one (`reason: 'undo'` restores exactly what Accept replaced).
 *  - `set-item-availability` / `set-category-availability`: accept or undo
 *    "Make available", "Hide from menu" and "Hide category".
 *  - `set-auto-translate`: the "Translate new dishes" toggle.
 *
 * Every intent needs `update:menu:any` (menu write rate limit included) and
 * writes through `menu-updates.server.ts` (audit, site cache purge). Skip
 * records nothing.
 */

const IdSchema = z.string().min(1).max(64)
const AvailabilitySchema = z.object({
	availabilityStatus: z.enum(AVAILABILITY_STATUSES),
	unavailableUntil: z.string().max(40).nullable().default(null),
})

const TextEntrySchema = z.object({
	itemId: IdSchema,
	changes: z.array(MenuTextChangeSchema).min(1).max(4),
})

const BodySchema = z.discriminatedUnion('intent', [
	z.object({
		intent: z.literal('generate'),
		seen: z
			.array(z.string().max(120))
			.max(MENU_SUGGESTION_SEEN_MAX)
			.default([]),
	}),
	TextEntrySchema.extend({
		intent: z.literal('set-text'),
		reason: z.enum(['translation', 'description', 'undo']),
	}),
	z.object({
		intent: z.literal('set-text-bulk'),
		reason: z.enum(['translation', 'undo']),
		entries: z.array(TextEntrySchema).min(1).max(50),
	}),
	z.object({
		intent: z.literal('set-item-availability'),
		itemId: IdSchema,
		reason: z.enum(['make_available', 'hide', 'undo']),
		availability: AvailabilitySchema,
		restoreUpdatedAt: z.string().max(40).nullable().optional(),
	}),
	z.object({
		intent: z.literal('set-category-availability'),
		categoryId: IdSchema,
		reason: z.enum(['hide', 'undo']),
		availability: AvailabilitySchema,
	}),
	z.object({
		intent: z.literal('set-auto-translate'),
		enabled: z.boolean(),
	}),
])

export type MenuSuggestionsBody = z.input<typeof BodySchema>

function fail(error: string, status: number) {
	return Response.json({ ok: false as const, error }, { status })
}

/**
 * Accepted text is AI output coming back from the browser: clean it again.
 * Undo puts back what was there before, so it is only length-checked.
 */
function cleanChanges(
	changes: MenuTextChange[],
	reason: 'translation' | 'description' | 'undo',
	allowedLocales: ReadonlySet<string>,
): MenuTextChange[] | null {
	const cleaned: MenuTextChange[] = []
	for (const change of changes) {
		if (!allowedLocales.has(change.locale)) return null
		if (reason === 'undo') {
			cleaned.push(change)
			continue
		}
		const max =
			change.field === 'displayName'
				? MENU_SUGGESTION_LIMITS.name
				: MENU_SUGGESTION_LIMITS.description
		const value = sanitizeSuggestionText(change.value, max)
		if (!value) return null
		cleaned.push({ ...change, value })
	}
	return cleaned
}

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		name: true,
		siteLocales: true,
		siteDefaultLocale: true,
	})
	const userId = await requireMenuWrite(request, organization.id)

	let raw: unknown
	try {
		raw = await request.json()
	} catch {
		return fail('invalid_input', 400)
	}
	const parsed = BodySchema.safeParse(raw)
	if (!parsed.success) return fail('invalid_input', 400)
	const body = parsed.data

	const { defaultLocale, translationLocales } = menuLocales(organization)
	const ref = { id: organization.id, slug: organization.slug }

	try {
		switch (body.intent) {
			case 'generate': {
				const result = await generateMenuSuggestions(organization, body.seen)
				if (!result.ok) return fail(result.error, 429)
				return Response.json({ ok: true as const, batch: result.batch })
			}
			case 'set-text':
			case 'set-text-bulk': {
				const entries =
					body.intent === 'set-text'
						? [{ itemId: body.itemId, changes: body.changes }]
						: body.entries
				// Translations write only the other languages; a new description
				// only the menu's own language. Undo may restore either.
				const allowed = new Set<string>(
					body.reason === 'translation'
						? translationLocales
						: body.reason === 'description'
							? [defaultLocale]
							: [defaultLocale, ...translationLocales],
				)
				const results: Array<{ itemId: string; previous: MenuTextChange[] }> =
					[]
				for (const entry of entries) {
					const changes = cleanChanges(entry.changes, body.reason, allowed)
					if (!changes) return fail('invalid_input', 400)
					const previous = await updateMenuItemText({
						organization: ref,
						userId,
						request,
						itemId: entry.itemId,
						changes,
						defaultLocale,
						reason: `suggestion_${body.reason}`,
					})
					results.push({ itemId: entry.itemId, previous })
				}
				return Response.json({ ok: true as const, results })
			}
			case 'set-item-availability': {
				const target = body.availability
				if (
					body.reason !== 'undo' &&
					target.availabilityStatus !==
						(body.reason === 'hide' ? 'hidden' : 'available')
				) {
					return fail('invalid_input', 400)
				}
				const previous = await setMenuItemAvailability({
					organization: ref,
					userId,
					request,
					itemId: body.itemId,
					availability: target,
					reason: `suggestion_${body.reason}`,
					restoreUpdatedAt:
						body.reason === 'undo' ? body.restoreUpdatedAt : undefined,
				})
				return Response.json({ ok: true as const, previous })
			}
			case 'set-category-availability': {
				if (
					body.reason === 'hide' &&
					body.availability.availabilityStatus !== 'hidden'
				) {
					return fail('invalid_input', 400)
				}
				const previous = await setMenuCategoryAvailability({
					organization: ref,
					userId,
					request,
					categoryId: body.categoryId,
					availability: body.availability,
					reason: `suggestion_${body.reason}`,
				})
				return Response.json({ ok: true as const, previous })
			}
			case 'set-auto-translate': {
				await setMenuAutoTranslate(organization.id, body.enabled)
				await auditService.log({
					action: AuditAction.ORG_SETTINGS_UPDATED,
					userId,
					organizationId: organization.id,
					resourceType: 'organization',
					resourceId: organization.id,
					details: `Translate new dishes automatically turned ${body.enabled ? 'on' : 'off'}.`,
					metadata: { setting: 'menu.auto_translate', to: body.enabled },
					request,
				})
				return Response.json({ ok: true as const, enabled: body.enabled })
			}
		}
	} catch (error) {
		if (error instanceof MenuUpdateError) {
			return fail(error.code, error.code === 'not_found' ? 404 : 400)
		}
		throw error
	}
}
