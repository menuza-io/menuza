import { createCn } from 'cn/config'

/**
 * `cn` that knows the design tokens from styles/tailwind.css, so a caller's
 * `shadow-none` or `ease-in` replaces `shadow-card` or `ease-out-quint`
 * instead of both being kept.
 */
export const cn = createCn({
	extend: {
		theme: {
			shadow: ['card', 'raised', 'pop'],
			ease: ['out-quint'],
		},
	},
})
