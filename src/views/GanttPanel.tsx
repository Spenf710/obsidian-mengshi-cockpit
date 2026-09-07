import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Notice, type App } from 'obsidian';
import {
  GANTT_DATA,
  getDateRange,
  parseLocalDate,
  daysBetween,
  getMonthLabels,
  type GanttTask,
  type GanttPhase,
} from '../data/ganttData';
import { getGanttOverrides, saveGanttOverride, getProjectMetaOverrides, getConfig, getDomainIcon } from '../data/settings';
import { PhaseModal, type PhaseSubmitData } from './PhaseModal';
import { MilestoneModal, type MilestoneSubmitData } from './MilestoneModal';

type DragTarget = { taskId: string; edge: 'start' | 'end'; phaseId?: string } | null;
type EditingField = { taskId: string; field: 'progress' | 'start' | 'end' } | null;

/** 加载排期数据：GANTT_DATA 为主源，新项目尝试读 README，override 最后覆盖 */
async function loadGanttData(app: App): Promise<GanttTask[]> {
  const knownMap = new Map(GANTT_DATA.map((t) => [t.id, t]));
  const allFiles = app.vault.getFiles();

  const roots = getConfig().projectRoots;
  const colors = ['var(--color-blue)', 'var(--color-green)', 'var(--color-orange)', 'var(--color-purple)', 'var(--color-cyan)', 'var(--color-red)'];
  const tasks: GanttTask[] = [];
  let colorIdx = 0;

  for (const root of roots) {
    const rootPath = root + '/';

    const folders = new Set<string>();
    for (const f of allFiles) {
      if (f.path.startsWith(rootPath)) {
        folders.add(f.path.slice(rootPath.length).split('/')[0]);
      }
    }

    for (const folder of folders) {
      const rawName = folder.replace(/^\d+\./, '');
      const known = knownMap.get(folder);

      // 默认：GANTT_DATA 已知项目
      if (known) {
        tasks.push({
          id: folder,
          name: known.name,
          group: `${getDomainIcon(root)} ${root}`,
          category: known.category,
          start: known.start,
          end: known.end,
          progress: known.progress,
          color: known.color,
          milestones: known.milestones ? [...known.milestones] : undefined,
          phases: known.phases ? known.phases.map((p) => ({ ...p })) : undefined,
        });
        continue;
      }

      // 新项目：尝试从 README 读排期 + 类别，失败用默认值
      const readme = allFiles.find(
        (f) => f.path.startsWith(`${rootPath}${folder}/`) && f.name.endsWith('.README.md'),
      );
      const now2 = new Date();
      const fmtDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      let start = fmtDate(now2);
      let end = fmtDate(new Date(now2.getTime() + 90 * 86400000));
      let progress = 0;
      let category: string | undefined;

      if (readme) {
        try {
          const content = await app.vault.cachedRead(readme);
          const m = content.match(/\*\*预计周期\*\*\s*[：:|]\s*(\S+)\s*~\s*(\S+)/);
          if (m) { start = m[1]; end = m[2]; }
          const s = content.match(/\*\*当前状态\*\*\s*[：:|]\s*(.+)/);
          if (s && s[1].trim().includes('已完成')) progress = 100;
          // 解析项目类型
          const cat = content.match(/\*\*项目类型\*\*\s*[：:|]\s*(\S+)/);
          if (cat) category = cat[1].trim();
        } catch { /* ignore */ }
      }

      tasks.push({
        id: folder,
        name: rawName,
        group: `${getDomainIcon(root)} ${root}`,
        category: category ?? '其他',
        start,
        end,
        progress,
        color: colors[colorIdx % colors.length],
      });
      colorIdx++;
    }
  }

  // override + 项目卡片类别同步
  const overrides = getGanttOverrides();
  const metaOverrides = getProjectMetaOverrides();
  for (const task of tasks) {
    const ov = overrides[task.id];
    if (ov) {
      if (ov.start) task.start = ov.start;
      if (ov.end) task.end = ov.end;
      if (ov.progress !== undefined) task.progress = ov.progress;
      if (ov.milestones) task.milestones = ov.milestones;
      if (Array.isArray(ov.phases)) task.phases = ov.phases.length > 0 ? ov.phases : undefined;
    }
    // 项目卡片编辑的 systemType → 甘特图 category
    const mo = metaOverrides[task.id];
    if (mo?.systemType) {
      task.category = mo.systemType;
    }
  }

  return tasks;
}

/** 串行化同文件写操作，避免多次拖拽并发覆盖 */
const syncQueue = new Map<string, Promise<void>>();

/** 将排期 + 阶段数据合并成一次 vault.process 写入 README */
async function syncToReadme(
  app: App,
  taskId: string,
  start: string,
  end: string,
  phases?: { label: string; start: string; end: string; progress: number }[],
): Promise<void> {
  // 串行化：同一 task 的写操作排队执行
  const prev = syncQueue.get(taskId) ?? Promise.resolve();
  const next = prev.then(async () => {
    const roots = getConfig().projectRoots;
    const allFiles = app.vault.getFiles();

    for (const root of roots) {
      // 支持多种 README 命名：xxx.README.md / README.md / readme.md
      const readme = allFiles.find(
        (f) => f.path.startsWith(`${root}/${taskId}/`) &&
          (f.name.endsWith('.README.md') || f.name.toLowerCase() === 'readme.md'),
      );
      if (!readme) continue;

      try {
        await app.vault.process(readme, (content) => {
          // 1. 更新预计周期（支持多种冒号和分隔符）
          const periodRe = /(\*\*预计周期\*\*\s*[：:|]\s*)\S+\s*[~～]\s*\S+/;
          if (periodRe.test(content)) {
            content = content.replace(periodRe, `$1${start} ~ ${end}`);
          } else {
            // 没有预计周期字段 → 在核心信息后追加
            content = content.replace(
              /(\*\*当前状态\*\*[：:|][^\n]*\n)/,
              `$1| **预计周期** | ${start} ~ ${end} |\n`,
            );
          }
          // 2. 更新/创建开发阶段段落
          content = content.replace(/## 📅 开发阶段[\s\S]*?(?=\n## |\n---|$)/g, '').replace(/\n{3,}/g, '\n\n');
          if (phases && phases.length > 0) {
            const phaseSection = `## 📅 开发阶段\n\n| 阶段 | 周期 | 进度 |\n|------|------|------|\n${phases
              .map((p) => `| ${p.label} | ${p.start} ~ ${p.end} | ${p.progress}% |`)
              .join('\n')}`;
            if (content.includes('## 核心信息')) {
              content = content.replace(/(## 核心信息[\s\S]*?\n)\n*---/, `$1\n${phaseSection}\n\n---`);
            } else {
              const sepIdx = content.lastIndexOf('\n---');
              if (sepIdx >= 0) {
                content = content.slice(0, sepIdx) + '\n\n' + phaseSection + '\n' + content.slice(sepIdx);
              } else {
                content = content.trimEnd() + '\n\n' + phaseSection + '\n';
              }
            }
          }
          return content;
        });
      } catch (e) { console.error('[猛士驾驶舱] README 同步失败:', e); }
      return;
    }
  });
  syncQueue.set(taskId, next);
  return next;
}

export function GanttPanel({ app }: { app: App }) {
  const [tasks, setTasks] = useState<GanttTask[]>([]);
  const [loading, setLoading] = useState(true);

  const reloadGantt = useCallback(() => {
    loadGanttData(app).then((data) => {
      setTasks(data);
      setLoading(false);
    });
  }, [app]);

  useEffect(() => {
    reloadGantt();
  }, [reloadGantt]);

  const [drag, setDrag] = useState<DragTarget>(null);
  const [editingField, setEditingField] = useState<EditingField>(null);
  const [editingPhaseProgress, setEditingPhaseProgress] = useState<{ taskId: string; phaseId: string } | null>(null);
  const barColRef = useRef<HTMLDivElement>(null);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const [filterCategory, setFilterCategory] = useState<string | null>(null);
  const [timeScale, setTimeScale] = useState<'all' | 'month' | 'week'>('all');
  const [focusDate, setFocusDate] = useState<Date>(new Date());
  const [focusMode, setFocusMode] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | 'overdue' | 'active' | 'done'>('all');

  const dataRange = useMemo(() => getDateRange(tasks), [tasks]);

  // 时间切片：按月度/周度聚焦
  const { min, max } = useMemo(() => {
    if (timeScale === 'all') return dataRange;
    const d = new Date(focusDate);
    if (timeScale === 'month') {
      const mStart = new Date(d.getFullYear(), d.getMonth(), 1);
      const mEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59);
      return { min: mStart, max: mEnd };
    }
    // week: Monday to Sunday
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d.getFullYear(), d.getMonth(), diff);
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6, 23, 59, 59);
    return { min: monday, max: sunday };
  }, [timeScale, focusDate, dataRange]);

  // 导航
  const navigateTime = (direction: -1 | 1) => {
    const d = new Date(focusDate);
    if (timeScale === 'month') {
      d.setMonth(d.getMonth() + direction);
    } else {
      d.setDate(d.getDate() + direction * 7);
    }
    setFocusDate(d);
  };

  const periodLabel = useMemo(() => {
    if (timeScale === 'all') return '';
    if (timeScale === 'month') {
      return `${focusDate.getFullYear()}年${focusDate.getMonth() + 1}月`;
    }
    const day = focusDate.getDay();
    const diff = focusDate.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(focusDate.getFullYear(), focusDate.getMonth(), diff);
    const fmtM = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    return `${fmtM(monday)} — ${fmtM(sunday)}`;
  }, [timeScale, focusDate]);
  const totalDays = Math.max(1, daysBetween(min, max));
  const monthLabels = useMemo(() => getMonthLabels(min, max), [min, max]);

  // 子刻度：月度/周度模式下标注更细的日期刻度
  const subTicks = useMemo(() => {
    if (timeScale === 'all' || totalDays <= 0) return [] as { pct: number; label: string }[];
    const ticks: { pct: number; label: string }[] = [];
    const totalMs = max.getTime() - min.getTime();
    if (totalMs <= 0) return ticks;
    const DAY = 86400000;

    if (timeScale === 'month') {
      // 按周标注：从当月第一个周一开始，每 7 天一个刻度
      const d = new Date(min);
      while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
      while (d <= max) {
        const pct = ((d.getTime() - min.getTime()) / totalMs) * 100;
        if (pct >= 0 && pct <= 100) {
          ticks.push({ pct, label: `${d.getMonth() + 1}/${d.getDate()}` });
        }
        d.setDate(d.getDate() + 7);
      }
    } else if (timeScale === 'week') {
      // 按天标注
      const DAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];
      for (let i = 0; i < 7; i++) {
        const d = new Date(min.getTime() + i * DAY);
        if (d > max) break;
        const pct = (i / 7) * 100 + (100 / 7 / 2); // 居中
        ticks.push({ pct, label: DAY_NAMES[d.getDay() === 0 ? 6 : d.getDay() - 1] });
      }
    }
    return ticks;
  }, [timeScale, min, max, totalDays]);

  const today = useMemo(() => new Date(), []);

  // 先按 group 分组，再按 filterCategory / focusMode 过滤
  const groups = useMemo(() => {
    const map = new Map<string, GanttTask[]>();
    for (const t of tasks) {
      if (filterCategory && t.category !== filterCategory) continue;
      // 聚焦模式：只显示项目周期覆盖今天的项目
      if (focusMode) {
        const todayTs = today.getTime();
        const ts = parseLocalDate(t.start).getTime();
        const te = parseLocalDate(t.end).getTime();
        if (todayTs < ts || todayTs > te) continue;
      }
      // 状态筛选
      if (statusFilter === 'overdue') {
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        if (!(t.end < todayStr && t.progress < 100)) continue;
      }
      if (statusFilter === 'active') {
        if (!(t.progress > 0 && t.progress < 100)) continue;
      }
      if (statusFilter === 'done') {
        if (t.progress < 100) continue;
      }
      const list = map.get(t.group) ?? [];
      list.push(t);
      map.set(t.group, list);
    }
    // 组内按开始时间从前往后排序
    for (const list of map.values()) {
      list.sort((a, b) => a.start.localeCompare(b.start));
    }
    return Array.from(map.entries());
  }, [tasks, filterCategory, focusMode, statusFilter, today]);

  // 从当前任务中提取所有类别
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) {
      if (t.category) set.add(t.category);
    }
    return Array.from(set).sort();
  }, [tasks]);

  // 统计：总数 / 已完成 / 进行中 / 已延期
  const ganttStats = useMemo(() => {
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    let total = 0, done = 0, active = 0, overdue = 0;
    for (const t of tasks) {
      if (filterCategory && t.category !== filterCategory) continue;
      total++;
      if (t.progress >= 100) { done++; continue; }
      if (t.progress > 0) active++;
      if (t.end < todayStr) overdue++;
    }
    return { total, done, active, overdue };
  }, [tasks, filterCategory, today]);

  const todayPct = (() => {
    const totalMs = max.getTime() - min.getTime();
    if (totalMs <= 0) return 50;
    return ((today.getTime() - min.getTime()) / totalMs) * 100;
  })();

  const monthWidths = (() => {
    if (monthLabels.length === 0 || totalDays <= 0) return [];
    return monthLabels.map((_, i) => {
      const mStart = i === 0 ? min : new Date(min.getFullYear(), min.getMonth() + i, 1);
      const mEnd = i < monthLabels.length - 1
        ? new Date(min.getFullYear(), min.getMonth() + i + 1, 0)
        : max;
      return (Math.max(1, daysBetween(mStart, mEnd)) / totalDays) * 100;
    });
  })();

  // ---- 工具函数 ----
  const pxToDate = useCallback(
    (px: number): Date => {
      // 用表头 bar-col 做坐标基准（class 选择器，避免多元素 ref 竞争）
      const el = barColRef.current?.querySelector('.mswb-gantt-bar-col') as HTMLElement | null
        ?? barColRef.current;
      if (!el) return new Date();
      const rect = el.getBoundingClientRect();
      const pct = ((px - rect.left) / rect.width) * 100;
      const ms = min.getTime() + (pct / 100) * (max.getTime() - min.getTime());
      return new Date(ms);
    },
    [min, max],
  );

  const dateToPx = useCallback(
    (date: Date): number => {
      return ((date.getTime() - min.getTime()) / (max.getTime() - min.getTime())) * 100;
    },
    [min, max],
  );

  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const fmtShort = (d: Date) => {
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  // ---- 拖拽处理 ----
  const handleBarMouseDown = (taskId: string, edge: 'start' | 'end', phaseId?: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 设置 drag 状态供 CSS 高亮使用
    setDrag({ taskId, edge, phaseId });

    const el = barColRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();

    const onMove = (e: MouseEvent) => {
      const px = Math.max(rect.left, Math.min(rect.right, e.clientX));
      const date = pxToDate(px);

      setTasks((prev) =>
        prev.map((t) => {
          if (t.id !== taskId) return t;
          if (phaseId && t.phases) {
            return {
              ...t,
              phases: t.phases.map((p) => {
                if (p.id !== phaseId) return p;
                if (edge === 'start') {
                  if (date >= parseLocalDate(p.end)) return p;
                  return { ...p, start: fmt(date) };
                } else {
                  if (date <= parseLocalDate(p.start)) return p;
                  return { ...p, end: fmt(date) };
                }
              }),
            };
          }
          if (edge === 'start') {
            if (date >= parseLocalDate(t.end)) return t;
            return { ...t, start: fmt(date) };
          } else {
            if (date <= parseLocalDate(t.start)) return t;
            return { ...t, end: fmt(date) };
          }
        }),
      );
    };

    const onUp = () => {
      setTasks((prev) => {
        const t = prev.find((x) => x.id === taskId);
        if (t) {
          if (phaseId && t.phases) {
            saveGanttOverride(t.id, { phases: t.phases });
            syncToReadme(app, t.id, t.start, t.end, t.phases);
          } else {
            saveGanttOverride(t.id, { start: t.start, end: t.end });
            syncToReadme(app, t.id, t.start, t.end);
          }
        }
        return prev;
      });
      setDrag(null);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ---- 编辑进度 & 日期（内联输入） ----
  const handleFieldClick = (taskId: string, field: 'progress' | 'start' | 'end') => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setEditingField({ taskId, field });
  };

  const handleFieldSubmit = (taskId: string, field: 'progress' | 'start' | 'end', value: string) => {
    setEditingField(null);
    if (!value) return;

    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== taskId) return t;
        if (field === 'progress') {
          const p = Math.max(0, Math.min(100, parseInt(value, 10) || 0));
          saveGanttOverride(taskId, { progress: p });
          return { ...t, progress: p };
        } else {
          const updated = { ...t, [field]: value };
          saveGanttOverride(taskId, { [field]: value });
          syncToReadme(app, taskId, updated.start, updated.end);
          return updated;
        }
      }),
    );
  };

  const handleFieldKeyDown = (taskId: string, field: 'progress' | 'start' | 'end') => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleFieldSubmit(taskId, field, (e.target as HTMLInputElement).value);
    if (e.key === 'Escape') setEditingField(null);
  };

  // ---- 里程碑管理 ----
  const handleMsAdd = (taskId: string) => {
    new MilestoneModal(app, (data: MilestoneSubmitData) => {
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id !== taskId) return t;
          const updated = [...(t.milestones ?? []), data];
          saveGanttOverride(taskId, { milestones: updated });
          return { ...t, milestones: updated };
        }),
      );
    }).open();
  };

  const handleMsClick = (taskId: string, idx: number) => {
    const task = tasksRef.current.find((t) => t.id === taskId);
    const ms = task?.milestones?.[idx];
    if (!ms) return;
    new MilestoneModal(app, (data: MilestoneSubmitData) => {
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id !== taskId || !t.milestones) return t;
          const updated = [...t.milestones];
          updated[idx] = data;
          saveGanttOverride(taskId, { milestones: updated });
          return { ...t, milestones: updated };
        }),
      );
    }, ms).open();
  };

  const handleMsDelete = (taskId: string, idx: number) => {
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== taskId || !t.milestones) return t;
        const updated = t.milestones.filter((_, i) => i !== idx);
        saveGanttOverride(taskId, { milestones: updated });
        return { ...t, milestones: updated };
      }),
    );
  };

  // ---- 阶段管理 ----
  const handlePhaseAdd = (taskId: string) => {
    const task = tasksRef.current.find((t) => t.id === taskId);
    const existingPhases = task?.phases ?? [];
    new PhaseModal(app, existingPhases, (data: PhaseSubmitData) => {
      const newPhase = {
        id: data.id ?? `p${Date.now()}`,
        label: data.label,
        start: data.start,
        end: data.end,
        progress: 0,
      };
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id !== taskId) return t;
          const existing = t.phases ?? [];
          const editIdx = data.id ? existing.findIndex((p) => p.id === data.id) : -1;
          const updated =
            editIdx >= 0
              ? existing.map((p, i) =>
                  i === editIdx
                    ? { ...p, label: data.label, start: data.start, end: data.end }
                    : p,
                )
              : [...existing, newPhase];
          saveGanttOverride(taskId, { phases: updated });
          syncToReadme(app, taskId, t.start, t.end, updated);
          return { ...t, phases: updated };
        }),
      );
    }).open();
  };

  const handlePhaseEdit = (taskId: string, phase: GanttPhase) => {
    const task = tasksRef.current.find((t) => t.id === taskId);
    const otherPhases = (task?.phases ?? []).filter((p) => p.id !== phase.id);
    new PhaseModal(app, otherPhases, (data: PhaseSubmitData) => {
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id !== taskId || !t.phases) return t;
          const updated = t.phases.map((p) => {
            if (p.id !== phase.id) return p;
            return { ...p, label: data.label, start: data.start, end: data.end };
          });
          saveGanttOverride(taskId, { phases: updated });
          syncToReadme(app, taskId, t.start, t.end, updated);
          return { ...t, phases: updated };
        }),
      );
    }, phase).open();
  };

  const handlePhaseDelete = (taskId: string, phaseId: string) => {
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== taskId || !t.phases) return t;
        const updated = t.phases.filter((p) => p.id !== phaseId);
        saveGanttOverride(taskId, { phases: updated.length > 0 ? updated : [] });
        syncToReadme(app, taskId, t.start, t.end, updated);
        return { ...t, phases: updated.length > 0 ? updated : undefined };
      }),
    );
  };

  // ---- 阶段进度编辑 ----
  const handlePhaseProgressSubmit = (taskId: string, phaseId: string, value: number) => {
    setEditingPhaseProgress(null);
    const v = Math.max(0, Math.min(100, value));
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== taskId || !t.phases) return t;
        const updated = t.phases.map((p) =>
          p.id === phaseId ? { ...p, progress: v } : p,
        );
        saveGanttOverride(taskId, { phases: updated });
        syncToReadme(app, taskId, t.start, t.end, updated);
        return { ...t, phases: updated };
      }),
    );
  };

  // ---- 点击项目名称跳转 README ----
  const handleNameClick = (task: GanttTask) => {
    const roots = getConfig().projectRoots;
    const allFiles = app.vault.getFiles();
    for (const root of roots) {
      const folderPath = `${root}/${task.id}`;
      // 在文件夹内搜索任意 .README.md 文件（与 loadGanttData 同逻辑）
      const readme = allFiles.find(
        (f) => f.path.startsWith(folderPath + '/') && f.name.endsWith('.README.md'),
      );
      if (readme) {
        app.workspace.openLinkText(readme.path, '', false);
        return;
      }
    }
    new Notice(`未找到「${task.name}」的 README 文件`);
  };

  // ---- 渲染 ----
  if (loading) {
    return (
      <div className="mswb-placeholder">
        <div className="mswb-placeholder-icon">📊</div>
        <p>加载排期中...</p>
      </div>
    );
  }

  return (
    <div className="mswb-gantt">
      {/* 统计栏 */}
      <div className="mswb-proj-stats">
        <span className="mswb-stat"><strong>{ganttStats.total}</strong> 个项目</span>
        <span className="mswb-stat"><strong>{ganttStats.done}</strong> 已完成</span>
        <span className="mswb-stat"><strong>{ganttStats.active}</strong> 进行中</span>
        {ganttStats.overdue > 0 && (
          <span className="mswb-stat" style={{ color: 'var(--color-red)' }}>⚠️ <strong>{ganttStats.overdue}</strong> 已延期</span>
        )}
        <button
          className={`mswb-sort-btn ${statusFilter === 'overdue' ? 'active' : ''}`}
          onClick={() => setStatusFilter(statusFilter === 'overdue' ? 'all' : 'overdue')}
          style={{ marginLeft: 'auto' }}
        >
          ⚠️ 已延期
        </button>
        <button
          className={`mswb-sort-btn ${statusFilter === 'active' ? 'active' : ''}`}
          onClick={() => setStatusFilter(statusFilter === 'active' ? 'all' : 'active')}
        >
          🔄 进行中
        </button>
        <button
          className={`mswb-sort-btn ${statusFilter === 'done' ? 'active' : ''}`}
          onClick={() => setStatusFilter(statusFilter === 'done' ? 'all' : 'done')}
        >
          ✅ 已完成
        </button>
        <button
          className={`mswb-sort-btn ${focusMode ? 'active' : ''}`}
          onClick={() => setFocusMode(!focusMode)}
          title={focusMode ? '取消聚焦' : '聚焦'}
        >
          🎯 聚焦
        </button>
      </div>

      <div className="mswb-gantt-legend">
        {/* 类别筛选按钮 */}
        <div className="mswb-gantt-filter">
          <button
            className={`mswb-sort-btn ${filterCategory === null ? 'active' : ''}`}
            onClick={() => setFilterCategory(null)}
          >
            全部
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              className={`mswb-sort-btn ${filterCategory === cat ? 'active' : ''}`}
              onClick={() => setFilterCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
        {/* 时间切片器 */}
        <div className="mswb-gantt-timeslicer">
          <button
            className={`mswb-sort-btn ${timeScale === 'all' ? 'active' : ''}`}
            onClick={() => setTimeScale('all')}
          >
            全部
          </button>
          <button
            className={`mswb-sort-btn ${timeScale === 'month' ? 'active' : ''}`}
            onClick={() => setTimeScale('month')}
          >
            月度
          </button>
          <button
            className={`mswb-sort-btn ${timeScale === 'week' ? 'active' : ''}`}
            onClick={() => setTimeScale('week')}
          >
            周度
          </button>
          {timeScale !== 'all' && (
            <>
              <button className="mswb-sort-btn" onClick={() => navigateTime(-1)} title="上一周期">
                ◀
              </button>
              <span className="mswb-gantt-period-label">{periodLabel}</span>
              <button className="mswb-sort-btn" onClick={() => navigateTime(1)} title="下一周期">
                ▶
              </button>
              <button
                className="mswb-sort-btn"
                onClick={() => setFocusDate(new Date())}
                title="回到今天"
              >
                今天
              </button>
            </>
          )}
        </div>
      </div>

      <div className="mswb-gantt-table">
        <div className="mswb-gantt-header">
          {/* 月份行 */}
          <div className="mswb-gantt-header-row">
            <div className="mswb-gantt-label-col" />
            <div className="mswb-gantt-bar-col" ref={barColRef}>
              {monthLabels.map((label, i) => (
                <div
                  key={label}
                  className="mswb-gantt-month"
                  style={{ width: `${monthWidths[i]}%` }}
                >
                  {label}
                </div>
              ))}
            </div>
          </div>
          {/* 子刻度行（月度/周度模式） */}
          {subTicks.length > 0 && (
            <div className="mswb-gantt-header-row mswb-gantt-sub-header">
              <div className="mswb-gantt-label-col" />
              <div className="mswb-gantt-bar-col">
                {subTicks.map((t, i) => (
                  <span
                    key={`sub-${i}`}
                    className="mswb-gantt-sub-tick"
                    style={{ left: `${t.pct}%` }}
                  >
                    {t.label}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {groups.map(([groupName, groupTasks]) => (
          <React.Fragment key={groupName}>
            <div className="mswb-gantt-group-header">
              <div className="mswb-gantt-label-col">{groupName}</div>
              <div className="mswb-gantt-bar-col" />
            </div>

            {groupTasks.map((task) => {
              const startPct = dateToPx(parseLocalDate(task.start));
              const endPct = dateToPx(parseLocalDate(task.end));
              const widthPct = endPct - startPct;
              const midPct = startPct + widthPct / 2;
              const isDragging = drag?.taskId === task.id;
              const ef = editingField;

              return (
                <div key={task.id} className="mswb-gantt-row">
                  <div className="mswb-gantt-label-col">
                    <span
                      className="mswb-gantt-name"
                      onClick={() => handleNameClick(task)}
                      title={`打开 ${task.name} 项目 README`}
                    >
                      {task.name}
                    </span>
                  </div>

                  <div className="mswb-gantt-bar-col">
                    {/* 网格线 */}
                    {monthLabels.map((_, i) => {
                      const leftPct = monthLabels
                        .slice(0, i)
                        .reduce((s, _, j) => s + monthWidths[j], 0);
                      return (
                        <div
                          key={i}
                          className="mswb-gantt-grid-line"
                          style={{ left: `${leftPct}%` }}
                        />
                      );
                    })}
                    {/* 子刻度网格线（月度/周度） */}
                    {subTicks.map((t, i) => (
                      <div
                        key={`subgrid-${i}`}
                        className="mswb-gantt-sub-grid-line"
                        style={{ left: `${t.pct}%` }}
                      />
                    ))}

                    {/* ---- 主计划线（始终显示） ---- */}
                    <div
                      className={`mswb-gantt-main-line ${isDragging && !drag?.phaseId ? 'dragging' : ''}`}
                      style={{
                        left: `${startPct}%`,
                        width: `${Math.max(0, widthPct)}%`,
                        borderColor: task.color,
                      }}
                    >
                      <div
                        className="mswb-gantt-handle left"
                        onMouseDown={handleBarMouseDown(task.id, 'start')}
                        title="拖拽调整开始日期"
                      />
                      <div
                        className="mswb-gantt-handle right"
                        onMouseDown={handleBarMouseDown(task.id, 'end')}
                        title="拖拽调整结束日期"
                      />
                    </div>

                    {/* 主计划线 — 开始日期（可点击编辑），仅在可视范围内显示 */}
                    {startPct >= 0 && startPct <= 100 && (
                      ef?.taskId === task.id && ef?.field === 'start' ? (
                        <input
                          type="date"
                          className="mswb-gantt-date-input"
                          defaultValue={task.start}
                          autoFocus
                          style={{ left: `${startPct}%` }}
                          onBlur={(e) => handleFieldSubmit(task.id, 'start', e.target.value)}
                          onKeyDown={handleFieldKeyDown(task.id, 'start')}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <span
                          className="mswb-gantt-main-label-start"
                          style={{ left: `${startPct}%` }}
                          onClick={handleFieldClick(task.id, 'start')}
                          title="点击编辑开始日期"
                        >
                          {fmtShort(parseLocalDate(task.start))}
                        </span>
                      )
                    )}

                    {/* 主计划线 — 结束日期（可点击编辑），仅在可视范围内显示 */}
                    {endPct >= 0 && endPct <= 100 && (
                      ef?.taskId === task.id && ef?.field === 'end' ? (
                        <input
                          type="date"
                          className="mswb-gantt-date-input"
                          defaultValue={task.end}
                          autoFocus
                          style={{ left: `${endPct}%` }}
                          onBlur={(e) => handleFieldSubmit(task.id, 'end', e.target.value)}
                          onKeyDown={handleFieldKeyDown(task.id, 'end')}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <span
                          className="mswb-gantt-main-label-end"
                          style={{ left: `${endPct}%` }}
                          onClick={handleFieldClick(task.id, 'end')}
                          title="点击编辑结束日期"
                        >
                          {fmtShort(parseLocalDate(task.end))}
                        </span>
                      )
                    )}

                    {/* 主计划线 — 进度百分比，仅在可视范围内显示 */}
                    {midPct >= 0 && midPct <= 100 && (
                      ef?.taskId === task.id && ef?.field === 'progress' ? (
                        <input
                          className="mswb-gantt-progress-input"
                          defaultValue={String(task.progress)}
                          autoFocus
                          style={{ left: `${midPct}%` }}
                          onBlur={(e) => handleFieldSubmit(task.id, 'progress', e.target.value)}
                          onKeyDown={handleFieldKeyDown(task.id, 'progress')}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <span
                          className="mswb-gantt-main-progress"
                          style={{ left: `${midPct}%` }}
                          onClick={handleFieldClick(task.id, 'progress')}
                          title="点击编辑进度"
                        >
                          {task.progress}%
                        </span>
                      )
                    )}

                    {/* ---- 阶段条（有 phases 时显示） ---- */}
                    {task.phases && task.phases.length > 0 &&
                      task.phases.map((phase) => {
                        const ps = dateToPx(parseLocalDate(phase.start));
                        const pw = dateToPx(parseLocalDate(phase.end)) - ps;
                        const isPhaseDragging =
                          drag?.taskId === task.id && drag?.phaseId === phase.id;
                        return (
                          <div
                            key={phase.id}
                            className={`mswb-gantt-bar ${isPhaseDragging ? 'dragging' : ''}`}
                            style={{
                              left: `${ps}%`,
                              width: `${pw}%`,
                              backgroundColor: task.color,
                              cursor: isPhaseDragging ? 'grabbing' : 'pointer',
                            }}
                            onClick={(e) => {
                              const target = e.target as HTMLElement;
                              if (!target.closest('.mswb-gantt-handle, .mswb-gantt-phase-delete')) {
                                e.stopPropagation();
                                handlePhaseEdit(task.id, phase);
                              }
                            }}
                          >
                            <div
                              className="mswb-gantt-handle left"
                              onMouseDown={handleBarMouseDown(task.id, 'start', phase.id)}
                              title="拖拽调整阶段开始日期"
                            />
                            <div className="mswb-gantt-bar-fill" style={{ width: `${phase.progress}%` }} />
                            {editingPhaseProgress?.taskId === task.id && editingPhaseProgress?.phaseId === phase.id ? (
                              <input
                                className="mswb-gantt-phase-progress-input"
                                defaultValue={String(phase.progress)}
                                autoFocus
                                onBlur={(e) => {
                                  handlePhaseProgressSubmit(task.id, phase.id, parseInt(e.target.value, 10) || 0);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter')
                                    handlePhaseProgressSubmit(task.id, phase.id, parseInt((e.target as HTMLInputElement).value, 10) || 0);
                                  if (e.key === 'Escape') setEditingPhaseProgress(null);
                                }}
                                onClick={(e) => e.stopPropagation()}
                              />
                            ) : (
                              <span
                                className="mswb-gantt-bar-label"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditingPhaseProgress({ taskId: task.id, phaseId: phase.id });
                                }}
                                title="点击编辑进度"
                              >
                                {phase.label} | {phase.progress}%
                              </span>
                            )}
                            <button
                              className="mswb-gantt-phase-delete"
                              onClick={(e) => {
                                e.stopPropagation();
                                handlePhaseDelete(task.id, phase.id);
                              }}
                              title="删除此阶段"
                            >
                              ×
                            </button>
                            <div
                              className="mswb-gantt-handle right"
                              onMouseDown={handleBarMouseDown(task.id, 'end', phase.id)}
                              title="拖拽调整阶段结束日期"
                            />
                          </div>
                        );
                      })}

                    {/* ---- 里程碑（在主计划线上） ---- */}
                    {task.milestones?.map((ms, msIdx) => {
                      const msPct = dateToPx(parseLocalDate(ms.date));
                      return (
                        <div
                          key={msIdx}
                          className="mswb-gantt-milestone"
                          style={{ left: `${msPct}%` }}
                        >
                          <span
                            className="mswb-gantt-milestone-diamond"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMsClick(task.id, msIdx);
                            }}
                            title={`${ms.date}: ${ms.label} — 点击编辑`}
                          />
                          <span
                            className="mswb-gantt-milestone-label"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMsClick(task.id, msIdx);
                            }}
                            title={`${ms.date}: ${ms.label} — 点击编辑`}
                          >
                            {ms.icon ? `${ms.icon} ` : ''}{ms.label}
                          </span>
                          <button
                            className="mswb-gantt-ms-delete"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMsDelete(task.id, msIdx);
                            }}
                            title="删除此里程碑"
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}

                    {/* 添加里程碑按钮 */}
                    <button
                      className="mswb-gantt-ms-add"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleMsAdd(task.id);
                      }}
                      title="添加里程碑"
                    >
                      +
                    </button>

                    {/* 添加阶段按钮 */}
                    <button
                      className="mswb-gantt-phase-add"
                      onClick={(e) => {
                        e.stopPropagation();
                        handlePhaseAdd(task.id);
                      }}
                      title="添加开发阶段"
                    >
                      📋+
                    </button>
                  </div>
                </div>
              );
            })}
          </React.Fragment>
        ))}

        {/* 今天红色竖线 */}
        {todayPct > 0 && todayPct < 100 && (
          <div className="mswb-gantt-today-overlay">
            <div
              className="mswb-gantt-today-line"
              style={{ left: `${todayPct}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
