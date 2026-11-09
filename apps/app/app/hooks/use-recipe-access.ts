import { DEFAULT_INVENTORY_LOCATION_ID } from '@repo/inventory'
import { useRouteLoaderData } from 'react-router'
import { type loader as rootLoader } from '#app/root.tsx'
import { HIDDEN_INVENTORY_NAV } from '#app/utils/inventory/nav.ts'

export type RecipeAccess = {
	/** Show recipe UI at all: the recipes flag is on and the member may read inventory. */
	enabled: boolean
	/** The member may save and clear recipes. */
	canEdit: boolean
	/** The member may type a cost per dish (needs the cost grant). */
	canTypeCost: boolean
	/** The inventory location the ingredient picker reads. */
	locationId: string
}

export const NO_RECIPE_ACCESS: RecipeAccess = {
	enabled: false,
	canEdit: false,
	canTypeCost: false,
	locationId: DEFAULT_INVENTORY_LOCATION_ID,
}

type RootAccessData = {
	inventoryNav?: {
		recipes?: boolean
		editRecipes?: boolean
		seeCost?: boolean
	} | null
	locations?: readonly { id: string }[] | null
	selectedLocationId?: string | null
} | null

/**
 * What the menu pages may show of recipes, from data the root loader already
 * has for the sidebar (the flag and the member's grants), so a menu page adds
 * no server query. It only decides what to RENDER: the region checks the token
 * on every call, and a 403, 404 or `feature_disabled` hides the panel again.
 */
export function computeRecipeAccess(data: RootAccessData): RecipeAccess {
	const nav = data?.inventoryNav ?? HIDDEN_INVENTORY_NAV
	if (!nav.recipes) return NO_RECIPE_ACCESS
	const locations = data?.locations ?? []
	// An organization without locations keeps its stock at the implicit `main`.
	const selected = data?.selectedLocationId
	const locationId =
		locations.find((loc) => loc.id === selected)?.id ??
		locations[0]?.id ??
		DEFAULT_INVENTORY_LOCATION_ID
	return {
		enabled: true,
		canEdit: nav.editRecipes === true,
		canTypeCost: nav.editRecipes === true && nav.seeCost === true,
		locationId,
	}
}

export function useRecipeAccess(): RecipeAccess {
	const data = useRouteLoaderData<typeof rootLoader>('root')
	return computeRecipeAccess(data as RootAccessData)
}
