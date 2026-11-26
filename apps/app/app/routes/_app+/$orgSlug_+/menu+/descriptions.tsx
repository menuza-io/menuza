import { Trans } from '@lingui/macro'
import { requireUserId } from '@repo/auth'
import { parseLocalizedString } from '@repo/common/site-locales'
import {
	and,
	db,
	eq,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuCategory,
} from '@repo/database'
import { Button } from '@repo/ui/button'
import { useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useFetcher,
	useLoaderData,
} from 'react-router'
import { DescriptionDraftReview } from '#app/components/menu/description-draft-review.tsx'
import {
	requireMenuRead,
	requireMenuWrite,
} from '#app/utils/menu/access.server.ts'
import { draftDishDescriptions } from '#app/utils/menu/description-drafts.server.ts'
import {
	applyDescriptionDrafts,
	descriptionIsEmpty,
	type DescriptionDraft,
	type DescriptionDraftDish,
} from '#app/utils/menu/description-drafts.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		siteDefaultLocale: true,
	})
	await requireMenuRead(request, organization.id)
	const locale = organization.siteDefaultLocale ?? 'en'
	const items = await db
		.select({
			id: OrganizationMenuItem.id,
			displayName: OrganizationMenuItem.displayName,
			description: OrganizationMenuItem.description,
			allergens: OrganizationMenuItem.allergens,
			category: OrganizationMenuCategory.displayName,
		})
		.from(OrganizationMenuItem)
		.leftJoin(
			OrganizationMenuItemCategoryAssignment,
			eq(
				OrganizationMenuItemCategoryAssignment.itemId,
				OrganizationMenuItem.id,
			),
		)
		.leftJoin(
			OrganizationMenuCategory,
			eq(
				OrganizationMenuCategory.id,
				OrganizationMenuItemCategoryAssignment.categoryId,
			),
		)
		.where(eq(OrganizationMenuItem.organizationId, organization.id))
	const dishes: DescriptionDraftDish[] = []
	const seen = new Set<string>()
	for (const item of items) {
		if (seen.has(item.id)) continue
		seen.add(item.id)
		const name = parseLocalizedString(item.displayName, locale)
		dishes.push({
			id: item.id,
			name: name[locale] || item.displayName,
			category: item.category,
			ingredients: [],
			allergens: safeList(item.allergens),
			description: item.description,
		})
	}
	const empty = dishes.filter(
		(dish) =>
			descriptionIsEmpty(dish.description, 'en') ||
			descriptionIsEmpty(dish.description, 'ar'),
	)
	return { organization, dishes: empty.slice(0, 50) }
}

function parseDishes(value: FormDataEntryValue | null): DescriptionDraftDish[] {
	if (typeof value !== 'string') return []
	try {
		const parsed = JSON.parse(value) as unknown
		return Array.isArray(parsed) ? (parsed as DescriptionDraftDish[]) : []
	} catch {
		return []
	}
}

function parseDrafts(value: FormDataEntryValue | null): DescriptionDraft[] {
	if (typeof value !== 'string') return []
	try {
		const parsed = JSON.parse(value) as unknown
		return Array.isArray(parsed) ? (parsed as DescriptionDraft[]) : []
	} catch {
		return []
	}
}

function parseIds(value: FormDataEntryValue | null): string[] {
	if (typeof value !== 'string') return []
	try {
		const parsed = JSON.parse(value) as unknown
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is string => typeof entry === 'string')
			: []
	} catch {
		return []
	}
}

function safeList(value: string | null): string[] {
	try {
		const parsed = JSON.parse(value || '[]') as unknown
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is string => typeof entry === 'string')
			: []
	} catch {
		return []
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		siteDefaultLocale: true,
	})
	await requireMenuWrite(request, organization.id)
	const form = await request.formData()
	const intent = form.get('intent')
	const dishes = parseDishes(form.get('dishes')).slice(0, 50)
	if (intent === 'draft') {
		const drafts = await draftDishDescriptions(dishes)
		return { drafts }
	}
	if (intent === 'apply') {
		const updates = applyDescriptionDrafts({
			dishes,
			drafts: parseDrafts(form.get('drafts')),
			selectedIds: parseIds(form.get('selectedIds')),
		})
		for (const update of updates) {
			const [current] = await db
				.select({ description: OrganizationMenuItem.description })
				.from(OrganizationMenuItem)
				.where(eq(OrganizationMenuItem.id, update.itemId))
				.limit(1)
			if (!current) continue
			const dish = dishes.find((entry) => entry.id === update.itemId)
			if (!dish) continue
			if (
				!descriptionIsEmpty(current.description, 'en') &&
				!descriptionIsEmpty(current.description, 'ar')
			) {
				continue
			}
			await db
				.update(OrganizationMenuItem)
				.set({ description: update.description })
				.where(
					and(
						eq(OrganizationMenuItem.id, update.itemId),
						eq(OrganizationMenuItem.organizationId, organization.id),
					),
				)
		}
		return { applied: updates.length }
	}
	return { ok: false }
}

export default function DescriptionDraftsRoute() {
	const { dishes } = useLoaderData<typeof loader>()
	const fetcher = useFetcher<{ drafts?: DescriptionDraft[] }>()
	const drafts = fetcher.data?.drafts ?? []
	const [selected, setSelected] = useState<string[]>([])
	const [edited, setEdited] = useState<DescriptionDraft[] | null>(null)
	const shown = edited ?? drafts
	return (
		<div className="space-y-4">
			<h2 className="text-lg font-semibold">
				<Trans>Write missing descriptions</Trans>
			</h2>
			<Button
				type="button"
				onClick={() => {
					setEdited(null)
					void fetcher.submit(
						{ intent: 'draft', dishes: JSON.stringify(dishes) },
						{ method: 'post' },
					)
				}}
			>
				<Trans>Write missing descriptions</Trans>
			</Button>
			{shown.length > 0 ? (
				<>
					<DescriptionDraftReview
						drafts={shown}
						selected={new Set(selected)}
						onToggle={(itemId, on) =>
							setSelected((current) =>
								on
									? [...current, itemId]
									: current.filter((id) => id !== itemId),
							)
						}
						onChange={(itemId, locale, value) => {
							setEdited(
								shown.map((draft) =>
									draft.itemId === itemId
										? { ...draft, [locale]: value }
										: draft,
								),
							)
						}}
					/>
					<Button
						type="button"
						onClick={() => {
							void fetcher.submit(
								{
									intent: 'apply',
									dishes: JSON.stringify(dishes),
									drafts: JSON.stringify(shown),
									selectedIds: JSON.stringify(selected),
								},
								{ method: 'post' },
							)
						}}
					>
						<Trans>Apply selected</Trans>
					</Button>
				</>
			) : null}
		</div>
	)
}
