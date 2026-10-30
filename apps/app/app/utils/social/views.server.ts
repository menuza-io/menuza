import { type CalendarPost } from '#app/components/social/social-calendar.tsx'
import { type SocialPostView } from './posts.server.ts'

/** What the calendar and lists need of a post (no tokens, short text). */
export function toCalendarPost(post: SocialPostView): CalendarPost {
	const at = post.publishedAt ?? post.scheduledAt
	return {
		id: post.id,
		body: post.body.slice(0, 280),
		status: post.status,
		at: at ? at.toISOString() : null,
		platforms: [...new Set(post.targets.map((target) => target.platform))],
		accounts: post.targets.map((target) => target.accountName),
		imageUrl: post.media[0]?.url ?? null,
	}
}
