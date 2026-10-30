# ccstatus-band

[English](README.md) · **中文**

Claude Code 桌面版的 mod：在输入框上方的条带里画一张小表，显示模型此刻写得多快、上一轮花了多少、本会话累计多少。

![输入框上方的条带](assets/band.png)

```
     tok/s · out ·   in ·   hit · total
live  ~96 · 726
last   58 · 16.8k · 138k · 97.3%
sess   55 · 726 · 138k · 97.3% · 5.0M
```

同一个指标永远在同一列，扫读时竖着看一列就行。每个值按该列最宽的一项右对齐；会消失的 live 行也保留位置，不会把下面几行顶走。

## 每一行的含义

| 行 | 字段 | 含义 |
| --- | --- | --- |
| `live` | `tok/s` | 正在输出这条回复的解码速度，**估算值**（见下文） |
| | `out` | 这条回复到目前为止的输出 token 估算值 |
| `last` | `tok/s` | 刚结束这一轮的解码速度：输出 token ÷ 生成耗时，不含工具执行时间 |
| | `out` | 这一轮模型输出的 token |
| | `in` | 这一轮**未命中**提示缓存的输入 token |
| | `hit` | 这一轮提示 token 的缓存命中率 |
| `sess` | `tok/s` | 本会话整体解码速度：全部输出 token ÷ 全部生成耗时 |
| | `out` | 本会话全部输出 token |
| | `in` | 本会话全部未缓存输入 token |
| | `hit` | 本会话缓存命中率 |
| | `total` | 本会话实际承载的全部 token：未缓存输入 + 缓存读 + 缓存写 + 输出 |

只有 `live` 是估算。API 只在一条回复的最后一个 chunk 里报一次 token 数，流式过程中没有可计数的东西；条带把中文/日文/韩文字符按 1 个 token、其他字符按 0.25 个 token 折算，回复结束时立刻换成 API 的真实数字。它适合看"现在快不快"，不适合拿去对账。

## 数字从哪来

`live` 之外全部是 API 自己的账，来自引擎的 `turn.step` 与 `turn.complete` 事件：

- **按请求累加，不按轮。** 一轮通常包含多次请求（回答 → 调工具 → 再回答）。部分网关只在 `turn.complete` 报最后一次请求的用量，本 mod 改为在每次请求的 `stop` chunk 处累加，所以 `last` 是整轮的真值。
- **不计子代理。** 子代理跑自己的循环，把它的 token 混进会话速度会让这个数失去意义。
- **全零的轮次直接跳过。** 网关偶尔用一个全 0 的 usage 回包作答，此时条带保留上一次的数字，而不是刷成 `0 tok/s`。

## 安装

桌面版会加载 `~/.claude/skills/` 下任何带 `.claude-plugin/plugin.json` 和 `hooks/hooks.json` 的目录：

```bash
git clone https://github.com/gzhang33/ccstatus-band.git ~/.claude/skills/ccstatus-band
```

重启会话（或新开会话）后条带即出现在输入框上方。删除该目录即可卸载。

也可以直接从本仓库的市场安装：

```
/plugin marketplace add gzhang33/ccstatus-band
/plugin install ccstatus-band --marketplace gzhang33/ccstatus-band
```

需要支持 mod 的 Claude Code 版本（`turn.step` / `turn.complete` 事件与 `AbovePrompt` 渲染目标），桌面版 2.1.x 起。

## 开发

```bash
claude plugin validate .      # 按引擎的方式校验清单与 hooks 模块
claude plugin test .          # 跑 tests/ 下的测试，跑的是真实 hook 引擎
```

结构：

- `hooks/register.tsx` —— 整个 mod：速率计算、整轮累加、表格渲染
- `types/index.d.ts` —— 存在 `$.state` 里的数据形状
- `tests/band.test.tsx` —— 解码速率口径、live 估算、全零轮次、行布局

## 已知限制

- 某项数值宽于列宽时（`5.0M` 的会话里出现 `10.5M` 的合计），该列会在本次会话余下时间右移一个字符。
- 每条回复结束到下一条开始时 `live` 为空（工具执行不是解码窗口），`last` 行位置不动。
- 不显示费用：需要每个模型的价目表，而这个 mod 常在多个网关后面使用。

## 许可

MIT，见 [LICENSE](LICENSE)。
