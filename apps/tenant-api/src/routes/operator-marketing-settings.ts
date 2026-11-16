import { getTenantDb, marketingSettings } from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { errorLogFields } from '../lib/error-log.ts'
import {
	cartReminderSettingsSchema,
	DEFAULT_CART_SETTINGS,
	readCartSettings,
	writeCartSettings,
} from '../services/cart-reminders.ts'
import {
	DEFAULT_FREQUENCY_CAP,
	FREQUENCY_CAP_KEY,
	readFrequencyCap,
} from '../services/journey-guards.ts'
import { authenticateOperator, requireOperatorClaim } from './operator.ts'

/**
 * Marketing settings (#99 #150), `/operator/marketing/settings`: the frequency
 * cap (at most N marketing messages per guest per 7 days across broadcasts and
 * automations) and the cart reminder (delay and smallest cart). Organization
 * wide, no guest data.
 */
export const marketingSettingsRoutes = new Hono()

const bodySchema = z
	.object({
		/** `null` turns the cap off. `days` is the window (the product uses 7). */
		frequencyCap: z
			.union([
				z
					.object({
						limit: z.number().int().min(1).max(50),
						days: z.number().int().min(1).max(30).default(7),
					})
					.strict(),
				z.null(),
			])
			.optional(),
		cartReminder: cartReminderSettingsSchema.optional(),
	})
	.strict()

marketingSettingsRoutes.get('/', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}
	try {
		const db = await getTenantDb(auth.orgId)
		const stored = await db
			.select({ key: marketingSettings.key })
			.from(marketingSettings)
			.where(eq(marketingSettings.key, FREQUENCY_CAP_KEY))
			.get()
		return c.json({
			frequencyCap: await readFrequencyCap(db),
			/** A cap was ever saved (also "no limit"); without one, none applies. */
			frequencyCapConfigured: Boolean(stored),
			defaultFrequencyCap: DEFAULT_FREQUENCY_CAP,
			cartReminder: await readCartSettings(db),
			defaultCartReminder: DEFAULT_CART_SETTINGS,
		})
	} catch (error) {
		console.error('Marketing settings could not be read', errorLogFields(error))
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})

marketingSettingsRoutes.put('/', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}
	const denied = requireOperatorClaim(c, auth, 'canUpdate')
	if (denied) return denied
	const parsed = bodySchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) return c.json({ error: 'invalid_settings' }, 400)
	try {
		const db = await getTenantDb(auth.orgId)
		if (parsed.data.frequencyCap !== undefined) {
			if (parsed.data.frequencyCap === null) {
				// "Not limited": a row with limit 0 reads as no cap.
				await db
					.insert(marketingSettings)
					.values({ key: FREQUENCY_CAP_KEY, value: { limit: 0, days: 7 } })
					.onConflictDoUpdate({
						target: marketingSettings.key,
						set: { value: { limit: 0, days: 7 }, updatedAt: Date.now() },
					})
			} else {
				await db
					.insert(marketingSettings)
					.values({ key: FREQUENCY_CAP_KEY, value: parsed.data.frequencyCap })
					.onConflictDoUpdate({
						target: marketingSettings.key,
						set: { value: parsed.data.frequencyCap, updatedAt: Date.now() },
					})
			}
		}
		if (parsed.data.cartReminder) {
			await writeCartSettings(db, parsed.data.cartReminder)
		}
		return c.json({
			frequencyCap: await readFrequencyCap(db),
			cartReminder: await readCartSettings(db),
		})
	} catch (error) {
		console.error('Marketing settings could not be saved', errorLogFields(error))
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})

