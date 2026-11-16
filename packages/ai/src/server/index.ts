// Chat utilities
export { createChatStream, type ChatStreamOptions } from './chat.js'

// Content generation
export {
	generateContent,
	generateNoteContent,
	generateObject,
	type GenerateContentOptions,
	type GenerateStructuredOptions,
} from './generate.js'

// Image generation and editing
export {
	DEFAULT_IMAGE_MODEL,
	editImage,
	IMAGE_ASPECT_RATIOS,
	type EditImageOptions,
	type EditImageResult,
	type ImageAspectRatio,
	type ImageInput,
} from './image.js'

// Prompt builders
export { buildNoteChatSystemPrompt, type NoteContext } from './prompts.js'
