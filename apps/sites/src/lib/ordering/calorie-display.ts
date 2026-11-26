import {
	guestCalorieView,
	type DailyIntakeMarket,
} from '@repo/common/calorie-display'

export type CalorieMenu = {
	showCalories?: boolean
	dailyIntake?: DailyIntakeMarket | null
}

/** Guest calories stay hidden when any menu on the page resolved to hidden. */
export function pageShowsCalories(
	menus: readonly CalorieMenu[] | undefined,
): boolean {
	if (!menus || menus.length === 0) return true
	return menus.every((menu) => menu.showCalories !== false)
}

export function pageDailyIntake(
	menus: readonly CalorieMenu[] | undefined,
): DailyIntakeMarket | null {
	if (!pageShowsCalories(menus)) return null
	return menus?.find((menu) => menu.dailyIntake)?.dailyIntake ?? null
}

export function guestCalorieNumbers(input: {
	show: boolean
	calorieMin?: number | null
	calorieMax?: number | null
	optionCalories?: readonly (number | null | undefined)[]
	dataRegion?: string | null
}): { min: number; max: number; intake: DailyIntakeMarket | null } | null {
	const view = guestCalorieView({
		show: input.show,
		dish: {
			calorieMin: input.calorieMin ?? null,
			calorieMax: input.calorieMax ?? null,
		},
		selectedOptionCalories: input.optionCalories,
		dataRegion: input.dataRegion,
	})
	if (!view.visible) return null
	return { min: view.min, max: view.max, intake: view.intake }
}
