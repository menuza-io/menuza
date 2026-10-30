/** A plain sRGB color with every channel and alpha in `0...1`. */
export interface RgbaColor {
	readonly red: number
	readonly green: number
	readonly blue: number
	readonly alpha: number
}

function sanitizeComponent(value: number): number {
	if (!Number.isFinite(value)) return 0
	return Math.min(Math.max(value, 0), 1)
}

export function rgba(
	red: number,
	green: number,
	blue: number,
	alpha = 1,
): RgbaColor {
	return {
		red: sanitizeComponent(red),
		green: sanitizeComponent(green),
		blue: sanitizeComponent(blue),
		alpha: sanitizeComponent(alpha),
	}
}

export const BLACK: RgbaColor = rgba(0, 0, 0)
export const WHITE: RgbaColor = rgba(1, 1, 1)

export const NAMED_COLORS: Readonly<Record<string, RgbaColor>> = {
	transparent: rgba(0, 0, 0, 0),
	white: WHITE,
	black: BLACK,
	red: rgba(1, 0, 0),
	green: rgba(0, 0.5019607843, 0),
	blue: rgba(0, 0, 1),
	gray: rgba(0.5019607843, 0.5019607843, 0.5019607843),
	grey: rgba(0.5019607843, 0.5019607843, 0.5019607843),
	silver: rgba(0.7529411765, 0.7529411765, 0.7529411765),
	orange: rgba(1, 0.6470588235, 0),
	purple: rgba(0.5019607843, 0, 0.5019607843),
	yellow: rgba(1, 1, 0),
}

export function colorsEqual(first: RgbaColor, second: RgbaColor): boolean {
	return (
		first.red === second.red &&
		first.green === second.green &&
		first.blue === second.blue &&
		first.alpha === second.alpha
	)
}

export function withAlpha(color: RgbaColor, alpha: number): RgbaColor {
	return rgba(color.red, color.green, color.blue, alpha)
}

export function mixColors(
	color: RgbaColor,
	other: RgbaColor,
	amount: number,
): RgbaColor {
	const ratio = Math.min(Math.max(amount, 0), 1)
	return rgba(
		color.red + (other.red - color.red) * ratio,
		color.green + (other.green - color.green) * ratio,
		color.blue + (other.blue - color.blue) * ratio,
		color.alpha + (other.alpha - color.alpha) * ratio,
	)
}

/** WCAG relative luminance. */
export function relativeLuminance(color: RgbaColor): number {
	const channel = (value: number) =>
		value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)
	return (
		0.2126 * channel(color.red) +
		0.7152 * channel(color.green) +
		0.0722 * channel(color.blue)
	)
}

export function isLightColor(color: RgbaColor): boolean {
	return relativeLuminance(color) > 0.5
}

export function contrastRatio(color: RgbaColor, other: RgbaColor): number {
	const first = Math.max(relativeLuminance(color), relativeLuminance(other))
	const second = Math.min(relativeLuminance(color), relativeLuminance(other))
	return (first + 0.05) / (second + 0.05)
}

function hexByte(value: number): string {
	const scaled = Math.round(value * 255)
	return Math.min(Math.max(scaled, 0), 255).toString(16).padStart(2, '0')
}

/** Opaque `#rrggbb`; alpha is dropped. */
export function toHexString(color: RgbaColor): string {
	return `#${hexByte(color.red)}${hexByte(color.green)}${hexByte(color.blue)}`
}

/** `#rrggbb` when opaque at 8-bit precision, otherwise `#rrggbbaa`. */
export function toCssHexString(color: RgbaColor): string {
	const alpha = hexByte(color.alpha)
	return alpha === 'ff' ? toHexString(color) : `${toHexString(color)}${alpha}`
}

const DECIMAL_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i
const HEX_NUMBER =
	/^([+-]?)0x((?:[0-9a-f]+\.?[0-9a-f]*|\.[0-9a-f]+))(?:p([+-]?\d+))?$/i
const SPECIAL_NUMBER = /^([+-]?)(?:(s?nan)(?:\([0-9a-z_]*\))?|(inf|infinity))$/i

function parseHexFloat(sign: string, digits: string, exponent?: string) {
	const [whole = '', fraction = ''] = digits.split('.')
	let value = 0
	for (const digit of whole) value = value * 16 + parseInt(digit, 16)
	let scale = 1 / 16
	for (const digit of fraction) {
		value += parseInt(digit, 16) * scale
		scale /= 16
	}
	value *= Math.pow(2, exponent ? Number(exponent) : 0)
	return sign === '-' ? -value : value
}

/**
 * Parses a number the way Swift's `Double(String)` does: the whole string must
 * be a decimal or hexadecimal float, `nan` or `inf`/`infinity` (no surrounding
 * whitespace), and a finite literal that overflows or underflows to zero is
 * rejected rather than rounded.
 */
export function parseSwiftDouble(text: string): number | null {
	const special = SPECIAL_NUMBER.exec(text)
	if (special) {
		if (special[2]) return NaN
		return special[1] === '-' ? -Infinity : Infinity
	}
	let value: number
	let mantissa: string
	const hex = HEX_NUMBER.exec(text)
	if (hex) {
		mantissa = hex[2] ?? ''
		value = parseHexFloat(hex[1] ?? '', mantissa, hex[3])
	} else if (DECIMAL_NUMBER.test(text)) {
		mantissa = text.split(/e/i)[0] ?? ''
		value = Number(text)
	} else {
		return null
	}
	if (!Number.isFinite(value)) return null
	if (value === 0 && /[1-9a-f]/i.test(mantissa)) return null
	return value
}

// MARK: - CSS parsing

/**
 * Parses the color formats the organization theme compiler emits: hex,
 * `rgb()`, `hsl()`, `oklch()`, `oklab()` and a few named colors. Anything else
 * (for example relative color syntax such as
 * `oklch(from var(--destructive) min(l, 0.42) c h)`) returns `null` so the
 * caller keeps its fallback token.
 */
export function parseCssColor(cssValue: string): RgbaColor | null {
	const value = cssValue.trim().toLowerCase()
	if (value === '') return null
	if (value.startsWith('#')) return fromHex(value)
	if (value.startsWith('rgb')) return fromFunctional(value, 'rgb')
	if (value.startsWith('hsl')) return fromHsl(value)
	if (value.startsWith('oklch(')) return fromOklch(value)
	if (value.startsWith('oklab(')) return fromOklab(value)
	return Object.prototype.hasOwnProperty.call(NAMED_COLORS, value)
		? (NAMED_COLORS[value] ?? null)
		: null
}

function fromHex(value: string): RgbaColor | null {
	const digits = value.slice(1)
	if (!/^[0-9a-f]*$/.test(digits)) return null
	const component = (text: string) => parseInt(text, 16) / 255
	const at = (index: number) => digits.charAt(index)

	switch (digits.length) {
		case 3:
		case 4:
			return rgba(
				component(at(0) + at(0)),
				component(at(1) + at(1)),
				component(at(2) + at(2)),
				digits.length === 4 ? component(at(3) + at(3)) : 1,
			)
		case 6:
		case 8:
			return rgba(
				component(at(0) + at(1)),
				component(at(2) + at(3)),
				component(at(4) + at(5)),
				digits.length === 8 ? component(at(6) + at(7)) : 1,
			)
		default:
			return null
	}
}

const SPACES_AND_TABS = /^[\t\p{Zs}]+|[\t\p{Zs}]+$/gu

/** Splits `rgb(1 2 3 / 40%)` or `rgb(1, 2, 3, 0.4)` into components. */
function splitFunction(
	value: string,
	prefix: string,
): { components: string[]; alpha: string | null } | null {
	const open = value.indexOf('(')
	if (open < 0 || !value.endsWith(')')) return null
	if (!value.startsWith(prefix)) return null
	const inner = value.slice(open + 1, -1)
	const body = inner.replaceAll(',', ' ')
	// Swift's `split` drops empty pieces, so `rgb(/ 1 2 3)` keeps `1 2 3`.
	const parts = body.split('/').filter((part) => part !== '')
	const first = parts[0]
	if (first === undefined) return null
	const alpha =
		parts.length > 1 ? (parts[1] ?? '').replace(SPACES_AND_TABS, '') : null
	const components = first.split(/[ \t]/).filter((part) => part !== '')
	return { components, alpha }
}

function componentValue(text: string, scale: number): number | null {
	const value = text.endsWith('%')
		? divide(parseSwiftDouble(text.slice(0, -1)), 100)
		: divide(parseSwiftDouble(text), scale)
	if (value === null || !Number.isFinite(value)) return null
	return value
}

function divide(value: number | null, by: number): number | null {
	return value === null ? null : value / by
}

/**
 * `null` when an explicit alpha is present but unparsable, so the caller keeps
 * its fallback token instead of silently rendering an opaque color.
 */
function alphaValue(text: string | null | undefined): number | null {
	if (text === null || text === undefined || text === '') return 1
	const value = text.endsWith('%')
		? divide(parseSwiftDouble(text.slice(0, -1)), 100)
		: parseSwiftDouble(text)
	if (value === null || !Number.isFinite(value)) return null
	return value
}

function fromFunctional(value: string, prefix: string): RgbaColor | null {
	const split = splitFunction(value, prefix)
	if (!split || split.components.length < 3) return null
	const [redText = '', greenText = '', blueText = '', legacyAlpha] =
		split.components
	const red = componentValue(redText, 255)
	const green = componentValue(greenText, 255)
	const blue = componentValue(blueText, 255)
	if (red === null || green === null || blue === null) return null
	const alpha = alphaValue(split.alpha ?? legacyAlpha ?? null)
	if (alpha === null) return null
	return rgba(red, green, blue, alpha)
}

function fromHsl(value: string): RgbaColor | null {
	const split = splitFunction(value, 'hsl')
	if (!split || split.components.length < 3) return null
	const [hueText = '', saturationText = '', lightnessText = '', legacyAlpha] =
		split.components
	const hue = parseSwiftDouble(hueText.replaceAll('deg', ''))
	const saturation = componentValue(saturationText, 100)
	const lightness = componentValue(lightnessText, 100)
	if (hue === null || saturation === null || lightness === null) return null
	const alpha = alphaValue(split.alpha ?? legacyAlpha ?? null)
	if (alpha === null) return null
	return fromHslComponents(hue, saturation, lightness, alpha)
}

export function fromHslComponents(
	hue: number,
	saturation: number,
	lightness: number,
	alpha = 1,
): RgbaColor {
	const hueDegrees = hue % 360
	const normalizedHue = hueDegrees < 0 ? hueDegrees + 360 : hueDegrees
	const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
	const secondary = chroma * (1 - Math.abs(((normalizedHue / 60) % 2) - 1))
	const match = lightness - chroma / 2

	let rgb: [number, number, number]
	if (normalizedHue >= 0 && normalizedHue < 60) rgb = [chroma, secondary, 0]
	else if (normalizedHue >= 60 && normalizedHue < 120)
		rgb = [secondary, chroma, 0]
	else if (normalizedHue >= 120 && normalizedHue < 180)
		rgb = [0, chroma, secondary]
	else if (normalizedHue >= 180 && normalizedHue < 240)
		rgb = [0, secondary, chroma]
	else if (normalizedHue >= 240 && normalizedHue < 300)
		rgb = [secondary, 0, chroma]
	else rgb = [chroma, 0, secondary]

	return rgba(rgb[0] + match, rgb[1] + match, rgb[2] + match, alpha)
}

/** `oklch(0.205 0 0)` / `oklch(62.3% 0.214 259.815)` / `oklch(1 0 0 / 50%)`. */
function fromOklch(value: string): RgbaColor | null {
	if (value.includes('from ')) return null
	const split = splitFunction(value, 'oklch')
	if (!split || split.components.length < 3) return null
	const [lightnessText = '', chromaText = '', hueText = ''] = split.components
	const lightness = componentValue(lightnessText, 1)
	if (lightness === null) return null
	const chroma = parseSwiftDouble(chromaText)
	if (chroma === null || !Number.isFinite(chroma)) return null
	const alpha = alphaValue(split.alpha)
	if (alpha === null) return null
	const hueValue = hueText.replaceAll('deg', '')
	let hue: number
	if (hueValue === 'none') {
		hue = 0
	} else {
		const parsedHue = parseSwiftDouble(hueValue)
		// An unparsable hue would silently become red; let the caller fall back.
		if (parsedHue === null || !Number.isFinite(parsedHue)) return null
		hue = parsedHue
	}
	return fromOklchComponents(lightness, chroma, hue, alpha)
}

function fromOklab(value: string): RgbaColor | null {
	const split = splitFunction(value, 'oklab')
	if (!split || split.components.length < 3) return null
	const [lightnessText = '', aText = '', bText = ''] = split.components
	const lightness = componentValue(lightnessText, 1)
	const a = parseSwiftDouble(aText)
	const b = parseSwiftDouble(bText)
	const alpha = alphaValue(split.alpha)
	if (
		lightness === null ||
		a === null ||
		!Number.isFinite(a) ||
		b === null ||
		!Number.isFinite(b) ||
		alpha === null
	) {
		return null
	}
	return fromOklabComponents(lightness, a, b, alpha)
}

/** OKLCH → OKLab → linear sRGB → sRGB (Björn Ottosson's matrices). */
export function fromOklchComponents(
	lightness: number,
	chroma: number,
	hue: number,
	alpha = 1,
): RgbaColor {
	const hueRadians = (hue * Math.PI) / 180
	return fromOklabComponents(
		lightness,
		chroma * Math.cos(hueRadians),
		chroma * Math.sin(hueRadians),
		alpha,
	)
}

export function fromOklabComponents(
	lightness: number,
	a: number,
	b: number,
	alpha = 1,
): RgbaColor {
	const long = Math.pow(lightness + 0.3963377774 * a + 0.2158037573 * b, 3)
	const medium = Math.pow(lightness - 0.1055613458 * a - 0.0638541728 * b, 3)
	const short = Math.pow(lightness - 0.0894841775 * a - 1.291485548 * b, 3)

	const linearRed =
		4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short
	const linearGreen =
		-1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short
	const linearBlue =
		-0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short

	const gamma = (value: number) =>
		value <= 0.0031308
			? 12.92 * value
			: 1.055 * Math.pow(Math.max(value, 0), 1 / 2.4) - 0.055

	return rgba(gamma(linearRed), gamma(linearGreen), gamma(linearBlue), alpha)
}
