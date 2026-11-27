import { Trans, useLingui } from '@lingui/react/macro'
import {
	voiceCapabilitySchema,
	voiceProposalSchema,
	type VoiceProposal,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { useRef, useState } from 'react'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'

/** One line a person confirms: the item, an amount they may change, and one of the item's units. */
export type VoiceDraftLine = {
	key: string
	itemId: string
	itemName: string
	amount: string
	unit: string
	unitLabel: string
	heard: string
	/** The item's units to pick from, when a question asked which one. */
	options: { ref: string; label: string }[] | null
}

/** Lines to start the review from: the proposal's lines, as typed fields. */
export function draftLinesOf(proposal: VoiceProposal): VoiceDraftLine[] {
	return proposal.lines.map((line, index) => ({
		key: `l${index}`,
		itemId: line.itemId,
		itemName: line.itemName,
		amount: String(line.amount),
		unit: line.unit,
		unitLabel: line.unitLabel,
		heard: line.heard,
		options: null,
	}))
}

export function amountOfDraft(line: VoiceDraftLine): number | null {
	const value = Number(line.amount.trim().replace(',', '.'))
	return Number.isFinite(value) && value > 0 ? value : null
}

/** The recording format this browser can make (never stored: it is sent and dropped). */
function recorderMime(): string {
	for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
		if (
			typeof MediaRecorder !== 'undefined' &&
			MediaRecorder.isTypeSupported(type)
		) {
			return type
		}
	}
	return ''
}

/**
 * The microphone on the count screen (#488). Shown only when the organization
 * has the feature AND this region has a speech model (`GET /voice`). It records,
 * sends the recording to the region (never stored), and shows PROPOSED lines to
 * confirm, edit or drop before anything is saved: "Which one?" for a word that
 * matches no item or several, "Which unit?" for a unit the item does not have.
 * Confirmed lines are handed to `onConfirm` and then go through the same entry
 * path as typed ones, with the words kept for the review.
 */
export function VoiceCountButton({
	locationId,
	enabled,
	disabled,
	onConfirm,
}: {
	locationId: string
	enabled: boolean
	disabled?: boolean
	onConfirm: (lines: VoiceDraftLine[], transcript: string) => void
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const capability = useInventoryQuery(
		enabled ? `/voice?${new URLSearchParams({ locationId })}` : null,
		voiceCapabilitySchema,
	)
	const [recording, setRecording] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [proposal, setProposal] = useState<VoiceProposal | null>(null)
	const [lines, setLines] = useState<VoiceDraftLine[]>([])
	const [transcript, setTranscript] = useState('')
	const recorder = useRef<MediaRecorder | null>(null)
	const chunks = useRef<Blob[]>([])

	if (!enabled || !capability.data?.available) return null
	if (typeof navigator === 'undefined' || !navigator.mediaDevices) return null

	async function send(blob: Blob) {
		setBusy(true)
		setError(null)
		try {
			const body = await request(
				`/voice/propose?${new URLSearchParams({ locationId })}`,
				{
					method: 'POST',
					body: blob,
					headers: { 'Content-Type': blob.type || 'audio/webm' },
				},
			)
			const parsed = voiceProposalSchema.parse(body)
			setProposal(parsed)
			setTranscript(parsed.transcript)
			setLines(draftLinesOf(parsed))
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setBusy(false)
		}
	}

	async function toggle() {
		if (recording) {
			recorder.current?.stop()
			return
		}
		setError(null)
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
			const mimeType = recorderMime()
			const next = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
			chunks.current = []
			next.ondataavailable = (event) => {
				if (event.data.size > 0) chunks.current.push(event.data)
			}
			next.onstop = () => {
				for (const track of stream.getTracks()) track.stop()
				setRecording(false)
				const blob = new Blob(chunks.current, {
					type: next.mimeType || mimeType || 'audio/webm',
				})
				chunks.current = []
				if (blob.size > 0) void send(blob)
			}
			recorder.current = next
			next.start()
			setRecording(true)
		} catch {
			setError(t`We could not use the microphone. Check that it is allowed.`)
		}
	}

	async function reread() {
		setBusy(true)
		setError(null)
		try {
			const body = await request('/voice/parse', {
				method: 'POST',
				body: JSON.stringify({ locationId, transcript }),
			})
			const parsed = voiceProposalSchema.parse(body)
			setProposal(parsed)
			setLines(draftLinesOf(parsed))
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setBusy(false)
		}
	}

	const confirmable = lines.filter((line) => amountOfDraft(line) !== null)
	return (
		<>
			<Button
				variant={recording ? 'destructive' : 'outline'}
				size="sm"
				disabled={disabled || busy}
				onClick={() => void toggle()}
				aria-pressed={recording}
				data-testid="count-voice"
			>
				<Icon name="mic" />
				{recording ? <Trans>Stop and read</Trans> : <Trans>Count by voice</Trans>}
			</Button>
			{error && !proposal ? (
				<Alert variant="destructive" data-testid="count-voice-error">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			<Dialog
				open={proposal !== null}
				onOpenChange={(open) => (!open ? setProposal(null) : undefined)}
			>
				<DialogContent
					className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
					data-testid="count-voice-review"
				>
					<DialogHeader>
						<DialogTitle>
							<Trans>Check what we heard</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>
								Nothing is saved until you confirm. Change an amount, drop a
								line, or answer the questions.
							</Trans>
						</DialogDescription>
					</DialogHeader>
					{error ? (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}
					<div className="flex flex-col gap-1.5">
						<label className="text-sm font-medium" htmlFor="voice-transcript">
							<Trans>What we heard</Trans>
						</label>
						<div className="flex gap-2">
							<Input
								id="voice-transcript"
								value={transcript}
								onChange={(event) => setTranscript(event.target.value)}
								data-testid="count-voice-transcript"
							/>
							<Button
								variant="outline"
								size="sm"
								disabled={busy || transcript.trim() === ''}
								onClick={() => void reread()}
								data-testid="count-voice-reread"
							>
								<Trans>Read again</Trans>
							</Button>
						</div>
					</div>
					<ul className="flex flex-col gap-2" data-testid="count-voice-lines">
						{lines.map((line) => (
							<li
								key={line.key}
								className="flex flex-wrap items-center gap-2 rounded-lg border p-2"
							>
								<span className="min-w-0 flex-1 text-sm font-medium wrap-anywhere">
									{line.itemName}
								</span>
								<Input
									className="w-20"
									inputMode="decimal"
									dir="ltr"
									value={line.amount}
									aria-label={t`${line.itemName}, amount`}
									onChange={(event) =>
										setLines((all) =>
											all.map((entry) =>
												entry.key === line.key
													? { ...entry, amount: event.target.value }
													: entry,
											),
										)
									}
									data-testid={`count-voice-amount-${line.key}`}
								/>
								<span className="text-muted-foreground text-sm">
									{line.unitLabel}
								</span>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={t`Remove ${line.itemName}`}
									onClick={() =>
										setLines((all) => all.filter((entry) => entry.key !== line.key))
									}
								>
									<Icon name="x" />
								</Button>
							</li>
						))}
					</ul>
					{proposal?.questions.map((question, index) => (
						<div
							key={index}
							className="flex flex-col gap-2 rounded-lg border border-dashed p-3"
							data-testid="count-voice-question"
						>
							{question.kind === 'which_item' ? (
								<>
									<p className="text-sm">
										<Trans>
											Which one is <span className="font-medium">{question.heard}</span>
											?
										</Trans>
									</p>
									<div className="flex flex-wrap gap-2">
										{question.candidates.map((candidate) => (
											<Button
												key={candidate.itemId}
												variant="outline"
												size="sm"
												disabled={question.amount === null}
												onClick={() => {
													setLines((all) => [
														...all,
														{
															key: `q${index}-${candidate.itemId}`,
															itemId: candidate.itemId,
															itemName: candidate.name,
															amount: String(question.amount ?? ''),
															unit: '',
															unitLabel: question.unitWords ?? '',
															heard: question.heard,
															options: null,
														},
													])
													setProposal((current) =>
														current
															? {
																	...current,
																	questions: current.questions.filter(
																		(_, i) => i !== index,
																	),
																}
															: current,
													)
												}}
												data-testid={`count-voice-pick-${candidate.itemId}`}
											>
												{candidate.name}
											</Button>
										))}
										{question.candidates.length === 0 ? (
											<span className="text-muted-foreground text-xs">
												<Trans>
													No close match. Say it again, or count it by hand.
												</Trans>
											</span>
										) : null}
									</div>
								</>
							) : (
								<>
									<p className="text-sm">
										<Trans>
											Which unit for{' '}
											<span className="font-medium">{question.itemName}</span>?
											"{question.unitWords}" is not one of its units.
										</Trans>
									</p>
									<div className="flex flex-wrap gap-2">
										{question.options.map((option) => (
											<Button
												key={option.ref}
												variant="outline"
												size="sm"
												onClick={() => {
													setLines((all) => [
														...all,
														{
															key: `u${index}-${option.ref}`,
															itemId: question.itemId,
															itemName: question.itemName,
															amount: String(question.amount),
															unit: option.ref,
															unitLabel: option.label,
															heard: question.heard,
															options: question.options,
														},
													])
													setProposal((current) =>
														current
															? {
																	...current,
																	questions: current.questions.filter(
																		(_, i) => i !== index,
																	),
																}
															: current,
													)
												}}
												data-testid={`count-voice-unit-${option.ref}`}
											>
												{option.label}
											</Button>
										))}
									</div>
								</>
							)}
						</div>
					))}
					<DialogFooter>
						<Button variant="ghost" onClick={() => setProposal(null)}>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							disabled={
								confirmable.length === 0 ||
								confirmable.some((line) => line.unit === '')
							}
							onClick={() => {
								onConfirm(confirmable, transcript)
								setProposal(null)
							}}
							data-testid="count-voice-confirm"
						>
							<Trans>Save these counts</Trans>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	)
}
