# dsh-pet-bibo-voice 🐟🔊

给 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 加一套「哔哔啵啵」声音：桌宠和你说的话、自己待机时的碎碎念、带文字的表情，开口时都按字合成对应的 bibo 声。

- 不录音、不联网、不调 TTS 服务：一条锯齿波 + 两个带通滤波器，本地合成。
- 一个字一声，同一个字永远是同一声；问号尾音上扬、感叹号整句升高、省略号压低。
- 两种声线：**大肥鱼**（高音、活泼）与 **路墨**（低音、冷淡）。
- 桌宠在网页、桌面窗口还是独立模式都生效——声音走 dsh-pet 自己的播放链路，不在本插件里另造一套。
- 自带设置页（设置 → 桌宠声音），支持试听、换声线、调音量、一键还原。

声音算法与听感来自哔哩哔哩「哈基科技 / Lumoswitch」《路墨小剧场》以及开源项目 [hakihakii/bibibobo](https://github.com/hakihakii/bibibobo)（MIT）。本插件只做适配与封装。

## 怎么工作

dsh-pet 公开了两个对接面，本插件只用这两个：

1. **宿主侧**：`ctx.provide('petApi7340', { voice: { register, list } })`
   本插件注册一个 provider `bibo`（音色 `fish` / `lumo`，输出 WAV）。dsh-pet 的 `/voice/speak` 因此能把任意一句话交给它合成。
2. **浏览器侧**：dsh-pet 设置页使用的 `GET /config` / `PUT /config`
   本插件把 dsh-pet 的 `voiceName` 指到 `bibo/*`，并打开它的 `voiceEnabled`、`voiceWhisperEnabled` 两个开关。之后 dsh-pet 自己会在正确的表面播放：
   - 对话回复 → `voiceEnabled`；
   - 待机碎碎念 / 带文字的表情 → `voiceWhisperEnabled`。

**不修改 dsh-pet 的任何文件，不 import 它的模块，不依赖气泡 DOM / 动画名 / 状态轮询的内部实现。** 它更新时只要还保留上面两个公开面，本插件就继续工作。

### 更新不失效的几道保险

| 风险 | 处理 |
| --- | --- |
| dsh-pet 启动比本插件晚 | 宿主每 2.5 秒探测一次，30 秒后放缓到 15 秒 |
| dsh-pet 热重载，注册表换新 | 发现 `voice.list()` 里没有 `bibo` 就重新注册；旧 disposer 先摘掉 |
| 没有 `petApi7340` 或没有 `voice.register` | 只降级：设置页显示「引擎未接入」，不抛错，不影响桌宠本身 |
| `GET /config` 形状变了 / 字段缺失 | 只提示，不写配置，避免弄坏桌宠设置 |
| 用户在 dsh-pet 设置里把语音改掉 | 浏览器侧每 20 秒对账一次，发现漂移会重新写回 |
| 用户已经开着别的语音 | **不自动抢占**，只在设置页提示；想切换点「立即接管」 |
| 想彻底退出 | 设置页「恢复原设置」把语音开关、音色、音量换回接管前的值 |

接管前会把 dsh-pet 原来的 `voiceEnabled` / `voiceWhisperEnabled` / `voiceName` / `voiceVolume` 存进浏览器 `localStorage`（键 `dsh-pet-bibo-voice:settings:v1`）；「恢复原设置」就是把这几个值写回去。

## 安装

```bash
dsh plugin --profile desktop add link:/Users/yangletian/Documents/deepseek-harness/default-workspace/adapted/dsh-pet-bibo-voice
```

或在 DSH 插件管理里安装本地目录。安装后刷新页面，打开 **设置 → 桌宠声音** 可以看到状态；第一次会自动接管（如果桌宠原本没有开语音），并让桌宠说一句「哔哔啵啵，听得到吗？」作为安装自检——听到这一声就说明整条链路通了。

> **卸载前**请先在设置页点「恢复原设置」，否则 dsh-pet 的 `voiceName` 会停留在 `bibo/fish`，卸载后它会找不到这个音色。

## 设置页

- **启用哔哔啵啵**：接管 / 停用。
- **声线**：大肥鱼 / 路墨；切换会立即写回 dsh-pet。
- **音量**：写到 dsh-pet 的 `voiceVolume`，只影响播放音量。
- **本地试听**：走宿主侧同一个合成引擎，听到的就是桌宠会播的。
- **让桌宠说**：通过 dsh-pet 自己的 `/broadcast` 让桌宠真的说一句（气泡 + 声音），用来验证端到端链路。
- **立即接管**：即使 dsh-pet 已经在用别的语音也强制切换。
- **恢复原设置**：回到接管前的 dsh-pet 语音配置。

调试可以在 DevTools 里用 `window.__DSH_PET_BIBO__.status`、`.preview('一句话')`、`.tellPet('一句话')`、`.reconcile()`。

## 兼容性

- 需要 dsh-pet **0.4.x**（`petApi7340.voice.register` 与 `/config` 这套接口从 0.4 起提供）。
- DSH 侧只需要 `webServer`、`slots` 两个核心服务；缺 `webServer` 时只是设置页读不到状态，发声不受影响。
- Node 20+。无第三方运行时依赖。

## 排障

宿主日志：`~/.dsh/dsh-pet-bibo-voice/log.txt`
dsh-pet 自己的日志：`~/.dsh/dsh-pet/logs.txt`

常见状态：

- `引擎未接入：还没探测到 dsh-pet`：dsh-pet 没启用，或版本低于 0.4。
- `dsh-pet 已启用其他语音（xxx），未自动切换`：点「立即接管」。
- `配置里的 pets 形状不认识，未写入`：dsh-pet 大版本改了配置格式，本插件选择不写，避免弄坏配置；请提 issue。

## 许可

本插件代码 MIT。声音算法移植自 [hakihakii/bibibobo](https://github.com/hakihakii/bibibobo)，Copyright (c) 2026 hakihakii (Lumoswitch)，MIT。完整许可见 [LICENSE](LICENSE)。
