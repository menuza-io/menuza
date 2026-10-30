import { generalPhotoStudio, type PhotoStudioVertical } from './photo-studio.ts'

// The one line that picks the business type for the AI photo studio. A fork
// for another kind of business swaps it for its own presets and options; the
// rest of the media library only talks to this vertical.
export const photoStudioVertical: PhotoStudioVertical = generalPhotoStudio
