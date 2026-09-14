/**
 * 会话面板 — 驾驶舱第 7 个 Tab（💬 会话）
 *
 * 布局：左侧菜单 + 右侧内容（仿飞书面板）
 *   - 左侧 Tab：项目 / 通用
 *   - 项目 Tab：按项目管理-系统/车型/日常工作-通用 分组的项目列表 + 全部/未归类
 *   - 通用 Tab：搜索 + 全部/今日/本周/未归类
 *   - 右侧：面包屑 + 会话卡片网格 + 详情视图
 */

import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import type { App } from 'obsidian';
import { Notice } from 'obsidian';
import { spawn } from 'child_process';
import * as path from 'path';
import { scanAllSessions, parseSessionTurns, archiveSessionFile, unarchiveSession, deleteSessionFile, getArchivedSessionIds, scanArchivedSessions, restoreSessionSource, encodeVaultPath, type SessionCard, type SessionDetail, type TurnBlock, type ArchivedSessionSummary, type SessionAgent } from '../data/sessionScanner';
import { scanCodemSessions, parseCodemSessionTurns } from '../data/codemScanner';
import { scanProjects, type ProjectInfo } from '../data/projectScanner';
import { getSessionArchiveDir, getSessionRootDir, getSessionTitleOverride, setSessionTitleOverride, getSessionProjectOverride, setSessionProjectOverride, removeSessionOverrides, getConfig, getCodemRootDir, getCodemCliPath } from '../data/settings';

// ===== 类型 =====
type SidebarTab = 'projects' | 'general';
// 'none' 为项目 Tab 的「未归类」筛选键，运行期一直在用但原类型定义遗漏，此处补齐
// 通用 Tab 状态筛选键：archived/unarchived（存档态）、harvested/pendingHarvest（收割态）
type FilterKey = 'all' | 'none' | 'daily' | 'today' | 'threeDays' | 'week' | 'archived' | 'unarchived' | 'harvested' | 'pendingHarvest' | 'turn5' | 'turn20' | 'turn20plus';

/** 通用 Tab 日期筛选项（横向小按钮，一行三个） */
const TIME_FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'today', label: '今日' },
  { key: 'threeDays', label: '近三日' },
  { key: 'week', label: '本周' },
];

/** 通用 Tab 轮次筛选项（横向小按钮，一行三个） */
const TURN_FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'turn5', label: '≤5 轮' },
  { key: 'turn20', label: '≤20 轮' },
  { key: 'turn20plus', label: '20+ 轮' },
];

/** 通用 Tab 会话状态筛选项（存档态仅 Claude 有概念；收割态两个 Agent 都支持） */
const GENERAL_STATUS_FILTERS: { key: FilterKey; icon: string; label: string; hint: string; claudeOnly?: boolean }[] = [
  { key: 'unarchived', icon: '📭', label: '未存档', hint: '未创建存档副本的会话', claudeOnly: true },
  { key: 'archived', icon: '📦', label: '已存档', hint: '已创建存档副本（含源文件被清理的仅存档会话）', claudeOnly: true },
  { key: 'harvested', icon: '✅', label: '已收割', hint: '会话中出现过收割调用' },
  { key: 'pendingHarvest', icon: '🌾', label: '待收割', hint: '从未执行过收割的会话' },
];

interface MenuGroup {
  root: string;
  projects: ProjectInfo[];
}

// ===== Markdown 完整渲染（支持代码块、表格、标题、列表等） =====
function mdRender(text: string): string {
  if (!text) return '';
  // 先 HTML 转义
  const esc = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // 按行处理，逐行渲染
  const lines = esc.split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let codeLang = '';
  let codeBuf: string[] = [];
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 代码块 ``` 开关
    if (/^```/.test(line)) {
      if (inCodeBlock) {
        out.push(`<pre><code${codeLang ? ` class="language-${codeLang}"` : ''}>${codeBuf.join('\n')}</code></pre>`);
        codeBuf = [];
        inCodeBlock = false;
        codeLang = '';
      } else {
        inCodeBlock = true;
        codeLang = line.replace(/^```/, '').trim();
      }
      continue;
    }
    if (inCodeBlock) { codeBuf.push(line); continue; }

    // 空行重置表格状态
    if (!line.trim()) { if (inTable) { inTable = false; } out.push(''); continue; }

    // 表格行：| 内容 | 内容 |
    if (/^\|.+\|$/.test(line.trim())) {
      if (!inTable) {
        inTable = true;
        out.push('<table>');
      }
      // 分隔行 |-|-| 跳过
      if (/^\|[\s\-:]+\|$/.test(line.trim())) continue;
      const cells = line.split('|').filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
      // 判断是否是表头（上一行是分隔行，或者第一行）
      const prevLine = i > 0 ? lines[i - 1] : '';
      const isHeader = inTable && prevLine.trim().startsWith('|') && /^\|[\s\-:]+\|$/.test(lines[i + 1]?.trim() || '');
      const tag = isHeader ? 'th' : 'td';
      out.push(`<tr>${cells.map((c) => `<${tag}>${inlineMd(c.trim())}</${tag}>`).join('')}</tr>`);
      continue;
    } else if (inTable) {
      inTable = false;
      out.push('</table>');
    }

    // 普通行：行内渲染，用 <p> 包裹
    if (line.trim()) {
      const rendered = inlineMd(line);
      if (/^<(h[1-6]|blockquote|hr)/.test(rendered)) {
        out.push(rendered);
      } else if (/^<li>/.test(rendered)) {
        // 收集连续的 <li>，包装为 <ul>
        const listItems = [rendered];
        while (i + 1 < lines.length) {
          const nextLine = lines[i + 1].trim();
          if (!nextLine) break;
          const nextRendered = inlineMd(lines[i + 1]);
          if (/^<li>/.test(nextRendered)) {
            listItems.push(nextRendered);
            i++;
          } else break;
        }
        out.push(`<ul>${listItems.join('')}</ul>`);
      } else {
        out.push(`<p>${rendered}</p>`);
      }
    }
  }

  // 关闭未闭合的代码块
  if (inCodeBlock) {
    out.push(`<pre><code${codeLang ? ` class="language-${codeLang}"` : ''}>${codeBuf.join('\n')}</code></pre>`);
  }
  if (inTable) out.push('</table>');

  return out.join('\n');
}

/** 行内 Markdown 渲染（单行，不含块级元素） */
function inlineMd(text: string): string {
  let s = text;

  // 标题 # ## ###
  s = s.replace(/^(#{1,6})\s+(.+)$/gm, (_, hashes, content) => {
    const level = hashes.length;
    return `<h${level}>${content}</h${level}>`;
  });

  // 无序列表 - 或 *
  s = s.replace(/^[\s]*[-*+]\s+(.+)$/gm, '<li>$1</li>');
  // 有序列表 1. 2.
  s = s.replace(/^[\s]*\d+\.\s+(.+)$/gm, '<li>$1</li>');

  // 引用 >
  s = s.replace(/^&gt;\s*(.*)$/gm, '<blockquote>$1</blockquote>');

  // 分隔线 ---
  if (/^-{3,}$/.test(s.trim())) s = '<hr>';

  // 复选框
  s = s.replace(/^- \[ \] /gm, '☐ ');
  s = s.replace(/^- \[x\] /gim, '☑ ');

  // 链接 [text](url) — 协议白名单：仅 https/http/mailto 渲染为可点击链接，其余降级为纯文本防注入
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => {
    const href = (u as string).trim();
    if (/^(https?:\/\/|mailto:)/i.test(href)) {
      return `<a href="${href}" target="_blank" rel="noopener">${t}</a>`;
    }
    return `${t}（${href}）`; // 非白名单协议 → 纯文本
  });

  // 粗体 + 斜体 ***
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  // 粗体 **
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // 斜体 *
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // 行内代码 `
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');

  return s;
}

// ===== 轮次内容块 =====
function BlockView({ block, isAssistant }: { block: TurnBlock; isAssistant?: boolean }) {
  const [open, setOpen] = useState(false);

  if (block.kind === 'text') {
    return <div className={`mswb-turn-text${isAssistant ? ' mswb-turn-text-final' : ''}`} dangerouslySetInnerHTML={{ __html: mdRender(block.content) }} />;
  }
  if (block.kind === 'thinking') {
    return (
      <div className="mswb-turn-block mswb-turn-thinking">
        <div className="mswb-turn-block-head" onClick={() => setOpen((v) => !v)}>
          <span>{open ? '▾' : '▸'} 思考</span>
        </div>
        {open && <div className="mswb-turn-block-body">{block.content}</div>}
      </div>
    );
  }
  if (block.kind === 'tool_use') {
    return (
      <div className="mswb-turn-block mswb-turn-tool">
        <div className="mswb-turn-block-head" onClick={() => setOpen((v) => !v)}>
          <span>{open ? '▾' : '▸'} {block.label}</span>
        </div>
        {open && <div className="mswb-turn-block-body"><pre>{block.content}</pre></div>}
      </div>
    );
  }
  if (block.kind === 'tool_result') {
    const preview = block.content.replace(/\s+/g, ' ').slice(0, 80);
    return (
      <div className="mswb-turn-block mswb-turn-result">
        <div className="mswb-turn-block-head" onClick={() => setOpen((v) => !v)}>
          <span>{open ? '▾' : '▸'} 📤 工具结果 {preview ? `· ${preview}${block.content.length > 80 ? '…' : ''}` : ''}</span>
        </div>
        {open && <div className="mswb-turn-block-body"><pre>{block.content}</pre></div>}
      </div>
    );
  }
  if (block.kind === 'structured') {
    return (
      <div className="mswb-turn-block mswb-turn-structured">
        <span className="mswb-turn-structured-badge">🧩 飞书附加信息（上下文 / 用户实体）</span>
        <div className="mswb-turn-block-head" onClick={() => setOpen((v) => !v)}>
          <span>{open ? '▾' : '▸'}展开附加信息</span>
        </div>
        {open && <div className="mswb-turn-block-body" style={{ padding: '4px 0' }}>
          {(() => {
            try {
              const obj = JSON.parse(block.content);
              if (obj && typeof obj === 'object') {
                return <table className="mswb-structured-table">
                  <tbody>
                    {Object.entries(obj).map(([k, v]) => {
                      let value = Array.isArray(v) ? v.join('、') : (v === null || v === undefined ? '' : String(v));
                      if (value.length > 240) value = value.slice(0, 240) + '…';
                      return <tr key={k}><td className="mswb-structured-key">{k}</td><td className="mswb-structured-value">{value}</td></tr>;
                    })}
                  </tbody>
                </table>;
              }
              return <pre>{block.content}</pre>;
            } catch {
              return <pre>{block.content}</pre>;
            }
          })()}
        </div>}
      </div>
    );
  }
  return null;
}

// ===== 会话详情视图 =====
function SessionDetailView({ detail, agent, onBack, onOpenInClaude }: { detail: SessionDetail; agent: SessionAgent; onBack: () => void; onOpenInClaude: (sessionId: string) => void }) {
  const AGENT_LABEL: Record<SessionAgent, string> = { claude: '🤖 Claude', codem: '🏷 CodeM' };
  const agentName = AGENT_LABEL[agent];
  const timeLabel = useMemo(() => {
    const fmt = (iso: string) => {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    return `${fmt(detail.startTime)} ~ ${fmt(detail.lastTime)}`;
  }, [detail]);

  const turnRefs = useRef<Record<number, HTMLDivElement | null>>({});

  const scrollToTurn = (lineIndex: number) => {
    const el = turnRefs.current[lineIndex];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('mswb-turn-highlight');
      setTimeout(() => el.classList.remove('mswb-turn-highlight'), 2000);
    }
  };

  return (
    <div className="mswb-session-detail">
      <div className="mswb-session-detail-bar">
        <button className="mswb-session-back" onClick={onBack}>← 返回列表</button>
        <span className="mswb-session-detail-title">{detail.aiTitle}</span>
          <button
            className="mswb-session-back"
            onClick={() => onOpenInClaude(detail.sessionId)}
            title={agent === 'codem' ? '在 CodeM CLI 中打开此前会话' : '在 Claude Code 中打开此会话'}
          >
            {agent === 'codem' ? '在 CodeM 中打开' : '在 Claude 中打开'}
          </button>
        <span className="mswb-session-detail-meta">{detail.userPrompts.length} 轮提问 · {detail.turns.length} 条消息 · {timeLabel}</span>
      </div>

      {detail.userPrompts.length > 0 && (
        <div className="mswb-session-jumps">
          <span className="mswb-session-jumps-label">🧩 我的提问：</span>
          {detail.userPrompts.map((p, i) => (
            <button key={i} className="mswb-session-jump-chip" onClick={() => scrollToTurn(p.lineIndex)} title={p.text}>
              {i + 1}
            </button>
          ))}
        </div>
      )}

      <div className="mswb-session-detail-turns">
        {detail.turns.map((turn, i) => {
          return (
          <div
            key={i}
            ref={(el) => { turnRefs.current[turn.lineIndex] = el; }}
            className={`mswb-turn mswb-turn-${turn.role}`}
          >
            <div className="mswb-turn-role">{turn.role === 'user' ? '🧑 用户' : turn.role === 'tool' ? '⚙ 系统' : agentName}</div>
            <div className="mswb-turn-blocks">
              {turn.blocks.map((b, j) => <BlockView key={j} block={b} isAssistant={turn.role === 'assistant'} />)}
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}

// ===== 会话卡片 =====
function SessionCardView({ card, archived, sourceMissing, titleOverride, effectiveProjectPath, onOpen, onOpenInClaude, onArchive, onUnarchive, onDelete, onTitleChange, onMoveClick }: { card: SessionCard; archived: boolean; sourceMissing: boolean; titleOverride: string | null; effectiveProjectPath: string | null; onOpen: (c: SessionCard) => void; onOpenInClaude: (c: SessionCard) => void; onArchive: (c: SessionCard) => void; onUnarchive: (c: SessionCard) => void; onDelete: (c: SessionCard) => void; onTitleChange: (sessionId: string, title: string) => void; onMoveClick: (c: SessionCard) => void }) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  /** CodeM 会话数据只读：仅标题可编辑，操作区不显示移动/存档/删除 */
  const isCodemReadonly = card.agent === 'codem';

  const displayTitle = titleOverride || card.aiTitle;

  const startEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setTitleDraft(displayTitle);
    setEditingTitle(true);
    setTimeout(() => inputRef.current?.select(), 50);
  }, [displayTitle]);

  const saveTitle = useCallback(() => {
    setEditingTitle(false);
    if (titleDraft.trim() && titleDraft.trim() !== displayTitle) {
      onTitleChange(card.sessionId, titleDraft.trim());
    }
  }, [titleDraft, displayTitle, card.sessionId, onTitleChange]);

  // 点击外部关闭移动菜单（模态框自带 overlay 点击关闭，此处无需额外处理）

  // 会话卡片时间标签：创建时间（卡片时间） + 修改时间（文件 mtime，Claude 30 天清理按此判定）
  const timeLabel = useMemo(() => {
    const fmt = (iso: string): string => {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      return `${mm}-${dd} ${hh}:${mi}`;
    };
    const created = fmt(card.startTime);
    const mtime = fmt(card.fileMTime || card.lastTime);
    if (!created && !mtime) return '';
    // 创建时间缺失（个别 CodeM 会话无 header）只显示修改时间
    if (!created) return `🕒 ${mtime}`;
    // 同一会话创建/修改时间相同时只显示一个，避免冗余
    if (created === mtime) return `📅 ${created}`;
    return `📅 ${created} 🕒 ${mtime}`;
  }, [card.startTime, card.lastTime, card.fileMTime]);

  const sourceLabel: Record<string, string> = {
    'at-ref': '@引用',
    wikilink: '[[链接]]',
    cwd: '工作目录',
    none: '未归类',
  };

  const entryLabel: Record<string, string> = {
    Obsidian: 'Obsidian',
    '命令行': '命令行',
    '飞书': '飞书',
  };

  // 项目归属标签（取项目名，不含路径，跟随 override）
  const projectLabel = useMemo(() => {
    if (!effectiveProjectPath) return null;
    if (effectiveProjectPath === '__daily__') return '日常';
    const segments = effectiveProjectPath.split('/');
    const folderName = segments[segments.length - 1];
    return folderName.replace(/^\d+\.\s*/, '');
  }, [effectiveProjectPath]);

  return (
    <div className={`mswb-session-card${archived ? ' archived' : ''}`}>
      <div className="mswb-session-head" onClick={() => { if (!editingTitle) onOpen(card); }}>
        {editingTitle ? (
          <input
            ref={inputRef}
            className="mswb-session-title-input"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') setEditingTitle(false); }}
            onBlur={saveTitle}
            onClick={(e) => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <span className="mswb-session-title">
            {displayTitle}
            <button className="mswb-session-icon-btn" onClick={startEdit} title="编辑标题">✏️</button>
          </span>
        )}
        <span className="mswb-session-head-actions">
          {/* 移动：Claude + CodeM 均可用（CodeM 只允许移动，不改数据文件；存档/删除保持只读隐藏） */}
          <button className="mswb-session-icon-btn" onClick={(e) => { e.stopPropagation(); onMoveClick(card); }} title="移动项目">📂</button>
          {archived ? (
            <button className="mswb-session-icon-btn" onClick={(e) => { e.stopPropagation(); onUnarchive(card); }} title={sourceMissing ? '取消存档（此会话源文件已被 Claude 清理）' : '取消存档'} hidden={isCodemReadonly}>{sourceMissing ? '🗄' : '↩️'}</button>
          ) : (
            <button className="mswb-session-icon-btn" onClick={(e) => { e.stopPropagation(); onArchive(card); }} title="存档" hidden={isCodemReadonly}>📦</button>
          )}
          <button className="mswb-session-icon-btn mswb-session-icon-danger" onClick={(e) => { e.stopPropagation(); onDelete(card); }} title="删除会话" hidden={isCodemReadonly}>🗑</button>
        </span>
      </div>
      <div className="mswb-session-meta-row" onClick={() => onOpen(card)}>
        <span className="mswb-session-time">{timeLabel}</span>
        <span className="mswb-session-messages">{sourceMissing ? '副本 · 源文件已清理' : `${card.userTurns} 轮提问 · ${card.toolCalls} 次调用`}</span>
      </div>
      <div className="mswb-session-sub">
        {/* 收割状态徽标：harvested=会话中出现过收割调用（第二行，避免第一行拥挤） */}
        {card.harvestStatus === 'harvested' && (
          <span className="mswb-session-badge mswb-session-badge-harvest" title="该会话执行过会话知识收割">✅ 已收割</span>
        )}
        <span className={`mswb-session-badge source-${card.projectRef.source}`}>
          {sourceLabel[card.projectRef.source] || card.projectRef.source}
        </span>
        <span className={`mswb-session-badge entry-${card.entrySource === 'Obsidian' ? 'obsidian' : card.entrySource === '飞书' ? 'feishu' : 'cmd'}`}>
          {entryLabel[card.entrySource] || card.entrySource}
        </span>
        {sourceMissing && (
          <span className="mswb-session-badge mswb-session-badge-archivedonly">📦 仅存档</span>
        )}
        {projectLabel && (
          <span className="mswb-session-badge mswb-session-badge-project">{projectLabel}</span>
        )}
      </div>
      {card.firstPrompt && (
        <div className="mswb-session-prompt" onClick={() => onOpen(card)}>{card.firstPrompt}</div>
      )}
      <div className="mswb-session-actions" style={{ position: 'relative' }}>
        <button className="mswb-session-action-btn" onClick={(e) => { e.stopPropagation(); onOpen(card); }}>查看详情</button>
        <button className="mswb-session-action-btn" onClick={(e) => { e.stopPropagation(); onOpenInClaude(card); }}>{isCodemReadonly ? (sourceMissing ? '在 CodeM 中打开' : '在 CodeM 中打开') : (sourceMissing ? '恢复并续接' : '在 Claude 中打开')}</button>
      </div>
    </div>
  );
}

// ===== 主面板 =====
export function SessionsPanel({ app }: { app: App }) {
  const [activeAgent, setActiveAgent] = useState<SessionAgent>('claude');
  const [sessions, setSessions] = useState<SessionCard[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSidebarTab, setActiveSidebarTab] = useState<SidebarTab>('projects');
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [selectedFilter, setSelectedFilter] = useState<FilterKey>('all');
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());
  const [archivedOnly, setArchivedOnly] = useState<ArchivedSessionSummary[]>([]); // 仅存档会话（源文件已被清理）
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set(getConfig().projectRoots)); // 默认全部收起（清爽界面），点击展开
  const [titleOverrides, setTitleOverrides] = useState<Record<string, string>>({});
  const [sessionProjectOverrides, setSessionProjectOverrides] = useState<Record<string, string | null>>({});
  const [moveTarget, setMoveTarget] = useState<SessionCard | null>(null);
  const [bulkArchiving, setBulkArchiving] = useState(false);
  // 当前 vault 绝对路径（恢复仅存档会话到源目录用）
  const vaultBasePathRef = useRef<string>('');

  // 扫描会话（按当前 Agent 分发）
  const doScan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (activeAgent === 'codem') {
        // CodeM：全量扫描 ~/.codem/sessions，参与 vault 项目分组（cwd/@引用/标题语义三线索），无存档概念
        const projectList = await scanProjects(app);
        const knownPaths = projectList.map((p) => p.folderPath);
        setProjects(projectList);
        setArchivedIds(new Set());
        setArchivedOnly([]);
        const cards = await scanCodemSessions(getCodemRootDir(), knownPaths);
        setSessions(cards);
        // 标题覆盖 + 手动项目归属覆盖均支持（CodeM 只读数据文件，但允许本地记录移动/备注）
        const overrides: Record<string, string> = {};
        const projOverrides: Record<string, string | null> = {};
        for (const s of cards) {
          const ov = getSessionTitleOverride(s.sessionId);
          if (ov) overrides[s.sessionId] = ov;
          const po = getSessionProjectOverride(s.sessionId);
          if (po !== undefined) projOverrides[s.sessionId] = po;
        }
        setTitleOverrides(overrides);
        setSessionProjectOverrides(projOverrides);
        return;
      }
      const projectList = await scanProjects(app);
      const knownPaths = projectList.map((p) => p.folderPath);
      const vaultPath = (app.vault.adapter as any).getBasePath?.();
      vaultBasePathRef.current = vaultPath || '';
      // 全量扫描：所有 projects 目录下的会话，不限入口
      const [result, archIds, archivedSummaries] = await Promise.all([
        scanAllSessions(knownPaths, vaultPath),
        getArchivedSessionIds(getSessionArchiveDir()),
        scanArchivedSessions(getSessionArchiveDir(), knownPaths),
      ]);
      setProjects(projectList);
      setSessions(result.sessions);
      // 并集：源文件存在的已存档 id + 仅存档会话 id（后者让卡片自动标记为已存档态）
      setArchivedIds(new Set([...archIds, ...archivedSummaries.map((a) => a.sessionId)]));
      setArchivedOnly(archivedSummaries);
      // 加载标题覆盖（源文件会话 + 仅存档会话都要支持标题编辑/归属覆盖）
      const overrides: Record<string, string> = {};
      const projOverrides: Record<string, string | null> = {};
      for (const s of result.sessions) {
        const ov = getSessionTitleOverride(s.sessionId);
        if (ov) overrides[s.sessionId] = ov;
        const po = getSessionProjectOverride(s.sessionId);
        if (po !== undefined) projOverrides[s.sessionId] = po;
      }
      for (const a of archivedSummaries) {
        const ov = getSessionTitleOverride(a.sessionId);
        if (ov) overrides[a.sessionId] = ov;
        const po = getSessionProjectOverride(a.sessionId);
        if (po !== undefined) projOverrides[a.sessionId] = po;
      }
      setTitleOverrides(overrides);
      setSessionProjectOverrides(projOverrides);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [app, activeAgent]);

  useEffect(() => { doScan(); }, [doScan]);

  // 详情
  const openDetail = useCallback(async (card: SessionCard) => {
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    try {
      // 按 Agent 选择解析器：CodeM jsonl 事件结构与 Claude 不同，不能共用
      const d = card.agent === 'codem'
        ? await parseCodemSessionTurns(card.filePath)
        : await parseSessionTurns(card.filePath);
      if (!d) { setDetailError('读取会话失败'); setDetailLoading(false); return; }
      d.sessionId = card.sessionId;
      if (!d.aiTitle) d.aiTitle = card.aiTitle;
      setDetail(d);
    } catch (e: any) {
      setDetailError(e?.message || String(e));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const openInClaude = useCallback(async (card: SessionCard | string) => {
    const sessionId = typeof card === 'string' ? card : card.sessionId;
    const agent = typeof card === 'string' ? activeAgent : card.agent;
    let cwd = typeof card === 'string' ? '' : card.cwd;
    try {
      // CodeM：独立终端窗口复用 session id 续接（codem --session <id>）
      if (agent === 'codem') {
        const cli = getCodemCliPath();
        // 与 claude 分支同款：shell:true 把整条命令行交给 cmd /c 执行，
        // 批处理启动器由 cmd 自行解析（start "" cmd /k 会把带引号路径误判为外部命令，已废弃）
        const res = spawn(`"${cli}" --session ${sessionId}`, {
          detached: true,
          stdio: 'ignore',
          shell: true,
          windowsHide: false, // 显示终端窗口（cmd /c 等待交互式 codem 退出后窗口才关闭）
          cwd: cwd || undefined,
        });
        res.on('error', (err: any) => {
          if (err?.code === 'ENOENT') {
            new Notice('未找到 codem 命令，请检查 CodeM 安装或设置页配置 codem CLI 路径');
          } else {
            new Notice(`打开 CodeM 失败：${err?.message || err}`);
          }
        });
        res.unref();
        new Notice('正在打开 CodeM…');
        return;
      }
      // 仅存档会话（源文件已被清理）：先把存档副本恢复到源目录，再续接
      if (typeof card !== 'string' && !card.cwd && vaultBasePathRef.current) {
        const archiveDir = getSessionArchiveDir();
        const vaultDir = path.join(getSessionRootDir(), encodeVaultPath(vaultBasePathRef.current));
        const r = await restoreSessionSource(card.sessionId, archiveDir, vaultDir);
        if (r.success) {
          cwd = vaultBasePathRef.current;
        } else {
          new Notice(`无法恢复会话源文件：${r.error || '未知错误'}`);
          return;
        }
      }
      // 用 spawn 以 detached 模式启动 claude，完全与 Obsidian 进程解耦
      // detached: true 让子进程独立运行，不附加到父进程
      // stdio: 'ignore' 不监听 stdin/stdout/stderr，避免任何管道错误
      // windowsHide: false 让终端窗口可见
      const res = spawn('claude', ['--resume', sessionId], {
        detached: true,
        stdio: 'ignore',
        shell: true,
        windowsHide: false,
        cwd: cwd || undefined,
      });
      // 监听 error：CLI 不存在/spawn 失败时防止 uncaughtException 崩溃
      res.on('error', (err: any) => {
        if (err?.code === 'ENOENT') {
          new Notice('未找到 claude 命令，请安装 Claude Code 或检查 PATH');
        } else {
          new Notice(`打开 Claude 失败：${err?.message || err}`);
        }
      });
      res.unref(); // 解除引用，父进程退出不影响子进程
      new Notice('正在打开 Claude Code…');
    } catch (e: any) {
      new Notice(agent === 'codem' ? `打开 CodeM 失败：${e?.message || e}` : `打开 Claude 失败：${e?.message || e}`);
    }
  }, [activeAgent]);

  // 存档
  const handleArchive = useCallback(async (card: SessionCard) => {
    if (card.agent === 'codem') { new Notice('CodeM 会话为只读数据，不支持存档'); return; }
    const archiveDir = getSessionArchiveDir();
    const result = await archiveSessionFile(card.filePath, archiveDir);
    if (result.success) {
      new Notice(`✅ 已存档：${card.aiTitle}`);
      // 更新存档集合
      setArchivedIds((prev) => new Set(prev).add(card.sessionId));
    } else {
      new Notice(`❌ 存档失败：${result.archivedPath}`);
    }
  }, []);

  // 标题修改
  const handleTitleChange = useCallback(async (sessionId: string, title: string) => {
    await setSessionTitleOverride(sessionId, title);
    setTitleOverrides((prev) => ({ ...prev, [sessionId]: title }));
  }, []);

  // 取消存档
  const handleUnarchive = useCallback(async (card: SessionCard) => {
    if (card.agent === 'codem') { new Notice('CodeM 会话为只读数据，不支持取消存档'); return; }
    try {
      const archiveDir = getSessionArchiveDir();
      const result = await unarchiveSession(card.sessionId, archiveDir);
      if (result.success) {
        new Notice(`✅ 已取消存档：${card.aiTitle}`);
        // 从存档集合移除（仅存档会话取消存档后，若源文件已清理则卡片自然消失）
        setArchivedIds((prev) => {
          const next = new Set(prev);
          next.delete(card.sessionId);
          return next;
        });
        setArchivedOnly((prev) => prev.filter((a) => a.sessionId !== card.sessionId));
      } else {
        new Notice(`❌ 取消存档失败：${result.error || '未知错误'}`);
      }
    } catch (e: any) {
      new Notice(`❌ 取消存档失败：${e?.message || e}`);
    }
  }, []);

  // 删除会话（卡片 + 存档 + 覆盖记录一并删除）
  const handleDelete = useCallback(async (card: SessionCard) => {
    if (card.agent === 'codem') { new Notice('CodeM 会话为只读数据，删除会破坏非 vault 数据，已阻止'); return; }
    if (!confirm(`确定要删除会话「${card.aiTitle}」吗？\n将删除源文件及其存档副本，此操作不可恢复。`)) return;
    try {
      const errs: string[] = [];
      // 删除源文件
      const src = await deleteSessionFile(card.filePath);
      if (!src.success) errs.push(`源文件：${src.error || '失败'}`);
      // 删除存档副本（若存在）
      const archiveDir = getSessionArchiveDir();
      const unarchived = await unarchiveSession(card.sessionId, archiveDir).catch(() => ({ success: false, error: '存档' }));
      if (errs.length === 0 && !unarchived.success && unarchived.error !== '不存在') {
        // 存档目录不存在 / 未找到副本属于正常情况，不视为错误；其它错误记录
        errs.push(`存档：${unarchived.error}`);
      }
      // 清理 data.json 覆盖记录
      await removeSessionOverrides(card.sessionId);
      // 更新本地 state（源文件 + 仅存档同时移除）
      setSessions((prev) => prev.filter((s) => s.sessionId !== card.sessionId));
      setArchivedOnly((prev) => prev.filter((a) => a.sessionId !== card.sessionId));
      setArchivedIds((prev) => { const n = new Set(prev); n.delete(card.sessionId); return n; });
      setTitleOverrides((prev) => { const n = { ...prev }; delete n[card.sessionId]; return n; });
      setSessionProjectOverrides((prev) => { const n = { ...prev }; delete n[card.sessionId]; return n; });
      if (detail && detail.sessionId === card.sessionId) setDetail(null);

      if (errs.length === 0) {
        new Notice(`🗑 已删除会话：${card.aiTitle}`);
      } else {
        new Notice(`⚠️ 会话已删除，但有部分清理失败：${errs.join('；')}`);
      }
    } catch (e: any) {
      new Notice(`❌ 删除失败：${e?.message || e}`);
    }
  }, [detail]);

  // 左侧菜单项渲染
  const projectCount = useCallback((path: string | null) => {
    if (!path) return sessions.filter((s) => {
      const ov = sessionProjectOverrides?.[s.sessionId];
      const effective = ov !== undefined ? ov : s.projectRef.projectPath;
      return effective === null;
    }).length;
    return sessions.filter((s) => {
      const ov = sessionProjectOverrides?.[s.sessionId];
      const effective = ov !== undefined ? ov : s.projectRef.projectPath;
      return effective === path;
    }).length;
  }, [sessions, sessionProjectOverrides]);

  // 折叠切换
  const toggleGroup = useCallback((root: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  }, []);

  // 移动项目
  const handleMoveProject = useCallback(async (sessionId: string, projectPath: string | null) => {
    await setSessionProjectOverride(sessionId, projectPath);
    setMoveTarget(null);
    doScan();
  }, [doScan]);

  // 打开移动对话框
  const openMoveDialog = useCallback((card: SessionCard) => {
    setMoveTarget(card);
  }, []);

  // 项目分组（按会话数量降序排列）— 根目录来自配置，不硬编码；会话数为 0 的项目隐藏
  const menuGroups = useMemo<MenuGroup[]>(() => {
    const roots = getConfig().projectRoots.length > 0 ? getConfig().projectRoots : [];
    return roots.map((root) => ({
      root,
      projects: projects
        .filter((p) => p.folderPath.startsWith(root + '/'))
        .filter((p) => projectCount(p.folderPath) > 0) // 隐藏 0 会话项目
        .sort((a, b) => projectCount(b.folderPath) - projectCount(a.folderPath)),
    })).filter((g) => g.projects.length > 0);
  }, [projects, projectCount]);

  // 移动弹窗可分组的项目（按 projectRoots 上级文件夹分组；移动弹窗显示全部项目文件夹，不隐藏 0 会话项目）
  const moveGroups = useMemo(() => {
    const roots = getConfig().projectRoots.length > 0 ? getConfig().projectRoots : [];
    return roots.map((root) => ({
      root,
      projects: projects
        .filter((p) => p.folderPath.startsWith(root + '/'))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh')),
    })).filter((g) => g.projects.length > 0);
  }, [projects]);

  // 右侧过滤
  const filteredSessions = useMemo(() => {
    let list = [...sessions];
    // 项目 Tab：Claude + CodeM 共用（按项目归属过滤；日常仅 Claude 有）
    if (activeSidebarTab === 'projects') {
      const effectiveProject = (s: SessionCard) => {
        const ov = sessionProjectOverrides?.[s.sessionId];
        if (ov === undefined) return s.projectRef.projectPath;
        if (ov === '__daily__') return activeAgent === 'claude' ? '__daily__' : s.projectRef.projectPath;
        return ov;
      };
      if (selectedProject) {
        list = list.filter((s) => effectiveProject(s) === selectedProject);
      } else if (selectedFilter === 'none') {
        list = list.filter((s) => effectiveProject(s) === null);
      } else if (selectedFilter === 'daily' && activeAgent === 'claude') {
        // 日常：手动标记为 __daily__ 的会话
        list = list.filter((s) => sessionProjectOverrides?.[s.sessionId] === '__daily__');
      }
    } else {
      // 通用 Tab（日期切片基于「修改时间」fileMTime：反映文件最后写入时间，与 Claude 30 天清理判定一致；
      // 仅存档补齐会话无源文件，退化用 lastTime）
      const parseTs = (iso: string | undefined): number => (iso ? new Date(iso).getTime() : NaN);
      const localMidnightDaysAgo = (daysAgo: number): number => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - daysAgo);
        return d.getTime();
      };
      const tsOf = (s: SessionCard): number => parseTs(s.fileMTime || s.lastTime);
      if (selectedFilter === 'today') {
        const now = new Date();
        list = list.filter((s) => {
          const t = tsOf(s);
          if (isNaN(t)) return false;
          const d = new Date(t);
          return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
        });
      } else if (selectedFilter === 'threeDays') {
        const cutoff = localMidnightDaysAgo(2); // 今天 + 前两天
        list = list.filter((s) => {
          const t = tsOf(s);
          return !isNaN(t) && t >= cutoff;
        });
      } else if (selectedFilter === 'week') {
        const cutoff = localMidnightDaysAgo(7); // 滚动 7 天
        list = list.filter((s) => {
          const t = tsOf(s);
          return !isNaN(t) && t >= cutoff;
        });
      } else if (selectedFilter === 'turn5') {
        list = list.filter((s) => s.userTurns <= 5);
      } else if (selectedFilter === 'turn20') {
        list = list.filter((s) => s.userTurns > 5 && s.userTurns <= 20);
      } else if (selectedFilter === 'turn20plus') {
        list = list.filter((s) => s.userTurns > 20);
      }
    }

    // 会话状态筛选（通用 Tab 专属：未存档/已存档/已收割/待收割）
    // 基于全量会话（含仅存档会话补充）独立过滤，不叠加时间/轮次，互斥选择
    if (activeSidebarTab === 'general' && (selectedFilter === 'unarchived' || selectedFilter === 'archived' || selectedFilter === 'harvested' || selectedFilter === 'pendingHarvest')) {
      const srcKeys = new Set(sessions.map((s) => s.sessionId));
      const archivedOnlySessions: SessionCard[] = archivedOnly
        .filter((a) => !srcKeys.has(a.sessionId)) // 查重：源文件仍在的不补齐
        .map((a) => ({
          sessionId: a.sessionId,
          agent: 'claude',
          aiTitle: a.aiTitle || a.firstPrompt.slice(0, 40) || '(无标题)',
          firstPrompt: a.firstPrompt,
          startTime: a.lastTime,
          lastTime: a.lastTime,
          fileMTime: a.latestMTime,
          userTurns: 0,
          toolCalls: 0,
          cwd: '',
          projectRef: a.projectRef, // 继承存档副本内重新匹配的项目归属（原分组）
          filePath: a.latestPath,
          entrySource: '命令行',
          skills: [],
          harvestStatus: 'none', // 仅存档会话无源文件可查收割，恒 none
          lastHarvestAt: null,
        }));
      // 全量可见会话：源文件会话 + 仅存档会话（后者 id 也已并入 archivedIds）
      const allVisible = [...sessions, ...archivedOnlySessions];
      if (selectedFilter === 'unarchived') {
        list = allVisible.filter((s) => !archivedIds.has(s.sessionId));
      } else if (selectedFilter === 'archived') {
        list = allVisible.filter((s) => archivedIds.has(s.sessionId));
      } else if (selectedFilter === 'harvested') {
        list = allVisible.filter((s) => s.harvestStatus === 'harvested');
      } else if (selectedFilter === 'pendingHarvest') {
        list = allVisible.filter((s) => s.harvestStatus !== 'harvested');
      }
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        list = list.filter((s) => (titleOverrides[s.sessionId] || s.aiTitle).toLowerCase().includes(q) || s.firstPrompt.toLowerCase().includes(q));
      }
      return list;
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((s) => (titleOverrides[s.sessionId] || s.aiTitle).toLowerCase().includes(q) || s.firstPrompt.toLowerCase().includes(q));
    }
    return list;
  }, [sessions, activeSidebarTab, activeAgent, selectedProject, selectedFilter, search, archivedIds, archivedOnly, titleOverrides, sessionProjectOverrides]);

  // 一键存档当前筛选结果
  // ⚠️ 必须在 filteredSessions 声明之后定义：useCallback 依赖数组在定义时求值，
  // 引用后声明的 const 会触发 TDZ（Cannot access 'X' before initialization），导致整个面板白屏
  const handleBulkArchive = useCallback(async () => {
    // CodeM 数据只读：无存档概念，按钮在 UI 层已隐藏，此处兜底防直接触发
    if (bulkArchiving) return;
    const targets = filteredSessions.filter((s) => !archivedIds.has(s.sessionId));
    if (targets.length === 0) {
      new Notice('当前列表没有可存档的会话');
      return;
    }
    if (!confirm(`确定要存档当前列表的 ${targets.length} 个会话吗？\n存档为复制副本，不会删除源文件。`)) return;
    const archiveDir = getSessionArchiveDir();
    setBulkArchiving(true);
    try {
      let ok = 0;
      let fail = 0;
      for (const s of targets) {
        const r = await archiveSessionFile(s.filePath, archiveDir);
        if (r.success) { ok++; setArchivedIds((prev) => new Set(prev).add(s.sessionId)); }
        else { fail++; console.warn('存档失败', s.sessionId, r.archivedPath); }
      }
      new Notice(`✅ 已存档 ${ok} 个（失败 ${fail}）`);
    } catch (e: any) {
      new Notice(`❌ 存档出错：${e?.message || e}`);
    } finally {
      setBulkArchiving(false);
    }
  }, [bulkArchiving, filteredSessions, archivedIds]);

  // 当前标题
  const currentTitle = useMemo(() => {
    if (activeSidebarTab === 'projects') {
      if (selectedProject) return selectedProject.replace(/^[^/]+\//, '');
      if (selectedFilter === 'none') return '未归类会话'; // 非 FilterKey 成员，绕开类型系统（全状态 only）
      if (selectedFilter === 'daily' && activeAgent === 'claude') return '日常会话';
      return '全部会话';
    }
    if (selectedFilter === 'archived' && activeAgent === 'claude') return '已存档';
    if (selectedFilter === 'unarchived' && activeAgent === 'claude') return '未存档';
    if (selectedFilter === 'harvested') return '已收割';
    if (selectedFilter === 'pendingHarvest') return '待收割';
    if (selectedFilter === 'today') return '今日会话';
    if (selectedFilter === 'threeDays') return '近三日会话';
    if (selectedFilter === 'week') return '本周会话';
    if (selectedFilter === 'turn5') return '≤5 轮提问';
    if (selectedFilter === 'turn20') return '≤20 轮提问';
    if (selectedFilter === 'turn20plus') return '20+ 轮提问';
    return '全部会话';
  }, [activeSidebarTab, activeAgent, selectedProject, selectedFilter]);

  // 已存档计数 = 源文件存在的已存档 + 仅存档的会话（与已存档视图一致）
  const archivedCount = useMemo(() => {
    const srcArchived = sessions.filter((s) => archivedIds.has(s.sessionId)).length;
    const srcKeys = new Set(sessions.map((s) => s.sessionId));
    const onlyArchived = archivedOnly.filter((a) => !srcKeys.has(a.sessionId)).length;
    return srcArchived + onlyArchived;
  }, [sessions, archivedIds, archivedOnly]);

  // 加载/空/错误占位
  const renderMain = () => {
    if (loading && sessions.length === 0) {
      return <div className="mswb-sessions-empty">扫描会话中…</div>;
    }
    if (error) {
      return (
        <div className="mswb-sessions-empty">
          <div style={{ fontSize: 32 }}>⚠️</div>
          <p>扫描失败：{error}</p>
          <button className="mswb-sessions-refresh-btn" onClick={doScan}>重试</button>
        </div>
      );
    }
    if (sessions.length === 0) {
      return (
        <div className="mswb-sessions-empty">
          <div style={{ fontSize: 32 }}>💬</div>
          <p>{activeAgent === 'codem' ? '未发现 CodeM 会话' : '未发现 Claude 会话'}</p>
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>{activeAgent === 'codem' ? '检查设置页「CodeM 会话目录」配置' : '检查设置页「Claude 会话目录」配置'}</p>
          <button className="mswb-sessions-refresh-btn" onClick={doScan}>🔄 重新扫描</button>
        </div>
      );
    }
    if (filteredSessions.length === 0) {
      return <div className="mswb-sessions-empty">没有符合条件的会话</div>;
    }
    return (
      <div className="mswb-sessions-grid">
        {filteredSessions.map((s) => {
            const ov = sessionProjectOverrides?.[s.sessionId];
            const ep = ov !== undefined ? ov : s.projectRef.projectPath;
            return (
              <SessionCardView key={s.sessionId} card={s} archived={archivedIds.has(s.sessionId)} sourceMissing={!s.cwd && !s.userTurns} titleOverride={titleOverrides[s.sessionId] ?? null} effectiveProjectPath={ep} onOpen={openDetail} onOpenInClaude={openInClaude} onArchive={handleArchive} onUnarchive={handleUnarchive} onDelete={handleDelete} onTitleChange={handleTitleChange} onMoveClick={openMoveDialog} />
            );
          })}
      </div>
    );
  };

  return (
    <div className="mswb-sessions">
      {/* 移动项目模态框（在顶层渲染，避免嵌套问题） */}
      {moveTarget && (
        <div className="mswb-session-modal-overlay" onClick={() => setMoveTarget(null)}>
          <div className="mswb-session-modal" onClick={(e) => e.stopPropagation()}>
            <div className="mswb-session-modal-title">移动到项目</div>
            <div className="mswb-session-modal-body">
              <div className="mswb-session-move-item" onClick={() => { handleMoveProject(moveTarget.sessionId, null); }}>
                🗂️ 不归属
              </div>
              <div className="mswb-session-move-item" onClick={() => { handleMoveProject(moveTarget.sessionId, '__daily__'); }}>
                📔 日常
              </div>
              {moveGroups.map((g) => (
                <div key={g.root} className="mswb-session-move-group">
                  <div className="mswb-session-move-group-title">{g.root}</div>
                  {g.projects.map((p) => (
                    <div
                      key={p.folderPath}
                      className="mswb-session-move-item"
                      onClick={() => { handleMoveProject(moveTarget.sessionId, p.folderPath); }}
                    >
                      {p.emoji || '📁'} {p.name}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 详情视图优先 */}
      {detail ? (
        <SessionDetailView detail={detail} agent={activeAgent} onBack={() => setDetail(null)} onOpenInClaude={openInClaude} />
      ) : detailLoading ? (
        <div className="mswb-sessions-empty">读取会话内容…</div>
      ) : detailError ? (
        <div className="mswb-sessions-empty">
          <div style={{ fontSize: 32 }}>⚠️</div>
          <p>{detailError}</p>
          <button className="mswb-sessions-refresh-btn" onClick={() => setDetailError(null)}>返回</button>
        </div>
      ) : (
        <>
          {/* 顶部栏 */}
          <div className="mswb-sessions-header">
            <div className="mswb-sessions-header-left">
              <span className="mswb-sessions-title">💬 会话</span>
              <select
                className="mswb-agent-select"
                value={activeAgent}
                onChange={(e) => {
                  const next = e.target.value as SessionAgent;
                  if (next === activeAgent) return;
                  setActiveAgent(next);
                  // 切换 Agent：重置筛选/搜索/详情，避免跨源残留
                  setDetail(null);
                  setSelectedProject(null);
                  setSelectedFilter('all');
                  setSearch('');
                  // Claude 与 CodeM 均支持项目分组 → 保持当前 Tab，无需强制切换
                }}
                title="切换会话数据源"
              >
                <option value="claude">🤖 Claude Code</option>
                <option value="codem">🏷 CodeM</option>
              </select>
            </div>
            <div className="mswb-sessions-header-actions">
              {activeAgent === 'claude' && (
                <button className="mswb-sessions-refresh-btn" onClick={handleBulkArchive} disabled={bulkArchiving} title="对当前筛选列表的会话创建存档副本（不删除源文件）">
                  {bulkArchiving ? '存档中…' : `📦 存档当前${filteredSessions.length > 0 ? ` (${filteredSessions.length})` : ''}`}
                </button>
              )}
              <button className="mswb-sessions-refresh-btn" onClick={doScan} disabled={loading}>
                {loading ? '扫描中…' : '🔄 刷新'}
              </button>
            </div>
          </div>

          {/* 主体 */}
          <div className="mswb-sessions-body">
            {/* 左侧边栏 */}
            <div className="mswb-sessions-sidebar">
              {/* Tab 切换 */}
              <div className="mswb-sessions-tabs">
                <button
                  className={activeSidebarTab === 'projects' ? 'active' : ''}
                  onClick={() => { setActiveSidebarTab('projects'); setSelectedFilter('all'); setSelectedProject(null); }}
                >项目</button>
                <button
                  className={activeSidebarTab === 'general' ? 'active' : ''}
                  onClick={() => { setActiveSidebarTab('general'); setSelectedFilter('all'); setSelectedProject(null); }}
                >通用</button>
              </div>

              {/* 项目 Tab（Claude + CodeM 共用：按项目文件夹分组，CodeM 无日常/存档概念） */}
              {activeSidebarTab === 'projects' && (
                <div className="mswb-sessions-menu">
                  {/* 顶部固定项：全部 / 未归类（存档/日常仅 Claude 有概念） */}
                  <div className="mswb-sessions-menu-group">
                    <div className="mswb-sessions-menu-item mswb-sessions-menu-all" onClick={() => { setSelectedProject(null); setSelectedFilter('all'); }}>
                      <span className="mswb-sessions-menu-icon">📆</span>
                      <span className="mswb-sessions-menu-name">全部</span>
                      <span className="mswb-sessions-menu-count">{sessions.length}</span>
                    </div>
                    <div className="mswb-sessions-menu-item" onClick={() => { setSelectedProject(null); setSelectedFilter('none'); }}>
                      <span className="mswb-sessions-menu-icon">🗂️</span>
                      <span className="mswb-sessions-menu-name">未归类</span>
                      <span className="mswb-sessions-menu-count">{projectCount(null)}</span>
                    </div>
                    {activeAgent === 'claude' && (
                      <div className="mswb-sessions-menu-item" onClick={() => { setSelectedProject(null); setSelectedFilter('daily'); }}>
                        <span className="mswb-sessions-menu-icon">📔</span>
                        <span className="mswb-sessions-menu-name">日常</span>
                        <span className="mswb-sessions-menu-count">{sessions.filter((s) => sessionProjectOverrides?.[s.sessionId] === '__daily__').length}</span>
                      </div>
                    )}
                  </div>

                  {/* 项目分组（可折叠） */}
                  {menuGroups.map((g) => {
                    const isCollapsed = collapsedGroups.has(g.root);
                    return (
                      <div key={g.root} className="mswb-sessions-menu-group">
                        <div
                          className="mswb-sessions-menu-group-title mswb-sessions-group-collapsible"
                          onClick={() => toggleGroup(g.root)}
                        >
                          <span className="mswb-sessions-group-arrow">{isCollapsed ? '▸' : '▾'}</span>
                          {g.root}
                        </div>
                        {!isCollapsed && g.projects.map((p) => (
                          <div
                            key={p.folderPath}
                            className={`mswb-sessions-menu-item ${selectedProject === p.folderPath ? 'active' : ''}`}
                            onClick={() => { setSelectedProject(p.folderPath); setSelectedFilter('all'); }}
                          >
                            <span className="mswb-sessions-menu-icon">{p.emoji || '📁'}</span>
                            <span className="mswb-sessions-menu-name">{p.name}</span>
                            <span className="mswb-sessions-menu-count">{projectCount(p.folderPath)}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 通用 Tab */}
              {activeSidebarTab === 'general' && (
                <div className="mswb-sessions-menu">
                  <div className="mswb-sessions-search">
                    <input
                      type="text"
                      placeholder="搜索会话…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  {/* 日期维度：今日 / 近三日 / 本周（横向小按钮） */}
                  <div className="mswb-sessions-menu-group mswb-filter-group">
                    <div className="mswb-sessions-menu-group-title">日期</div>
                    <div className="mswb-filter-row">
                      {TIME_FILTERS.map((item) => (
                        <button
                          key={item.key}
                          className={`mswb-filter-chip${selectedFilter === item.key ? ' active' : ''}`}
                          onClick={() => { setSelectedFilter(item.key); setSelectedProject(null); }}
                        >{item.label}</button>
                      ))}
                    </div>
                  </div>
                  {/* 轮次维度：≤5 轮 / ≤20 轮 / 20+ 轮（横向小按钮） */}
                  <div className="mswb-sessions-menu-group mswb-filter-group">
                    <div className="mswb-sessions-menu-group-title">轮次</div>
                    <div className="mswb-filter-row">
                      {TURN_FILTERS.map((item) => (
                        <button
                          key={item.key}
                          className={`mswb-filter-chip${selectedFilter === item.key ? ' active' : ''}`}
                          onClick={() => { setSelectedFilter(item.key); setSelectedProject(null); }}
                        >{item.label}</button>
                      ))}
                    </div>
                  </div>
                  {/* 会话状态筛选：未存档 / 已存档 / 已收割 / 待收割（互斥，点击即切换） */}
                  <div className="mswb-sessions-menu-group">
                    {GENERAL_STATUS_FILTERS.map((item) => {
                      const isCodemVisible = !item.claudeOnly || activeAgent === 'claude';
                      if (!isCodemVisible) return null;
                      return (
                        <div
                          key={item.key}
                          className={`mswb-sessions-menu-item ${selectedFilter === item.key && !search ? 'active' : ''}`}
                          onClick={() => { setSelectedFilter(item.key); setSelectedProject(null); }}
                          title={item.hint}
                        >
                          <span className="mswb-sessions-menu-icon">{item.icon}</span>
                          <span className="mswb-sessions-menu-name">{item.label}</span>
                          {item.key === 'unarchived' && (
                            <span className="mswb-sessions-menu-count">{sessions.filter((s) => !archivedIds.has(s.sessionId)).length}</span>
                          )}
                          {item.key === 'archived' && (
                            <span className="mswb-sessions-menu-count">{archivedCount}</span>
                          )}
                          {item.key === 'harvested' && (
                            <span className="mswb-sessions-menu-count">{sessions.filter((s) => s.harvestStatus === 'harvested').length}</span>
                          )}
                          {item.key === 'pendingHarvest' && (
                            <span className="mswb-sessions-menu-count">{sessions.filter((s) => s.harvestStatus !== 'harvested').length}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* 右侧内容 */}
            <div className="mswb-sessions-main">
              <div className="mswb-sessions-breadcrumb">
                <span>会话</span>
                <span className="mswb-sessions-breadcrumb-sep">/</span>
                <span>{activeSidebarTab === 'projects' ? '项目' : '通用'}</span>
                {selectedProject && (
                  <>
                    <span className="mswb-sessions-breadcrumb-sep">/</span>
                    <span>{selectedProject.replace(/^[^/]+\//, '')}</span>
                  </>
                )}
                {selectedFilter !== 'all' && !selectedProject && (
                  <>
                    <span className="mswb-sessions-breadcrumb-sep">/</span>
                    <span>{currentTitle}</span>
                  </>
                )}
                <span className="mswb-sessions-count">（{filteredSessions.length} 个）</span>
              </div>
              {renderMain()}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
