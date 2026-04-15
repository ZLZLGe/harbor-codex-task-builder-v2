# codex_task_builder_v2 最终生成任务要求

本文整理当前 `codex_task_builder_v2` 对“最终生成 Harbor 任务”的要求，目标是把分散在 `prompts.ts`、`validate.ts`、Harbor oracle / runtime 和流程文档中的约束汇总成一份可直接对照的规范。

建议把这些要求分成两层理解：

- `必须满足`
  - 当前代码会通过 static validate、task blocking reviewer、Harbor Oracle runtime、skill-effect gate 或发布流程实际卡住的要求。
- `应该满足`
  - 当前主要通过 prompt 强化的质量要求。
  - 这类要求不一定全都有硬编码校验，但都属于当前 builder 希望稳定产出的任务形态。

## 1. 最终产物定位

最终生成的内容必须是一个完整、可发布的 Harbor task，而不是草稿片段、仅有测试的半成品，或只能靠 builder 上下文才能运行的内部中间产物。

最终任务应同时满足：

- 是一个自包含的 Harbor task
- 能在 Harbor 中完成 build / start / verify
- 用户可见文本使用英文
- 有清晰输出契约
- 有稳定 verifier
- 有 shipped skill 时，skill 对解题应有真实帮助

## 2. 目录与命名要求

最终发布目录结构固定为：

```text
<output-root>/final/<template-id>/<scope>/<task-name>
```

失败任务隔离目录结构固定为：

```text
<output-root>/quarantine/<template-id>/<scope>/<task-name>
```

其中：

- `scope`
  - `all` 模式固定为 `all-skills`
  - `per-skill` 模式固定为目标 input skill 的 `dirName`
- `task-name`
  - 只能是 `similar1`、`similar2`、`transfer1`、`transfer2` 这类 canonical name

family 层要求：

- `similar` / `transfer` 的数量必须与本轮目标一致
- 同一 family 内的 `primaryOutputFile` 必须唯一
- family 规划上应让不同任务在任务场景、输入资产、输出语义和验证方式上拉开差异
- 当前硬 gate 的去重主要针对 `final` 中已发布的同 family sibling / 历史任务

## 3. 必备文件要求

每个最终任务至少必须包含：

- `plan.json`
- `task.toml`
- `instruction.md`
- `environment/Dockerfile`
- `environment/skills/**`
- `solution/solve.sh`
- `tests/test.sh`
- `tests/test_outputs.py`

补充要求：

- `plan.json` 当前实现仍会保留，不能删除或改名
- 发布时只允许复制 Harbor 必需文件，不发布 builder 内部额外产物
- 发布 allowlist 固定为：
  - `task.toml`
  - `instruction.md`
  - `plan.json`
  - `environment/`
  - `solution/`
  - `tests/`

## 4. task.toml 与基础元数据要求

`task.toml` 中的 `[metadata]` 至少必须包含：

- `id`
- `name`
- `description`
- `author_name`
- `author_email`
- `difficulty`
- `category`
- `tags`
- `primary_output_file`
- `source_template_id`
- `task_role`

并且必须满足：

- `metadata.id` 必须等于当前 `derivedTaskId`
- `metadata.name` 必须显式包含 `Similar N` 或 `Transfer N`
- `metadata.name` 与 `metadata.description` 必须使用英文
- `metadata.primary_output_file` 必须与 `plan.json` 一致
- `metadata.source_template_id` 必须与当前 `templateId` 一致
- `metadata.task_role` 必须与任务角色一致
- `tags` 不能为空

`[environment]` 必须固定为：

```toml
[environment]
cpus = 2
memory_mb = 2048
storage_mb = 5120
gpus = 0
```

## 5. 文本与指令要求

以下用户可见文本必须使用英文：

- `instruction.md`
- `task.toml` 中的 `metadata.name`
- `task.toml` 中的 `metadata.description`

`instruction.md` 应满足：

- 清楚说明任务目标、输入资产、输出契约、边界条件
- 不直接点名当前 shipped skill 的 `name` 或 `dirName`
- 不引入隐藏要求
- 不把任务写成按步骤执行即可过关的教程式 recipe
- 不依赖模板之外的隐含背景知识

## 6. 模板与输入 skill 语义要求

当前版本必须把模板参考和最终 shipped skill 严格区分开：

- `template_source/`
  - 是参考模板，不是最终任务
  - 模板自带 `environment/skills/` 只作为参考上下文
- `input_skills/`
  - 才是最终 shipped skills 的唯一来源
- `drafts/<task>/environment/skills/`
  - 是从 `input_skills/` 自动注入的真实 shipped skill payload

因此必须满足：

- 不得把模板自带 `environment/skills/` 误当成最终 shipped skills
- 任务只能依赖当前 scope 下可见的 input skills
- 不得假设其他未提供 skills 存在
- `solution/solve.sh` 与 `tests/**` 不能把 skill 当运行时依赖
- `environment/skills/**` 的内容必须与输入 skill 完全一致，不允许 writer / repair 修改 injected skill payload

scope 约束：

- `per-skill`
  - `environment/skills/` 必须且只能包含当前目标 input skill
- `all`
  - `environment/skills/` 必须等于本次输入的全部 skills

## 7. Dockerfile 要求

`environment/Dockerfile` 必须满足：

- 必须显式声明 `WORKDIR`
- 默认优先 `WORKDIR /root`
- 必须保留 `COPY skills /root/.codex/skills`
- 不得使用 `COPY . /root`、`ADD . /root` 或同类宽泛复制
- 不得把 `skills` 复制到普通运行时路径，如：
  - `/root/environment/skills`
  - `/app/skills`
  - `/workspace/skills`
- 不得使用私有、本地、仅在个人机器可用的 registry
- 必须使用公开可复现的公共镜像，或 `FROM scratch`

## 8. solution / verifier / runtime 契约要求

当前 runtime / oracle 口径：

- 当前 builder 默认使用 Harbor oracle + `e2b` 做 runtime 校验
- 也允许切换到 `daytona` 或 `docker`
- 最终任务不应依赖只在某一个特定 runtime 后端下才成立的私有假设

`solution/solve.sh` 要求：

- 是参考解脚本，而不是现成答案搬运器
- 不得只是复制、重命名、移动、直接输出随任务提供的完整标准答案
- 与 `tests/test.sh`、`tests/test_outputs.py`、`environment/Dockerfile` 的路径契约必须一致

`tests/test_outputs.py` 要求：

- 只检查 `instruction.md` 明示的输出契约
- 尽量面向结果语义，而非内部实现细节
- `expected` 应来自输入资产、题目规则或可复算逻辑
- 不得依赖任务内现成答案文件
- 不能让 fresh state、no-op、复制现成答案、改名已有 deliverable 这类伪解法错误通过

`tests/test.sh` 要求：

- 必须先创建 `/logs/verifier`
- 必须稳定写出 `reward.txt` 或 `reward.json`
- 不能只是裸跑测试命令然后直接退出
- 即使测试失败，也必须在退出前落盘 reward

运行通过标准：

- 必须产出可解析的 `result.json`
- `result.json` 里不能有 `exception_info`
- verifier 必须产出 reward
- reward 必须 `>= 1.0`
- `harbor run` 自身退出码必须为 `0`

## 9. verifier 语义要求

任务必须满足 hard to solve but easy to verify。

具体要求：

- 难点在求解，不在猜 verifier
- 验收规则清晰、可程序化判断
- 输出格式、路径、字段、容忍误差应明确
- 不靠隐藏阈值、隐藏步骤、隐藏接口卡 agent
- 任务必须 self-contained
- 完成任务所需关键信息必须写在 `instruction.md` 或输入资产中

关键补充：

- verifier 用到的任何决定性语义都必须能从 `instruction.md` 或输入资产直接推出
- 不得把决定性语义只隐含在 `tests/solution` 中
- 如果一个认真执行的 agent 需要阅读 verifier 或参考解才能消除关键歧义，则该任务不合格

这类决定性语义包括但不限于：

- 状态更新顺序
- 时间步长语义
- 最后一步处理
- 聚合规则
- replay 口径
- 容差口径

## 10. benchmark 质量要求

### 10.1 难度要求

无论 `all` 模式还是 `per-skill` 模式，benchmark 任务默认都应规划为 `hard`。

只有在下面这种情况下，才允许降到 `medium`：

- `hard` 带来的主要代价会变成 build / start / runtime 噪声
- 难点不再体现为 skill bottleneck
- 继续追求 `hard` 只会明显破坏评测稳定性

不应为了追求“hard”而引入：

- 重型环境搭建
- 多服务长启动链路
- 大下载、大模型预热
- 明显脆弱的时序依赖
- 主要依赖运行基础设施而非任务本身的难点

### 10.2 skill effect 要求

任务应该尽量体现“带相关 skill 时能明显压缩搜索空间，不带相关 skill 时更容易走错路、漏关键步骤或选错工具”的特征。

更具体地说：

- 规划阶段
  - 必须先阅读目标 shipped skill 的 `SKILL.md`
  - `all` 模式下应覆盖全部 input skills
  - 必须先提炼 2-4 个独特、非通用模板化的关键能力点
  - 每个候选任务都必须能说明：
    - 依赖了哪些关键能力点
    - 没有这些能力点时通用 agent 最可能卡在哪一步
    - 为什么这不是“读 helper + 套模板 + 调参”就能过的题
- `per-skill`
  - 当前目标 skill 必须是关键瓶颈，而不是可有可无的加速器
- `all`
  - 多个 shipped skills 的核心收益点必须真实参与解题，不能退化成只靠通用能力也能直接完成的任务

任务对相关 skill 的依赖必须满足：

- 目标 skill 必须依赖 `SKILL.md` 中独特、非通用模板化的能力点
- 这些能力点应实质改变解题成败，而不只是节省体力或压缩少量时间
- 不能只是把常见 bash / python 模板、通用调试套路或轻量工作流包装成所谓 skill bottleneck

不应生成以下弱信号任务：

- 单个明显文件就能直接读出答案
- 单条 shell 命令就能直接完成
- 主要依赖浅层通用 bash / python / jq / grep 技巧
- 通用 agent 仅靠常见 bash / python 模板、通用调试套路或轻量试错就能完成
- 资产天然暴露解法结构，或题目只需要复用模板任务的求解骨架
- 主要考模板填空，而不是 skill 对应的推理、建模或工作流能力
- skill 只是节省几分钟体力，而不是改变解题成败

### 10.3 skill-effect gate 的接受口径

当前 bucket 有四种：

- `with_skill_pass__no_skill_fail`
- `with_skill_fail__no_skill_fail`
- `with_skill_pass__no_skill_pass`
- `with_skill_fail__no_skill_pass`

其中：

- 接受：
  - `with_skill_pass__no_skill_fail`
- 不接受，必须修：
  - `with_skill_fail__no_skill_fail`
  - `with_skill_pass__no_skill_pass`
  - `with_skill_fail__no_skill_pass`

因此，不合格任务通常包括：

- `no_skill` 也能通过
- `with_skill` 反而更差
- with-skill / no-skill 对照没有形成稳定 skill bottleneck

## 11. 明确禁止的坏任务形态

以下情况都应视为不合格：

- 机械复写模板任务，只做轻微换皮
- 与同 family 已发布任务几乎重复
- instruction / tests / solution / task.toml 彼此不一致
- verifier 使用 `instruction.md` 未声明的隐藏要求
- 决定性语义只埋在 `tests/solution` 中
- `solution/solve.sh` 或 `tests/**` 直接依赖 skill 模块或 skill 安装路径
- `environment/skills/**` 被 writer / repair 改写
- Dockerfile 使用宽泛复制，把整个 build context 暴露进去
- Dockerfile 把 `skills` 复制到普通运行时路径
- 私有镜像、本地 registry、只在个人机器可跑的环境
- 题面或资产直接暴露答案结构
- 现成 deliverable 可以通过复制 / 改名直接过关
- 主要考模板填空或常见脚本套路，而不是目标 skill 的关键能力点

## 12. 发布判断

任务最终只有两种去向：

- 满足要求
  - 发布到 `<output-root>/final`
- 不满足要求
  - 进入 `<output-root>/quarantine`

skill-effect bucket 还会额外同步到：

- `<output-root>/final/_skill_effect_buckets/...`
- `<output-root>/quarantine/_skill_effect_buckets/...`

当前执行语义还有两个关键点：

- 任务按 `similar -> transfer` 的顺序逐个执行
- 某个任务一旦达到 `with_skill_pass__no_skill_fail`，会立即发布到 `final`，不会等待同 family 其他任务结束

因此同一个 family 允许出现：

- 一部分 task 已发布到 `final`
- 另一部分 task 最终进入 `quarantine`

当前实现下，一个任务要进入发布态，至少意味着：

- task blocking reviewer 未判失败
- static validate 通过
- Harbor Oracle runtime 通过
- skill-effect gate 落在 `with_skill_pass__no_skill_fail`，或者显式关闭了 skill-effect gate
