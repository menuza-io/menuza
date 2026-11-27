import { Trans } from '@lingui/macro'
import { ALLERGEN_LABELS, type Allergen } from '@repo/common/menu-types'
import {
	allergenListsDiffer,
	applyRecipeAllergens,
	rollUpRecipeAllergens,
	type RecipeAllergenItem,
} from '@repo/common/recipe-allergens'

/**
 * Shows the recipe rollup beside the dish's typed allergens (#496).
 * Applying copies the recipe list; the menu never changes on its own.
 */
export function RecipeAllergenNotice({
	ingredients,
	optionIngredients = [],
	menuAllergens,
	onApply,
}: {
	ingredients: readonly RecipeAllergenItem[]
	optionIngredients?: readonly RecipeAllergenItem[]
	menuAllergens: readonly string[]
	onApply: (allergens: Allergen[]) => void
}) {
	const rollup = rollUpRecipeAllergens(ingredients, optionIngredients)
	if (rollup.allergens.length === 0 && rollup.sources.length === 0) return null
	const differs = allergenListsDiffer(menuAllergens, rollup.allergens)
	const labels = rollup.allergens.map((allergen) => ALLERGEN_LABELS[allergen])
	return (
		<div className="space-y-2 rounded-md border p-3 text-sm">
			<p>
				<Trans>Contains: {labels.join(', ')}</Trans>
			</p>
			{rollup.sources.length > 0 ? (
				<p className="text-muted-foreground">{rollup.sources.join(', ')}</p>
			) : null}
			{differs ? (
				<button
					type="button"
					className="text-primary underline underline-offset-4"
					onClick={() => onApply(applyRecipeAllergens(rollup.allergens))}
				>
					<Trans>Use recipe allergens</Trans>
				</button>
			) : null}
		</div>
	)
}
