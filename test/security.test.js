import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { SensitiveBox } from '../src/crypto.js';
import {
  makeClock,
  makeService,
  manager,
  operator,
  submitInput,
  teacher,
} from './helpers.js';

test('信封加密：往返一致，篡改密文或标签即失败', () => {
  const box = new SensitiveBox({ masterKey: randomBytes(32), keyId: 'k1' });
  const sealed = box.seal('敏感内容');
  assert.equal(box.open(sealed), '敏感内容');
  assert.equal(sealed.alg, 'aes-256-gcm');

  const tamperedData = { ...sealed, data: Buffer.from('垃圾').toString('base64') };
  assert.throws(() => box.open(tamperedData));
  const tamperedTag = { ...sealed, tag: Buffer.from('0000000000000000').toString('base64') };
  assert.throws(() => box.open(tamperedTag));

  const other = new SensitiveBox({ masterKey: randomBytes(32), keyId: 'k2' });
  assert.throws(() => other.open(sealed)); // 错密钥不可解
});

test('敏感说明与排队数据分离：任何排队/决策/审计结构都不含明文', async () => {
  const clock = makeClock();
  const { service, store } = await makeService({ clock });
  const secret = '绝密：健康细节 654321';
  const { application } = await service.submitApplication(
    teacher('T-1'),
    submitInput(clock, { sensitiveNote: secret }),
  );

  // 密文独立存放
  const sealed = store.sensitiveNotes.get(application.applicationId);
  assert.ok(sealed.data && sealed.iv && sealed.tag);
  assert.equal(JSON.stringify(sealed).includes(secret), false);

  // 排队、决策、审计、申请主体均不含明文
  const queue = service.queue(operator(), 'counselling');
  assert.equal(JSON.stringify(queue).includes(secret), false);
  assert.equal(JSON.stringify(store.decisions).includes(secret), false);
  assert.equal(JSON.stringify(store.auditLog).includes(secret), false);
  assert.equal(JSON.stringify(store.applications.get(application.applicationId)).includes(secret), false);

  // 读取留痕，审计内容同样不含明文
  service.readSensitive(manager(), application.applicationId);
  assert.equal(JSON.stringify(store.auditLog).includes(secret), false);
});

test('未知角色没有任何权限', async () => {
  const clock = makeClock();
  const { service } = await makeService({ clock });
  const stranger = { id: 'X-1', role: 'intern' };
  await assert.rejects(
    () => service.submitApplication(stranger, submitInput(clock)),
    (err) => err.status === 403,
  );
  assert.throws(() => service.queue(stranger, 'counselling'), (err) => err.status === 403);
  assert.throws(() => service.capacityReport(stranger), (err) => err.status === 403);
});

test('教师不能被经办人代替撤回，只能本人操作', async () => {
  const clock = makeClock();
  const { service } = await makeService({ clock });
  const { application } = await service.submitApplication(teacher('T-1'), submitInput(clock));
  await assert.rejects(
    () => service.withdraw(operator(), application.applicationId),
    (err) => err.status === 403,
  );
  await assert.rejects(
    () => service.withdraw(manager(), application.applicationId),
    (err) => err.status === 403,
  );
  const withdrawn = await service.withdraw(teacher('T-1'), application.applicationId);
  assert.equal(withdrawn.state, 'withdrawn');
});
