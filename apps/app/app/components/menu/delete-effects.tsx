import { type MessageDescriptor } from '@lingui/core'
import { Plural, Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { AlertDialogDescription } from '@repo/ui/alert-dialog'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { Skeleton } from '@repo/ui/skeleton'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { z } from 'zod'
import { useOperatorClient } from '#app/hooks/use-operator-client.ts'

/**
 * "What uses this record?" for the menu delete dialogs (`MenuDeleteEffects`)
 * and the Used in card on option and modifier group pages (`MenuUsedInCard`).
 * Both read `/:orgSlug/menu/delete-effects` when they appear and again every
 * minute while they stay on screen. Recipes live in the region: the browser
 * asks the regional tenant-api directly, and gives up after two seconds.
 */

export type MenuEffectsEntityType =
	'menu' | 'category' | 'item' | 'modifier_group' | 'modifier_option'

/** How long a list may stay on screen before it is read again. */
export const DELETE_EFFECTS_REFRESH_MS = 60_000
/** How long the region gets to answer about recipes. */
export const RECIPE_CHECK_TIMEOUT_MS = 2_000

const EFFECT_KINDS = [
	'in_menus',
	'in_categories',
	'in_modifier_groups',
	'contains_categories',
	'contains_items',
	'contains_options',
	'used_by_items',
	'nested_in_options',
	'discounts',
	'drops',
	'print_designs',
	'pos_links',
] as const
type EffectKind = (typeof EFFECT_KINDS)[number]

const rowSchema = z.object({
	id: z.string(),
	name: z.string(),
	count: z.number().optional(),
	note: z.enum(['loses_all_targets', 'blocks_delete']).optional(),
	status: z.string().optional(),
})

const recipeOwnerSchema = z.object({
	ownerKind: z.enum(['menu_item', 'variant', 'option']),
	ownerId: z.string(),
})
type RecipeOwner = z.infer<typeof recipeOwnerSchema>

export const deleteEffectsResponseSchema = z.object({
	entityType: z.string(),
	entityId: z.string(),
	name: z.string(),
	groups: z.array(
		z.object({
			kind: z.enum(EFFECT_KINDS),
			total: z.number(),
			rows: z.array(rowSchema),
		}),
	),
	recipes: z.boolean(),
	recipeOwners: z.array(recipeOwnerSchema),
	checkedAt: z.number(),
})
export type DeleteEffectsResponse = z.infer<typeof deleteEffectsResponseSchema>
type EffectGroup = DeleteEffectsResponse['groups'][number]
type EffectRow = EffectGroup['rows'][number]

export function deleteEffectsUrl(
	orgSlug: string,
	entityType: MenuEffectsEntityType,
	entityId: string,
): string {
	const query = new URLSearchParams({ type: entityType, id: entityId })
	return `/${encodeURIComponent(orgSlug)}/menu/delete-effects?${query.toString()}`
}

type EffectsState = {
	key: string | null
	data: DeleteEffectsResponse | null
	error: boolean
	loading: boolean
}

const IDLE: EffectsState = {
	key: null,
	data: null,
	error: false,
	loading: false,
}

/**
 * Reads the effects of one record, and again every minute while `entityId`
 * stays set. The last answer stays on screen while a refresh runs.
 */
function useDeleteEffects(
	orgSlug: string,
	entityType: MenuEffectsEntityType,
	entityId: string | null,
) {
	const [state, setState] = useState<EffectsState>(IDLE)
	const [tick, setTick] = useState(0)
	const key = entityId ? `${orgSlug}:${entityType}:${entityId}` : null

	useEffect(() => {
		if (!entityId || !key) {
			setState(IDLE)
			return
		}
		const controller = new AbortController()
		setState((current) =>
			current.key === key
				? { ...current, loading: current.data === null }
				: { key, data: null, error: false, loading: true },
		)
		fetch(deleteEffectsUrl(orgSlug, entityType, entityId), {
			headers: { Accept: 'application/json' },
			signal: controller.signal,
		})
			.then(async (response) => {
				if (!response.ok) throw new Error('request_failed')
				return deleteEffectsResponseSchema.parse(await response.json())
			})
			.then(
				(data) => {
					if (controller.signal.aborted) return
					setState({ key, data, error: false, loading: false })
				},
				() => {
					if (controller.signal.aborted) return
					// A failed refresh keeps the list already shown.
					setState((current) =>
						current.key === key && current.data
							? { ...current, loading: false }
							: { key, data: null, error: true, loading: false },
					)
				},
			)
		return () => controller.abort()
	}, [orgSlug, entityType, entityId, key, tick])

	useEffect(() => {
		if (!key) return
		const timer = setInterval(
			() => setTick((value) => value + 1),
			DELETE_EFFECTS_REFRESH_MS,
		)
		return () => clearInterval(timer)
	}, [key])

	const reload = useCallback(() => setTick((value) => value + 1), [])
	// Never show one record's list under another record's dialog.
	const current = state.key === key ? state : { ...IDLE, loading: key !== null }
	return { ...current, reload }
}

const recipeAnswerSchema = z.object({ recipe: z.unknown().nullable() })

type RecipeRequest = (path: string, init?: RequestInit) => Promise<unknown>

/**
 * How many of these owners have a recipe in the region. One small read per
 * owner; rejects when the region has not answered all of them in time.
 */
export async function countRecipes(
	request: RecipeRequest,
	owners: readonly RecipeOwner[],
	timeoutMs: number = RECIPE_CHECK_TIMEOUT_MS,
): Promise<number> {
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((ignoredResolve, reject) => {
		timer = setTimeout(() => {
			controller.abort()
			reject(new Error('recipe_check_timeout'))
		}, timeoutMs)
	})
	const answers = Promise.all(
		owners.map(async (owner) => {
			const query = new URLSearchParams({
				ownerKind: owner.ownerKind,
				ownerId: owner.ownerId,
			})
			const body = await request(`/recipes?${query.toString()}`, {
				signal: controller.signal,
			})
			return recipeAnswerSchema.parse(body).recipe != null
		}),
	)
	// The timeout may win; the reads it left behind must not go unhandled.
	answers.catch(() => {})
	try {
		const found = await Promise.race([answers, timeout])
		return found.filter(Boolean).length
	} finally {
		clearTimeout(timer)
	}
}

type RecipeState =
	| { status: 'off' }
	| { status: 'checking' }
	| { status: 'failed' }
	| { status: 'done'; count: number }

/** Asks the region about recipes each time the effects are read. */
function useRecipeCount(
	orgSlug: string,
	effects: DeleteEffectsResponse | null,
): RecipeState {
	const { request } = useOperatorClient(
		orgSlug,
		'/operator/inventory',
		'inventory-token',
	)
	const [state, setState] = useState<RecipeState>({ status: 'off' })
	const enabled = Boolean(effects?.recipes && effects.recipeOwners.length > 0)
	const owners = effects?.recipeOwners
	const checkedAt = effects?.checkedAt

	useEffect(() => {
		if (!enabled || !owners) {
			setState({ status: 'off' })
			return
		}
		let live = true
		// A refresh keeps the count already shown until the new one is in.
		setState((current) =>
			current.status === 'done' ? current : { status: 'checking' },
		)
		countRecipes(request, owners).then(
			(count) => {
				if (live) setState({ status: 'done', count })
			},
			() => {
				if (live) setState({ status: 'failed' })
			},
		)
		return () => {
			live = false
		}
		// `owners` changes only with `checkedAt` (one response, one check).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [enabled, request, checkedAt])

	return enabled ? state : { status: 'off' }
}

// ── Presentation ────────────────────────────────────────────────────────────

const GROUP_LABELS: Record<EffectKind, MessageDescriptor> = {
	in_menus: msg`On menus`,
	in_categories: msg`In categories`,
	in_modifier_groups: msg`In modifier groups`,
	contains_categories: msg`Categories that will be unassigned`,
	contains_items: msg`Items that will be unassigned`,
	contains_options: msg`Options that will be unassigned`,
	used_by_items: msg`Items using it`,
	nested_in_options: msg`Options that open it`,
	discounts: msg`Discounts`,
	drops: msg`Drops`,
	print_designs: msg`Print designs`,
	pos_links: msg`Connected platforms`,
}

function rowHref(orgSlug: string, kind: EffectKind, row: EffectRow): string {
	const org = `/${encodeURIComponent(orgSlug)}`
	const id = encodeURIComponent(row.id)
	switch (kind) {
		case 'in_menus':
			return `${org}/menu/menus/${id}`
		case 'in_categories':
		case 'contains_categories':
			return `${org}/menu/categories/${id}`
		case 'contains_items':
		case 'used_by_items':
			return `${org}/menu/items/${id}`
		case 'in_modifier_groups':
			return `${org}/menu/modifiers/${id}`
		case 'contains_options':
		case 'nested_in_options':
			return `${org}/menu/options/${id}`
		case 'discounts':
			return `${org}/discounts/${id}`
		case 'drops':
			return `${org}/menu/drops/${id}`
		case 'print_designs':
			return `${org}/marketing/print/${id}`
		case 'pos_links':
			return `${org}/settings/integrations`
	}
}

function RowNote({ row }: { row: EffectRow }) {
	if (row.note === 'loses_all_targets') {
		return (
			<p className="text-destructive text-xs">
				<Trans>This discount will no longer apply to anything</Trans>
			</p>
		)
	}
	if (row.note === 'blocks_delete') {
		return (
			<p className="text-destructive text-xs">
				<Trans>Delete or move this drop before deleting the menu</Trans>
			</p>
		)
	}
	return null
}

function EffectGroupSection({
	orgSlug,
	group,
}: {
	orgSlug: string
	group: EffectGroup
}) {
	const { _ } = useLingui()
	const hidden = group.total - group.rows.length
	return (
		<section className="flex flex-col gap-1">
			<h3 className="text-foreground text-sm font-medium">
				{_(GROUP_LABELS[group.kind])}{' '}
				<span className="text-muted-foreground font-normal tabular-nums">
					{group.total}
				</span>
			</h3>
			<ul className="flex flex-col gap-1">
				{group.rows.map((row) => (
					<li key={row.id} className="text-sm">
						<Link
							to={rowHref(orgSlug, group.kind, row)}
							className="text-foreground wrap-anywhere underline underline-offset-4"
						>
							{row.name}
						</Link>
						{group.kind === 'pos_links' && row.count && row.count > 1 ? (
							<span className="text-muted-foreground">
								{' '}
								<Plural value={row.count} one="# link" other="# links" />
							</span>
						) : null}
						<RowNote row={row} />
					</li>
				))}
				{hidden > 0 ? (
					<li className="text-muted-foreground text-sm">
						<Plural value={hidden} one="and # more" other="and # more" />
					</li>
				) : null}
			</ul>
		</section>
	)
}

function RecipeLine({ recipes }: { recipes: RecipeState }) {
	if (recipes.status === 'off') return null
	if (recipes.status === 'done' && recipes.count === 0) return null
	return (
		<section className="flex flex-col gap-1">
			<h3 className="text-foreground text-sm font-medium">
				<Trans>Recipes</Trans>
			</h3>
			<p className="text-muted-foreground text-sm" role="status">
				{recipes.status === 'checking' ? (
					<Trans>Checking recipes…</Trans>
				) : recipes.status === 'failed' ? (
					<Trans>Could not check recipes</Trans>
				) : (
					<Plural
						value={recipes.count}
						one="# recipe in inventory uses it"
						other="# recipes in inventory use it"
					/>
				)}
			</p>
		</section>
	)
}

function EffectsSkeleton() {
	return (
		<div className="flex flex-col gap-2" aria-hidden>
			<Skeleton className="h-4 w-1/3" />
			<Skeleton className="h-4 w-2/3" />
			<Skeleton className="h-4 w-1/2" />
		</div>
	)
}

function hasRecipeLine(recipes: RecipeState): boolean {
	return (
		recipes.status === 'checking' ||
		recipes.status === 'failed' ||
		(recipes.status === 'done' && recipes.count > 0)
	)
}

/**
 * The body of a menu delete dialog: put it inside `AlertDialogHeader`, after
 * the title. It supplies the dialog's description. The delete stays allowed
 * whatever it lists.
 */
export function MenuDeleteEffects({
	orgSlug,
	entityType,
	entityId,
}: {
	orgSlug: string
	entityType: MenuEffectsEntityType
	/** The record the dialog is open for; `null` while it is closed. */
	entityId: string | null
}) {
	const effects = useDeleteEffects(orgSlug, entityType, entityId)
	const recipes = useRecipeCount(orgSlug, effects.data)
	if (!entityId) return null

	const { data } = effects
	const groups = data?.groups ?? []
	const blocked = groups.some((group) =>
		group.rows.some((row) => row.note === 'blocks_delete'),
	)
	const used = groups.length > 0 || hasRecipeLine(recipes)
	const name = data?.name ?? ''

	return (
		<>
			<AlertDialogDescription>
				{effects.error ? (
					<Trans>
						Could not check what uses this. You can still delete it.
					</Trans>
				) : !data ? (
					<Trans>Checking what uses this…</Trans>
				) : blocked ? (
					<Trans>
						{name} cannot be deleted while a drop uses it. This is what uses it
						now:
					</Trans>
				) : used ? (
					<Trans>
						{name} will be permanently deleted. This is what uses it now:
					</Trans>
				) : (
					<Trans>
						{name} will be permanently deleted. Nothing else uses it.
					</Trans>
				)}
			</AlertDialogDescription>
			{effects.error ? (
				<div>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={effects.reload}
					>
						<Trans>Try again</Trans>
					</Button>
				</div>
			) : !data ? (
				<EffectsSkeleton />
			) : used ? (
				<div className="flex max-h-64 flex-col gap-3 overflow-y-auto text-start">
					{groups.map((group) => (
						<EffectGroupSection
							key={group.kind}
							orgSlug={orgSlug}
							group={group}
						/>
					))}
					<RecipeLine recipes={recipes} />
				</div>
			) : null}
		</>
	)
}

/** What a Used in card lists: where the record is used, not what it holds. */
const USED_IN_KINDS: ReadonlySet<EffectKind> = new Set<EffectKind>([
	'in_menus',
	'in_categories',
	'in_modifier_groups',
	'used_by_items',
	'nested_in_options',
	'discounts',
	'drops',
	'print_designs',
	'pos_links',
])

/**
 * The reverse view on a detail page: everything that uses this option or
 * modifier group, each line a link. Fetches for itself; needs only the
 * organization slug and the record.
 */
export function MenuUsedInCard({
	orgSlug,
	entityType,
	entityId,
}: {
	orgSlug: string
	entityType: MenuEffectsEntityType
	entityId: string
}) {
	const effects = useDeleteEffects(orgSlug, entityType, entityId)
	const recipes = useRecipeCount(orgSlug, effects.data)
	const groups = (effects.data?.groups ?? []).filter((group) =>
		USED_IN_KINDS.has(group.kind),
	)
	const used = groups.length > 0 || hasRecipeLine(recipes)

	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Used in</Trans>
				</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				{effects.error ? (
					<>
						<p className="text-muted-foreground text-sm" role="status">
							<Trans>Could not check where this is used.</Trans>
						</p>
						<div>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={effects.reload}
							>
								<Trans>Try again</Trans>
							</Button>
						</div>
					</>
				) : !effects.data ? (
					<EffectsSkeleton />
				) : used ? (
					<>
						{groups.map((group) => (
							<EffectGroupSection
								key={group.kind}
								orgSlug={orgSlug}
								group={group}
							/>
						))}
						<RecipeLine recipes={recipes} />
					</>
				) : (
					<p className="text-muted-foreground text-sm">
						<Trans>Not used anywhere yet.</Trans>
					</p>
				)}
			</CardContent>
		</Card>
	)
}
