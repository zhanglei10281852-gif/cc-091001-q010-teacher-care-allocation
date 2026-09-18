# 教师关怀资源公平分配

教师服务中心使用本项目维护关怀申请与资源容量的公共语义。`fixtures/application-context.json` 是脱敏申请样例，`src/domain.js` 声明资源、申请和复核状态。敏感说明与排队所需字段具有不同访问范围，普通查询不应依赖敏感说明内容。

请使用 Node.js 20 或更高版本，运行 `npm test` 验证领域资料。加密密钥、真实证明材料和个人身份数据必须留在受控环境中。

## 组成

- `policy/rules-2026.2.json` — 结构化政策：资源容量、紧急等级权重、等待加分、证明有效期、冷静期、经办角色权限。所有版本由 `PolicyRegistry` 保留，供复算重放。
- `src/service.js` — 领域服务：资格核验、优先级、占用、递补、撤回、升级、申诉复核、政策发布。
- `src/policy.js` — 规则校验与统一打分函数（实时分配与事后复算共用同一函数）。
- `src/crypto.js` — 敏感说明信封加密（AES-256-GCM），密文与排队数据分离存放。
- `src/locks.js` — 按资源串行化的互斥锁，并发请求不会突破容量。
- `src/server.js` / `src/index.js` — HTTP API 与装配入口（无第三方依赖）。

## 运行

```bash
npm test                 # 运行全部测试
npm start                # 启动服务（默认 :8080，PORT 可覆盖）
CARE_MASTER_KEY=<64位hex> npm start   # 生产模式必须提供 32 字节主密钥
```

未设置 `CARE_MASTER_KEY` 时使用临时密钥并告警，仅限开发/测试。

## 身份与权限

请求头 `x-actor-id` + `x-actor-role`（`teacher` / `operator` / `manager`），权限矩阵写在政策 `roles` 中：

- **教师**：提交/撤回/申诉本人申请、更新本人证明、查询本人阶段与等待解释（只有位置与数量，不含他人信息）。
- **经办人**：查看必要字段（不含敏感说明内容）、升级紧急等级、办结、标记爽约、受理复核、查看队列与容量。
- **负责人**：在经办人权限之外，可读取敏感说明（留痕）、查看审计、复算每次分配决策、发布新政策版本。

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/applications` | 提交申请（支持 `Idempotency-Key`，重试不产生重复申请） |
| GET | `/applications` / `/applications/:id` | 按角色裁剪的查询视图 |
| POST | `/applications/:id/withdraw` | 本人撤回（占用中则释放并递补，进入冷静期） |
| POST | `/applications/:id/escalate` | 经办人上调紧急等级（只升不降、仅限未承诺申请） |
| POST | `/applications/:id/proof` | 更新证明有效期（解除过期挂起） |
| POST | `/applications/:id/complete` / `no-show` | 办结 / 爽约，释放名额并按当时有效优先级递补 |
| POST | `/applications/:id/appeal` / `review` | 申诉与复核；推翻后回到排队而非直接占用 |
| GET | `/applications/:id/sensitive` | 负责人读取敏感说明（审计留痕） |
| GET | `/queue/:resource` / `/capacity` | 经办队列视图 / 容量不变量报告 |
| GET | `/decisions` + POST `/decisions/:id/recompute` | 负责人复算每次分配选择 |
| GET/POST | `/policy` / `/policy/versions` | 查看当前政策 / 发布新版本 |

## 关键语义

- **优先级** = 紧急等级权重 + 等待加分（每日 `aging.perDay`，封顶 `aging.maxBonus`），同分按提交时间、再按申请号排序；资源释放时按**当时有效**的规则与得分递补。
- **不重复占用**：同一教师同一资源仅允许一个活跃申请；证明过期者挂起跳过；爽约先结束占用再递补；复核推翻只回到排队。任一申请至多一条未结束的占用记录。
- **规则版本**：申请在承诺（占用）时刻钉住政策版本与条款；版本变化只作用于尚未承诺的申请。缩容不撤销既有承诺，但在占用回落到新容量以下之前不再新增。
- **可复算**：每次占用决策记录候选、得分、跳过原因与容量快照；负责人用同一打分函数按当时版本重放，结果必须一致，且 `inUseBefore < capacity` 恒成立。
