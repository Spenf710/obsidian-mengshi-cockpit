/**
 * 会话数据层 — 读取 Claude Code 的会话 .jsonl，构建会话卡片
 *
 * 依赖：Node.js fs（Obsidian Electron 环境可用）
 * 数据源：~/.claude/projects/<编码vault路径>/<sessionId>.jsonl
 *
 * 路径默认值在 settings.ts::getSessionRootDir()，用户可在设置页覆盖。
 */

import * as fs from 'fs';
import * as path from 'path';
import { getSessionRootDir, getHarvestSkillNames as getHarvestSkillNamesConfig } from './settings';

// ===== 扫描缓存（性能优化：增量扫描） =====
// 记录每个 .jsonl 文件的 文件大小 + 最后修改时间 → 未变化的文件跳过重新解析
// 元信息（标题/首问/轮数/项目归属）直接从缓存读取，避免重复 IO 解析
interface JsonlMeta {
  aiTitle: string;
  firstPrompt: string;
  startTime: string;
  lastTime: string;
  userTurns: number;
  toolCalls: number;
  cwd: string;
  projectPath: string | null;
  projectSource: string;
  projectEvidence: string;
  entrySource: string;
  skills: string[];
  /** 收割状态：harvested=会话中出现过收割调用；none=从未收割 */
  harvestStatus: HarvestStatus;
  /** 最后一次收割调用时间 ISO */
  lastHarvestAt: string | null;
}
const fileCache = new Map<string, { size: number; mtimeMs: number; meta: JsonlMeta | null }>();

/** 校验缓存是否可用（文件大小 + mtime 未变） */
function cacheValid(key: string, size: number, mtimeMs: number): boolean {
  const c = fileCache.get(key);
  return !!c && c.size === size && c.mtimeMs === mtimeMs;
}

// ===== 类型定义 =====

export interface ProjectRef {
  /** 项目目录相对路径，如「项目管理-系统/8.猛士驾驶舱插件」，无法归属时为 null */
  projectPath: string | null;
  /** 命中线索类型 */
  source: 'at-ref' | 'wikilink' | 'cwd' | 'none';
  /** 命中的原始证据（@引用或链接文本），用于调试/展示 */
  evidence: string;
}

/** 会话来源 Agent。claude = Claude Code，codem = 飞书 CodeM */
export type SessionAgent = 'claude' | 'codem';

/** 收割状态：harvested=会话中出现过收割调用（SKILL 工具 / 斜杠命令 / openInClaude 收割模式均会调用 Skill 工具）；none=从未收割 */
export type HarvestStatus = 'harvested' | 'none';

export interface SessionCard {
  sessionId: string;
  /** 所在数据源类型 */
  agent: SessionAgent;
  /** AI 自动生成的标题（取最后一条 ai-title 事件） */
  aiTitle: string;
  /** 用户首条 prompt，作主题预览 */
  firstPrompt: string;
  /** 会话开始时间 ISO */
  startTime: string;
  /** 会话最后活动时间 ISO */
  lastTime: string;
  /** .jsonl 文件最后修改时间 ISO（Claude 30 天清理按此判定，卡片/日期切片用它） */
  fileMTime: string;
  /** 用户真实提问轮次数（排除 tool_result 回传） */
  userTurns: number;
  /** 工具调用次数（tool_use 块数） */
  toolCalls: number;
  /** 工作目录 */
  cwd: string;
  /** 项目归属（三线索交叉） */
  projectRef: ProjectRef;
  /** .jsonl 文件绝对路径 */
  filePath: string;
  /** 会话发起入口：Obsidian / 命令行 / 未知 */
  entrySource: string;
  /** 会话内调用的 skill 名集合（判断日常操作：日志/周报等） */
  skills: string[];
  /** 收割状态：harvested=会话中出现过收割调用；none=从未收割 */
  harvestStatus: HarvestStatus;
  /** 最后一次收割调用时间 ISO */
  lastHarvestAt: string | null;
}

// ===== Vault 路径编码 =====

/**
 * Claude Code 把 cwd 编码成 projects 子目录名：
 * 盘符冒号、盘符冒号后的斜杠、路径分隔符、非 ASCII 字符 → 全部替换为连字符。
 * 例：E:\obsidian_md\猛士科技 → E--obsidian-md-----
 */
export function encodeVaultPath(vaultPath: string): string {
  // 逐字符映射：ASCII 字母数字原样保留，其余（: \ / _ . 非 ASCII）统一转连字符，不合并
  let out = '';
  for (const ch of vaultPath) {
    if (/[A-Za-z0-9]/.test(ch)) {
      out += ch;
    } else {
      out += '-';
    }
  }
  return out;
}

// ===== 文本提取 =====

/** 判断 user 消息是否是纯 tool_result 回传（非人的实际输入） */
export function isToolResultTurn(content: unknown): boolean {
  if (Array.isArray(content)) {
    return content.length > 0 && content.every((b: any) => b?.type === 'tool_result');
  }
  return false;
}

/** 判断 user 消息是否是系统自动注入（非人的实际输入）
 *  真实用户输入 content 是纯字符串，系统注入 content 是数组 */
export function isSystemInjected(obj: any): boolean {
  return Array.isArray(obj.message?.content) && !isToolResultTurn(obj.message?.content);
}

/** 从一行 message.content 提取纯文本（user 是字符串，assistant 是 block 数组） */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => {
        if (b && typeof b === 'object') {
          if (typeof b.text === 'string') return b.text;
          if (typeof b.thinking === 'string') return ''; // 跳过 thinking
          if (b.type === 'tool_use' || b.type === 'tool_result') return '';
        }
        return '';
      })
      .join('');
  }
  return '';
}

// ===== 项目归属提取（三线索） =====

/** 从会话文本中提取 @文件引用 和 [[链接]]，匹配项目目录 */
export function extractProjectRef(
  textChunks: string[],
  knownProjectPaths: string[],
  cwd: string,
  aiTitle?: string,
): ProjectRef {
  const joined = textChunks.join('\n');

  // 线索1：@文件引用
  const atRefs = [...joined.matchAll(/@([^\s,，()（）]+[^\s,，()（）.]*\.?(?:md)?)/g)].map((m) => m[1]);
  for (const ref of atRefs) {
    const hit = knownProjectPaths.find((p) => ref.startsWith(p) || ref.startsWith(p + '/'));
    if (hit) return { projectPath: hit, source: 'at-ref', evidence: `@${ref}` };
  }

  // 线索2：[[链接]]
  const wiki = [...joined.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].split('|')[0]);
  for (const link of wiki) {
    const hit = knownProjectPaths.find((p) => link.startsWith(p) || link.startsWith(p + '/'));
    if (hit) return { projectPath: hit, source: 'wikilink', evidence: `[[${link}]]` };
  }

  // 线索3：aiTitle / firstPrompt 语义匹配项目名
  // 提取每个项目的"核心名"（去掉数字前缀和通用后缀）
  const projectNameMap = new Map<string, { core: string; path: string }>();
  for (const p of knownProjectPaths) {
    const segments = p.split('/');
    const folderName = segments[segments.length - 1];
    const fullName = folderName.replace(/^\d+\.\s*/, '');
    // 核心名：去掉常见后缀词
    const core = fullName.replace(/(?:插件|系统|平台|工具|面板|模块|引擎|管理|助手|项目|开发|重构|自动化|智能体)$/, '');
    projectNameMap.set(fullName, { core: core || fullName, path: p });
  }

  // 用 aiTitle 和 firstPrompt 分别匹配
  const matchTexts = [aiTitle || '', textChunks[0] || ''].filter(Boolean);
  for (const text of matchTexts) {
    if (!text) continue;
    // 先试完整项目名匹配
    for (const [fullName, { path: p }] of projectNameMap) {
      if (text.includes(fullName)) {
        return { projectPath: p, source: 'at-ref', evidence: `标题匹配「${fullName}」` };
      }
    }
    // 再试核心名匹配（排除过于短的核心名避免误匹配）
    for (const [, { core, path: p }] of projectNameMap) {
      if (core.length >= 3 && text.includes(core)) {
        return { projectPath: p, source: 'at-ref', evidence: `标题匹配「${core}」` };
      }
    }
  }

  // 线索4：cwd 兜底
  if (cwd) return { projectPath: null, source: 'cwd', evidence: cwd };

  return { projectPath: null, source: 'none', evidence: '' };
}

// ===== 单会话解析 =====

export interface SessionRaw {
  aiTitle: string;
  firstPrompt: string;
  startTime: string;
  lastTime: string;
  userTurns: number;
  toolCalls: number;
  cwd: string;
  textChunks: string[];
  /** CodeM：是否出现过「飞书 IM 输入：」包裹（飞书侧发起）；Claude 侧无此语义，省略即可 */
  fromFeishu?: boolean;
  /** 会话内调用的 skill 名集合（识别日志/周报等日常操作） */
  skills: string[];
  /** 最后一次收割调用时间 ISO */
  lastHarvestAt: string | null;
  /** 会话中出现过收割调用 */
  harvestIsLast: boolean;
  /** 收割状态：harvested=会话中出现过收割调用；none=从未收割 */
  harvestStatus: HarvestStatus;
}

// ===== 日常操作 skill 识别 =====
// 命中这些 skill 的会话归入"日常"抽屉：日志、周报、日报、站会等
const DAILY_SKILLS = ['work-log-refine', 'weekly-report', 'lark-workflow-standup-report', 'lark-workflow-meeting-summary'];

/** 收割技能名变体兜底（不含用户配置）：默认名 + 常见变体，保持兼容 */
const DEFAULT_HARVEST_SKILL_NAMES = ['session-harvest', 'session_harvest', 'sessionHarvest'];

/** 获取生效的收割技能名名单：用户配置（settings）∪ 默认变体，统一小写。
 *  用户自定义命名（如 my-harvest）也能匹配，默认名始终兼容。 */
function resolveHarvestNames(): string[] {
  const set = new Set<string>();
  const configured = getHarvestSkillNamesConfig();
  if (Array.isArray(configured)) {
    for (const n of configured) set.add(String(n).toLowerCase());
  }
  for (const d of DEFAULT_HARVEST_SKILL_NAMES) set.add(d.toLowerCase());
  return [...set];
}

/** 从一行内容提取 <command-name>/xxx</command-name> 或 Skill("xxx") 调用的 skill 名 */
function extractSkillNames(content: unknown): string[] {
  const names: string[] = [];
  const str = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  for (const m of str.matchAll(/command-name>(.+?)<\/command-name/g)) {
    names.push(m[1].trim());
  }
  for (const m of str.matchAll(/Skill\(\s*["'](.+?)["']\s*\)/g)) {
    names.push(m[1].trim());
  }
  for (const sk of DAILY_SKILLS) {
    if (str.includes(sk)) names.push(sk);
  }
  return names;
}

/**
 * 判断一段 user 原文是否为收割指令（仅两种硬信号，讨论收割 ≠ 执行收割）：
 *   1. 斜杠命令注入：`<command-name>/<收割技能名></command-name>`（claude 会话用户消息里出现，执行收割的硬信号）
 *   2. SKILL 定义注入：user 消息含「<技能名> Skill」标题 + 该 SKILL 的 Base directory（执行收割时系统才会注入 SKILL.md 正文）
 * 命中即视为该会话执行过收割。**不包含**「文本提到收割字样」类宽松匹配，避免讨论收割被误判。
 */
function isHarvestInstruction(text: string): boolean {
  if (!text) return false;
  const names = resolveHarvestNames();
  // 1. 斜杠命令：<command-name>/session-harvest</command-name> 或 <command-message>session-harvest</command-message>
  for (const name of names) {
    if (text.toLowerCase().includes(`<command-name>${name}</command-name>`)) return true;
    if (text.toLowerCase().includes(`<command-message>${name}</command-message>`)) return true;
    if (text.toLowerCase().includes(`<command-name>/${name}</command-name>`)) return true;
  }
  // 2. SKILL 定义注入：heading 含「会话知识收割 Skill」+ Base directory for this skill
  if (text.includes('会话知识收割 Skill') && text.includes('Base directory for this skill')) return true;
  return false;
}

/** 流式按行解析单个 .jsonl，抽元信息 + 文本块（供项目归属分析） */
export async function parseSessionFile(filePath: string): Promise<SessionRaw | null> {
  return new Promise((resolve) => {
    let aiTitle = '';
    let firstPrompt = '';
    let startTime = '';
    let lastTime = '';
    let userTurns = 0;
    let toolCalls = 0;
    let cwd = '';
    let firstUserFound = false;
    const textChunks: string[] = [];
    const skills: string[] = [];
    // [收割元信息] 收割调用：记录每次收割触发的时间（SKILL 调用 / 斜杠命令 / user 发起的收割指令）；出现即视为已收割
    let lastHarvestAt: string | null = null;
    let sawHarvest = false;        // 是否出现过收割触发

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    let buf = '';

    stream.on('data', (chunk: Buffer | string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? ''; // 最后一行可能当前不完整，留到下次
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const t = obj.type;
        const ts = obj.timestamp as string | undefined;
        if (ts) {
          if (!startTime) startTime = ts;
          lastTime = ts;
        }
        if (obj.cwd && !cwd) cwd = obj.cwd;
        if (t === 'ai-title' && obj.aiTitle) aiTitle = obj.aiTitle as string;
        if (t === 'user' || t === 'assistant') {
          // 性能优化：tool_result 回传行（user 消息中的巨型 content）不参与 skill 提取，
          // 避免对超大对象 JSON.stringify + 正则扫描
          const content = obj.message?.content;
          const isToolTurn = isToolResultTurn(content);
          if (!isToolTurn) {
            const found = extractSkillNames(content);
            for (const n of found) if (!skills.includes(n)) skills.push(n);
          }
        }
        if (t === 'user') {
          // 跳过纯 tool_result 回传 + 系统注入的 skill/指令消息
          if (!isToolResultTurn(obj.message?.content) && !isSystemInjected(obj)) {
            userTurns++;
            const text = extractText(obj.message?.content);
            // [收割判定] 用户消息里出现收割指令（斜杠命令 / SKILL 定义注入）→ 该会话执行过收割
            if (isHarvestInstruction(text)) {
              sawHarvest = true;
              if (ts) lastHarvestAt = ts;
            }
            // 性能优化：textChunks 仅保留前 3 条，足够做项目归属三线索匹配（@引用/[[链接]]/标题）
            // 此前会把整场对话全量文本驻留内存（大会话可累积数 MB）
            if (text && textChunks.length < 3) {
              textChunks.push(text);
              if (!firstUserFound) {
                firstPrompt = text.slice(0, 200);
                firstUserFound = true;
              }
            } else if (!firstPrompt && text) {
              // 前 3 条已满时，firstPrompt 取后续第一条（避免丢失首问预览）
              firstPrompt = text.slice(0, 200);
            }
          }
        } else if (t === 'assistant') {
          // 统计 tool_use 块数 + 回收【收割】调用（Skill tool_use 且参数含 session-harvest）
          const content = obj.message?.content;
          const ts = obj.timestamp as string | undefined;
          if (Array.isArray(content)) {
            for (const b of content) {
              if (b?.type !== 'tool_use') continue;
              toolCalls++;
              // 收割判定：Skill 工具且入参定位到当前配置的收割技能名（默认 session-harvest，
              // 可配置成自己命名的收割 SKILL；input.skill / skill_name 变体兼容）
              const sn = (b.name === 'Skill' && b.input && 'skill' in b.input && typeof (b.input as any).skill === 'string')
                ? (b.input as any).skill
                : (b.name === 'Skill' && b.input && typeof (b.input as any).skill_name === 'string' ? (b.input as any).skill_name : '');
              if (sn && resolveHarvestNames().some((name) => sn.toLowerCase().includes(name))) {
                skills.push('session-harvest'); // 沿既有 skills 集合
                sawHarvest = true;
                if (ts) lastHarvestAt = ts;    // 取最后一次调用的时间
              }
            }
          }
        }
      }
    });

    stream.on('end', () => {
      if (buf.trim()) {
        try {
          const obj = JSON.parse(buf);
          if (obj.type === 'ai-title' && obj.aiTitle) aiTitle = obj.aiTitle;
        } catch {
          /* ignore */
        }
      }
      const harvestStatus: HarvestStatus = sawHarvest ? 'harvested' : 'none';
      resolve({ aiTitle, firstPrompt, startTime, lastTime, userTurns, toolCalls, cwd, textChunks, skills, lastHarvestAt: lastHarvestAt || null, harvestIsLast: sawHarvest, harvestStatus });
    });

    stream.on('error', () => resolve(null));
  });
}

// ===== 完整轮次解析（详情视图用） =====

export interface TurnBlock {
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'structured';
  /** text→正文；thinking→思考；tool_use→工具名；tool_result→占位提示；structured→CodeM 结构化键值 */
  label?: string;
  /** text/thinking: 正文内容；tool_use: 工具输入 JSON；structured: 结构化键值 JSON 串 */
  content: string;
}

export interface SessionTurn {
  role: 'user' | 'assistant' | 'tool';
  /** 该轮的有序内容块（text/thinking/tool_use/tool_result 分离展示） */
  blocks: TurnBlock[];
  timestamp: string;
  /** 原始行号索引（用于快捷定位） */
  lineIndex: number;
}

export interface SessionDetail {
  sessionId: string;
  aiTitle: string;
  cwd: string;
  startTime: string;
  lastTime: string;
  turns: SessionTurn[];
  /** 用户提问标题列表（用于快速定位） */
  userPrompts: { lineIndex: number; text: string }[];
}

/** 把 message.content 解析为内容块数组 */
function parseBlocks(content: unknown): TurnBlock[] {
  const blocks: TurnBlock[] = [];
  if (typeof content === 'string') {
    if (content.trim()) blocks.push({ kind: 'text', content });
    return blocks;
  }
  if (Array.isArray(content)) {
    for (const b of content) {
      const item = b as { type?: string; text?: unknown; thinking?: unknown };
      const t = item.type;
      if (t === 'text' && typeof item.text === 'string' && item.text.trim()) {
        blocks.push({ kind: 'text', content: item.text });
      } else if (t === 'thinking' && typeof item.thinking === 'string' && item.thinking.trim()) {
        blocks.push({ kind: 'thinking', content: item.thinking });
      } else if (t === 'tool_use') {
        const item2 = b as { name?: string; input?: unknown };
        blocks.push({ kind: 'tool_use', label: item2.name || '工具', content: JSON.stringify(item2.input ?? {}, null, 2).slice(0, 2000) });
      } else if (t === 'tool_result') {
        // tool_result 的 content 可能是 array[{type:text}] 或 string
        let tr = '';
        const raw = (b as { content?: unknown }).content;
        if (typeof raw === 'string') tr = raw;
        else if (Array.isArray(raw)) {
          tr = raw.map((x) => (x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string' ? (x as { text: string }).text : '')).join('');
        }
        blocks.push({ kind: 'tool_result', content: tr.slice(0, 3000) });
      }
    }
  }
  return blocks;
}

/**
 * 读取单个会话的完整轮次（详情视图用）。
 * 不做合并——保留每条 user/assistant 原始消息为独立 turn，由 UI 决定折叠策略。
 * tool_result 类型的 user 行跳过（避免把工具回显当用户输入）。
 */
export async function parseSessionTurns(filePath: string): Promise<SessionDetail | null> {
  return new Promise((resolve) => {
    let aiTitle = '';
    let cwd = '';
    let startTime = '';
    let lastTime = '';
    const turns: SessionTurn[] = [];
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
        try { obj = JSON.parse(line); } catch { continue; }
        const t = obj.type;
        const ts = obj.timestamp as string | undefined;
        if (ts) { if (!startTime) startTime = ts; lastTime = ts; }
        if (obj.cwd && !cwd) cwd = obj.cwd;
        if (t === 'ai-title' && obj.aiTitle) aiTitle = obj.aiTitle;
        if (t === 'user') {
          const blocks = parseBlocks(obj.message?.content);
          // 纯 tool_result 回传 → 标记为 tool 角色
          const isToolOnly = blocks.length > 0 && blocks.every((b) => b.kind === 'tool_result');
          // 系统注入（parentUuid 有值）→ 标记为 tool 角色
          const isSystem = isSystemInjected(obj);
          if (blocks.length) {
            turns.push({ role: isToolOnly || isSystem ? 'tool' : 'user', blocks, timestamp: ts || '', lineIndex: currentLine });
            if (!isToolOnly && !isSystem) {
              const textBlock = blocks.find((b) => b.kind === 'text');
              if (textBlock) {
                userPrompts.push({ lineIndex: currentLine, text: textBlock.content.slice(0, 100) });
              }
            }
          }
        } else if (t === 'assistant') {
          const blocks = parseBlocks(obj.message?.content);
          if (blocks.length) {
            turns.push({ role: t, blocks, timestamp: ts || '', lineIndex: currentLine });
          }
        }
      }
    });

    stream.on('end', () => resolve({ sessionId: '', aiTitle, cwd, startTime, lastTime, turns, userPrompts }));
    stream.on('error', () => resolve(null));
  });
}

// ===== 扫描入口 =====

export interface ScanSessionsResult {
  vaultDirName: string;
  sessions: SessionCard[];
  scanned: number;
  failed: number;
}

/**
 * 扫描当前 vault 的全部会话。
 * @param vaultPath vault 绝对路径（app.vault.adapter.getBasePath()）
 * @param knownProjectPaths 已知项目目录相对路径列表（来自 projectScanner）
 */
export async function scanSessions(
  vaultPath: string,
  knownProjectPaths: string[],
): Promise<ScanSessionsResult> {
  const root = getSessionRootDir();
  const vaultDirName = encodeVaultPath(vaultPath);
  const vaultDir = path.join(root, vaultDirName);

  let entries: string[];
  try {
    entries = await fs.promises.readdir(vaultDir);
  } catch {
    return { vaultDirName, sessions: [], scanned: 0, failed: 0 };
  }

  const jsonlFiles = entries.filter((f) => f.endsWith('.jsonl'));
  const results = await Promise.all(
    jsonlFiles.map(async (f) => {
      const filePath = path.join(vaultDir, f);
      const sessionId = f.replace(/\.jsonl$/, '');

      // 增量：文件未变化 → 直接用缓存，不重解析
      let st: fs.Stats;
      try { st = await fs.promises.stat(filePath); } catch { return null; }
      let meta: JsonlMeta | null;
      if (cacheValid(filePath, st.size, st.mtimeMs)) {
        meta = fileCache.get(filePath)!.meta;
      } else {
        const raw = await parseSessionFile(filePath);
        // 强制在建卡前完成项目归属（内存态），保持原语义：项目归属随缓存复用
        const projectRef = raw ? extractProjectRef(raw.textChunks, knownProjectPaths, raw.cwd, raw.aiTitle) : null;
        const entrySource = raw ? (encodeVaultPath(raw.cwd).startsWith(vaultDirName) ? 'Obsidian' : '命令行') : '命令行';
        meta = raw ? {
          aiTitle: raw.aiTitle || raw.firstPrompt.slice(0, 40) || '(无标题)',
          firstPrompt: raw.firstPrompt,
          startTime: raw.startTime,
          lastTime: raw.lastTime,
          userTurns: raw.userTurns,
          toolCalls: raw.toolCalls,
          cwd: raw.cwd,
          projectPath: projectRef!.projectPath,
          projectSource: projectRef!.source,
          projectEvidence: projectRef!.evidence,
          entrySource,
          skills: raw.skills,
          harvestStatus: raw.harvestStatus,
          lastHarvestAt: raw.lastHarvestAt,
        } : null;
        fileCache.set(filePath, { size: st.size, mtimeMs: st.mtimeMs, meta });
      }
      if (!meta) return null;

      const projectRef = {
        projectPath: meta.projectPath,
        source: meta.projectSource as ProjectRef['source'],
        evidence: meta.projectEvidence,
      };
      const card: SessionCard = {
        sessionId,
        agent: 'claude',
        aiTitle: meta.aiTitle,
        firstPrompt: meta.firstPrompt,
        startTime: meta.startTime,
        lastTime: meta.lastTime,
        fileMTime: new Date(st.mtimeMs).toISOString(),
        userTurns: meta.userTurns,
        toolCalls: meta.toolCalls,
        cwd: meta.cwd,
        projectRef,
        filePath,
        entrySource: meta.entrySource,
        skills: meta.skills,
        harvestStatus: meta.harvestStatus,
        lastHarvestAt: meta.lastHarvestAt,
      };
      return card;
    }),
  );

  const sessions = (results.filter(Boolean) as SessionCard[]).sort(
    (a, b) => (b.lastTime || '').localeCompare(a.lastTime || ''),
  );
  const failed = jsonlFiles.length - sessions.length;
  return { vaultDirName, sessions, scanned: sessions.length, failed };
}

/**
 * 一次性扫描所有 projects 子目录下的所有会话（跨 vault 全量）。
 * 用于用户想看到所有历史会话，不限制当前 vault。
 * @param currentVaultPath 当前 vault 绝对路径，用于判断入口来源
 */
export async function scanAllSessions(
  knownProjectPaths: string[],
  currentVaultPath?: string,
): Promise<ScanSessionsResult> {
  const root = getSessionRootDir();
  const allDirs = await fs.promises.readdir(root).catch(() => [] as string[]);
  const sessions: SessionCard[] = [];
  let failed = 0;
  const currentEncoded = currentVaultPath ? encodeVaultPath(currentVaultPath) : '';

  for (const d of allDirs) {
    if (d === '_archived') continue; // 跳过存档目录
    const dirPath = path.join(root, d);
    try {
      const st = await fs.promises.stat(dirPath);
      if (!st.isDirectory()) continue;
    } catch { continue; }
    const files = await fs.promises.readdir(dirPath).catch(() => [] as string[]);
    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
    for (const f of jsonlFiles) {
      const filePath = path.join(dirPath, f);

      // 增量：文件未变化 → 直接用缓存，不重解析
      let st: fs.Stats;
      try { st = await fs.promises.stat(filePath); } catch { failed++; continue; }
      let meta: JsonlMeta | null;
      if (cacheValid(filePath, st.size, st.mtimeMs)) {
        meta = fileCache.get(filePath)!.meta;
      } else {
        const raw = await parseSessionFile(filePath);
        const projectRef = raw ? extractProjectRef(raw.textChunks, knownProjectPaths, raw.cwd, raw.aiTitle) : null;
        const entrySource = d === currentEncoded ? 'Obsidian' : '命令行';
        meta = raw ? {
          aiTitle: raw.aiTitle || raw.firstPrompt.slice(0, 40) || '(无标题)',
          firstPrompt: raw.firstPrompt,
          startTime: raw.startTime,
          lastTime: raw.lastTime,
          userTurns: raw.userTurns,
          toolCalls: raw.toolCalls,
          cwd: raw.cwd,
          projectPath: projectRef!.projectPath,
          projectSource: projectRef!.source,
          projectEvidence: projectRef!.evidence,
          entrySource,
          skills: raw.skills,
          harvestStatus: raw.harvestStatus,
          lastHarvestAt: raw.lastHarvestAt,
        } : null;
        fileCache.set(filePath, { size: st.size, mtimeMs: st.mtimeMs, meta });
      }
      if (!meta) { failed++; continue; }

      const projectRef = {
        projectPath: meta.projectPath,
        source: meta.projectSource as ProjectRef['source'],
        evidence: meta.projectEvidence,
      };
      sessions.push({
        sessionId: f.replace(/\.jsonl$/, ''),
        agent: 'claude',
        aiTitle: meta.aiTitle,
        firstPrompt: meta.firstPrompt,
        startTime: meta.startTime,
        lastTime: meta.lastTime,
        fileMTime: new Date(st.mtimeMs).toISOString(),
        userTurns: meta.userTurns,
        toolCalls: meta.toolCalls,
        cwd: meta.cwd,
        projectRef,
        filePath,
        entrySource: meta.entrySource,
        skills: meta.skills,
        harvestStatus: meta.harvestStatus,
        lastHarvestAt: meta.lastHarvestAt,
      });
    }
  }

  sessions.sort((a, b) => (b.lastTime || '').localeCompare(a.lastTime || ''));
  return { vaultDirName: '*all*', sessions, scanned: sessions.length, failed };
}

// ===== 存档功能 =====

/**
 * 将会话 .jsonl 文件复制到存档目录（不删除源文件）。
 * 存档文件名格式：<sessionId>_<YYYYMMDD>.jsonl
 */
export async function archiveSessionFile(
  filePath: string,
  archiveDir: string,
): Promise<{ success: boolean; archivedPath: string }> {
  try {
    // 确保存档目录存在
    fs.mkdirSync(archiveDir, { recursive: true });

    // 提取 sessionId
    const basename = path.basename(filePath).replace(/\.jsonl$/, '');
    const today = new Date();
    const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
    const archivedName = `${basename}_${dateStr}.jsonl`;
    const archivedPath = path.join(archiveDir, archivedName);

    // 复制文件
    fs.copyFileSync(filePath, archivedPath);

    return { success: true, archivedPath };
  } catch (e: any) {
    return { success: false, archivedPath: e?.message || String(e) };
  }
}

/**
 * 扫描存档目录，返回已存档的 sessionId 集合。
 * 存档文件名格式：<sessionId>_<YYYYMMDD>.jsonl
 */
export async function getArchivedSessionIds(archiveDir: string): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const entries = await fs.promises.readdir(archiveDir);
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      // 去掉 _YYYYMMDD.jsonl 后缀，提取原始 sessionId
      const match = f.match(/^(.+?)_\d{8}\.jsonl$/);
      if (match) {
        ids.add(match[1]);
      }
    }
  } catch {
    // 目录不存在时静默处理
  }
  return ids;
}

// ===== 删除会话 =====

/**
 * 删除会话源 .jsonl 文件（不可恢复），同时清理增量扫描缓存。
 * 仅删源文件，不触碰 _archived 中的存档副本。
 */
export async function deleteSessionFile(filePath: string): Promise<{ success: boolean; error?: string }> {
  try {
    await fs.promises.unlink(filePath);
    fileCache.delete(filePath);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

/**
 * 取消存档：删除存档目录中该会话的全部存档副本（源文件不受影响），会话恢复到「未存档」状态。
 * 存档文件名格式：<sessionId>_<YYYYMMDD>.jsonl，同名会话可能被多次存成多个副本，一并删除。
 */
export async function unarchiveSession(sessionId: string, archiveDir: string): Promise<{ success: boolean; error?: string }> {
  try {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(archiveDir);
    } catch {
      return { success: false, error: '存档目录不存在' };
    }
    const targets = entries.filter((f) => f.endsWith('.jsonl') && f.startsWith(sessionId + '_'));
    if (targets.length === 0) return { success: false, error: '未找到该会话的存档副本' };
    for (const t of targets) {
      await fs.promises.unlink(path.join(archiveDir, t));
    }
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

// ===== 存档扫描（源文件被清理后，仅存档会话的展示 + 查重） =====

/** 存档会话的完整摘要：去重后每个 sessionId 一份，取最新存档副本 */
export interface ArchivedSessionSummary {
  sessionId: string;
  /** 最新存档副本文件名 <sessionId>_<YYYYMMDD>.jsonl */
  latestName: string;
  /** 最新存档副本绝对路径 */
  latestPath: string;
  /** 存档文件大小（字节） */
  size: number;
  /** 存档副本文件修改时间 ISO */
  latestMTime: string;
  /** 最后活动时间 ISO（从 jsonl 内解析，无则用 mtime） */
  lastTime: string;
  aiTitle: string;
  firstPrompt: string;
  /** 项目归属（从存档副本内重新做三线索匹配，继承原有分组） */
  projectRef: ProjectRef;
}

/** 存档元信息轻量解析（提取标题/时间/首问/归属文本片段） */
async function parseArchivedMetadata(filePath: string): Promise<{ aiTitle: string; firstPrompt: string; lastTime: string; cwd: string; textChunks: string[] } | null> {
  return new Promise((resolve) => {
    let aiTitle = '';
    let firstPrompt = '';
    let lastTime = '';
    let cwd = '';
    let hasAny = false;
    const textChunks: string[] = [];

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    let buf = '';
    stream.on('data', (chunk: Buffer | string) => {
      buf += chunk;
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const line of parts) {
        if (!line.trim()) continue;
        let obj: any;
        try { obj = JSON.parse(line); } catch { continue; }
        hasAny = true;
        const t = obj.type;
        if (obj.timestamp && !lastTime) lastTime = obj.timestamp;
        else if (obj.timestamp) lastTime = obj.timestamp;
        if (obj.cwd && !cwd) cwd = obj.cwd;
        if (t === 'ai-title' && obj.aiTitle) aiTitle = obj.aiTitle as string;
        if (t === 'user') {
          const content = obj.message?.content;
          const isToolTurn = isToolResultTurn(content) || isSystemInjected(obj);
          if (!isToolTurn) {
            const text = extractText(content);
            if (text) {
              if (!firstPrompt) firstPrompt = text.slice(0, 200);
              if (textChunks.length < 3) textChunks.push(text);
            }
          }
        }
      }
    });
    stream.on('end', () => {
      if (buf.trim()) {
        try {
          const obj = JSON.parse(buf);
          hasAny = true;
          if (obj.type === 'ai-title' && obj.aiTitle) aiTitle = obj.aiTitle;
        } catch { /* ignore */ }
      }
      resolve(hasAny ? { aiTitle, firstPrompt, lastTime, cwd, textChunks } : null);
    });
    stream.on('error', () => resolve(null));
  });
}

// 存档元信息增量缓存（同源文件扫描策略：文件大小+mtime 未变则跳过解析）
const archivedMetaCache = new Map<string, { size: number; mtimeMs: number; meta: { aiTitle: string; firstPrompt: string; lastTime: string; cwd: string; textChunks: string[] } | null }>();

/**
 * 扫描存档目录，按 sessionId 去重（查重），每个会话取最新存档副本。
 * 归档结构：<sessionId>_<YYYYMMDD>.jsonl，同名可多次存档（多份副本），仅保留最新一份展示。
 * 项目归属从存档副本内重新三线索匹配（继承源文件时期的自动分组）。
 * @param archiveDir 存档目录
 * @param knownProjectPaths 已知项目目录相对路径列表（来自 projectScanner）
 * @returns 存档会话摘要列表，按最后活动时间降序
 */
export async function scanArchivedSessions(archiveDir: string, knownProjectPaths: string[] = []): Promise<ArchivedSessionSummary[]> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(archiveDir);
  } catch {
    return [];
  }

  // 第一遍：文件名解析，按 sessionId 归并，取日期最新的一份
  interface Pending { name: string; path: string; dateStr: string; size: number; mtimeMs: number; }
  const byId = new Map<string, Pending>();
  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue;
    const m = f.match(/^(.+?)_(\d{8})\.jsonl$/);
    if (!m) continue;
    const sessionId = m[1];
    const dateStr = m[2];
    const fullPath = path.join(archiveDir, f);
    let st: fs.Stats;
    try { st = await fs.promises.stat(fullPath); } catch { continue; }
    const cur = byId.get(sessionId);
    if (!cur || dateStr > cur.dateStr || (dateStr === cur.dateStr && st.mtimeMs > cur.mtimeMs)) {
      byId.set(sessionId, { name: f, path: fullPath, dateStr, size: st.size, mtimeMs: st.mtimeMs });
    }
  }

  // 第二遍：对每个最新副本提取元信息（增量缓存）+ 项目归属
  const summaries: ArchivedSessionSummary[] = [];
  for (const [sessionId, p] of byId) {
    let meta: { aiTitle: string; firstPrompt: string; lastTime: string; cwd: string; textChunks: string[] } | null;
    const cached = archivedMetaCache.get(p.path);
    if (cached && cached.size === p.size && cached.mtimeMs === p.mtimeMs) {
      meta = cached.meta;
    } else {
      meta = await parseArchivedMetadata(p.path);
      archivedMetaCache.set(p.path, { size: p.size, mtimeMs: p.mtimeMs, meta });
    }
    const projectRef = extractProjectRef(meta?.textChunks ?? [], knownProjectPaths, meta?.cwd ?? '', meta?.aiTitle);
    summaries.push({
      sessionId,
      latestName: p.name,
      latestPath: p.path,
      size: p.size,
      latestMTime: new Date(p.mtimeMs).toISOString(),
      lastTime: meta?.lastTime || new Date(p.mtimeMs).toISOString(),
      aiTitle: meta?.aiTitle || '',
      firstPrompt: meta?.firstPrompt || '',
      projectRef,
    });
  }

  summaries.sort((a, b) => (b.lastTime || '').localeCompare(a.lastTime || ''));
  return summaries;
}

/**
 * 恢复源文件：把存档副本复制回源目录（~/.claude/projects/<编码vault>/<sessionId>.jsonl），
 * 使 `claude --resume <sessionId>` 可继续续接该会话。源文件已存在则直接返回。
 * 恢复后副本仍保留在存档目录，作为双保险。
 * @returns 恢复后的目标路径（存在则复用已有源文件）
 */
export async function restoreSessionSource(
  sessionId: string,
  archiveDir: string,
  vaultDir: string,
): Promise<{ success: boolean; targetPath?: string; error?: string }> {
  try {
    const summaries = await scanArchivedSessions(archiveDir);
    const target = summaries.find((s) => s.sessionId === sessionId);
    if (!target) return { success: false, error: '未找到该会话的存档副本' };
    const targetPath = path.join(vaultDir, `${sessionId}.jsonl`);
    if (fs.existsSync(targetPath)) return { success: true, targetPath };
    fs.copyFileSync(target.latestPath, targetPath);
    fileCache.delete(targetPath); // 清掉可能存在的旧条目，让下次扫描重解析
    return { success: true, targetPath };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}
