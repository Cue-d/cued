/**
 * Transaction signing helpers adapted from mautrix/twitter twittermeow crypto package.
 */

import { createHash, randomInt } from 'node:crypto'

const SDP_TEMPLATE =
  'v=0\r\no=- %d 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\na=extmap-allow-mixed\r\n' +
  'a=msid-semantic: WMS\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=ice-ufrag:%s\r\n' +
  'a=ice-pwd:%s\r\na=ice-options:trickle\r\na=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:' +
  '00:00:00:00:00:00:00:00:00:00:00:00:00\r\na=setup:actpass\r\na=mid:0\r\na=sctp-port:5000\r\na=max-message-size:262144\r\n'

function randomAlpha(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let out = ''
  for (let i = 0; i < length; i++) {
    out += chars[randomInt(0, chars.length)]
  }
  return out
}

function generateSDP(): string {
  // randomInt max range is 2^48 - 1; Number.MAX_SAFE_INTEGER (2^53-1) exceeds it
  const sessionId = randomInt(0, 2 ** 48 - 1)
  return SDP_TEMPLATE.replace('%d', String(sessionId))
    .replace('%s', randomAlpha(4))
    .replace('%s', randomAlpha(24))
}

function makeTSBytes(): { ts: string; tsBytes: Buffer } {
  const ts = Math.floor(Date.now() / 1000) - 1682924400
  const tsBytes = Buffer.alloc(4)
  tsBytes.writeUInt32LE(ts >>> 0, 0)
  return { ts: String(ts), tsBytes }
}

function encodeXor(input: Buffer): Buffer {
  const output = Buffer.alloc(input.length)
  for (let i = 0; i < input.length; i++) {
    output[i] = i === 0 ? input[i] : input[i] ^ input[0]
  }
  return output
}

export function signTransaction(
  animationToken: string,
  verificationToken: string,
  requestUrl: string,
  method: string
): string {
  const verificationTokenBytes = Buffer.from(verificationToken, 'base64')
  if (verificationTokenBytes.length < 9) {
    throw new Error('Invalid verification token')
  }

  const parsedUrl = new URL(requestUrl)
  const { ts, tsBytes } = makeTSBytes()
  // base64 without padding (standard alphabet)
  const salt = Buffer.from([161, 183, 226, 163, 7, 171, 122, 24, 171, 138, 120]).toString('base64').replace(/=+$/, '')

  const hashInput = `${method.toUpperCase()}!${parsedUrl.pathname}!${ts}${salt}${animationToken}`
  const rawHash = createHash('sha256').update(hashInput).digest()

  const sdp = generateSDP()
  const sdpHash = Buffer.from([
    sdp.charCodeAt(verificationTokenBytes[5] % 8),
    sdp.charCodeAt(verificationTokenBytes[8] % 8),
  ])

  const hash = Buffer.concat([rawHash, sdpHash])
  const randomPrefix = Buffer.from([randomInt(0, 256)])
  const resultBytes = Buffer.concat([
    randomPrefix,
    verificationTokenBytes,
    tsBytes,
    hash.subarray(0, 16),
    Buffer.from([3]),
  ])

  return encodeXor(resultBytes).toString('base64').replace(/=+$/, '')
}

const TOTAL_TIME = 4096

function roundPositive(num: number): number {
  return Math.trunc(num + Math.sign(num) * 0.5)
}

function toFixed(num: number, precision: number): number {
  const output = 10 ** precision
  return roundPositive(num * output) / output
}

function mapValueToRange(value: number, min: number, max: number): number {
  return (value * (max - min)) / 255 + min
}

/** Returns 0 for even indices, -1 for odd (used as range min in mapValueToRange). */
function oddNegation(index: number): number {
  return index % 2 === 1 ? -1 : 0
}

function bezierCurve(a: number, b: number, m: number): number {
  return 3 * a * (1 - m) * (1 - m) * m + 3 * b * (1 - m) * m * m + m * m * m
}

class Cubic {
  constructor(private curves: [number, number, number, number]) {}

  getValue(time: number): number {
    let startGradient = 0
    let endGradient = 0

    if (time <= 0) {
      if (this.curves[0] > 0) {
        startGradient = this.curves[1] / this.curves[0]
      } else if (this.curves[1] === 0 && this.curves[2] > 0) {
        startGradient = this.curves[3] / this.curves[2]
      }
      return startGradient * time
    }

    if (time >= 1) {
      if (this.curves[2] < 1) {
        endGradient = (this.curves[3] - 1) / (this.curves[2] - 1)
      } else if (this.curves[2] === 1 && this.curves[0] < 1) {
        endGradient = (this.curves[1] - 1) / (this.curves[0] - 1)
      }
      return 1 + endGradient * (time - 1)
    }

    let start = 0
    let end = 1
    let mid = 0
    for (let i = 0; i < 100; i++) {
      mid = (start + end) / 2
      const xEst = bezierCurve(this.curves[0], this.curves[2], mid)
      if (Math.abs(time - xEst) < 0.00001) {
        return bezierCurve(this.curves[1], this.curves[3], mid)
      }
      if (xEst < time) {
        start = mid
      } else {
        end = mid
      }
    }
    return bezierCurve(this.curves[1], this.curves[3], mid)
  }
}

function interpolate(from: number[], to: number[], f: number): number[] {
  return from.map((value, index) => value * (1 - f) + to[index] * f)
}

function convertRotationToMatrix(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  return [c, s, -s, c, 0, 0]
}

function floatToHex(value: number): string {
  let quotient = Math.trunc(value)
  let fraction = value - quotient
  let result = quotient.toString(16)

  if (fraction === 0) {
    return result
  }

  const MAX_HEX_DIGITS = 16
  for (let i = 0; fraction > 0 && i < MAX_HEX_DIGITS; i++) {
    fraction *= 16
    quotient = Math.trunc(fraction)
    result += quotient.toString(16)
    fraction -= quotient
  }

  return result
}

function generateAnimationStateWithParams(row: number[], animationTime: number): string {
  if (animationTime >= TOTAL_TIME - 1) {
    return '000'
  }

  const fromColor = [row[0], row[1], row[2], 1]
  const toColor = [row[3], row[4], row[5], 1]
  const fromRotation = [0]
  const toRotation = [Math.floor(mapValueToRange(row[6], 60, 360))]
  const curves = row.slice(7, 11).map((value, index) =>
    toFixed(mapValueToRange(value, oddNegation(index), 1), 2)
  ) as [number, number, number, number]

  const cubic = new Cubic(curves)
  const value = cubic.getValue((Math.round(animationTime / 10) * 10) / TOTAL_TIME)

  const color = interpolate(fromColor, toColor, value)
  const rotation = interpolate(fromRotation, toRotation, value)
  const matrix = convertRotationToMatrix(rotation[0])

  const colorHex = color.slice(0, 3).map((c) => Math.max(0, Math.round(c)).toString(16))
  const matrixHex = matrix.slice(0, 4).map((m) => floatToHex(Math.abs(toFixed(m, 2))))

  return [...colorHex, ...matrixHex, '0', '0'].join('')
}

export function generateAnimationState(
  variableIndexes: [number, number, number, number] | null,
  loadingAnimations: number[][][] | null,
  verificationToken: string
): string {
  if (!variableIndexes || !loadingAnimations || loadingAnimations.length === 0 || !verificationToken) {
    return ''
  }

  const tokenBytes = Buffer.from(verificationToken, 'base64')
  if (tokenBytes.length < 9) return ''

  // Select SVG and row based on verification token bytes
  const svgIndex = tokenBytes[5] % 4
  const svgData = loadingAnimations[svgIndex]
  if (!svgData || svgData.length === 0) return ''

  const rowIndex = tokenBytes[variableIndexes[0]] % 16
  const row = svgData[rowIndex]
  if (!row || row.length < 11) return ''

  const animationTime =
    (tokenBytes[variableIndexes[1]] % 16) *
    (tokenBytes[variableIndexes[2]] % 16) *
    (tokenBytes[variableIndexes[3]] % 16)

  return generateAnimationStateWithParams(row, animationTime)
}
