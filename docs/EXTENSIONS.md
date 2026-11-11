# 扩展 Agent、Skill 和模型

## 新增助理

在 `config.yaml` 的 agents 数组增加一项，使用唯一 id、自己的飞书应用凭据变量以及人格文件路径。工作目录和私有记忆默认位于 `data/agents/<id>/`。复制已有配置后重启即可，核心代码不需要增加分支。

可为不同 Agent 选不同模型。`sharedKnowledge` 只列它允许读取的通用知识文件。修改人格、共享资料、已有 Skill 的内容会在下一次运行加载。

## 安装现成 Pi Skill

将你信任的 Pi Skill 文件夹放到例如 `agents/finance/skills/<skill-name>/`，其根文件为 `SKILL.md`。该目录已在财务助理配置中。

本项目使用 SDK 的 `loadSkills`，仅从配置的 skill 路径发现资源，不隐式读取服务器账户的全局 Skill、扩展或上层目录中的上下文。

Skill 的描述会提供给模型，模型使用 `read` 读取完整说明。若 Skill 需要运行脚本，在该 Agent 的 `builtinTools` 中显式增加 `bash`，并安装其所需的语言环境和依赖。这会授予该 Agent 运行账户的命令执行能力。仅有 Skill 说明文件并不会自动获得行情 API、凭据或可执行工具。

首版不自动加载 Pi Extension/第三方 npm 插件，也不自动接入 MCP。已有 Skill 如依赖这些机制，需在 `src/agent.ts` 的资源配置中显式接入，不能假设放入 Skill 文件就全部可用。

## A股、港股、美股监测接入点

行情供应商由你后续选择。建议 Skill/脚本的接口输出结构化 JSON，包含：

- 标的和市场；币种；报价及报价时间；数据源。
- 本地市场是否处于交易时段、是否交易日；报价是否过期。
- 触发的规则、去重/冷却标识；需要通知的原因。

不要仅凭“周一至周五的 cron”认定市场开盘；要处理节假日、美股夏令时及数据延迟。Skill 调用既有行情源查询当前状态，模型解释结果。无触发时可以最终返回 `[NO_REPLY]`，后台任务就不发消息。

少量低频查询可先通过 `action: agent` 的计划调用 Skill。若将来需要每分钟监控很多标的，建议加确定性数据轮询工具，只在规则触发时调用模型。当前代码没有内置报价轮询、交易日历或告警阈值引擎。

## 新增业务工具

- `src/tools.ts`：定义给模型看的名称、说明和 TypeBox 参数。
- `src/services.ts`：参数校验和实际业务行为；使用当前 Agent / Run 上下文确定数据范围，不接受模型自由指定其他 Agent ID。
- `src/store.ts`：需要结构化存储时增加表与迁移。
- 默认工具通过事务中的 `(run_id, tool_call_id)` 回执避免同一调用重复执行。外部 API 的写操作还需要它自己的幂等机制。

健康记录是这个扩展模式的现成例子。若要新增技能而不改源码，可先使用现成 Skill 加 bash 脚本；复杂业务写操作更适合做自定义工具。

## 自定义模型接口

在配置中指定 `modelsFile: ./models.json`，例如：

```json
{
  "providers": {
    "my-provider": {
      "baseUrl": "https://your-model-endpoint.example/v1",
      "api": "openai-completions",
      "apiKey": "$MY_MODEL_API_KEY",
      "models": [
        {
          "id": "your-model-id",
          "name": "My model",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 32768,
          "maxTokens": 4096,
          "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
        }
      ]
    }
  }
}
```

然后为 Agent 配置：

```yaml
model:
  provider: my-provider
  id: your-model-id
  apiKeyEnv: MY_MODEL_API_KEY
```

上述限额和零价格只是格式示例，请按实际供应商填写，不代表免费。接口必须支持流式响应和工具调用。模型参数与供应商兼容选项以固定依赖版本的 Pi 文档为准。

修改模型设置后重启；如果希望全新上下文，在私聊使用 `/new`。SDK 历史不设计成可直接迁移到 Claude Agent SDK。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| main.ts | 初始化、单实例锁、控制台/飞书模式、退出 |
| config.ts | YAML 校验、目录、凭据引用 |
| feishu.ts | 飞书身份/消息过滤、长连接和发送 |
| dispatcher.ts | 命令、串行/并行队列、取消、结果投递 |
| scheduler.ts | 时间解析、计划管理、到期触发 |
| agent.ts | Pi Session、模型、资源及事件桥接 |
| tools.ts | 模型可调用工具定义 |
| services.ts | 业务工具实现与调用回执 |
| store.ts | SQLite 状态、业务记录与恢复 |

SQLite 是应用状态的依据，Pi 文件是模型对话的依据。两者与工作区共同备份；不要把“恢复对话”理解为恢复或撤销文件系统修改。
