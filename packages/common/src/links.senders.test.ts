import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GUEST_LINK_TYPES } from './links.ts'

/**
 * #195, "no sender builds a guest link without the registry": scans the code
 * that writes guest-facing messages, emails, printed QR codes, push payloads and
 * notifications for hand-built guest URLs. The pages themselves live in Sites
 * (`apps/sites`, which serves them and links between them) and are not senders.
 */

const ROOT = join(__dirname, '../../..')
const SCAN_ROOTS = [
	'apps/tenant-api/src',
	'apps/app/app',
	'apps/admin/app',
	'apps/jobs-cron/src',
	'apps/voice-agent/src',
	'packages',
]
const SKIP_DIRS = new Set([
	'node_modules',
	'dist',
	'.turbo',
	'locales',
	'contract-fixtures',
	'drizzle',
])

/** Why a file may name a guest path: it is not a sender of a message link. */
const ALLOWED: Record<string, string> = {
	'packages/common/src/links.ts': 'the registry itself',
	'apps/app/app/utils/restaurant-orders/checkout.server.ts':
		'payment provider return URLs (web only, never texted or emailed as a message link)',
	'apps/app/app/utils/reservations/payments.server.ts':
		'payment provider return URLs (web only)',
	'packages/common/src/site-popup.ts':
		'comment naming the excluded ordering pages',
	'apps/app/app/utils/website/site-import.ts':
		'website page content, not a sender',
	'apps/app/app/utils/website/home-page.ts':
		'website page content, not a sender',
	'apps/app/app/utils/website/generate-site.ts':
		'website page content, not a sender',
	'apps/app/app/utils/seo/search-console.server.ts':
		'paths Search Console is asked about',
	'apps/app/app/utils/launch/launch.ts':
		'operator checklist links inside the App',
	'apps/app/app/utils/dashboards/attention.server.ts':
		'operator links inside the App',
	'apps/tenant-api/src/services/voice-actions.ts': 'comment',
	'packages/common/src/merge-tags.ts': 'sample text shown in the designer',
	'packages/common/src/location-health.ts': 'operator links inside the App',
}

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name)) continue
		const full = join(dir, name)
		const stat = statSync(full)
		if (stat.isDirectory()) walk(full, out)
		else if (
			/\.(ts|tsx)$/.test(name) &&
			!/\.(test|spec)\.(ts|tsx)$/.test(name) &&
			!name.endsWith('.d.ts')
		) {
			out.push(full)
		}
	}
	return out
}

/** Paths that only a guest link uses, from the registry (the generic `/menu` and `/reserve` are covered below). */
const SPECIFIC_PATHS = [
	...new Set(Object.values(GUEST_LINK_TYPES).map((def) => def.path)),
].filter((path) => path !== '/menu' && path !== '/reserve')

const FORBIDDEN = [
	...SPECIFIC_PATHS.map((path) => ({
		label: path,
		pattern: new RegExp(
			`['"\`]/?[^'"\`\\s]*${path.replace(/\//g, '\\/')}(?![\\w-])`,
		),
	})),
	{ label: 'a menu link with a query', pattern: /['"`]\/menu\?/ },
	{
		label: 'a menu link built from a site base',
		pattern:
			/\$\{(origin|base|siteBase|prefix|siteOrigin|site)\}\/menu(\?|['"`#])/,
	},
	{
		label: 'a booking link built from a site base',
		pattern:
			/\$\{(origin|base|siteBase|prefix|siteOrigin|site)\}\/reserve(['"`#?])/,
	},
	{
		label: 'a capability fragment',
		pattern: /#(cart|link|table|t|h|add)=\$\{/,
	},
	{ label: 'new URL(menu)', pattern: /new URL\(\s*['"`]\/(menu|reserve)['"`]/ },
]

describe('every sender builds guest links through the registry (#195)', () => {
	const files = SCAN_ROOTS.flatMap((root) => {
		try {
			return walk(join(ROOT, root))
		} catch {
			return []
		}
	})

	it('scans a meaningful set of files', () => {
		expect(files.length).toBeGreaterThan(500)
	})

	it('finds no hand-built guest URL outside the allowed files', () => {
		const offenders: string[] = []
		for (const file of files) {
			const rel = relative(ROOT, file)
			if (ALLOWED[rel]) continue
			const text = readFileSync(file, 'utf8')
			const code = text
				.split('\n')
				.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
				.join('\n')
			for (const rule of FORBIDDEN) {
				if (rule.pattern.test(code)) offenders.push(`${rel}: ${rule.label}`)
			}
		}
		expect(offenders).toEqual([])
		// Reads the whole repo's source: give a loaded CI runner room.
	}, 60_000)

	it('keeps the allow list honest: every allowed file still exists', () => {
		for (const rel of Object.keys(ALLOWED)) {
			expect(() => statSync(join(ROOT, rel))).not.toThrow()
		}
	})

	it('has the senders it should: each imports the registry', () => {
		const mustUse = [
			'apps/tenant-api/src/lib/order-link.ts',
			'apps/tenant-api/src/lib/cart-link.ts',
			'apps/tenant-api/src/services/rsv-message-service.ts',
			'apps/tenant-api/src/services/rsv-payment-service.ts',
			'apps/tenant-api/src/services/rsv-payment-booking.ts',
			'apps/tenant-api/src/services/gift-card-messages.ts',
			'packages/common/src/qr-ordering.ts',
			'packages/common/src/email-blocks-restaurant.ts',
			'packages/common/src/form-alerts.ts',
			'apps/app/app/utils/email/menu-items.server.ts',
			'apps/app/app/utils/print/restaurant/vertical.server.ts',
			'apps/app/app/utils/gbp/context.server.ts',
			'packages/marketing-workflow/src/programs.ts',
		]
		for (const rel of mustUse) {
			expect(readFileSync(join(ROOT, rel), 'utf8'), rel).toMatch(
				/links(\.ts)?'/,
			)
		}
	})
})
