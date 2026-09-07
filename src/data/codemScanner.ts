/**
 * CodeM 会话数据层 — 读取飞书 CodeM CLI 的会话 .jsonl，构建会话卡片
 *
 * 依赖：Node.js fs（Obsidian Electron 环境可用）
 * 数据源：~/.codem/sessions/<项目hash>/<sessionId>.jsonl
 * 默认根目录在 settings.ts::getCodemRootDir()，用户可在设置页覆盖。
 *
 * CodeM jsonl 事件类型（与 Claude Code 不同，注意不要混用 sessionScanner 解析器）：
 *   header         会话起始（started_at / cwd / profile / model），无 ai-title 事件
 *   user_message   用户提问，content 为字符串
 *   turn_request   向模型请求（内嵌 system/消息，无需展示）
 *   turn_response  模型响应（response_json.content[] → thinking / text / tool_use）
 *   tool_call      工具调用（name + input）
 *   tool_result    工具结果
 *   turn_end / usage / hook_execution / governance_snapshot  辅助事件，跳过
 *
 * 收割（session-harvest）在 CodeM 里是斜杠技能触发（本地 `codem` CLI 与飞书侧『收割当前会话』均会触发）：
 *   - user_message 原文（【原文】）含「收割/归档/收尾」等触发词
 *   - 斜杠技能调用事件 user_invocation（input.kind==='skill'，name='session-harvest'）
 *   - 兜底 model_input 事件内含 <command-name>session-harvest</command-name>（SKILL 定义注入）
 *   - 任一命中即视为已收割。是否落地成稿本插件不追踪，只保留"是否收割过"标签
 *
 * 增量缓存：独立 codemFileCache（与 sessionScanner 的 fileCache 互不干扰）。
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractText, extractProjectRef, type HarvestStatus, type SessionCard, type SessionDetail, type SessionRaw, type TurnBlock } from './sessionScanner';
import { getHarvestSkillNames as getHarvestSkillNamesConfig } from './settings';

/** 生效收割技能名名单：用户配置 ∪ 默认名（统一小写），CodeM 的 skill 名匹配走同一名单 */
function resolveHarvestSkillNames(): string[] {
  const set = new Set<string>(['session-harvest', 'session_harvest', 'sessionharvest']);
  const configured = getHarvestSkillNamesConfig();
  if (Array.isArray(configured)) {
    for (const n of configured) set.add(String(n).toLowerCase().replace(/-/g, ''));
  }
  return [...set];
}

// ===== 扫描缓存（性能优化：增量扫描） =====
// 与 Claude 会话缓存同策略：文件大小 + 最后修改时间未变 → 跳过重新解析
interface CodemMeta {
  aiTitle: string;
  firstPrompt: string;
  startTime: string;
  lastTime: string;
  userTurns: number;
  toolCalls: number;
  cwd: string;
  /** 收割状态（CodeM 斜杠技能：user_message 原文含「收割/归档/收尾」等触发词） */
  harvestStatus: HarvestStatus;
  /** 最后一次收割指令的 ISO 时间 */
  lastHarvestAt: string | null;
}
const codemFileCache = new Map<string, { size: number; mtimeMs: number; meta: CodemMeta | null }>();

/** 收割触发词（仅保留具备强收割语义的词——真实执行必然伴随 user_invocation / SKILL 加载等硬信号兜底，此处不过度宽泛）
 *  · 「收割」：用户飞书/本地直接发「收割当前会话」「收割」
 *  · session-harvest：显式点名 skill
 *  ⚠️ 不收录「归档/收尾/总结对话」——系统自检/收尾提示语里频繁出现（实测 AI先锋大赛会话被「收尾」误标），弱词交由 user_invocation/model_input 兜底 */
const HARVEST_KEYWORDS = ['收割', 'session-harvest', 'session harvest'];

/** 系统注入的消息前缀：AI 主动注入（skill 定义/system-reminder 等）不是用户真实指令，不能当作收割请求 */
const SYSTEM_INJECT_CHARS = ['<system-reminder>', '<command-name>', '<skill-instructions', 'Base directory for this skill', 'The following skill was loaded earlier'];

/** 判断一段 user 原文（已抽【原文】）是否包含收割触发词——仅用户真实输入，排除系统注入 */
function isHarvestRequest(text: string): boolean {
  if (!text) return false;
  // 排除系统注入：skill 定义 / system-reminder 里必然出现的收割策略词（如 CLAUDE.md 中「会话归档 → session-harvest」）
  if (SYSTEM_INJECT_CHARS.some((s) => text.startsWith(s))) return false;
  return HARVEST_KEYWORDS.some((kw) => text.includes(kw));
}

/** 校验缓存是否可用（文件大小 + mtime 未变） */
function codemCacheValid(key: string, size: number, mtimeMs: number): boolean {
  const c = codemFileCache.get(key);
  return !!c && c.size === size && c.mtimeMs === mtimeMs;
}

/** 生成 CodeM 卡片默认标题（CodeM 无 ai-title 事件）：首问前 40 字 */
export function codemDefaultTitle(firstPrompt: string): string {
  return firstPrompt.slice(0, 40) || '(无标题)';
}

/** 从飞书 IM 入参包裹中抽取「【原文】」内容（无包裹时返回空串） */
function extractImOriginal(text: string): string {
  if (!text.includes('飞书 IM 输入：')) return '';
  const m = text.match(/【原文】\s*([\s\S]*?)(?=\n\s*【上下文】|$)/);
  return m ? m[1].trim() : '';
}

/**
 * 解析飞书 IM 入参包裹 → 提炼后的用户原话 + 附加信息（上下文/用户实体）。
 * 提炼规则：去掉「飞书 IM 输入：」头标签，正文只保留【原文】；
 * 上下文（chat_id/message_id）与用户实体 JSON 收进 extra 供折叠查看，不污染主文本。
 */
function parseImEnvelope(text: string): { original: string; extra: { key: string; value: string }[] } {
  if (!text.includes('飞书 IM 输入：')) return { original: text, extra: [] };
  const extra: { key: string; value: string }[] = [];
  const ctxM = text.match(/【上下文】\s*([\s\S]*?)(?=\n\s*(【用户实体】|$))/);
  if (ctxM?.[1]?.trim()) extra.push({ key: '上下文', value: ctxM[1].trim() });
  const entM = text.match(/【用户实体】\s*([\s\S]*?)\s*$/);
  if (entM?.[1]?.trim()) extra.push({ key: '用户实体', value: entM[1].trim() });
  return { original: extractImOriginal(text), extra };
}

// ===== 单会话元信息解析 =====

/**
 * 流式按行解析单个 CodeM .jsonl，抽元信息。
 * 映射到 SessionRaw 便于上层复用统一的卡片构建逻辑。
 *
 * 收割判定（CodeM 斜杠/飞书「收割当前会话」）：user_message 原文（【原文】）出现收割触发词即视为已收割。
 */
export async function parseCodemSessionFile(filePath: string): Promise<SessionRaw | null> {
  return new Promise((resolve) => {
    let firstPrompt = '';
    let startTime = '';
    let lastTime = '';
    let userTurns = 0;
    let toolCalls = 0;
    let cwd = '';
    const textChunks: string[] = [];
    let sawHarvestReq = false;     // 出现收割触发词
    let lastHarvestReqAt: string | null = null;

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    let buf = '';

    stream.on('data', (chunk: Buffer | string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const t = obj.type;
        const at = obj.at as string | undefined;
        if (at) {
          if (!startTime) startTime = at;
          lastTime = at;
        }
        if (t === 'header') {
          // header 可能不在文件首行前面（一般首行），cwd 只取一次
          if (obj.cwd && !cwd) cwd = obj.cwd as string;
        } else if (t === 'user_message') {
          const text = extractText(obj.content);
          if (text) {
            // 飞书 IM 入参包裹时抽「【原文】」作为标题，避免卡片标题显示“飞书 IM 输入：”整段模板
            const displayText = extractImOriginal(text) || text;
            // 系统注入的消息（skill 定义 / system-reminder 等）不是用户真实提问，不计轮次、不做收割判定
            const isSystemInjected = SYSTEM_INJECT_CHARS.some((s) => text.startsWith(s));
            if (!isSystemInjected) {
              userTurns++;
              if (!firstPrompt) firstPrompt = displayText.slice(0, 200);
              if (textChunks.length < 3) textChunks.push(displayText);
              // 收割触发词在用户原文（proto【原文】）里命中 → 记收割请求
              if (isHarvestRequest(displayText)) {
                sawHarvestReq = true;
                if (at) lastHarvestReqAt = at;
              }
            }
          }
        } else if (t === 'tool_call') {
          toolCalls++;
        } else if (t === 'user_invocation') {
          // 斜杠技能调用：input.kind==='skill' 且 name 命中收割技能名单（本地 / 收割 与飞书侧『收割当前会话』均产生此事件）
          const input = obj.input;
          if (input && input.kind === 'skill' && typeof input.name === 'string') {
            const skillName = String(input.name).toLowerCase().replace(/-/g, '');
            const isHarvest = resolveHarvestSkillNames().some((n) => skillName.includes(n)) || input.name.includes('收割');
            if (isHarvest) {
              sawHarvestReq = true;
              // 收割指令本身是一条用户真实发起的轮次（user_invocation 独立于 user_message）→ 计入 userTurns，卡片轮数才一致
              userTurns++;
              if (at) lastHarvestReqAt = at;
            }
          }
        } else if (t === 'model_input') {
          // 兜底：user_invocation 后的 model_input 携带 SKILL 定义正文（<command-name>session-harvest</command-name> 等）
          const contentStr = typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content ?? '');
          const target = contentStr.match(/<command-name>\s*\/?\s*([^<\s]+)\s*<\/command-name>/);
          const cmd = target ? target[1].toLowerCase().replace(/-/g, '') : '';
          if (cmd && resolveHarvestSkillNames().some((n) => cmd.includes(n))) {
            sawHarvestReq = true;
            if (at) lastHarvestReqAt = at;
          }
        }
      }
    });

    stream.on('end', () => {
      if (buf.trim()) {
        try {
          const obj = JSON.parse(buf);
          if (obj.type === 'header' && obj.cwd && !cwd) cwd = obj.cwd as string;
        } catch {
          /* ignore */
        }
      }
      const harvestStatus: HarvestStatus = sawHarvestReq ? 'harvested' : 'none';
      resolve({
        aiTitle: codemDefaultTitle(firstPrompt),
        firstPrompt,
        startTime,
        lastTime,
        userTurns,
        toolCalls,
        cwd,
        textChunks,
        skills: [],
        // CodeM 无 Skill 工具；收割状态 = 是否有收割触发词
        lastHarvestAt: lastHarvestReqAt,
        harvestIsLast: sawHarvestReq,
        harvestStatus,
      });
    });

    stream.on('error', () => resolve(null));
  });
}

// ===== 完整轮次解析（详情视图用） =====

export interface CodemBlockStats {
  textBlockCount: number;
  thoughtBlockCount: number;
}

/**
 * 从一条 turn_response 的 response_json.content[] 提取内容块。
 * CodeM 实测存在多种 content 形状（0.8.x）：
 *  - {type:'thinking', thinking:'...'} / {type:'text', text:'...'}         —— 标准 assistant 轮
 *  - {type:'thinking', thinking:'...'} / {type:'tool_use', name, input}    —— Claude 风格、经桥接
 *  - {type:'thinking', thinking:'...'}                                    —— 纯思考轮（无最终输出）
 * 二者映射到 UI 统一的 TurnBlock（text / thinking / tool_use）。
 * 额外回传 textBlockCount/thoughtBlockCount：
 *   - 无 text 块 → 该轮是「思考中」中间轮，详情跳过展示，冗余标题不再出现
 *   - 有 text 块（无论是否伴随 thinking）→ 该轮保留，text 块是「完整最终答复」
 *     （飞书场景下是"发送到 IM 的完整文本"，一定显式持久展示，不做隐藏）
 */
export function parseCodemResponseBlocks(contentJson: unknown): { blocks: TurnBlock[]; stats: CodemBlockStats } {
  const blocks: TurnBlock[] = [];
  let textBlockCount = 0;
  let thoughtBlockCount = 0;
  if (Array.isArray(contentJson)) {
    for (const b of contentJson) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
        thoughtBlockCount++;
        blocks.push({ kind: 'thinking', content: b.thinking });
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        textBlockCount++;
        blocks.push({ kind: 'text', content: b.text });
      } else if (b.type === 'tool_use') {
        const name = typeof b.name === 'string' ? b.name : '';
        // 飞书 CodeM 的最终答复：tool_use 名为 final_answer，其 input.summary 即发送到 IM 的正文。
        // 必须显式作为 text 块展示，否则一句话回复会被塞进工具 JSON 折叠块，阅读性极差。
        if (name === 'final_answer' && b.input && typeof b.input.summary === 'string' && b.input.summary.trim()) {
          textBlockCount++;
          blocks.push({ kind: 'text', content: b.input.summary });
          continue;
        }
        const input = typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}, null, 2);
        blocks.push({ kind: 'tool_use', label: name, content: input.slice(0, 2000) });
      }
    }
  }
  return { blocks, stats: { textBlockCount, thoughtBlockCount } };
}

/**
 * 读取单个 CodeM 会话的完整轮次（详情视图用）。
 * 事件映射：
 *   user_message    → user 轮（text 块）
 *   turn_response   → assistant 轮（response_json.content[] 的 thinking/text 块）
 *   tool_call       → tool 轮（tool_use 块，label=工具名，content=tool input JSON）
 *   tool_result     → tool 轮（tool_result 块，content=文本结果）
 * 其余事件跳过。userPrompts 收集 user 轮文本用于「我的提问」快捷定位。
 */
export async function parseCodemSessionTurns(filePath: string): Promise<SessionDetail | null> {
  return new Promise((resolve) => {
    const aiTitle = '';
    let cwd = '';
    let startTime = '';
    let lastTime = '';
    const turns: { role: 'user' | 'assistant' | 'tool'; blocks: TurnBlock[]; timestamp: string; lineIndex: number }[] = [];
    const userPrompts: { lineIndex: number; text: string }[] = [];

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    let buf = '';
    let lineIndex = 0;

    stream.on('data', (chunk: Buffer | string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const currentLine = lineIndex;
        lineIndex++;
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const t = obj.type;
        const at = obj.at as string | undefined;
        if (at) {
          if (!startTime) startTime = at;
          lastTime = at;
        }
        if (t === 'header') {
          if (obj.cwd && !cwd) cwd = obj.cwd as string;
        } else if (t === 'user_message') {
          const text = extractText(obj.content);
          if (text) {
            // 系统注入的消息（skill 定义 / system-reminder 等）不是用户真实提问，跳过（详情不展示、不进 userPrompts）
            const isSystemInjected = SYSTEM_INJECT_CHARS.some((s) => text.startsWith(s));
            if (isSystemInjected) continue;
            // 飞书 IM 自动包裹：提炼用户原话为主文本（显式展示），上下文/用户实体收进折叠附加块
            const isImEnvelope = text.includes('飞书 IM 输入：');
            const { original, extra } = isImEnvelope ? parseImEnvelope(text) : { original: text, extra: [] as { key: string; value: string }[] };
            const blocks: TurnBlock[] = [{ kind: 'text', content: original }];
            if (extra.length) blocks.push({ kind: 'structured', label: '飞书附加信息', content: JSON.stringify(Object.fromEntries(extra.map((x) => [x.key, x.value])), null, 2) });
            turns.push({ role: 'user', blocks, timestamp: at || '', lineIndex: currentLine });
            userPrompts.push({ lineIndex: currentLine, text: original.slice(0, 100) });
          }
        } else if (t === 'user_invocation') {
          // 斜杠技能调用（如 /session-harvest）是一条用户发起的真实轮次 → 详情也展示，参与「我的提问」跳转
          const input = obj.input as any;
          const label = input && typeof input === 'object' ? (input.name || input.kind || '技能') : '技能';
          turns.push({
            role: 'user',
            blocks: [{ kind: 'text', content: `/${label}` }],
            timestamp: at || '',
            lineIndex: currentLine,
          });
          userPrompts.push({ lineIndex: currentLine, text: `/${label}` });
        } else if (t === 'turn_response') {
          const { blocks, stats } = parseCodemResponseBlocks(obj.response_json?.content);
          if (blocks.length && stats.textBlockCount > 0) {
            turns.push({ role: 'assistant', blocks, timestamp: at || '', lineIndex: currentLine });
          }
        } else if (t === 'tool_call') {
          const name = typeof obj.name === 'string' ? obj.name : (typeof obj.tool_name === 'string' ? obj.tool_name : '工具');
          const input = obj.input ?? obj.request_json;
          turns.push({
            role: 'tool',
            blocks: [{ kind: 'tool_use', label: name, content: typeof input === 'string' ? input.slice(0, 2000) : JSON.stringify(input ?? {}, null, 2).slice(0, 2000) }],
            timestamp: at || '',
            lineIndex: currentLine,
          });
        } else if (t === 'tool_result' || t === 'hook_execution') {
          // tool_result：微信中 protocol=feishu_bridge 时以 standard_input 包裹，需解包；老格式 content 为 string/string[]
          // hook_execution：挂勾执行回显（tool_name + blocked + exit_code），归入工具结果块统一展示
          let content = '';
          if (t === 'tool_result') {
            if (typeof obj.content === 'string') content = obj.content;
            else if (Array.isArray(obj.content)) content = obj.content.map((x: any) => (typeof x === 'string' ? x : (x?.text ?? ''))).join('');
            else if (obj.content && typeof obj.content.standard_input === 'string') content = obj.content.standard_input;
          } else {
            const nm = typeof obj.tool_name === 'string' ? obj.tool_name : '';
            content = `${nm ? `${nm} · ` : ''}exit=${obj.exit_code ?? '?'}${obj.blocked ? ' · blocked' : ''}${obj.elapsed_ms ? ` · ${obj.elapsed_ms}ms` : ''}`;
          }
          if (content.trim()) {
            turns.push({
              role: 'tool',
              blocks: [{ kind: 'tool_result', content: content.slice(0, 3000) }],
              timestamp: at || '',
              lineIndex: currentLine,
            });
          }
        }
      }
    });

    stream.on('end', () => {
      if (buf.trim()) {
        try {
          const obj = JSON.parse(buf);
          if (obj.type === 'header' && obj.cwd && !cwd) cwd = obj.cwd as string;
        } catch {
          /* ignore */
        }
      }
      resolve({
        sessionId: '',
        aiTitle: aiTitle || codemDefaultTitle(userPrompts[0]?.text || ''),
        cwd,
        startTime,
        lastTime,
        turns: turns as SessionDetail['turns'],
        userPrompts,
      });
    });

    stream.on('error', () => resolve(null));
  });
}

// ===== 扫描入口 =====

/**
 * 根据会话 jsonl 行的关键词推断发起入口。
 * CodeM 没有 Clichd 的 cwd 编码判断法，只能靠内容特征：
 *   - header.cwd = ~/CodeM/playgrounds/default         → 飞书侧启动
 *   - user_message 含「飞书 IM 输入：」前缀             → 飞书侧启动
 *   - 其余（cwd 为任意工作目录）                         → 命令行
 */
export function detectCodemEntrySource(meta: CodemMeta): string {
  const cwd = (meta.cwd || '').toLowerCase();
  const prompt = (meta.firstPrompt || '');
  if (cwd.includes('codem') && cwd.includes('playgrounds')) return '飞书';
  if (prompt.startsWith('飞书 IM 输入')) return '飞书';
  return '命令行';
}

/** 扫描 CodeM 根目录下全部项目的会话 .jsonl（全量，不分 vault）。
 *  @param knownProjectPaths 已知项目目录相对路径列表（来自 projectScanner），
 *    用于对 CodeM 会话做三线索项目归属（cwd / @引用 / 标题语义）——与 Claude 一致。
 */
export async function scanCodemSessions(rootDir: string, knownProjectPaths: string[] = []): Promise<SessionCard[]> {
  let childDirs: string[];
  try {
    childDirs = await fs.promises.readdir(rootDir);
  } catch {
    return [];
  }

  const jsonlFiles: string[] = [];
  for (const d of childDirs) {
    const dirPath = path.join(rootDir, d);
    try {
      const st = await fs.promises.stat(dirPath);
      if (!st.isDirectory()) {
        // 兼容直接放在根目录下的 .jsonl（结构性容忍）
        if (d.endsWith('.jsonl')) jsonlFiles.push(dirPath);
        continue;
      }
    } catch {
      continue;
    }
    const files = await fs.promises.readdir(dirPath).catch(() => [] as string[]);
    for (const f of files) {
      if (f.endsWith('.jsonl')) jsonlFiles.push(path.join(dirPath, f));
    }
  }

  const cards: SessionCard[] = [];
  for (const filePath of jsonlFiles) {
    const sessionId = path.basename(filePath).replace(/\.jsonl$/, '');

    let st: fs.Stats;
    try {
      st = await fs.promises.stat(filePath);
    } catch {
      continue;
    }
    let meta: CodemMeta | null;
    if (codemCacheValid(filePath, st.size, st.mtimeMs)) {
      meta = codemFileCache.get(filePath)!.meta;
    } else {
      const raw = await parseCodemSessionFile(filePath);
      meta = raw
        ? {
            aiTitle: raw.aiTitle,
            firstPrompt: raw.firstPrompt,
            startTime: raw.startTime,
            lastTime: raw.lastTime,
            userTurns: raw.userTurns,
            toolCalls: raw.toolCalls,
            cwd: raw.cwd,
            harvestStatus: raw.harvestStatus,
            lastHarvestAt: raw.lastHarvestAt,
          }
        : null;
      codemFileCache.set(filePath, { size: st.size, mtimeMs: st.mtimeMs, meta });
    }
    if (!meta) continue;
    // 过滤「空会话」：仅 header 行的占位文件（启动 CLI 但未发生任何对话即退出会留下此文件）。
    // 文件无 startTime/lastTime/userTurns/toolCalls → 无内容可展示，不列入列表。
    // 真实 CodeM 会话 header 自带 started_at，一旦产生 user_message 必然非空。
    if (!meta.startTime && !meta.lastTime && !meta.userTurns && !meta.toolCalls) continue;

    // 项目归属（与 Claude 同源三线索）：cwd / @文件引用 / 标题语义
    const projectRef = extractProjectRef(textChunksOf(meta), knownProjectPaths, meta.cwd, meta.aiTitle);
    cards.push({
      sessionId,
      agent: 'codem',
      aiTitle: meta.aiTitle,
      firstPrompt: meta.firstPrompt,
      startTime: meta.startTime,
      lastTime: meta.lastTime,
      userTurns: meta.userTurns,
      toolCalls: meta.toolCalls,
      cwd: meta.cwd,
      projectRef,
      filePath,
      entrySource: detectCodemEntrySource(meta),
      skills: [],
      harvestStatus: meta.harvestStatus,
      lastHarvestAt: meta.lastHarvestAt,
    });
  }

  cards.sort((a, b) => (b.lastTime || '').localeCompare(a.lastTime || ''));
  return cards;
}

/** CodemMeta → textChunks（供 extractProjectRef 三线索匹配）：首问 + 会话标题 */
function textChunksOf(meta: CodemMeta): string[] {
  const chunks: string[] = [];
  if (meta.firstPrompt) chunks.push(meta.firstPrompt);
  if (meta.aiTitle && meta.aiTitle !== meta.firstPrompt) chunks.push(meta.aiTitle);
  return chunks;
}