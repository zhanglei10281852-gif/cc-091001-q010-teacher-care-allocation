// 加密保管与身份指纹测试：AES-256-GCM 往返、篡改即失败、AAD 绑定申请号、
// 敏感存储与排队存储分离、教师指纹不可逆且稳定。

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { CryptoVault, SensitiveStore, hashTeacherRef } from '../src/crypto.js';

function memFs() {
  const files = new Map();
  return {
    files,
    async readFile(f) {
      if (!files.has(f)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(f);
    },
    async writeFile(f, c) {
      files.set(f, c);
    },
    async mkdir() {},
    async rm(f) {
      files.delete(f);
    },
  };
}

test('AES-256-GCM 加解密往返，且密文随机不重复', () => {
  const vault = new CryptoVault(randomBytes(32));
  const a = vault.encrypt('敏感说明', 'CARE-001');
  const b = vault.encrypt('敏感说明', 'CARE-001');
  assert.notEqual(a, b); // 随机 IV
  assert.equal(vault.decrypt(a, 'CARE-001'), '敏感说明');
  assert.equal(vault.decrypt(b, 'CARE-001'), '敏感说明');
});

test('密文被篡改或 AAD 不符时解密失败', () => {
  const vault = new CryptoVault(randomBytes(32));
  const payload = vault.encrypt('秘密', 'CARE-001');
  // 篡改末位
  const tampered = payload.slice(0, -2) + (payload.endsWith('A') ? 'B' : 'A');
  assert.throws(() => vault.decrypt(tampered, 'CARE-001'));
  // 用别的申请号作为 AAD
  assert.throws(() => vault.decrypt(payload, 'CARE-002'));
  // 错误密钥
  const other = new CryptoVault(randomBytes(32));
  assert.throws(() => other.decrypt(payload, 'CARE-001'));
});

test('SensitiveStore 落盘内容不含明文，且信封绑定申请号', async () => {
  const fs = memFs();
  const store = new SensitiveStore('/sensitive', new CryptoVault(randomBytes(32)), { fs });
  await store.put('CARE-001', '家庭隐私 XYZ');
  const [file, content] = [...fs.files.entries()][0];
  assert.match(file, /CARE-001\.note\.enc$/);
  assert.ok(!content.includes('家庭隐私'));
  assert.ok(!content.includes('XYZ'));
  assert.equal(await store.get('CARE-001'), '家庭隐私 XYZ');
  // 把信封里的申请号改成别的 → 拒绝解密
  const envelope = JSON.parse(content);
  envelope.applicationId = 'CARE-002';
  fs.files.set(file, JSON.stringify(envelope));
  await assert.rejects(() => store.get('CARE-001'), /mismatch/);
});

test('教师指纹不可逆、稳定、可区分', () => {
  const h1 = hashTeacherRef('T-HASH-09');
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(h1, hashTeacherRef('T-HASH-09'));
  assert.notEqual(h1, hashTeacherRef('T-HASH-12'));
  assert.ok(!h1.includes('T-HASH'));
});
