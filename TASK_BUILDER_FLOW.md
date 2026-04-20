# codex_task_builder_v2 造任务流程说明

本文基于当前 `codex_task_builder_v2` 源码整理，目标是把这个项目“如何从 template + input skills 自动构造 Harbor task family”讲清楚，方便后续维护、排障和改 prompt / validator。

## 1. 项目目标

`codex_task_builder_v2` 不是一个单纯的“任务生成器”，而是一条闭环流水线：

`family planner -> task writer -> task blocking reviewer -> static validate -> Harbor Oracle runtime -> skill-effect gate -> repair -> PF 立即双版本 publish / 非 PF 仅留 raw`

核心目标有两个：

1. 给定一个任务模板目录和一组输入 skill，自动构造新的 Harbor task family。
2. 不只生成草稿，还要自动做审稿、静态校验、Oracle 运行、真实 with-skill / no-skill 对照和失败修复。

## 2. 当前输入模型

当前版本不再围绕 `source task` 工作，而是围绕下面两类输入：

### 2.1 TaskTemplate

由这两个参数指定：

```bash
--template-root /Users/leviviya/Documents/Harbor/template
--template tools/debugging
```

表示：

- 模板根目录是 `template-root`
- 当前使用的模板是相对路径 `tools/debugging`
- 内部会把它规范化为 `templateId=tools__debugging`

模板最小必需内容固定为：

- `task.toml`
- `instruction.md`
- `environment/`
- `tests/`
- `solution/`

模板目录中的 `environment/skills/` 可以存在，但它只作为模板参考上下文，不决定最终 shipped skill。

### 2.2 InputSkills

通过重复传 `--skill-dir` 指定：

```bash
--skill-dir /Users/leviviya/Documents/Harbor/skills/tools/debugging/01__node-connect
--skill-dir /Users/leviviya/Documents/Harbor/skills/tools/debugging/03__session-logs
```

约束：

- 每个 `--skill-dir` 必须直接指向一个具体 skill 目录
- 目录内必须有 `SKILL.md`
- 当前实现要求每个输入 skill 的目录 `basename` 唯一，因为最终会被直接注入到 `environment/skills/<basename>/`

## 3. 关键目录

默认目录约定如下：

- template root：`/Users/leviviya/Documents/Harbor/template`
- output root：`/Users/leviviya/Documents/Harbor/codex_task_builder_v2_runs`
- raw runs：`<output-root>/raw`
- final tasks：`<output-root>/final`
- PF bucket 镜像：`<output-root>/final/_skill_effect_buckets`

最终发布目录结构固定为：

```text
<output-root>/final/<template-id>/<scope>/<task-name>__with_skill
<output-root>/final/<template-id>/<scope>/<task-name>__no_skill
```

PF bucket 镜像目录结构固定为：

```text
<output-root>/final/_skill_effect_buckets/with_skill_pass__no_skill_fail/<template-id>/<scope>/<task-name>__with_skill
<output-root>/final/_skill_effect_buckets/with_skill_pass__no_skill_fail/<template-id>/<scope>/<task-name>__no_skill
```

其中：

- `scope`
  - `all-skills`：`all` 模式
  - `<input-skill-dirname>`：`per-skill` 模式
- `task-name`
  - `similar1`, `similar2`, ...
  - `transfer1`, `transfer2`, ...
  - 正式扫描和复用只认 `*__with_skill`
  - `*__no_skill` 只是对照副本

## 4. 核心数据模型

### 4.1 TaskTemplate

表示一个模板任务，包含：

- `task.toml`
- `instruction.md`
- `environment/`
- `solution/`
- `tests/`
- `environment/skills/`
- 从 `task.toml` 解析出的 metadata
- 从模板自带 `environment/skills/*/SKILL.md` 解析出的参考 skill 列表

这里要注意：

- 模板自带 `environment/skills/` 只是参考上下文
- 最终 shipped skills 不由它决定

### 4.2 GenerationUnit

实际执行单元是 `GenerationUnit`，可以理解为：

- 一个 template
- 一组 input skills
- 加上一个 scope

两种 scope 模式：

- `all`
  - 一组输入 skill 只生成一个 family
  - scope 固定为 `all-skills`
  - 最终 shipped skills 等于本次输入的全部 skills
- `per-skill`
  - 一组输入 skill 会按 skill 拆成多个 family
  - 每个 family 只围绕一个目标 skill
  - scope 等于该 input skill 的 `dirName`

### 4.3 FamilyPlan / DerivedTaskPlan

- `FamilyPlan`
  - planner 输出的 family 级蓝图
  - 描述本轮应生成多少个 `similar` / `transfer`
  - 当前核心身份字段是 `templateId`
- `DerivedTaskPlan`
  - 把 `FamilyPlan` 展平后的单任务蓝图
  - 程序会把 planner 的任务数组映射成 `similar1`、`transfer1` 这种固定 ID

## 5. CLI 入口

CLI 现在只保留两类命令：

- `inventory`
- `generate-family`

### 5.1 inventory

递归扫描模板根目录，不生成任务。输出：

- `templateId`
- `templateRelativePath`
- difficulty / category
- 模板自带的参考 skill 名称
- environment 资产列表

### 5.2 generate-family

面向单个 template + 一组 input skills 生成 family。

当前版本已经不再支持：

- `batch`
- `review`

也不再支持旧参数：

- `--source-root`
- `--source-task-id`
- `--target-skill-dir`
- `--raw-root`
- `--final-root`
- `--quarantine-root`
- `--runs-root`

如果传入这些旧参数，CLI 会直接报错。

当前 `generate-family` 还支持：

- `--limit`
  - 在完成 unit 发现、published-state 判断并筛出 executable units 后，最多执行前 N 个 unit
  - 这是 unit 级限制，不是单个 family 内的 task 数量限制，也不是 similar / transfer 数量限制
- `--codex-run-retries`
  - 控制 builder 侧 planner / writer / review / repair 这四类 Codex `thread.run(...)` 调用在首次失败后最多额外重试几次
  - 默认值是 `3`
  - `0` 表示关闭自动重试
  - 只影响本地 builder 进程，不影响 Harbor / E2B trial 内部重试行为

## 6. 完整造任务流程

下面按实际执行顺序说明。

### 第 1 步：发现 template 和 input skills

程序先读取：

- `template-root/<template>/`
- 所有 `--skill-dir`

并解析出：

- template metadata
- 模板自带参考 skills
- input skill 列表

### 第 2 步：构造 generation units

程序根据 `--skill-mode`、`--similar-count`、`--transfer-count` 生成 `GenerationUnit`：

- `all` 模式：当前 template + 全部 input skills 组成一个 unit
- `per-skill` 模式：当前 template 的每个 input skill 各自形成一个 unit

### 第 3 步：读取已发布 family，决定缺哪些槽位

程序会读取：

```text
<output-root>/final/<template-id>/<scope>/
```

下已经发布的任务：

- 只识别已有的 `similarN__with_skill`
- 只识别已有的 `transferN__with_skill`
- 会忽略对应的 `*__no_skill`
- 也不会兼容旧布局 `<task-name>`

然后只补缺失槽位。

如果显式传了 `--limit`，程序会在这些 executable units 上再应用一次数量裁剪，只继续执行前 N 个 unit；这里限制的是 unit 数量，不是单个 family 内的 task 数量，也不是 `similar-count` / `transfer-count`。

例如目标是：

- `similar-count = 2`
- `transfer-count = 3`

如果 final 里已经有：

- `similar1`
- `transfer1`

那么本轮只需要补：

- `similar2`
- `transfer2`
- `transfer3`

这一步的目的是避免重复造已经发布的任务。

### 第 4 步：runtime preflight

在真正生成之前，程序先检查运行环境：

- 是否能找到 `harbor`
- `harbor --version` 是否正常
- 如果 runtime 环境是 `e2b`
  - 是否设置了 `E2B_API_KEY`
- 如果 runtime 环境是 `daytona`
  - 是否设置了 `DAYTONA_API_KEY`
- 如果 runtime 环境是 `docker`
  - 是否存在 `docker`
  - `docker info` 是否正常
- 如果启用了默认 skill-effect gate
  - 是否设置了 `OPENAI_API_KEY`

preflight 失败会直接终止，不进入生成阶段。

### 第 5 步：创建 family workspace

每个 unit 会创建一个独立 workspace：

```text
<output-root>/raw/<run-id>/<template-id>/<scope>/
```

其中固定包含：

- `template_source/`
- `input_skills/`
- `drafts/`
- `artifacts/`
- `TASK_BUILDER_BRIEF.md`

说明：

- `template_source/` 是模板任务的工作副本，保留模板自带 `environment/skills/`
- `input_skills/` 是本轮输入的真实 shipped skill payload
- `drafts/` 是本轮派生任务草稿
- `artifacts/` 存 planner / writer / reviewer / runtime / skill-effect / repair 的输出
- `TASK_BUILDER_BRIEF.md` 是给 Codex 的统一总纲

### 第 6 步：planner 生成 family 蓝图

程序调用 Codex planner，要求它：

- 先读 `TASK_BUILDER_BRIEF.md`
- 再读 `template_source/`
- 再读 `input_skills/`
- 如有已发布任务，也必须读 final 里的历史任务

planner 只做 family 规划，不直接写文件。

planner 的输出是严格 JSON，核心字段包括：

- `templateId`
- `familyTheme`
- `similarTasks`
- `transferTasks`
- 每个任务的：
  - `title`
  - `goal`
  - `primaryOutputFile`
  - `difficulty`
  - `category`
  - `skillBenefitRationale`

随后程序会做三类校验：

1. `validateFamilyPlan`
   - `templateId` 是否一致
   - `skillMode` 是否一致
   - similar / transfer 数量是否一致
2. `validateTaskPlans`
   - `derivedTaskId` 是否符合 `similarN/transferN`
   - `roleOrdinal` 是否正确
   - `primaryOutputFile` 是否唯一
3. `collectFamilyObservationIssues`
   - family 角色布局是否正确

如果 planner 阶段有 blocking issue，整组 family 会直接失败。

### 第 7 步：按固定顺序串行执行任务

planner 输出 `FamilyPlan` 后，程序会把它展平成 `DerivedTaskPlan`，再按固定顺序串行执行：

- 全部 `similar` 按 `roleOrdinal` 升序
- 全部 `transfer` 按 `roleOrdinal` 升序

也就是说：

- 不是“先把整组任务都写完，再统一 review / validate / publish”
- 而是“一个 task 完整走完 write -> review -> validate -> runtime -> skill-effect -> repair，再处理下一个 task”

对于当前 task：

1. 程序先创建 `drafts/<task-id>/`
2. 预先把 `input_skills/` 复制到 `drafts/<task-id>/environment/skills/`
3. 写入 `plan.json`
4. 再调用 writer 生成：
   - `task.toml`
   - `instruction.md`
   - `environment/Dockerfile`
   - `environment/` 下必要输入资产
   - `solution/solve.sh`
   - `tests/test.sh`
   - `tests/test_outputs.py`

这里最关键的变化是：

- draft 里的 `environment/skills/` 不再从模板复制
- 而是始终从 `input_skills/` 注入
- writer 做 sibling / 历史去重时，只参考 `final-root` 下已经发布的同 family 任务
- workspace 中其他尚未发布的 sibling drafts 不再作为强制去重基准

### 第 8 步：task blocking reviewer

当前版本已经没有独立的 family reviewer。

writer 完成后，当前 task 会直接进入单任务 blocking reviewer。它除了审单题 blocking 问题，也会顺手检查：

- 当前 task 是否与 `final-root` 下已发布 sibling / 历史任务过于接近

也就是说，去重现在改成两层：

- writer 生成时主动避重
- 单任务 blocking reviewer 兜底

task blocking reviewer 的输出只有：

- `taskResults`
  - 当前只返回这个 task 一条结果
  - 包含 `blockingPass / blockingIssues`

程序不会盲信 reviewer，会做结构归一化和结果校验。

### 第 9 步：static validate

当前 task 的 draft 会进入静态校验。

当前 static validate 会检查：

- 必备文件是否齐全
- `plan.json` 是否能解析，且 `derivedTaskId` 是否一致
- `environment/skills/` 是否与当前 scope 一致
  - `per-skill`：必须且只能包含当前目标 input skill
  - `all`：必须等于本次输入的全部 skills
- `environment/skills/<skill>/` 的内容是否与 `input_skills/<skill>/` 完全一致
  - 也就是 injected skill payload 不允许被 writer / repair 改写
- `task.toml` 中的关键字段
  - `id`
  - `name`
  - `description`
  - `primary_output_file`
  - `source_template_id`
  - `task_role`
- `instruction.md`、`metadata.name`、`metadata.description` 是否包含中文
- `environment/Dockerfile` 是否满足固定规则

只有 reviewer 和 static 都通过的任务，才会进入 runtime validate。

### 第 10 步：Harbor Oracle runtime validate

每个通过前置检查的任务都会跑一遍 Harbor Oracle：

```bash
harbor run -p <draft-task-dir> -a oracle -e <runtime-environment>
```

程序会收集：

- `harbor-run.log`
- `result.json`
- `job.log`
- `trial.log`
- `verifier/test-stdout.txt`
- `reward.txt` 或 `reward.json`
- `artifacts/manifest.json`

runtime 通过标准：

- 产出可解析的 `result.json`
- `result.json` 中没有 `exception_info`
- verifier 产出 reward
- reward `>= 1.0`
- `harbor run` 退出码为 `0`

### 第 11 步：skill-effect gate

如果没有显式 `--skip-skill-effect-gate`，每个通过 Oracle runtime 的任务都会继续做真实对照：

- `with_skill`
  - 先把当前 draft task 快照到 `variants/with_skill/`
  - 再基于这份快照运行 Codex
- `no_skill`
  - 从 `variants/with_skill/` 派生出 `variants/no_skill/`
  - 从 `environment/Dockerfile` 中删除 `COPY skills ...` 相关行
  - 再基于 `variants/no_skill/` 运行 Codex

这里的执行顺序要注意：

- variant 准备阶段仍然是顺序的
  - 先准备 `variants/with_skill`
  - 再从它派生 `variants/no_skill`
- 两个 variant 准备完成后，`with_skill` / `no_skill` 会默认并行执行
- 因此 task 主流程仍然是串行的，但单个 task 进入 `skill-effect` 阶段后，会同时占用两个 Harbor/E2B trial
- `--concurrency` 仍然只表示 family unit 级并发，不会吸收这两个 variant 的内部并发预算

当前 bucket 有五种：

- `with_skill_pass__no_skill_fail`
- `with_skill_pass__no_skill_invalid_fail`
- `with_skill_fail__no_skill_fail`
- `with_skill_pass__no_skill_pass`
- `with_skill_fail__no_skill_pass`

其中：

- `with_skill_pass__no_skill_fail`
  - 只有 `with_skill` 通过，且 `no_skill` 形成“结果文件正常、无 exception、reward < 1”的有效失败时才成立
- `with_skill_pass__no_skill_invalid_fail`
  - 表示 `no_skill` 是异常失败，必须优先修复 variant / verifier / runtime 问题

只有 `with_skill_pass__no_skill_fail` 视为接受；其余所有 bucket 都会触发 repair。

### 第 12 步：repair

只要命中下面任一问题，就可能触发 repair：

- reviewer issues
- static issues
- runtime issues
- skill-effect issues

repair prompt 可以读取：

- 当前 draft
- reviewer / static / runtime / skill-effect 的问题列表
- Oracle runtime 日志
- with_skill / no_skill 日志、reward、trajectory、result

repair 只允许修改：

```text
drafts/<task-id>/
```

明确禁止修改：

- `template_source/`
- `input_skills/`
- `artifacts/`
- Harbor 仓库代码
- injected skill payload

修完后只会回到**当前 task** 的下一轮 reviewer / static / runtime / skill-effect，不会把已经通过并发布的其他 task 重新拉回流程。

### 第 13 步：publish / 保留 raw

当前 task 在 blocking reviewer、static validate、Harbor Oracle runtime 都通过之后，发布分两条路径：

- 默认开启 skill-effect gate
  - 只有当 skill-effect bucket 为 `with_skill_pass__no_skill_fail`
    - 即 `with_skill` 通过
    - 且 `no_skill` 是“结果文件正常、无 exception、reward < 1”的有效失败
  - 才会被视为 `PF`，并立即：
    - 从接受那一轮的 `variants/with_skill` 复制到 `final/<template-id>/<scope>/<task-name>__with_skill`
    - 从接受那一轮的 `variants/no_skill` 复制到 `final/<template-id>/<scope>/<task-name>__no_skill`
    - 同步镜像到 `final/_skill_effect_buckets/with_skill_pass__no_skill_fail/...`
    - 追加到当前 unit 的已发布 sibling 列表
- 显式关闭 skill-effect gate（`--skip-skill-effect-gate`）
  - runtime 通过后就会直接发布
  - 只会把当前 draft 复制到 `final/<template-id>/<scope>/<task-name>__with_skill`
  - 不会生成 `__no_skill`
  - 也不会写入 `final/_skill_effect_buckets/`

后续 task 可以读取这个刚发布的 sibling，但不会重新打开它。

如果当前 task 在用尽 repair 轮数后仍未达到上面的发布条件，则不会被复制到额外目录，只会保留在当前 run 的 `raw/`、manifest 和 run summary 中。

因此当前实现允许：

- 同一个 family 中部分 task 已经发布到 `final`
- 另一些 task 未发布，但仍可回到 `raw` 查看最后一次 draft、runtime 与 skill-effect 证据

复制时只保留 allowlist：

- `task.toml`
- `instruction.md`
- `plan.json`
- `environment/`
- `solution/`
- `tests/`

默认开启 gate 且达到 PF 时，实际发布路径为：

```text
<output-root>/final/<template-id>/<scope>/<task-name>__with_skill
<output-root>/final/<template-id>/<scope>/<task-name>__no_skill
```

PF bucket 会额外落盘到：

```text
<output-root>/final/_skill_effect_buckets/with_skill_pass__no_skill_fail/<template-id>/<scope>/<task-name>__with_skill
<output-root>/final/_skill_effect_buckets/with_skill_pass__no_skill_fail/<template-id>/<scope>/<task-name>__no_skill
```

显式关闭 gate 时，实际发布路径为：

```text
<output-root>/final/<template-id>/<scope>/<task-name>__with_skill
```

## 7. 产物与日志

workspace `artifacts/` 中常见产物包括：

- `generation-unit.json`
- `family-plan.json`
- `family-plan.raw.json`
- `<task>.writer.json`
- `<task>.writer.raw.json`
- `<task>.review.round-<n>.json`
- `<task>.review.round-<n>.raw.json`
- `<task>.runtime.cycle-<n>.json`
- `<task>.runtime.cycle-<n>.attempt-<m>.json`
- `<task>.skill-effect.cycle-<n>.attempt-<m>.json`
- `<task>.repair.<n>.json`
- `<task>.repair.<n>.raw.json`

output root 顶层还会额外写：

- `<output-root>/manifest.jsonl`
- `<output-root>/<run-id>.json`

## 8. 当前版本最重要的语义变化

相较旧版 `source task` 流程，当前版本最重要的变化有五个：

1. 输入身份从 `sourceTaskId` 切成了 `templateId`
2. 最终 shipped skill 不再来自模板，而来自外部输入的 `--skill-dir`
3. workspace 里同时保留 `template_source/` 和 `input_skills/`，不再混在一起
4. draft 的 `environment/skills/` 由系统自动注入，并被视为只读 payload
5. 输出路径从多个根参数收敛为单个 `--output-root`

## 9. 一句话总结

**当前 `codex_task_builder_v2` 的主流程是：先把 template 和 input skills 组装成 family unit，再让 Codex 基于 `template_source/`、`input_skills/`、Harbor 参考材料和已发布任务做 family 规划，然后按 `similar -> transfer` 的固定顺序逐个任务写作、单题 blocking 审查、static validate、Harbor Oracle runtime 和 skill-effect 对照；默认 gate 开启时，某个任务只有在达到真正 PF 的 `with_skill_pass__no_skill_fail` 时才会把 `__with_skill` / `__no_skill` 两份快照一起发布到 `<output-root>/final`；如果显式关闭 skill-effect gate，则 runtime 通过后只发布 `__with_skill`，其他失败结果只留在 `raw`。**
