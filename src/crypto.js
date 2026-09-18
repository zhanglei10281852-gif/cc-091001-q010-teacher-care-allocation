import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// 敏感说明信封加密（AES-256-GCM）。密文与排队数据分离存放，
// 任何排队、查询、审计结构中都只出现“是否存在说明”的标记，不出现明文。
export class SensitiveBox {
  constructor({ masterKey, keyId = 'dev-1' }) {
    if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
      throw new Error('masterKey 必须是 32 字节 Buffer');
    }
    this.masterKey = masterKey;
    this.keyId = keyId;
  }

  // 密钥只能来自受控环境（CARE_MASTER_KEY，hex 或 base64 编码的 32 字节）。
  // 未配置时生成临时密钥并告警，仅供开发/测试，重启后历史密文不可解。
  static fromEnv(env = process.env, warn = () => {}) {
    const raw = env.CARE_MASTER_KEY;
    if (raw) {
      const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
      if (buf.length !== 32) throw new Error('CARE_MASTER_KEY 必须是 32 字节（hex 或 base64）');
      return new SensitiveBox({ masterKey: buf, keyId: env.CARE_KEY_ID || 'env-1' });
    }
    warn('CARE_MASTER_KEY 未设置，已生成临时密钥（仅用于开发/测试）');
    return new SensitiveBox({ masterKey: randomBytes(32), keyId: 'ephemeral-1' });
  }

  seal(plaintext) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return {
      v: 1,
      alg: 'aes-256-gcm',
      keyId: this.keyId,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
  }

  open(payload) {
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(payload.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}
