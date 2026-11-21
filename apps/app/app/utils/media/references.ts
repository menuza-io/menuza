/**
 * Where a media asset is used (the media library's "Used in" list and the
 * archive guard, #147). Shared by the loader types and the server lookup.
 */
export type MediaReferenceItem = {
	id: string
	type:
		| 'note'
		| 'comment'
		| 'logo'
		| 'site-icon'
		| 'page'
		| 'social-post'
		| 'email-template'
		| 'menu-item'
		| 'menu-option'
		| 'source'
	title: string
	subtitle?: string
	url?: string
	createdAt?: string
}

export function getSourceLabel(source: string) {
	switch (source) {
		case 'ai-studio':
			return 'AI studio'
		case 'comment':
			return 'Comment'
		case 'note':
			return 'Note'
		case 'organization-logo':
			return 'Organization logo'
		case 'site-icon':
			return 'Site icon'
		case 'video-thumbnail':
			return 'Video thumbnail'
		case 'website-asset':
			return 'Website'
		case 'website-seo':
			return 'Website SEO'
		case 'hero-video':
			return 'Hero video'
		default:
			return 'Media library'
	}
}
