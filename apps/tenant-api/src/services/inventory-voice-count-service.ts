import {
	parseSpokenCount,
	VOICE_AUDIO_MAX_BYTES,
	type VoiceItem,
	type VoiceProposal,
} from '@repo/inventory'
import { InventoryError } from '../lib/inventory-http.ts'
import { type InventoryReader } from '../lib/inventory-write.ts'
import {
	isSpeechReaderConfigured,
	SPEECH_AUDIO_TYPES,
	transcribeAudio,
	type SpeechAudio,
} from '../lib/speech-reader.ts'
import { takeVisionReadSlot } from '../lib/vision-read-limit.ts'
import { assertLocationAllowed, badRequest, wireUnit } from './inventory-common.ts'
import {
	loadLocationStock,
	type InventoryCaller,
} from './inventory-items-service.ts'

/**
 * Counting stock by voice (#488). The words come from this node's own speech
 * model (`lib/speech-reader.ts`), the matching runs here against the items of
 * the location, and nothing is written: the answer only proposes lines for a
 * person to confirm. The recording is never stored.
 */

/** Recordings one organization may send an hour (the model costs money). */
const VOICE_PER_HOUR = 120

/** The microphone is offered only with the flag on AND a speech model in this node's region. */
export function voiceCountsAvailable(caller: InventoryCaller): boolean {
	return caller.features?.voiceCounts === true && isSpeechReaderConfigured()
}

function assertVoiceAvailable(caller: InventoryCaller): void {
	if (!caller.features?.voiceCounts) {
		throw new InventoryError('feature_disabled', 403, { feature: 'voiceCounts' })
	}
	if (!isSpeechReaderConfigured()) {
		throw new InventoryError('reader_not_configured', 503)
	}
}

/** The items a person can count at a location, as the parser reads them. */
export async function loadVoiceItems(
	db: InventoryReader,
	locationId: string,
): Promise<VoiceItem[]> {
	const rows = await loadLocationStock(db, locationId)
	const kept = rows.filter((row) => !row.group.isGroup)
	const here = kept.filter((row) => row.place !== null)
	return (here.length > 0 ? here : kept).map((row) => ({
		id: row.item.id,
		name: row.item.name,
		nameAr: row.item.nameAr,
		baseUnit: row.item.baseUnit,
		countUnit: row.place?.countUnit ? wireUnit(row.place.countUnit) : null,
		units: row.units
			.filter((unit) => unit.archivedAt === null)
			.map((unit) => ({ id: unit.id, name: unit.name })),
	}))
}

/** The audio of a request, or 400: a known type and a size the node accepts. */
export function checkAudio(audio: SpeechAudio): SpeechAudio {
	const type = audio.contentType.toLowerCase().split(';')[0]!.trim()
	if (!(SPEECH_AUDIO_TYPES as readonly string[]).includes(type)) {
		throw badRequest('audio_type')
	}
	if (audio.bytes.length === 0) throw badRequest('audio_empty')
	if (audio.bytes.length > VOICE_AUDIO_MAX_BYTES) throw badRequest('audio_too_large')
	return audio
}

/**
 * A recording becomes proposed lines. Answers 503 `reader_not_configured` with
 * no speech model in this node's region, 502 `reader_failed` when the model
 * did not answer; an unclear recording answers no lines and no questions (the
 * person says it again).
 */
export async function proposeFromAudio(
	db: InventoryReader,
	input: {
		caller: InventoryCaller
		locationId: string
		audio: SpeechAudio
		language?: 'en' | 'ar'
		now?: number
	},
): Promise<VoiceProposal> {
	assertVoiceAvailable(input.caller)
	assertLocationAllowed(input.caller.locationIds, input.locationId)
	const audio = checkAudio(input.audio)
	if (!takeVisionReadSlot(`voice:${input.caller.orgId}`, input.now, VOICE_PER_HOUR)) {
		throw new InventoryError('limit_reached', 429)
	}
	const items = await loadVoiceItems(db, input.locationId)
	let transcript: string
	try {
		transcript = await transcribeAudio(audio, {
			vocabulary: items.slice(0, 80).map((item) => item.name),
			language: input.language ?? null,
		})
	} catch {
		throw new InventoryError('reader_failed', 502)
	}
	return parseSpokenCount(transcript, items)
}

/** The same matching for words a person typed or corrected. Needs no speech model. */
export async function proposeFromText(
	db: InventoryReader,
	input: { caller: InventoryCaller; locationId: string; transcript: string },
): Promise<VoiceProposal> {
	if (!input.caller.features?.voiceCounts) {
		throw new InventoryError('feature_disabled', 403, { feature: 'voiceCounts' })
	}
	assertLocationAllowed(input.caller.locationIds, input.locationId)
	return parseSpokenCount(
		input.transcript,
		await loadVoiceItems(db, input.locationId),
	)
}
