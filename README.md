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
- `--max-repair-rounds`
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
    <run-id>/<template-id>/<scope>/...
  final/
    <template-id>/<scope>/<task-name>
  quarantine/
    <template-id>/<scope>/<task-name>
```

例如：

```text
  /Users/leviviya/Documents/Harbor/.local-workspace/codex_task_builder_v2_debugging/
  raw/20260410.../tools__debugging/01__node-connect/...
  final/tools__debugging/01__node-connect/transfer1
  quarantine/tools__debugging/03__session-logs/transfer1
```

## Workspace 语义

每个 family workspace 现在固定包含：

- `template_source/`
  - 模板任务原样拷贝，包含模板自带的 `environment/skills/`
- `input_skills/`
  - 本次输入的真实 skill payload
- `drafts/<task>/environment/skills/`
  - 从 `input_skills/` 自动注入的 shipped skills

注意：

- `template_source/` 只是参考模板，不是让 writer 机械复写的任务。
- `input_skills/` 才是最终 shipped skill 的唯一来源。
- `drafts/<task>/environment/skills/` 里的 injected skills 视为只读 payload，writer/repair 不允许修改。
- static validate 会校验 draft 中的 injected skill 与 `input_skills/` 内容完全一致。

## 当前执行语义

当前执行模型是：

- 保留 family planner
  - planner 仍一次性产出当前 scope 下全部 `similar` / `transfer` blueprint
- 改为 task 级串行执行
  - 固定顺序是 `similar1..N` 先于 `transfer1..N`
  - 每个 task 单独经历 `write -> blocking review -> static validate -> runtime -> skill-effect -> repair`
- 不再有独立 family reviewer
  - 去重改为 writer 主动避重 + 单任务 blocking reviewer 兜底
  - 去重范围只包含 `final-root` 下已经发布的 sibling / 历史任务
- 一旦某个 task 达到 `PF`
  - 即 `with_skill_pass__no_skill_fail`
  - 会立即 materialize 到 `<output-root>/final/...`
  - 后续 task 可以读取这个刚发布的 sibling，但不会重新打开它
- 一个 family 允许部分成功
  - 已经通过的 task 会保留在 `final/`
  - 后续失败的 task 单独进入 `quarantine/`

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
