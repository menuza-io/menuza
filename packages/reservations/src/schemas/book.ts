import { z } from 'zod'
import {
	attributeTagSchema,
	bookingChannelSchema,
	businessDateStringSchema,
	guestOccasionSchema,
	normalizedPhoneSchema,
	partySizeSchema,
	reservationStatusSchema,
	seatingPreferenceSchema,
	slotMinSchema,
} from './common.ts'

export const operatorBookDayQuerySchema = z.strictObject({
	locationId: z.string().trim().min(1),
	businessDate: businessDateStringSchema,
	serviceId: z.string().trim().min(1).optional(),
	areaId: z.string().trim().min(1).optional(),
	status: reservationStatusSchema.optional(),
	search: z.string().trim().max(120).optional(),
})

export const operatorCreateReservationSchema = z.strictObject({
	locationId: z.string().trim().min(1),
	businessDate: businessDateStringSchema,
	slotMin: slotMinSchema,
	partySize: partySizeSchema,
	guestName: z.string().trim().min(1).max(120),
	guestPhone: normalizedPhoneSchema.optional().nullable(),
	guestEmail: z.string().trim().email().max(160).optional().nullable(),
	channel: bookingChannelSchema.default('operator'),
	serviceId: z.string().trim().min(1).optional().nullable(),
	areaId: z.string().trim().min(1).optional().nullable(),
	tableIds: z.array(z.string().trim().min(1)).optional(),
	tableLocked: z.boolean().default(false),
	overbook: z.boolean().default(false),
	seatingPreference: seatingPreferenceSchema.default('any'),
	requestedAttributes: z.array(attributeTagSchema).optional(),
	occasion: guestOccasionSchema.optional().nullable(),
	dietaryNotes: z.string().trim().max(500).optional().nullable(),
	guestNotes: z.string().trim().max(1000).optional().nullable(),
	internalNotes: z.string().trim().max(1000).optional().nullable(),
	durationMin: z.number().int().min(15).max(720).optional(),
	waivePolicy: z.boolean().default(false),
	sendPaymentLink: z.boolean().default(false),
	smsOptIn: z.boolean().default(false),
	idempotencyKey: z.string().trim().min(8).max(128).optional(),
})

export const operatorWalkInSchema = z.strictObject({
	locationId: z.string().trim().min(1),
	partySize: partySizeSchema,
	tableIds: z.array(z.string().trim().min(1)).optional(),
	areaId: z.string().trim().min(1).optional().nullable(),
	guestName: z.string().trim().max(120).default('Walk-in'),
	guestPhone: normalizedPhoneSchema.optional().nullable(),
	durationMin: z.number().int().min(15).max(720).optional(),
	internalNotes: z.string().trim().max(1000).optional().nullable(),
	overbook: z.boolean().default(false),
})

export const operatorUpdateReservationSchema = z.strictObject({
	businessDate: businessDateStringSchema.optional(),
	slotMin: slotMinSchema.optional(),
	partySize: partySizeSchema.optional(),
	durationMin: z.number().int().min(15).max(720).optional(),
	tableIds: z.array(z.string().trim().min(1)).optional(),
	tableLocked: z.boolean().optional(),
	overbook: z.boolean().optional(),
	seatingPreference: seatingPreferenceSchema.optional(),
	occasion: guestOccasionSchema.optional().nullable(),
	dietaryNotes: z.string().trim().max(500).optional().nullable(),
	guestNotes: z.string().trim().max(1000).optional().nullable(),
	internalNotes: z.string().trim().max(1000).optional().nullable(),
	expectedVersion: z.number().int().min(1).optional(),
})

export const operatorTransitionReservationSchema = z.strictObject({
	toStatus: reservationStatusSchema,
	reason: z.string().trim().max(500).optional().nullable(),
	tableIds: z.array(z.string().trim().min(1)).optional(),
	waiveFee: z.boolean().default(false),
	overrideFullRefund: z.boolean().default(false),
	expectedVersion: z.number().int().min(1).optional(),
})

export const operatorAssignTablesRequestSchema = z.strictObject({
	tableIds: z.array(z.string().trim().min(1)).min(1),
	tableLocked: z.boolean().optional(),
	overbook: z.boolean().default(false),
	expectedVersion: z.number().int().min(1).optional(),
})

export const operatorCreateBlockSchema = z.strictObject({
	locationId: z.string().trim().min(1),
	businessDate: businessDateStringSchema,
	startMin: slotMinSchema,
	endMin: slotMinSchema,
	tableIds: z.array(z.string().trim().min(1)).optional(),
	areaId: z.string().trim().min(1).optional().nullable(),
	reason: z.string().trim().max(240).optional().nullable(),
	reflowSoftBookings: z.boolean().default(true),
})

export const operatorApproveRequestSchema = z.strictObject({
	tableIds: z.array(z.string().trim().min(1)).optional(),
	sendPaymentLink: z.boolean().default(false),
	note: z.string().trim().max(500).optional().nullable(),
})

export const operatorDeclineRequestSchema = z.strictObject({
	reason: z.string().trim().max(500).optional().nullable(),
})

export const operatorShiftNoteSchema = z.strictObject({
	locationId: z.string().trim().min(1),
	businessDate: businessDateStringSchema,
	serviceId: z.string().trim().min(1).optional().nullable(),
	content: z.string().trim().max(4000),
	pinned: z.boolean().default(false),
})
