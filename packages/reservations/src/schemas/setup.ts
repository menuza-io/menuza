import { z } from 'zod'
import { localizedTextSchema } from '../i18n.ts'
import {
	areaConfigSchema,
	businessDateSchema,
	COMBINATION_TYPES,
	combinationConfigSchema,
	DECOR_ELEMENT_KINDS,
	hexColorSchema,
	intervalMinSchema,
	LARGE_PARTY_MODES,
	locationSettingsSchema,
	pacingRuleSchema,
	policyRuleSchema,
	SEATING_PREFERENCE_MODES,
	SEATING_PREFERENCES,
	SERVICE_TABLE_MODES,
	serviceConfigSchema,
	serviceTableModeRuleSchema,
	SPECIAL_DAY_TYPES,
	specialDayConfigSchema,
	TABLE_SHAPES,
	tableConfigSchema,
	timeZoneSchema,
	turnTimeBucketSchema,
} from '../config.ts'
import { ianaTimeZoneStringSchema } from './common.ts'

export const setupLocationSettingsObjectSchema = z.object({
	expectedVersion: z.number().int().min(1).optional(),
	locationName: z.string().trim().min(1).max(160).optional(),
	enabled: z.boolean().optional(),
	onlineEnabled: z.boolean().optional(),
	waitlistEnabled: z.boolean().optional(),
	waitlistOnline: z.boolean().optional(),
	notifyMeEnabled: z.boolean().optional(),
	timeZone: timeZoneSchema.optional(),
	currency: z.string().trim().min(3).max(8).optional(),
	dayStartMin: z.number().int().min(0).max(720).optional(),
	intervalMin: intervalMinSchema.optional(),
	horizonDays: z.number().int().min(1).max(365).optional(),
	releaseLocalMin: z.number().int().min(0).max(1439).nullable().optional(),
	minNoticeMin: z.number().int().min(0).max(10_080).optional(),
	sameDayCutoffMin: z.number().int().min(0).max(1439).nullable().optional(),
	onlinePartyMin: z.number().int().min(1).max(99).optional(),
	onlinePartyMax: z.number().int().min(1).max(99).optional(),
	partyMax: z.number().int().min(1).max(99).optional(),
	minParty: z.number().int().min(1).max(99).optional(),
	maxOnlineParty: z.number().int().min(1).max(99).optional(),
	maxParty: z.number().int().min(1).max(99).optional(),
	largePartyMode: z
		.enum([...LARGE_PARTY_MODES, 'contact'] as [string, ...string[]])
		.optional(),
	largePartyNoteI18n: localizedTextSchema(2000).nullable().optional(),
	requestHoldsCapacity: z.boolean().optional(),
	requestDeadlineHours: z.number().int().min(1).max(720).optional(),
	contactPhone: z.string().trim().max(40).nullable().optional(),
	publicNoteI18n: localizedTextSchema(2000).nullable().optional(),
	seatingPrefMode: z
		.enum([
			...SEATING_PREFERENCE_MODES,
			...SEATING_PREFERENCES,
			'preferred',
		] as [string, ...string[]])
		.optional(),
	seatingPreferenceMode: z
		.enum([
			...SEATING_PREFERENCE_MODES,
			...SEATING_PREFERENCES,
			'preferred',
		] as [string, ...string[]])
		.optional(),
	defaultTurnMin: z.number().int().min(15).max(480).optional(),
	bufferMin: z.number().int().min(0).max(240).optional(),
	holdMinutes: z.number().int().min(3).max(20).optional(),
	holdTtlSec: z.number().int().min(180).max(1200).optional(),
	paymentHoldMinutes: z.number().int().min(10).max(60).optional(),
	voiceHoldMinutes: z.number().int().min(5).max(30).optional(),
	voiceMode: z.enum(['hold_link', 'confirm_on_call']).optional(),
	freezeMin: z.number().int().min(0).max(1440).optional(),
	assignmentFreezeMin: z.number().int().min(0).max(1440).optional(),
	lateGraceMin: z.number().int().min(0).max(240).optional(),
	graceMin: z.number().int().min(0).max(240).optional(),
	autoNoShowAfterMin: z.number().int().min(15).max(720).nullable().optional(),
	autoNoShowMin: z.number().int().min(15).max(720).nullable().optional(),
	maxActivePerPhone: z.number().int().min(1).max(50).optional(),
	blockSamePhoneOverlap: z.boolean().optional(),
	guestModifyCutoffMin: z.number().int().min(0).max(10_080).optional(),
	modifyCutoffMin: z.number().int().min(0).max(10_080).optional(),
	contactStatusesEnabled: z.boolean().optional(),
	courseStatusesEnabled: z.boolean().optional(),
	defaultPolicyId: z.string().trim().max(64).nullable().optional(),
	waitlistResponseMin: z.number().int().min(1).max(120).optional(),
	waitlistMaxParties: z.number().int().min(1).max(1000).nullable().optional(),
	floorPlanVersion: z.number().int().min(1).optional(),
})

export const setupLocationSettingsSchema =
	setupLocationSettingsObjectSchema.superRefine((val, ctx) => {
		const minP = val.onlinePartyMin ?? val.minParty
		const maxOnlineP = val.onlinePartyMax ?? val.maxOnlineParty
		const maxP = val.partyMax ?? val.maxParty
		if (minP !== undefined && maxOnlineP !== undefined && minP > maxOnlineP) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['onlinePartyMin'],
				message: 'onlinePartyMin must be <= onlinePartyMax',
			})
		}
		if (maxOnlineP !== undefined && maxP !== undefined && maxOnlineP > maxP) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['onlinePartyMax'],
				message: 'onlinePartyMax must be <= partyMax',
			})
		}
		if (minP !== undefined && maxP !== undefined && minP > maxP) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['onlinePartyMin'],
				message: 'onlinePartyMin must be <= partyMax',
			})
		}
	})

export const setupLocationSettingsPatchSchema = setupLocationSettingsSchema

export const setupAreaInputSchema = z.object({
	locationId: z.string().min(1).max(64),
	name: z.string().trim().min(1).max(120),
	nameI18n: localizedTextSchema(120).optional(),
	color: hexColorSchema.optional(),
	isOutdoor: z.boolean().optional(),
	onlineBookable: z.boolean().optional(),
	guestSelectable: z.boolean().optional(),
	canvasW: z.number().int().min(100).max(10_000).optional(),
	canvasH: z.number().int().min(100).max(10_000).optional(),
	sort: z.number().int().min(0).max(10_000).optional(),
	sortOrder: z.number().int().min(0).max(10_000).optional(),
	active: z.boolean().optional(),
	archived: z.boolean().optional(),
})

export const setupTableInputSchema = z.object({
	locationId: z.string().min(1).max(64),
	areaId: z.string().min(1).max(64),
	label: z.string().trim().min(1).max(40),
	shape: z.enum(TABLE_SHAPES).default('square'),
	minCovers: z.number().int().min(1).max(99).optional(),
	maxCovers: z.number().int().min(1).max(99).optional(),
	minSeats: z.number().int().min(1).max(99).optional(),
	maxSeats: z.number().int().min(1).max(99).optional(),
	onlineBookable: z.boolean().optional(),
	onlineEnabled: z.boolean().optional(),
	combinable: z.boolean().default(false),
	priority: z.number().int().min(-1000).max(1000).default(0),
	resetBufferMin: z.number().int().min(0).max(120).nullable().optional(),
	x: z.number().int().min(0).max(10_000).default(0),
	y: z.number().int().min(0).max(10_000).default(0),
	w: z.number().int().min(10).max(2_000).optional(),
	h: z.number().int().min(10).max(2_000).optional(),
	width: z.number().int().min(10).max(2_000).optional(),
	height: z.number().int().min(10).max(2_000).optional(),
	rotation: z.number().int().min(-360).max(360).default(0),
	active: z.boolean().optional(),
	archived: z.boolean().optional(),
})

export const setupComboInputSchema = z.object({
	locationId: z.string().min(1).max(64),
	label: z.string().trim().min(1).max(120).optional(),
	name: z.string().trim().min(1).max(120).optional(),
	type: z.enum(COMBINATION_TYPES).optional(),
	minCovers: z.number().int().min(1).max(99).optional(),
	maxCovers: z.number().int().min(1).max(99).optional(),
	minSeats: z.number().int().min(1).max(99).optional(),
	maxSeats: z.number().int().min(1).max(99).optional(),
	priority: z.number().int().min(-1000).max(1000).default(0),
	onlineBookable: z.boolean().default(true),
	active: z.boolean().optional(),
	archived: z.boolean().optional(),
	tableIds: z.array(z.string().min(1).max(64)).min(2).max(20),
})

export const setupFloorElementInputSchema = z.object({
	locationId: z.string().min(1).max(64),
	areaId: z.string().min(1).max(64),
	kind: z.enum(DECOR_ELEMENT_KINDS),
	label: z.string().trim().max(120).nullable().optional(),
	x: z.number().int().min(0).max(10_000).default(0),
	y: z.number().int().min(0).max(10_000).default(0),
	w: z.number().int().min(1).max(5_000).optional(),
	h: z.number().int().min(1).max(5_000).optional(),
	width: z.number().int().min(1).max(5_000).optional(),
	height: z.number().int().min(1).max(5_000).optional(),
	rotation: z.number().int().min(-360).max(360).default(0),
})

export const setupServiceInputSchema = z.object({
	locationId: z.string().min(1).max(64),
	name: z.string().trim().min(1).max(120),
	nameI18n: localizedTextSchema(120).optional(),
	slug: z.string().trim().min(1).max(80).optional(),
	color: z.string().trim().min(1).max(40).optional(),
	colorToken: z.string().trim().min(1).max(40).optional(),
	daysMask: z.number().int().min(1).max(127).optional(),
	daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
	firstSeatingMin: z.number().int().min(0).max(1439).optional(),
	startMin: z.number().int().min(0).max(1439).optional(),
	lastSeatingMin: z.number().int().min(0).max(2880),
	endMin: z.number().int().min(1).max(2880),
	intervalMin: intervalMinSchema.nullable().optional(),
	effectiveFrom: businessDateSchema.nullable().optional(),
	effectiveTo: businessDateSchema.nullable().optional(),
	priority: z.number().int().min(-1000).max(10_000).default(0),
	specialDayId: z.string().min(1).max(64).nullable().optional(),
	onlineEnabled: z.boolean().optional(),
	onlineBookable: z.boolean().optional(),
	onlineFromMin: z.number().int().min(0).max(2880).nullable().optional(),
	onlineToMin: z.number().int().min(0).max(2880).nullable().optional(),
	maxParty: z.number().int().min(1).max(99).nullable().optional(),
	onlinePartyMax: z.number().int().min(1).max(99).nullable().optional(),
	onlineCapPerInterval: z.number().int().min(1).max(2000).nullable().optional(),
	concurrentCoversCap: z
		.number()
		.int()
		.min(1)
		.max(10_000)
		.nullable()
		.optional(),
	policyId: z.string().min(1).max(64).nullable().optional(),
	sectionLayoutId: z.string().min(1).max(64).nullable().optional(),
	allowOverrunPastEnd: z.boolean().optional(),
	sort: z.number().int().min(0).max(10_000).optional(),
	sortOrder: z.number().int().min(0).max(10_000).optional(),
	active: z.boolean().optional(),
	archived: z.boolean().optional(),
})

export const setupTurnTimeInputSchema = z.object({
	locationId: z.string().min(1).max(64),
	serviceId: z.string().min(1).max(64).nullable().optional(),
	partyMin: z.number().int().min(1).max(99).optional(),
	partyMax: z.number().int().min(1).max(99).optional(),
	minParty: z.number().int().min(1).max(99).optional(),
	maxParty: z.number().int().min(1).max(99).optional(),
	minutes: z.number().int().min(15).max(480).optional(),
	turnMin: z.number().int().min(15).max(480).optional(),
	durationMin: z.number().int().min(15).max(480).optional(),
	daysMask: z.number().int().min(1).max(127).nullable().optional(),
})

export const setupPacingRuleInputSchema = z.object({
	locationId: z.string().min(1).max(64).optional(),
	serviceId: z.string().min(1).max(64),
	fromMin: z.number().int().min(0).max(2880).nullable().optional(),
	toMin: z.number().int().min(0).max(2880).nullable().optional(),
	windowStartMin: z.number().int().min(0).max(2880).nullable().optional(),
	windowEndMin: z.number().int().min(0).max(2880).nullable().optional(),
	bucketMin: intervalMinSchema.default(15),
	maxCovers: z.number().int().min(1).max(2000).nullable().optional(),
	maxParties: z.number().int().min(1).max(500).nullable().optional(),
	maxCoversPerSlot: z.number().int().min(1).max(2000).nullable().optional(),
	maxPartiesPerSlot: z.number().int().min(1).max(500).nullable().optional(),
	rollingMin: z.number().int().min(1).max(1440).nullable().optional(),
	rollingMaxCovers: z.number().int().min(1).max(10_000).nullable().optional(),
	channel: z.enum(['all', 'online']).default('all'),
})

export const setupServiceAvailabilityInputSchema = z.object({
	locationId: z.string().min(1).max(64).optional(),
	serviceId: z.string().min(1).max(64),
	areaId: z.string().min(1).max(64).nullable().optional(),
	tableId: z.string().min(1).max(64).nullable().optional(),
	comboId: z.string().min(1).max(64).nullable().optional(),
	combinationId: z.string().min(1).max(64).nullable().optional(),
	fromMin: z.number().int().min(0).max(2880).nullable().optional(),
	toMin: z.number().int().min(0).max(2880).nullable().optional(),
	mode: z.enum(SERVICE_TABLE_MODES),
})

export const setupSpecialDayInputSchema = z.object({
	locationId: z.string().min(1).max(64),
	fromDate: businessDateSchema.optional(),
	toDate: businessDateSchema.optional(),
	businessDate: businessDateSchema.optional(),
	date: businessDateSchema.optional(),
	kind: z.enum(SPECIAL_DAY_TYPES).optional(),
	type: z.enum(SPECIAL_DAY_TYPES).optional(),
	serviceId: z.string().min(1).max(64).nullable().optional(),
	patch: z.record(z.unknown()).nullable().optional(),
	name: z.string().trim().min(1).max(120).nullable().optional(),
	label: z.string().trim().min(1).max(120).nullable().optional(),
	publicNoteI18n: localizedTextSchema(2000).nullable().optional(),
	note: z.string().trim().max(500).nullable().optional(),
	services: z.array(z.record(z.unknown())).nullable().optional(),
	customServices: z.array(z.record(z.unknown())).nullable().optional(),
})

export const setupBlockInputSchema = z.object({
	locationId: z.string().min(1).max(64),
	areaId: z.string().min(1).max(64).nullable().optional(),
	tableId: z.string().min(1).max(64).nullable().optional(),
	businessDate: businessDateSchema,
	startMin: z.number().int().min(0).max(2880).optional(),
	endMin: z.number().int().min(1).max(2880).optional(),
	startAt: z.number().int().min(0).optional(),
	endAt: z.number().int().min(1).optional(),
	reason: z.string().trim().max(240).nullable().optional(),
	note: z.string().trim().max(500).nullable().optional(),
})

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
