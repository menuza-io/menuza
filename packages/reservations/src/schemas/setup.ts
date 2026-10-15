import { z } from 'zod'
import {
	areaConfigSchema,
	combinationConfigSchema,
	locationSettingsSchema,
	pacingRuleSchema,
	policyRuleSchema,
	serviceConfigSchema,
	serviceTableModeRuleSchema,
	specialDayConfigSchema,
	tableConfigSchema,
	turnTimeBucketSchema,
} from '../config.ts'
import { ianaTimeZoneStringSchema } from './common.ts'

export const upsertLocationConfigSchema = z.strictObject({
	id: z.string().trim().min(1).optional(),
	slug: z
		.string()
		.trim()
		.min(1)
		.max(80)
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
	name: z.string().trim().min(1).max(120),
	timeZone: ianaTimeZoneStringSchema,
	address: z.string().trim().max(240).nullable().optional(),
	phone: z.string().trim().max(40).nullable().optional(),
	email: z.string().trim().email().max(160).nullable().optional(),
	currency: z
		.string()
		.trim()
		.regex(/^[A-Z]{3}$/)
		.default('USD'),
	active: z.boolean().default(true),
})

export const updateSettingsRequestSchema = locationSettingsSchema
export const upsertAreaRequestSchema = areaConfigSchema
export const upsertTableRequestSchema = tableConfigSchema
export const upsertCombinationRequestSchema = combinationConfigSchema
export const upsertServiceRequestSchema = serviceConfigSchema
export const upsertTurnTimeBucketRequestSchema = turnTimeBucketSchema
export const upsertPacingRuleRequestSchema = pacingRuleSchema
export const upsertServiceTableModeRequestSchema = serviceTableModeRuleSchema
export const upsertSpecialDayRequestSchema = specialDayConfigSchema
export const upsertPolicyRuleRequestSchema = policyRuleSchema

export const setupFullBundleRequestSchema = z.strictObject({
	location: upsertLocationConfigSchema,
	settings: locationSettingsSchema,
	areas: z.array(areaConfigSchema),
	tables: z.array(tableConfigSchema),
	combinations: z.array(combinationConfigSchema),
	services: z.array(serviceConfigSchema),
	turnTimeBuckets: z.array(turnTimeBucketSchema),
	pacingRules: z.array(pacingRuleSchema),
	serviceTableModes: z.array(serviceTableModeRuleSchema),
	specialDays: z.array(specialDayConfigSchema).optional(),
	policies: z.array(policyRuleSchema).optional(),
})
