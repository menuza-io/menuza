/**
 * Calorie display (#285). Display only: stored `calorieMin` / `calorieMax`
 * and option calories stay on the dish. The phone agent does not read this.
 */

export const CALORIE_DISPLAY_MODES = ['always', 'complete', 'never'] as const
export type CalorieDisplayMode = (typeof CALORIE_DISPLAY_MODES)[number]

export function isCalorieDisplayMode(
	value: unknown,
): value is CalorieDisplayMode {
	return (
		typeof value === 'string' &&
		(CALORIE_DISPLAY_MODES as readonly string[]).includes(value)
	)
}

export type CalorieNumbers = {
	calorieMin: number | null
	calorieMax: number | null
}

/** A dish has calories when a minimum is stored. A max alone does not count. */
export function dishHasCalories(dish: CalorieNumbers): boolean {
	return dish.calorieMin != null && dish.calorieMin >= 0
}

export type ResolvedCalorieDisplay = {
	mode: CalorieDisplayMode
	/** Guest surfaces may show calorie numbers. */
	show: boolean
	/** Dishes on this menu with no calorie minimum. */
	missingCount: number
}

/**
 * Organization default, optional per-menu override. An older menu whose
 * nutritional-info switch is off hides calories unless the menu sets a mode.
 */
export function resolveCalorieDisplay(input: {
	orgMode: CalorieDisplayMode
	menuMode?: string | null
	nutritionalInfo?: boolean
	missingCount: number
}): ResolvedCalorieDisplay {
	const menuMode = isCalorieDisplayMode(input.menuMode) ? input.menuMode : null
	const mode =
		menuMode ?? (input.nutritionalInfo === false ? 'never' : input.orgMode)
	const missingCount = Math.max(0, input.missingCount)
	const show = mode === 'always' || (mode === 'complete' && missingCount === 0)
	return { mode, show, missingCount }
}

export type CalorieRange = { min: number; max: number }

/**
 * Selected options add their calories to the top of the dish's range.
 * Options without a number do not move it. No minimum on the dish: nothing
 * to show.
 */
export function calorieRangeWithOptions(
	dish: CalorieNumbers,
	selectedOptionCalories: readonly (number | null | undefined)[],
): CalorieRange | null {
	if (!dishHasCalories(dish) || dish.calorieMin == null) return null
	const baseMax = dish.calorieMax != null ? dish.calorieMax : dish.calorieMin
	let extra = 0
	for (const value of selectedOptionCalories) {
		if (value != null && value > 0) extra += value
	}
	return {
		min: dish.calorieMin,
		max: Math.max(baseMax, dish.calorieMin) + extra,
	}
}

/** Markets that require a daily-intake statement beside displayed calories. */
export type DailyIntakeMarket = 'us' | 'ksa'

export function dailyIntakeMarket(
	dataRegion: string | null | undefined,
): DailyIntakeMarket | null {
	if (dataRegion === 'ksa') return 'ksa'
	if (dataRegion === 'us') return 'us'
	return null
}

export type GuestCalorieView =
	| {
			visible: false
	  }
	| {
			visible: true
			min: number
			max: number
			intake: DailyIntakeMarket | null
	  }

/**
 * What a guest surface may render. `never`, and `complete` while any dish on
 * the menu is missing calories, hide every number. Stored values are not
 * part of this result.
 */
export function guestCalorieView(input: {
	show: boolean
	dish: CalorieNumbers
	selectedOptionCalories?: readonly (number | null | undefined)[]
	dataRegion?: string | null
}): GuestCalorieView {
	if (!input.show) return { visible: false }
	const range = calorieRangeWithOptions(
		input.dish,
		input.selectedOptionCalories ?? [],
	)
	if (!range) return { visible: false }
	return {
		visible: true,
		min: range.min,
		max: range.max,
		intake: dailyIntakeMarket(input.dataRegion),
	}
}
