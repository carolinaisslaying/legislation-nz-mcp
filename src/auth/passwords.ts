/**
 * Password hashing for the login page (scrypt, from node:crypto).
 *
 * Encoded as `scrypt.N.r.p.<salt>.<hash>` with base64url salt and hash. The
 * format has no `$`, `:` or `,`, so it survives Docker Compose interpolation
 * and fits in LEGISLATION_AUTH_USERS (`user:hash,user:hash`).
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash, type ScryptOptions } from "node:crypto";

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const MAX_MEM = 64 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCallback(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEM });
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join(".");
}

/** True when the string is a hash in the format hashPassword produces. */
export function isPasswordHash(encoded: string): boolean {
  return /^scrypt\.\d+\.\d+\.\d+\.[\w-]+\.[\w-]+$/.test(encoded);
}

/** Constant-time check of a password against an encoded hash. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (!isPasswordHash(encoded)) return false;
  const [, n, r, p, saltText, keyText] = encoded.split(".");
  const expected = Buffer.from(keyText, "base64url");
  const key = await scrypt(password, Buffer.from(saltText, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAX_MEM,
  });
  return timingSafeEqual(key, expected);
}

/**
 * A hash to check against when the username is unknown, so a wrong username
 * takes as long as a wrong password and does not reveal which accounts exist.
 */
let dummyHash: Promise<string> | undefined;
export function unknownUserHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyHash;
}

/**
 * Identifies a user's current password without revealing it. Stored with
 * each login, so changing or removing a password ends that user's logins.
 */
export function passwordFingerprint(encoded: string): string {
  return createHash("sha256").update(encoded).digest("base64url").slice(0, 22);
}
