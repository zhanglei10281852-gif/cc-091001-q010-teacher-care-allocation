import { pathToFileURL } from 'node:url';
import { Store } from './store.js';
import { PolicyRegistry } from './policy.js';
import { SensitiveBox } from './crypto.js';
import { CareService } from './service.js';
import { createServer } from './server.js';

export async function buildApp({
  policyPath = new URL('../policy/rules-2026.2.json', import.meta.url),
  env = process.env,
  now,
  logger = console,
} = {}) {
  const store = new Store();
  const policies = await PolicyRegistry.fromFile(policyPath);
  const box = SensitiveBox.fromEnv(env, (msg) => logger.warn?.(msg));
  const service = new CareService({ store, policies, box, now });
  const server = createServer({ service });
  return { store, policies, box, service, server };
}

// 直接运行（node src/index.js）时启动 HTTP 服务
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = await buildApp();
  const port = Number(process.env.PORT || 8080);
  server.listen(port, () => {
    console.log(`教师关怀资源分配服务已启动：http://localhost:${port}`);
  });
}
