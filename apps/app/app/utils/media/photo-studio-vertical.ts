import { RESTYLE_FOOD_RULE } from '@repo/common/media-restyle'
import { generalPhotoStudio, type PhotoStudioVertical } from './photo-studio.ts'

// The one line that picks the business type for the AI photo studio. A fork
// for another kind of business swaps it for its own presets and options; the
// rest of the media library only talks to this vertical.
export const photoStudioVertical: PhotoStudioVertical = generalPhotoStudio

/**
 * The studio for a restaurant's dishes, used by "Restyle menu" (#146). It has
 * the studio's presets, but the subject is a dish and every prompt carries the
 * food rule: only the plate, the backdrop and the light change, never the food.
 */
export const restaurantDishPhotoStudio: PhotoStudioVertical = {
	...photoStudioVertical,
	id: 'restaurant-dish',
	subject: 'dish',
	rules: [...(photoStudioVertical.rules ?? []), RESTYLE_FOOD_RULE],
}
