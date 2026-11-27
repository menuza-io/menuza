import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type VoiceProposal } from '@repo/inventory'
import { Icon } from '@repo/ui/icon'
import { useEffect, useRef, useState } from 'react'
import { StockApiError } from './api.ts'
import { BigStepper } from './BigStepper.tsx'
import { formatAmount } from './model.ts'
import { type StockState } from './useStock.ts'
import { Button, Chip, Input, Modal } from '~/ui/primitives.tsx'

/** A recording is cut at this length: the region takes at most 2 MB. */
const MAX_RECORDING_MS = 60_000

export type VoiceLineChoice = {
	itemId: string
	itemName: string
	amount: number
	unit: string
	unitLabel: string
	unitAssumed: boolean
	/** The words heard for this line. */
	heard: string
}

type Phase = 'idle' | 'recording' | 'working' | 'review'

/** Whether this tablet can record at all (otherwise only typing is offered). */
export const canRecord = () =>
	typeof navigator !== 'undefined' &&
	typeof MediaRecorder !== 'undefined' &&
	Boolean(navigator.mediaDevices?.getUserMedia)

/**
 * Counting by voice on Station (#488). The recording is held in memory for the
 * one request and never stored; the region answers PROPOSED lines and nothing
 * is written. The person reads what was heard, fixes an amount, answers a
 * "which one?" and confirms: the confirmed lines go through the same offline
 * count queue as typed ones (`onConfirm`), with the words kept on each entry
 * for the review. Words can be typed when the microphone is not allowed.
 */
export function VoiceCount({
	stock,
	open,
	onClose,
	onConfirm,
}: {
	stock: StockState
	open: boolean
	onClose: () => void
	onConfirm: (lines: VoiceLineChoice[]) => void
}) {
	const { _, i18n } = useLingui()
	const [phase, setPhase] = useState<Phase>('idle')
	const [proposal, setProposal] = useState<VoiceProposal | null>(null)
	const [amounts, setAmounts] = useState<Record<number, number | null>>({})
	const [dropped, setDropped] = useState<ReadonlySet<number>>(new Set())
	const [extra, setExtra] = useState<VoiceLineChoice[]>([])
	const [words, setWords] = useState('')
	const [problem, setProblem] = useState<string | null>(null)
	const recorder = useRef<MediaRecorder | null>(null)
	const chunks = useRef<Blob[]>([])
	const stopTimer = useRef<number | undefined>(undefined)

	const reset = () => {
		setPhase('idle')
		setProposal(null)
		setAmounts({})
		setDropped(new Set())
		setExtra([])
		setWords('')
		setProblem(null)
	}
	const stopStream = () => {
		window.clearTimeout(stopTimer.current)
		recorder.current?.stream.getTracks().forEach((track) => track.stop())
		recorder.current = null
	}
	useEffect(() => {
		if (!open) {
			stopStream()
			reset()
		}
		return stopStream
	}, [open])

	const fail = (caught: unknown) => {
		const code = caught instanceof StockApiError ? caught.code : 'unknown'
		setPhase('idle')
		setProblem(
			code === 'connection_lost'
				? _(t`You are offline. Counting by voice needs the connection.`)
				: code === 'voice_not_available'
					? _(t`Counting by voice is not available here.`)
					: _(t`That did not work. Try again, or type what you counted.`),
		)
	}
	const show = (next: VoiceProposal) => {
		setProposal(next)
		setAmounts({})
		setDropped(new Set())
		setExtra([])
		setWords(next.transcript)
		setPhase('review')
	}

	const start = async () => {
		setProblem(null)
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
			const media = new MediaRecorder(stream)
			chunks.current = []
			media.ondataavailable = (event) => {
				if (event.data.size > 0) chunks.current.push(event.data)
			}
			media.onstop = () => {
				const blob = new Blob(chunks.current, {
					type: media.mimeType || 'audio/webm',
				})
				chunks.current = []
				stream.getTracks().forEach((track) => track.stop())
				setPhase('working')
				stock.api
					.voicePropose(blob, i18n.locale.startsWith('ar') ? 'ar' : 'en')
					.then(show, fail)
			}
			recorder.current = media
			media.start()
			setPhase('recording')
			stopTimer.current = window.setTimeout(
				() => media.state === 'recording' && media.stop(),
				MAX_RECORDING_MS,
			)
		} catch {
			setProblem(
				_(t`The microphone is not allowed. Type what you counted instead.`),
			)
		}
	}
	const finish = () => {
		window.clearTimeout(stopTimer.current)
		if (recorder.current?.state === 'recording') recorder.current.stop()
	}
	const parse = async (text: string) => {
		if (!text.trim()) return
		setPhase('working')
		setProblem(null)
		try {
			show(await stock.api.voiceParse({ transcript: text.trim() }))
		} catch (caught) {
			fail(caught)
		}
	}

	const lines: VoiceLineChoice[] = [
		...(proposal?.lines ?? []).flatMap((line, index) =>
			dropped.has(index)
				? []
				: [
						{
							itemId: line.itemId,
							itemName: line.itemName,
							amount: amounts[index] ?? line.amount,
							unit: line.unit,
							unitLabel: line.unitLabel,
							unitAssumed: line.unitAssumed,
							heard: line.heard,
						},
					],
		),
		...extra,
	]
	const confirmable = lines.filter((line) => line.amount > 0)

	return (
		<Modal
			open={open}
			onClose={() => {
				if (phase !== 'working') onClose()
			}}
			title={_(t`Count by voice`)}
			size="lg"
			footer={
				<>
					<Button variant="secondary" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					{phase === 'review' ? (
						<Button
							variant="primary"
							disabled={confirmable.length === 0}
							onClick={() => {
								onConfirm(confirmable)
								onClose()
							}}
							data-testid="voice-confirm"
						>
							<Trans>Add to the count</Trans>
						</Button>
					) : null}
				</>
			}
		>
			<div className="flex flex-col gap-4" data-testid="voice-count">
				{problem ? (
					<p role="alert" className="notice-danger px-4 py-3 text-sm">
						{problem}
					</p>
				) : null}
				{phase === 'idle' || phase === 'recording' ? (
					<div className="flex flex-col gap-3">
						<p className="text-muted-foreground text-sm">
							<Trans>
								Say what you counted, like "three boxes of tomatoes, two litres
								of milk". You check every line before it is added. The recording
								is not kept.
							</Trans>
						</p>
						{canRecord() ? (
							phase === 'recording' ? (
								<Button variant="primary" size="lg" onClick={finish}>
									<Icon name="square" className="size-5" />
									<Trans>Stop and read it</Trans>
								</Button>
							) : (
								<Button
									variant="primary"
									size="lg"
									onClick={() => void start()}
									disabled={!stock.reachable}
								>
									<Icon name="mic" className="size-5" />
									<Trans>Start recording</Trans>
								</Button>
							)
						) : null}
						<label className="flex flex-col gap-1">
							<span className="text-muted-foreground text-sm">
								<Trans>Or type it</Trans>
							</span>
							<Input
								value={words}
								maxLength={1000}
								onChange={(event) => setWords(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === 'Enter') void parse(words)
								}}
							/>
						</label>
						<Button
							variant="secondary"
							disabled={!words.trim() || phase === 'recording'}
							onClick={() => void parse(words)}
						>
							<Trans>Read it</Trans>
						</Button>
					</div>
				) : null}
				{phase === 'working' ? (
					<p role="status" className="text-base">
						<Trans>Reading what you said…</Trans>
					</p>
				) : null}
				{phase === 'review' && proposal ? (
					<div className="flex flex-col gap-4">
						<label className="flex flex-col gap-1">
							<span className="text-muted-foreground text-sm">
								<Trans>What we heard</Trans>
							</span>
							<Input
								value={words}
								maxLength={1000}
								onChange={(event) => setWords(event.target.value)}
							/>
						</label>
						<Button
							variant="secondary"
							onClick={() => void parse(words)}
							disabled={!words.trim()}
						>
							<Trans>Check it again</Trans>
						</Button>
						{lines.length === 0 && proposal.questions.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								<Trans>Nothing was understood. Try again.</Trans>
							</p>
						) : null}
						<ul className="flex flex-col gap-3">
							{(proposal.lines ?? []).map((line, index) =>
								dropped.has(index) ? null : (
									<li
										key={`${line.itemId}-${index}`}
										className="border-border flex flex-col gap-2 rounded-xl border p-3"
										data-testid={`voice-line-${index}`}
									>
										<div className="flex items-start justify-between gap-2">
											<div className="min-w-0">
												<p className="text-xl font-semibold break-words">
													{line.itemName}
												</p>
												<p className="text-muted-foreground text-sm">
													<bdi dir="ltr">
														{formatAmount(line.amount, i18n.locale)}{' '}
														{line.unitLabel}
													</bdi>
													{line.unitAssumed ? (
														<>
															{' · '}
															<Trans>unit assumed</Trans>
														</>
													) : null}
													{line.match === 'close' ? (
														<>
															{' · '}
															<Trans>close match</Trans>
														</>
													) : null}
												</p>
											</div>
											<Button
												variant="ghost"
												onClick={() =>
													setDropped((before) => new Set([...before, index]))
												}
											>
												<Trans>Remove</Trans>
											</Button>
										</div>
										<BigStepper
											value={amounts[index] ?? line.amount}
											label={line.itemName}
											step={1}
											fractions
											onChange={(next) =>
												setAmounts((before) => ({ ...before, [index]: next }))
											}
										/>
									</li>
								),
							)}
							{extra.map((line, index) => (
								<li
									key={`extra-${index}`}
									className="border-border rounded-xl border p-3"
								>
									<p className="text-xl font-semibold">{line.itemName}</p>
									<p className="text-muted-foreground text-sm">
										<bdi dir="ltr">
											{formatAmount(line.amount, i18n.locale)} {line.unitLabel}
										</bdi>
									</p>
								</li>
							))}
						</ul>
						{proposal.questions.map((question, index) =>
							question.kind === 'which_item' ? (
								<div key={`q-${index}`} className="flex flex-col gap-2">
									<p className="text-base font-medium">
										<Trans>Which one did you mean by “{question.heard}”?</Trans>
									</p>
									<div className="flex flex-wrap gap-2">
										{question.candidates.map((candidate) => (
											<Chip
												key={candidate.itemId}
												selected={false}
												onClick={() =>
													void parse(
														[
															question.amount ?? '',
															question.unitWords ?? '',
															candidate.name,
														]
															.join(' ')
															.trim(),
													)
												}
											>
												{candidate.name}
											</Chip>
										))}
									</div>
								</div>
							) : (
								<div key={`q-${index}`} className="flex flex-col gap-2">
									<p className="text-base font-medium">
										<Trans>
											Which unit for {question.itemName}: “{question.unitWords}
											”?
										</Trans>
									</p>
									<div className="flex flex-wrap gap-2">
										{question.options.map((option) => (
											<Chip
												key={option.ref}
												selected={false}
												onClick={() =>
													setExtra((before) => [
														...before,
														{
															itemId: question.itemId,
															itemName: question.itemName,
															amount: question.amount,
															unit: option.ref,
															unitLabel: option.label,
															unitAssumed: false,
															heard: question.heard,
														},
													])
												}
											>
												{option.label}
											</Chip>
										))}
									</div>
								</div>
							),
						)}
					</div>
				) : null}
			</div>
		</Modal>
	)
}
