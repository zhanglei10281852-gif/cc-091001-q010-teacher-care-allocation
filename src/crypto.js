// 敏感说明的加密保管：与排队数据物理分离（独立目录、独立文件）。
// 使用 AES-256-GCM（认证加密），密钥由密钥短语经 scrypt 派生，
// 或直接接收 32 字节原始密钥（受控环境注入）。明文绝不进入排队库、日志或教师之外的视图。

import { randomBytes, scryptSync, createCipheriv, createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const KEY_LEN = 32;
const IV_LEN = 12; // GCM 推荐 12 字节
const TAG_LEN = 16;

export function deriveKey(passphrase, salt) {
  return scryptSync(Buffer.from(passphrase, 'utf8'), salt, KEY_LEN, { N: 16384, r: 8, p: 1 });
}

// 32 字节原始密钥，或 { passphrase } 派生。
export class CryptoVault {
  constructor(keyMaterial) {
    if (Buffer.isBuffer(keyMaterial) && keyMaterial.length === KEY_LEN) {
      this.key = keyMaterial;
    } else if (keyMaterial && typeof keyMaterial.passphrase === 'string') {
      // 固定盐仅用于本地开发/测试；生产必须注入原始密钥。
      this.key = deriveKey(keyMaterial.passphrase, keyMaterial.salt ?? 'teacher-care-vault');
    } else {
      throw new Error('vault-requires-32-byte-key-or-passphrase');
    }
  }

  encrypt(plaintext, aad) {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // v1 版本前缀，便于将来轮换算法。
    return 'v1:' + Buffer.concat([iv, tag, ct]).toString('base64');
  }

  decrypt(payload, aad) {
    if (typeof payload !== 'string' || !payload.startsWith('v1:')) throw new Error('bad-ciphertext-format');
    const buf = Buffer.from(payload.slice(3), 'base64');
    if (buf.length < IV_LEN + TAG_LEN) throw new Error('bad-ciphertext');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}

// 教师身份在排队库中只保留不可逆指纹（SHA-256），
// 使排队视图无法还原“是谁”，而同一教师重复申请仍可被识别。
export function hashTeacherRef(teacherRef) {
  return createHash('sha256').update('teacher-ref:').update(teacherRef).digest('hex');
}

export function constantTimeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// 敏感说明仓库：每个申请一份独立密文文件，文件名用申请 id（本身是不透明编号）。
export class SensitiveStore {
  constructor(dir, vault, { fs = { readFile, writeFile, mkdir, rm } } = {}) {
    this.dir = dir;
    this.vault = vault;
    this.fs = fs;
  }

  _file(applicationId) {
    if (!/^[A-Z0-9-]+$/.test(applicationId)) throw new Error('bad-application-id');
    return path.join(this.dir, `${applicationId}.note.enc`);
  }

  async put(applicationId, notePlain) {
    await this.fs.mkdir(this.dir, { recursive: true });
    const envelope = {
      schema: 'sensitive-note/v1',
      applicationId,
      ciphertext: this.vault.encrypt(notePlain, applicationId),
    };
    await this.fs.writeFile(this._file(applicationId), JSON.stringify(envelope), 'utf8');
  }

  async get(applicationId) {
    const raw = await this.fs.readFile(this._file(applicationId), 'utf8');
    const envelope = JSON.parse(raw);
    if (envelope.schema !== 'sensitive-note/v1' || envelope.applicationId !== applicationId) {
      throw new Error('sensitive-envelope-mismatch');
    }
    return this.vault.decrypt(envelope.ciphertext, applicationId);
  }

  async delete(applicationId) {
    // 撤回/关闭后销毁密文；删除失败不阻断流程，但向上抛出由调用方决定。
    await this.fs.rm?.(this._file(applicationId), { force: true });
  }
}
