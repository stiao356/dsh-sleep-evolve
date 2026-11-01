# dsh-sleep-evolve · 睡眠进化

让大肥鱼在**睡眠期**（默认 00:10–05:30，本地时间）自动整理一天的经历，达成"今天的经历塑造明天的我"：

- **整理所有记忆卡**：surfcore 衰减记忆卡摘要 + 海马体 stream.jsonl（全部 DSH 会话流水）
- **全部 QQ 私聊 + QQ 群聊**：`state/social-v2.json` 的 `private:*` 与 `group:*` 会话近期消息
- **B站学习**：watch-history / scores / bili-memory / 私人日记
- **B站私信**：直连 B站 `get_sessions` 只读拉取（**不碰** surfcore 调度器每 5 秒轮询用的 `dm-await` 共享水位，避免偷走私信唤醒信号）

产出（只写 `~/.dsh/sleep-evolve/`，不碰 surfcore/海马体任何文件）：

| 文件 | 内容 |
| --- | --- |
| `journal.jsonl` | 进化笔记（只追加，每天最多 5 条） |
| `journal.md` | 最近 7 天汇总（鱼/主人快速读） |
| `human-world.md` | **每天一句**人格基质（带来源+修订号，删节即撤回） |
| `proposals.json` | 待确认提案：记忆卡操作（add/strengthen/merge/forget）与生活参数建议（**AI 只提议，主人确认后才可应用**） |
| `status.json` | 上次运行结果（失败可见：ok/code/error/hint） |
| `config.json` | 本插件配置（窗口/预算/汇报开关） |

## 与现有插件的分工（不冲突）

| 插件 | 白天职责 | 睡眠进化的角色 |
| --- | --- | --- |
| dsh-hippocampus | 在线记忆（stream.jsonl 只增不改） | 只读流水做夜间巩固 |
| surfcore 记忆卡 | 每 10 分钟维护 + 每天 4 点衰减 | 只读摘要，出"待确认提案"，不写卡 |
| dsh-seekmemory | 检索内核 | 不碰 |
| dsh-plugin-efficiency-notes | 提示词纪律 | 无交集 |
| dsh-plugin-whale-pet | 桌面宠物 | 无交集 |

## 安全与预算

- 只写自己的目录；B站私信汇报复用 surfcore `bili.mjs dm`（写死只发主人、须互关、≤300 字）。
- 预算硬闸：`maxInputChars` 60k / `maxRequests` 2 / `maxTokens` 8k / `timeoutMs` 240s；失败写 status、不重试。
- 触发前检查：睡眠窗口内 + 当天没跑过 + 最近 60 分钟 QQ 无动静（不跟聊天抢额度）。
- 输出强制脱敏（QQ 号打码），提示词要求"只基于证据、不编造、AI 只提议不生效"。

## 工具（任意 DSH 会话可用）

- `sleep_evolve_status` / `sleep_evolve_run`（force=true 强制）/ `sleep_evolve_journal` / `sleep_evolve_proposals`

## 配置示例（`~/.dsh/sleep-evolve/config.json`）

```json
{
  "window": { "start": "00:10", "end": "05:30" },
  "report": { "enabled": true, "maxChars": 280 },
  "maxInputChars": 60000,
  "maxTokens": 8000
}
```
