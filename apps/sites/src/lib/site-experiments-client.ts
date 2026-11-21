import { EMBED_RESCAN_EVENT } from '@repo/common/site-embeds'
import { armFor, rememberAssignment } from '~/lib/site-funnel-client'

/**
 * Picks the visitor's arm for each A/B test on the page and shows it (#338).
 * A new visitor gets an even split; a returning one keeps their arm (kept in
 * this browser only). Arm A is already on the page; B is swapped in from its
 * template, then the wrapper is shown.
 */
export function applyExperiments() {
	for (const wrapper of document.querySelectorAll<HTMLElement>('[data-exp]')) {
		const id = wrapper.dataset.exp
		if (!id) continue
		const arm = armFor(id)
		rememberAssignment(id, arm)
		if (arm === 'b') {
			const original = wrapper.querySelector('[data-exp-arm="a"]')
			const template = wrapper.querySelector<HTMLTemplateElement>(
				'template[data-exp-arm="b"]',
			)
			if (original && template) {
				original.replaceWith(template.content.cloneNode(true))
			}
		}
		wrapper.removeAttribute('data-exp-pending')
	}
	// Variant B may hold an embed: tell the embed script to look again.
	window.dispatchEvent(new CustomEvent(EMBED_RESCAN_EVENT))
}
