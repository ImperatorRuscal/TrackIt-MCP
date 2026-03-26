import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";

export interface TokenRecord {
  ourToken: string;
  username: string;          // for display/logging only — password is NOT stored
  trackItAccessToken: string;
  trackItRefreshToken: string;
  trackItExpiresAt: number;
  issuedAt: number;
  expiresAt: number;
}

const STORE_FILE = join(process.cwd(), "data", "token-store.enc");
const TMP_FILE = STORE_FILE + ".tmp";
const SALT = "trackit-mcp-store";
const ALGORITHM = "aes-256-gcm";

function deriveKey(secret: string): Buffer {
  return scryptSync(secret, SALT, 32) as Buffer;
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decrypt(data: string, key: Buffer): string {
  const [ivHex, authTagHex, ciphertextHex] = data.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export class TokenStore {
  private key: Buffer;
  private records: Map<string, TokenRecord> = new Map();

  constructor(secret: string) {
    this.key = deriveKey(secret);
    this.load();
  }

  private load(): void {
    if (!existsSync(STORE_FILE)) return;
    try {
      const raw = readFileSync(STORE_FILE, "utf8").trim();
      const plaintext = decrypt(raw, this.key);
      const arr: TokenRecord[] = JSON.parse(plaintext);
      const now = Date.now();
      for (const r of arr) {
        if (r.expiresAt > now) {
          this.records.set(r.ourToken, r);
        }
      }
      console.log(`[token-store] loaded ${this.records.size} active sessions`);
    } catch (err) {
      console.warn("[token-store] could not load store (first run or bad key):", (err as Error).message);
    }
  }

  private save(): void {
    mkdirSync(dirname(STORE_FILE), { recursive: true });
    const plaintext = JSON.stringify([...this.records.values()]);
    const encrypted = encrypt(plaintext, this.key);
    writeFileSync(TMP_FILE, encrypted, "utf8");
    try {
      renameSync(TMP_FILE, STORE_FILE);
    } catch (err) {
      // Windows AV/file-locking can cause EPERM on rename when the target exists.
      // Fall back to a direct overwrite — slightly less atomic but safe for our use case.
      writeFileSync(STORE_FILE, encrypted, "utf8");
      try { unlinkSync(TMP_FILE); } catch { /* ignore */ }
      console.warn("[token-store] atomic rename failed, used direct write:", (err as Error).message);
    }
  }

  set(record: TokenRecord): void {
    this.records.set(record.ourToken, record);
    this.save();
  }

  get(ourToken: string): TokenRecord | undefined {
    return this.records.get(ourToken);
  }

  update(ourToken: string, patch: Partial<TokenRecord>): void {
    const existing = this.records.get(ourToken);
    if (!existing) throw new Error("Token not found");
    this.records.set(ourToken, { ...existing, ...patch });
    this.save();
  }

  delete(ourToken: string): void {
    this.records.delete(ourToken);
    this.save();
  }

  prune(): number {
    const now = Date.now();
    let count = 0;
    for (const [token, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(token);
        count++;
      }
    }
    if (count > 0) this.save();
    return count;
  }

  size(): number {
    return this.records.size;
  }
}
