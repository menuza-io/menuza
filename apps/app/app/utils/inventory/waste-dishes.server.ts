import { loadMenuGraph } from '#app/utils/menu/menu-graph.server.ts'
import { buildWasteDishes, type WasteDish } from './waste-dishes.ts'

/** The menu's dishes (names, sizes, options) for the Log waste picker. */
export async function loadWasteDishes(organization: {
	id: string
	siteLocales: string | null
	siteDefaultLocale: string | null
}): Promise<WasteDish[]> {
	const { graph } = await loadMenuGraph(organization)
	return buildWasteDishes(graph)
}
