# codex_task_builder_v2

`codex_task_builder_v2/` 现在采用新的输入模型：`template + input skills`。

它不再从 `source task` 扫描 family，也不再保留 `batch` / `review` 这两个旧入口。当前主链路只关注一件事：给定一个任务模板目录和一组输入 skill，自动规划、写作、单题 blocking 审查、runtime 校验、skill-effect 对照并发布 Harbor 任务。

## 输入模型

### 模板

通过下面两个参数指定：

```bash
--template-root /Users/leviviya/Documents/Harbor/template
--template tools/debugging
```

- `--template-root` 是模板根目录。
- `--template` 是相对 `template-root` 的模板相对路径。
- 内部会把 `tools/debugging` 规范化为 `templateId=tools__debugging`。

模板最小必需内容固定为：

- `task.toml`
- `instruction.md`
- `environment/`
- `tests/`
- `solution/`

模板目录中的 `environment/skills/` 可以存在，但它只作为模板参考上下文，不决定最终 shipped skill。

### Skills

skill 输入继续采用重复传 `--skill-dir` 的方式：

```bash
--skill-dir /Users/leviviya/Documents/Harbor/skills/tools/debugging/01__node-connect
--skill-dir /Users/leviviya/Documents/Harbor/skills/tools/debugging/03__session-logs
```

- 每个 `--skill-dir` 必须直接指向一个具体 skill 目录，目录内必须有 `SKILL.md`。
- 当前接口不引入 `skill-root + relative-path` 第二套参数。
- 当前实现要求每个输入 skill 的目录 `basename` 唯一，因为最终会被直接注入到任务的 `environment/skills/<basename>/`。

## 命令

### `inventory`

递归扫描模板根目录，输出模板清单：

```bash
npm run inventory -- \
  --template-root /Users/leviviya/Documents/Harbor/template
```

### `generate-family`

```bash
npm run generate-family -- \
  --template-root /Users/leviviya/Documents/Harbor/template \
  --template tools/debugging \
  --skill-dir /Users/leviviya/Documents/Harbor/skills/tools/debugging/01__node-connect \
  --skill-dir /Users/leviviya/Documents/Harbor/skills/tools/debugging/03__session-logs \
  --skill-mode per-skill \
  --similar-count 0 \
  --transfer-count 1 \
  --output-root /Users/leviviya/Documents/Harbor/.local-workspace/codex_task_builder_v2_debugging \
  --concurrency 1 \
  --codex-run-retries 3 \
  --task-attempt-timeout-hours 2 \
  --max-task-restarts 1 \
  --max-repair-rounds 2
```

关键参数：

- `--template-root`
- `--template`
- `--skill-dir`，可重复
- `--skill-mode`
  - `all`：把本次输入的全部 skill 一起作为 shipped skills
  - `per-skill`：每个输入 skill 各自生成一个 family unit
- `--similar-count`
- `--transfer-count`
- `--scope-slug`
  - 可选，只跑某个 unit，例如 `01__node-connect`
- `--output-root`
  - 唯一输出根目录参数
- `--concurrency`
- `--codex-run-retries`
  - 可选，控制 builder 侧每次 Codex `thread.run(...)` 调用在首次失败后最多额外重试几次
  - 默认值是 `3`
  - `0` 表示关闭自动重试
  - 只作用于 planner / writer / review / repair 这些本地 builder 调用，不影响 Harbor / E2B trial 内部行为
- `--task-attempt-timeout-hours`
  - 可选，控制单题单次 fresh attempt 的 wall-clock 时长预算
  - 默认值是 `2`
  - `0` 表示关闭这层超时
- `--max-task-restarts`
  - 可选，控制单题在首版 attempt 失败后最多再 fresh restart 几次
  - 默认值是 `1`
  - fresh restart 会进入全新的 attempt workspace，不会复用旧草稿
- `--max-repair-rounds`
- `--limit`
  - 可选，按 unit 限制本次实际执行数量
  - 程序会先发现 units、读取 published state、筛出 executable units，再最多执行前 N 个；`0` 或未传表示不额外限制
- `--skip-skill-effect-gate`
- `--skill-effect-model`

## 输出布局

只允许配置一个根目录：`--output-root`

内部固定拆成：

```text
<output-root>/
  manifest.jsonl
  <run-id>.json
  raw/
    <run-id>/<template-id>/<scope>/
      task_attempts/<task-id>/attempt-<n>/...
  final/
    <template-id>/<scope>/<task-name>__with_skill
    <template-id>/<scope>/<task-name>__no_skill
    _skill_effect_buckets/
      with_skill_pass__no_skill_fail/<template-id>/<scope>/<task-name>__with_skill
      with_skill_pass__no_skill_fail/<template-id>/<scope>/<task-name>__no_skill
```

例如：

```text
/Users/leviviya/Documents/Harbor/.local-workspace/codex_task_builder_v2_debugging/
raw/20260410.../tools__debugging/01__node-connect/...
final/tools__debugging/01__node-connect/transfer1__with_skill
final/tools__debugging/01__node-connect/transfer1__no_skill
final/_skill_effect_buckets/with_skill_pass__no_skill_fail/tools__debugging/01__node-connect/transfer1__with_skill
final/_skill_effect_buckets/with_skill_pass__no_skill_fail/tools__debugging/01__node-connect/transfer1__no_skill
```

补充语义：

- `final/` 只保留真正接受的 PF 任务。
- `__with_skill` 是正式发布体，也是历史去重、重复运行复用、pending slot 判断唯一参考。
- `__no_skill` 是对照副本，会随 PF 一起发布，但不会参与历史任务扫描。
- 非 PF 任务不再 materialize 到单独目录，只保留在 `raw/`、`manifest.jsonl` 和 `<run-id>.json` 中。
- 旧布局 `final/<template-id>/<scope>/<task-name>` 不兼容；当前代码只识别 `*__with_skill`。上线前需要手动清理或迁移旧 `final/`。

## Workspace 语义

每个 family workspace 现在固定包含：

- `template_source/`
  - 模板任务原样拷贝，包含模板自带的 `environment/skills/`
- `input_skills/`
  - 本次输入的真实 skill payload
- `task_attempts/<task>/attempt-<n>/draft/environment/skills/`
  - 当前 attempt 的 draft 会从 `input_skills/` 自动注入 shipped skills

注意：

- `template_source/` 只是参考模板，不是让 writer 机械复写的任务。
- `input_skills/` 才是最终 shipped skill 的唯一来源。
- `task_attempts/<task>/attempt-<n>/draft/environment/skills/` 里的 injected skills 视为只读 payload，writer/repair 不允许修改。
- static validate 会校验 draft 中的 injected skill 与 `input_skills/` 内容完全一致。
- family root 不再生成 `TASK_BUILDER_BRIEF.md`；当前 active 模型上下文只看 `task_attempts/<task>/attempt-<n>/TASK_BUILDER_BRIEF.md`。

## 当前执行语义

当前执行模型是：

- 改为 task 级单题 planner + 串行执行
  - 固定顺序是 `similar1..N` 先于 `transfer1..N`
  - 每个 task 单独经历 `single-task planner -> write -> blocking review -> static validate -> runtime -> skill-effect -> repair`
  - 每次 fresh restart 都会切到新的 `task_attempts/<task>/attempt-<n>/` 工作区
  - `skill-effect` 内部会在变体准备完成后默认并行运行 `with_skill` / `no_skill`
- 不再有独立 family reviewer
  - 去重改为 writer 主动避重 + 单任务 blocking reviewer 兜底
  - 去重范围只包含 `final-root` 下已经发布的 `*__with_skill` sibling / 历史任务
- 一旦某个 task 达到 `PF`
  - 即 `with_skill` 通过，且 `no_skill` 满足“结果文件正常、无 exception、reward < 1”的 `with_skill_pass__no_skill_fail`
  - 会立即 materialize 到 `<output-root>/final/.../<task>__with_skill` 和 `<output-root>/final/.../<task>__no_skill`
  - 同时镜像到 `<output-root>/final/_skill_effect_buckets/with_skill_pass__no_skill_fail/...`
  - 后续 task 可以读取这个刚发布的 sibling，但不会重新打开它
- 一个 family 允许部分成功
  - 已经通过的 task 会保留在 `final/`
  - 后续失败的 task 只保留在 `raw/` 和 run summary / manifest 里，不再进入 `quarantine/`

skill-effect gate 现在进一步区分：

- `with_skill_pass__no_skill_fail`
  - 真正可接受的 PF；`no_skill` 必须是有效 reward 失败
- `with_skill_pass__no_skill_invalid_fail`
  - `no_skill` 是异常失败，必须继续 repair，不能发布
- 其他 bucket
  - 一律继续 repair，直到达到 PF 或耗尽 repair 轮数

资源语义补充：

- `--concurrency` 仍然只控制同时处理多少个 family unit
- `--task-attempt-timeout-hours` 控制单题单次 attempt 的 wall-clock 预算
- `--max-task-restarts` 控制单题在失败后最多再 fresh restart 几次
- 单个 task 进入 `skill-effect` 阶段后，会默认同时起两个 Harbor/E2B trial
- 因此 `skill-effect` 阶段的峰值活跃 trial 数最多可到 `2 * --concurrency`

重复运行同一条命令时：

- `raw/` 每次 runId 唯一，不会冲突
- `final/` 只把 `*__with_skill` 视为正式已发布任务并参与复用
- `*__no_skill` 是否存在不影响已发布判断

## 当前不再支持的旧接口

下面这些旧参数已经不再支持：

- `--source-root`
- `--source-task-id`
- `--target-skill-dir`
- `--raw-root`
- `--final-root`
- `--quarantine-root`
- `--runs-root`

下面这些旧命令已经移除：

- `batch`
- `review`

如果传入旧参数，CLI 会直接报错。
