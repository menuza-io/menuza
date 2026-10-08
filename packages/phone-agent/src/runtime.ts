import {
	type FlowGraph,
	type FlowNode,
	MENU_KEYS,
	type MenuKey,
	type MenuOption,
	outgoingEdges,
} from './flow.ts'
import { wordsOf } from './normalize.ts'

export function findStartNode(graph: FlowGraph) {
	const start = graph.nodes.find((node) => node.type === 'start')
	if (!start) throw new Error('Flow has no start step')
	return start
}

/** The step an output leads to, or null when that output isn't connected. */
export function nextNode(
	graph: FlowGraph,
	nodeId: string,
	handle: string | null = null,
): FlowNode | null {
	const edge = outgoingEdges(graph, nodeId).find(
		(candidate) => (candidate.sourceHandle ?? null) === handle,
	)
	if (!edge) return null
	return graph.nodes.find((node) => node.id === edge.target) ?? null
}

/** DTMF digits arrive as strings; anything else is ignored. */
export function parseMenuKey(value: string): MenuKey | null {
	const key = value.trim()
	return (MENU_KEYS as readonly string[]).includes(key)
		? (key as MenuKey)
		: null
}

/**
 * Placeholder values for fixed lines and step messages. `business` is always
 * set; a vertical can add more (see `PhoneAgentVertical.messageVariables`).
 */
export type MessageVariables = { business: string } & Record<string, string>

/**
 * Fills `{name}` placeholders (case-insensitive) in a step's message.
 * Unknown placeholders are left as written.
 */
export function fillMessage(text: string, variables: MessageVariables) {
	const values = new Map(
		Object.entries(variables).map(([key, value]) => [key.toLowerCase(), value]),
	)
	return text.replace(
		/\{([a-z][a-z0-9_]*)\}/gi,
		(match, name: string) => values.get(name.toLowerCase()) ?? match,
	)
}

// Keys are folded with `wordsOf`, so Arabic entries are written without
// hamza, with ه for ة and ي for ى, and without the definite article.
const NUMBER_WORDS: Record<string, MenuKey> = {
	zero: '0',
	oh: '0',
	one: '1',
	two: '2',
	three: '3',
	four: '4',
	five: '5',
	six: '6',
	seven: '7',
	eight: '8',
	nine: '9',
	star: '*',
	pound: '#',
	hash: '#',
	// Spanish
	cero: '0',
	uno: '1',
	una: '1',
	dos: '2',
	tres: '3',
	cuatro: '4',
	cinco: '5',
	seis: '6',
	siete: '7',
	ocho: '8',
	nueve: '9',
	estrella: '*',
	asterisco: '*',
	numeral: '#',
	almohadilla: '#',
	gato: '#',
	// Arabic cardinals, including common spoken (Gulf/Levantine/Egyptian) forms
	صفر: '0',
	واحد: '1',
	واحده: '1',
	اثنين: '2',
	اثنان: '2',
	اتنين: '2',
	ثنين: '2',
	ثلاثه: '3',
	ثلاث: '3',
	تلاته: '3',
	تلات: '3',
	اربعه: '4',
	اربع: '4',
	خمسه: '5',
	خمس: '5',
	سته: '6',
	ست: '6',
	سبعه: '7',
	سبع: '7',
	ثمانيه: '8',
	ثماني: '8',
	ثمان: '8',
	تمانيه: '8',
	تمنيه: '8',
	تسعه: '9',
	تسع: '9',
	// Arabic ordinals ("الخيار الأول" = the first option)
	اول: '1',
	ثاني: '2',
	ثانيه: '2',
	تاني: '2',
	ثالث: '3',
	ثالثه: '3',
	تالت: '3',
	رابع: '4',
	رابعه: '4',
	خامس: '5',
	خامسه: '5',
	سادس: '6',
	سادسه: '6',
	سابع: '7',
	سابعه: '7',
	ثامن: '8',
	ثامنه: '8',
	تاسع: '9',
	تاسعه: '9',
	نجمه: '*',
	مربع: '#',
	هاش: '#',
}

const STOP_WORDS = new Set([
	'the',
	'and',
	'with',
	'our',
	'for',
	'you',
	'your',
	'from',
	'this',
	'that',
	'want',
	'like',
	'please',
	'would',
	'need',
	'have',
	'can',
	'get',
	'let',
	'about',
	'just',
	'some',
	// Spanish
	'quiero',
	'por',
	'favor',
	'para',
	'con',
	'los',
	'las',
	'una',
	// Arabic (folded): "I want", "please", "number", "option", "can", "from"
	'اريد',
	'ابغي',
	'ابي',
	'عايز',
	'بدي',
	'ممكن',
	'لو',
	'سمحت',
	'رقم',
	'خيار',
	'من',
	'في',
	'علي',
])

function tokenize(text: string) {
	return wordsOf(text)
}

function optionTerms(option: MenuOption) {
	return [
		...tokenize(option.label),
		...(option.keywords ?? []).flatMap((keyword) => tokenize(keyword)),
	].filter((term) => term.length >= 3 && !STOP_WORDS.has(term))
}

/** 2 for an exact word, 1 for a shared stem such as "bookings" and "booking". */
function termScore(spoken: string, term: string) {
	if (spoken === term) return 2
	return Math.min(spoken.length, term.length) >= 4 &&
		(spoken.startsWith(term) || term.startsWith(spoken))
		? 1
		: 0
}

/**
 * Maps what a caller said at a keypad menu to an option key. Words from the
 * option label and keywords win over numbers, so "I want to book two
 * tickets" picks the booking option rather than option 2. Returns null when
 * unsure.
 */
export function matchMenuChoice(
	options: MenuOption[],
	spokenText: string,
): MenuKey | null {
	const spoken = tokenize(spokenText)
	if (!spoken.length || !options.length) return null

	const scores = options.map((option) => {
		const terms = optionTerms(option)
		const hits = spoken.reduce(
			(sum, word) =>
				sum + Math.max(0, ...terms.map((term) => termScore(word, term))),
			0,
		)
		return { key: option.key, hits }
	})
	const best = Math.max(...scores.map((score) => score.hits))
	if (best > 0) {
		const winners = scores.filter((score) => score.hits === best)
		if (winners.length === 1) return winners[0]!.key
	}

	const keys = new Set(options.map((option) => option.key))
	const spokenKeys = new Set(
		spoken
			.map((word) => NUMBER_WORDS[word] ?? parseMenuKey(word))
			.filter((key): key is MenuKey => key !== null && keys.has(key)),
	)
	return spokenKeys.size === 1 ? [...spokenKeys][0]! : null
}
