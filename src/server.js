// 服务启动入口：从受控环境变量读取数据目录、加密密钥与监听端口。
// 用法：node src/server.js
// 环境变量：
//   CARE_DATA_DIR      排队事件日志目录（默认 ./.data/queue）
//   CARE_SENSITIVE_DIR 敏感说明密文目录（默认 ./.data/sensitive，必须与排队目录分离）
//   CARE_VAULT_KEY     32 字节密钥的 base64（缺失时回退开发口令 CARE_VAULT_PASSPHRASE）
//   CARE_PORT          监听端口（默认 3000）

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { EventStore } from './store.js';
import { CryptoVault, SensitiveStore } from './crypto.js';
import { CareService } from './service.js';
import { createHttpServer } from './http.js';

export async function buildApp({
  dataDir = process.env.CARE_DATA_DIR ?? './.data/queue',
  sensitiveDir = process.env.CARE_SENSITIVE_DIR ?? './.data/sensitive',
  vaultKey = process.env.CARE_VAULT_KEY,
  vaultPassphrase = process.env.CARE_VAULT_PASSPHRASE,
  clock = () => Date.now(),
} = {}) {
  // 先校验物理分离，再创建任何目录，避免拒绝启动时仍写入同一路径。
  if (path.resolve(dataDir) === path.resolve(sensitiveDir)) {
    throw new Error('sensitive-store-must-be-separate-from-queue-store');
  }
  await mkdir(dataDir, { recursive: true });
  await mkdir(sensitiveDir, { recursive: true });

  let keyMaterial;
  if (vaultKey) {
    const buf = Buffer.from(vaultKey, 'base64');
    if (buf.length !== 32) throw new Error('CARE_VAULT_KEY must decode to 32 bytes');
    keyMaterial = buf;
  } else if (vaultPassphrase) {
    keyMaterial = { passphrase: vaultPassphrase };
  } else {
    throw new Error('missing-vault-key: set CARE_VAULT_KEY or CARE_VAULT_PASSPHRASE');
  }

  const vault = new CryptoVault(keyMaterial);
  const store = new EventStore(path.join(dataDir, 'events.jsonl'));
  const sensitive = new SensitiveStore(sensitiveDir, vault);
  const service = new CareService({ store, sensitiveStore: sensitive, clock });
  await service.init();
  return service;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const service = await buildApp();
  const server = createHttpServer(service);
  const port = Number(process.env.CARE_PORT ?? 3000);
  server.listen(port, () => {
    // 不输出任何身份或密钥相关信息。
    console.log(JSON.stringify({ event: 'server-listening', port }));
  });
}
