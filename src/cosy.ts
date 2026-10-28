/**
 * Qoder「cosy」协议原语 —— 自定义 base64、请求签名、RSA/AES 会话、设备指纹。
 *
 * 这里只有**无状态纯函数 + 加密原语**，一行网络调用都没有；流程在 upstream.ts。
 *
 * 协议来源（社区逆向 + 官方产物核对，均为 MIT）：
 *   - dingminhua/dsh-connect-qoder 的 `src/cosy.ts`（本文件的移植来源，逐字节对齐）；
 *   - fengyinxia/qoder2api 的 `qoder_auth.py`（PAT→jobToken 交换、cosy 签名、
 *     自定义 base64、RSA/AES 会话构建，CN 网关实测可用）；
 *   - x_Zhengyuuuui/qoder2api（Go）的 `internal/cosy/*`（同一协议 + 指纹派生 +
 *     CN/Global 双区域端点）。
 *
 * ⚠️ 这份文件里几乎所有常量都是**上游的字节**（字母表、公钥、签名格式、
 * 会话载荷的键序）。它们看起来可以「整理得更整齐」，但每一个都直接决定
 * 网关认不认这个请求 —— 改任何一个字母都会变成 401 `Signature invalid`。
 */
import { createCipheriv, createDecipheriv, createHash, privateDecrypt, publicEncrypt } from 'node:crypto'
import { randomBytes, randomUUID } from 'node:crypto'

/** cosy 自定义 base64 字母表（与 qoder2api 逐字节一致）。 */
const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const CUSTOM_PAD = '$'

const stdToCustom = new Map<string, string>()
const customToStd = new Map<string, string>()
for (let i = 0; i < 64; i += 1) {
  stdToCustom.set(STD_ALPHABET[i]!, CUSTOM_ALPHABET[i]!)
  customToStd.set(CUSTOM_ALPHABET[i]!, STD_ALPHABET[i]!)
}
stdToCustom.set('=', CUSTOM_PAD)
customToStd.set(CUSTOM_PAD, '=')

/**
 * cosy 自定义 base64 编码：标准 base64 → 按 `n/3` 三块重排 → 逐字符换字母表。
 *
 * 重排是 `std.slice(n-a) + std.slice(a, n-a) + std.slice(0, a)`，`a = floor(n/3)`。
 * 这不是「混淆一下」：网关按同样的顺序反解，顺序错一位整段就是乱码。
 */
export function cosyEncode(plaintext: Uint8Array): string {
  const std = Buffer.from(plaintext).toString('base64')
  const n = std.length
  const a = Math.floor(n / 3)
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a)
  let out = ''
  for (const ch of rearranged) {
    const mapped = stdToCustom.get(ch)
    if (mapped === undefined) throw new Error(`cosy encode: char out of alphabet: ${ch}`)
    out += mapped
  }
  return out
}

/** 自定义 base64 解码（{@link cosyEncode} 的逆）。 */
export function cosyDecode(encoded: string): Uint8Array {
  let mapped = ''
  for (const ch of encoded) {
    const std = customToStd.get(ch)
    if (std === undefined) throw new Error(`cosy decode: char out of custom alphabet: ${ch}`)
    mapped += std
  }
  const n = mapped.length
  const a = Math.floor(n / 3)
  const std = mapped.slice(n - a) + mapped.slice(a, n - a) + mapped.slice(0, a)
  return new Uint8Array(Buffer.from(std, 'base64'))
}

/** RFC1123 的当前 UTC 时刻（旧式签名的 `date` 头）。 */
export function currentRfc1123Date(): string {
  return new Date().toUTCString()
}

export function md5Hex(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex')
}

function sha512Base64Url(input: string): string {
  return createHash('sha512').update(input, 'utf8').digest('base64url')
}

const COSY_APPCODE = 'cosy'
/** base64("war, war never changes") —— appcode 的密钥，名字就是这串字面量。 */
const COSY_SECRET_B64 = 'd2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw=='

/** 旧式请求签名（jobToken 交换用）：`md5("cosy&<secret>&<rfc1123date>")`。 */
export function signLegacy(date: string): string {
  return md5Hex(`${COSY_APPCODE}&${COSY_SECRET_B64}&${date}`)
}

/** 网关公钥（客户端用它加密会话临时密钥）。与 qoder2api / Go 克隆一致。 */
const SERVER_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

/** cosy 版本号（客户端身份的一部分，与 qoder2api 实测一致）。 */
const COSY_VERSION = '0.1.43'

/** AES-128-CBC + PKCS7（IV = key，上游如此）。 */
function aesCbcEncrypt(plain: Uint8Array, key: Uint8Array): Uint8Array {
  const iv = key
  const blockSize = 16
  const padLen = blockSize - (plain.length % blockSize)
  const padded = new Uint8Array(plain.length + padLen)
  padded.set(plain)
  padded.fill(padLen, plain.length)
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  return new Uint8Array(Buffer.concat([cipher.update(padded), cipher.final()]))
}

/** AES-CBC 解密（PKCS7）。 */
export function aesCbcDecrypt(encrypted: Uint8Array, key: Uint8Array): Uint8Array {
  const decipher = createDecipheriv('aes-128-cbc', key, key)
  return new Uint8Array(Buffer.concat([decipher.update(encrypted), decipher.final()]))
}

/** RSA PKCS1v1.5 加密（用网关公钥加密会话临时密钥）。 */
function rsaEncrypt(plain: Uint8Array): Uint8Array {
  const out = publicEncrypt({ key: SERVER_PUBKEY_PEM, padding: 1 }, Buffer.from(plain))
  return new Uint8Array(out)
}

/** RSA PKCS1v1.5 解密（只在测试里用；运行时插件没有私钥）。 */
export function rsaDecrypt(encrypted: Uint8Array, privateKeyPem: string): Uint8Array {
  return new Uint8Array(privateDecrypt({ key: privateKeyPem, padding: 1 }, Buffer.from(encrypted)))
}

/** 会话身份（jobToken 交换响应里的用户字段，全部蛇形命名 —— 上游就是这么读的）。 */
export interface CosyAuthIdentity {
  name: string
  aid: string
  uid: string
  yx_uid: string
  organization_id: string
  organization_name: string
  user_type: string
  security_oauth_token: string
  refresh_token: string
}

/** 一次 cosy 会话的全部签名要素。 */
export interface CosySession {
  /** 16 字节临时密钥（随机 hex 的前 16 个字符）。 */
  tempKey: Uint8Array
  /** base64(RSA(tempKey)) —— 每个请求进 `cosy-key` 头。 */
  cosyKey: string
  /** base64(AES(tempKey, identityPayload)) —— 每个 Bearer 的 info 段。 */
  info: string
  identity: CosyAuthIdentity
  machineId: string
  machineToken: string
  machineType: string
}

/** 从 jobToken 响应构建会话身份（字段名见 upstream 的交换实现）。 */
export function identityFromJobToken(jobToken: Record<string, unknown>): CosyAuthIdentity {
  return {
    name: String(jobToken.name ?? ''),
    aid: String(jobToken.id ?? ''),
    uid: String(jobToken.id ?? ''),
    yx_uid: '',
    organization_id: '',
    organization_name: '',
    user_type: String(jobToken.userType ?? 'personal_standard'),
    security_oauth_token: String(jobToken.securityOauthToken ?? ''),
    refresh_token: String(jobToken.refreshToken ?? ''),
  }
}

/** 身份载荷（键序固定：上游按这份 JSON 原样 AES，键序变了密文就变了）。 */
function identityPayload(identity: CosyAuthIdentity): Record<string, string> {
  return {
    name: identity.name,
    aid: identity.aid,
    uid: identity.uid,
    yx_uid: identity.yx_uid,
    organization_id: identity.organization_id,
    organization_name: identity.organization_name,
    user_type: identity.user_type,
    security_oauth_token: identity.security_oauth_token,
    refresh_token: identity.refresh_token,
  }
}

/** 新会话：随机临时密钥 → RSA 得 cosyKey → AES 身份载荷得 info。 */
export function newCosySession(
  identity: CosyAuthIdentity,
  fingerprint: CosyFingerprint,
): CosySession {
  const tempKey = new Uint8Array(Buffer.from(randomBytes(16).toString('hex').slice(0, 16), 'utf8'))
  const cosyKey = Buffer.from(rsaEncrypt(tempKey)).toString('base64')
  const payload = JSON.stringify(identityPayload(identity))
  const info = Buffer.from(aesCbcEncrypt(new Uint8Array(Buffer.from(payload, 'utf8')), tempKey)).toString('base64')
  return {
    tempKey,
    cosyKey,
    info,
    identity,
    machineId: fingerprint.machineId,
    machineToken: fingerprint.machineToken,
    machineType: fingerprint.machineType,
  }
}

/**
 * Bearer 载荷：`{cosyVersion, ideVersion, info, requestId, version}` 的**标准**
 * base64，键按字典序排（上游解析时依赖这个顺序，与 qoder2api 一致）。
 *
 * 注意这里是标准 base64 而不是 {@link cosyEncode} —— 两个编码用在两个不同地方，
 * 混用会得到「签名对、载荷读不出」这种最难查的 401。
 */
export function buildPayloadB64(info: string): string {
  const payload = {
    cosyVersion: COSY_VERSION,
    ideVersion: '',
    info,
    requestId: randomUUID(),
    version: 'v1',
  }
  const sorted = Object.fromEntries(Object.entries(payload).sort(([a], [b]) => (a < b ? -1 : 1)))
  return Buffer.from(JSON.stringify(sorted)).toString('base64')
}

/** 请求签名：`md5(payloadB64 \n cosyKey \n date \n body \n pathWithoutAlgo)`。 */
export function signRequest(payloadB64: string, cosyKey: string, cosyDate: string, body: string, pathSig: string): string {
  return md5Hex(`${payloadB64}\n${cosyKey}\n${cosyDate}\n${body}\n${pathSig}`)
}

/** `Authorization: Bearer COSY.<payloadB64>.<sig>`。 */
export function composeBearer(payloadB64: string, sig: string): string {
  return `Bearer COSY.${payloadB64}.${sig}`
}

/** 签名用的路径：去掉 `/algo` 前缀、丢掉查询串。 */
export function pathSigFrom(fullUrl: string): string {
  let path: string
  try {
    path = new URL(fullUrl).pathname
  } catch {
    path = fullUrl
  }
  return path.startsWith('/algo') ? path.slice('/algo'.length) : path
}

/** 设备指纹（长期稳定）。 */
export interface CosyFingerprint {
  machineId: string
  machineType: string
  machineToken: string
}

/**
 * 派生设备指纹：以账号 UID（还没有 UID 时用凭据本身）为种子单向哈希。
 *
 * 同一个账号每次派生结果必须一致 —— 网关把这三件套当「这台机器」，每次请求都换
 * 一个新身份反而是异常信号。`uid` 未知时用 `cred:<PAT>` 兜底，保证同一凭据稳定。
 */
export function deriveFingerprint(uid: string, credential: string, installSalt?: string): CosyFingerprint {
  const seed = uid !== '' ? uid : `cred:${credential}`
  const salted = installSalt ? `${seed}|salt:${installSalt}` : seed
  return {
    machineId: md5Hex(`machine:${salted}`),
    machineType: md5Hex(`machinetype:${salted}`).slice(0, 18),
    machineToken: sha512Base64Url(`machinetoken:${salted}`).slice(0, 43),
  }
}

export { CUSTOM_PAD }
