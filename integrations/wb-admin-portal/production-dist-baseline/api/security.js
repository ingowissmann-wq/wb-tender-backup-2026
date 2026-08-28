import crypto from "node:crypto";
import argon2 from "argon2";
const pepper = () => process.env.SESSION_PEPPER || "";
export const randomToken = () => crypto.randomBytes(32).toString("base64url");
export const hashToken = (value) => crypto.createHmac("sha256", pepper()).update(value).digest("hex");
export const hashValue = (value) => crypto.createHash("sha256").update(value).digest("hex");
export const passwordHash = (value) => argon2.hash(value, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
export const passwordVerify = (hash, value) => argon2.verify(hash, value);
export function safeEqual(a, b) { const x = Buffer.from(hashValue(a)), y = Buffer.from(hashValue(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
export function ipPrefix(ip) { if (ip.includes(":"))
    return ip.split(":").slice(0, 4).join(":"); return ip.split(".").slice(0, 3).join("."); }
const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function encryptionKey() { const value = process.env.FIELD_ENCRYPTION_KEY || ""; if (!/^[0-9a-f]{64}$/i.test(value))
    throw new Error("FIELD_ENCRYPTION_KEY must be 32-byte hex"); return Buffer.from(value, "hex"); }
export function encryptSecret(value) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv), encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url"); }
export function decryptSecret(value) { const data = Buffer.from(value, "base64url"), iv = data.subarray(0, 12), tag = data.subarray(12, 28), encrypted = data.subarray(28), decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"); }
export function generateTotpSecret() { const bytes = crypto.randomBytes(20); let bits = ""; for (const byte of bytes)
    bits += byte.toString(2).padStart(8, "0"); let result = ""; for (let i = 0; i < bits.length; i += 5)
    result += base32Alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)]; return result; }
function decodeBase32(value) { let bits = ""; for (const char of value.toUpperCase().replace(/=+$/, "")) {
    const index = base32Alphabet.indexOf(char);
    if (index < 0)
        throw new Error("invalid base32");
    bits += index.toString(2).padStart(5, "0");
} const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(bytes); }
function totpAt(secret, counter) { const buffer = Buffer.alloc(8); buffer.writeBigUInt64BE(BigInt(counter)); const digest = crypto.createHmac("sha1", decodeBase32(secret)).update(buffer).digest(), offset = digest[digest.length - 1] & 15, number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000; return String(number).padStart(6, "0"); }
export function verifyTotp(secret, token, now = Date.now()) { if (!/^\d{6}$/.test(token))
    return false; const counter = Math.floor(now / 30000); return [-1, 0, 1].some(window => safeEqual(totpAt(secret, counter + window), token)); }
