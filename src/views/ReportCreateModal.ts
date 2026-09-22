import { App, Modal, Setting, Notice, TFile, TFolder } from 'obsidian';
import { centerModalInWorkbench } from './modalHelpers';
import { buildReportDraft, type ReportDraft } from '../data/reportDraft';

// ===== 生成周报/月报 =====

interface ReportCreateOptions {
  kind: 'weekly' | 'monthly';
  /** weekly：周一起始日期 */
  start?: Date;
  /** weekly：周结束日期 */
  end?: Date;
  /** monthly：月份 1-12 */
  month?: number;
  /** monthly：年份 */
  year?: number;
  /** 创建成功后回调（刷新列表/空态） */
  onCreated?: (path: string) => void;
}

/** 补齐两位数 */
const pad2 = (n: number) => String(n).padStart(2, '0');
/** 转 YYYY-MM-DD（本地时区） */
const toLocalYMD = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** 季度号：1-3月→Q1 ... */
function quarterOf(month: number): number {
  return Math.floor((month - 1) / 3) + 1;
}

/**
 * 「一键生成周报/月报」。
 * 初衷：没用过驾驶舱的新手，开箱没有周报/月报 skill 支撑，周卡/月卡无数据。
 * 本弹窗让用户在面板里直接创建报告文件，两种内容来源：
 *   1) 从日志提取草稿（默认）：用 reportDraft 聚合该周期日志 → 项目分区 + 每日一句话 + 状态统计 + 自动 ai_summary
 *   2) 空骨架：frontmatter + 章节占位，可手填或后续让 AI 总结
 * 目录自动按 year/季度 创建；文件已存在则 Notice 拦截。
 */
export class ReportCreateModal extends Modal {
  private kind: 'weekly' | 'monthly';
  private start: Date | null;
  private end: Date | null;
  private month: number;
  private year: number;
  private onCreated?: (path: string) => void;
  private draft: ReportDraft | null = null;
  private mode: 'draft' | 'skeleton' = 'draft';
  private previewEl: HTMLDivElement | null = null;
  private submitBtn: HTMLButtonElement | null = null;

  constructor(app: App, opts: ReportCreateOptions) {
    super(app);
    this.kind = opts.kind;
    this.onCreated = opts.onCreated;

    if (opts.kind === 'weekly') {
      // weekly：周一是周开始，周日结束
      const base = opts.start ? new Date(opts.start) : new Date();
      const dow = base.getDay(); // 0=Sun
      const monday = new Date(base);
      monday.setDate(monday.getDate() - (dow === 0 ? 6 : dow - 1));
      monday.setHours(12, 0, 0, 0);
      this.start = monday;
      const sunday = new Date(monday);
      sunday.setDate(sunday.getDate() + 6);
      this.end = sunday;
      this.month = monday.getMonth() + 1;
      this.year = monday.getFullYear();
    } else {
      this.start = null;
      this.end = null;
      this.month = opts.month ?? new Date().getMonth() + 1;
      this.year = opts.year ?? new Date().getFullYear();
    }
  }

  private getRangeYMD(): { from: string; to: string } {
    if (this.kind === 'weekly') {
      return { from: toLocalYMD(this.start!), to: toLocalYMD(this.end!) };
    }
    const daysInMonth = new Date(this.year, this.month, 0).getDate();
    return {
      from: `${this.year}-${pad2(this.month)}-01`,
      to: `${this.year}-${pad2(this.month)}-${pad2(daysInMonth)}`,
    };
  }

  private getFileName(): string {
    if (this.kind === 'weekly') {
      const s = this.start!;
      const e = this.end!;
      const sameMonth = s.getMonth() === e.getMonth();
      const sm = s.getMonth() + 1;
      const em = e.getMonth() + 1;
      const md = `${sm}月${s.getDate()}日~${sameMonth ? '' : `${em}月`}${e.getDate()}日`;
      return `周工作总结（${md}）.md`;
    }
    return `${this.year}-${pad2(this.month)}-月报.md`;
  }

  private buildContent(): string {
    const now = new Date();
    const todayStr = toLocalYMD(now);
    const draft = this.mode === 'draft' ? this.draft : null;
    const ai = draft?.aiSummary ? `"${draft.aiSummary}"` : '""';

    if (this.kind === 'weekly') {
      const s = this.start!;
      const e = this.end!;
      const period = `${toLocalYMD(s)}~${toLocalYMD(e)}`;
      const mdStart = `${s.getMonth() + 1}月${s.getDate()}日`;
      const mdEnd = `${e.getMonth() + 1}月${e.getDate()}日`;

      const parts: string[] = [
        '---',
        `title: 周工作总结（${mdStart} ~ ${mdEnd}）`,
        `date: ${todayStr}`,
        `period: ${period}`,
        'type: 周报',
        `ai_summary: ${ai}`,
        'tags:',
        '  - 工作周报',
        '---',
        '',
        `# 📅 周工作总结（${mdStart} ~ ${mdEnd}）`,
        '',
        `> 💬 **本周概述**：${draft?.aiSummary ?? ''}`,
        '',
        '## ✅ 本周完成',
        '',
      ];
      if (draft && draft.projects.length) {
        for (const p of draft.projects.slice(0, 6)) {
          parts.push(`### ${p.label}`, '');
          for (const ln of p.lines) {
            parts.push(`- **${ln.date}**：${ln.summary}`);
          }
          parts.push('');
        }
      } else {
        parts.push('### 📌 项目一', '- 进展描述（保留关键数据：数量 / 率 / 日期）', '');
        parts.push('### 📌 项目二', '- 进展描述', '');
      }
      parts.push('## 📅 下周计划', '', '### 项目一', '- 计划描述', '', '---', '', '**相关笔记：**', '');
      return parts.join('\n');
    }

    // monthly
    const daysInMonth = new Date(this.year, this.month, 0).getDate();
    const st = draft?.statuses ?? { green: 0, yellow: 0, red: 0 };
    const logDays = draft?.logDays ?? 0;
    const projCount = draft?.projects.length ?? 0;
    const parts: string[] = [
      '---',
      `title: ${this.year}年${this.month}月 月报`,
      `date: ${todayStr}`,
      `period: ${this.year}-${pad2(this.month)}-01~${this.year}-${pad2(this.month)}-${pad2(daysInMonth)}`,
      'type: 月度总结',
      `ai_summary: ${ai}`,
      'tags:',
      '  - 月度总结',
      '---',
      '',
      `# 📊 ${this.year}年${this.month}月 月报`,
      '',
      `> 📝 日志天数：${logDays} 天 · 🟢 在线 ${st.green} 天 / 🟡 有点忙 ${st.yellow} 天 / 🔴 忙炸了 ${st.red} 天`,
      '',
      `> 💬 **本月概述**：${draft?.aiSummary ?? ''}`,
      '',
      '## 📊 本月工作统计',
      '',
      '| 指标 | 值 |',
      '| --- | --- |',
      `| 日志天数 | ${logDays} 天 |`,
      `| 项目数 | ${projCount} 个 |`,
      '| 高光主线 | 待补充 |',
      '| 新项目 | 待补充 |',
      '',
    ];
    if (draft && draft.projects.length) {
      let i = 1;
      for (const p of draft.projects.slice(0, 6)) {
        parts.push(`## ${'一二三四五六七八'[i - 1]}、${p.label}`, '');
        for (const ln of p.lines) {
          parts.push(`- **${ln.date}**：${ln.summary}`);
        }
        parts.push('');
        i++;
      }
    } else {
      parts.push('## 一、🏆 项目一', '', '- 该月进展要点', '');
      parts.push('## 二、🏆 项目二', '', '- 该月进展要点', '');
    }
    parts.push('---', '', '**相关笔记：**', '');
    return parts.join('\n');
  }

  private async loadDraft(): Promise<ReportDraft | null> {
    const { from, to } = this.getRangeYMD();
    try {
      return await buildReportDraft(this.app, from, to);
    } catch {
      return null;
    }
  }

  private renderPreview(): void {
    if (!this.previewEl) return;
    this.previewEl.empty();
    if (this.mode === 'skeleton') {
      this.previewEl.createEl('div', {
        text: '将创建空骨架（正确 frontmatter + 章节占位），正文可手填或后续让 AI 总结。',
        cls: 'mswb-modal-hint',
      });
      return;
    }
    const d = this.draft;
    if (!d || d.total === 0) {
      this.previewEl.createEl('div', {
        text: '该时间段没有工作日志，无法提取草稿 → 建议选择「空骨架」。',
        cls: 'mswb-modal-hint',
      });
      return;
    }
    this.previewEl.createEl('div', {
      text: `将提取 ${d.logDays} 天 · ${d.total} 条日志，聚合 ${d.projects.length} 个项目：`,
      cls: 'mswb-modal-hint',
    });
    const list = this.previewEl.createEl('ul', { cls: 'mswb-modal-draft-list' });
    const listItemCls = 'mswb-modal-draft-item';
    for (const p of d.projects.slice(0, 6)) {
      const li = list.createEl('li', { cls: listItemCls });
      li.setText(`${p.label}（${p.lines.length} 条）`);
    }
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mswb-modal');
    centerModalInWorkbench(this);

    contentEl.createEl('h3', {
      text: this.kind === 'weekly' ? '📅 一键生成周报' : '📊 一键生成月报',
    });

    // 周期
    if (this.kind === 'weekly') {
      new Setting(contentEl)
        .setName('周期')
        .setDesc(
          `周一 ~ 周日：${toLocalYMD(this.start!)} ~ ${toLocalYMD(this.end!)}（${this.start!.getMonth() + 1}月${this.start!.getDate()}日 ~ ${this.end!.getMonth() + 1}月${this.end!.getDate()}日）`,
        );
    } else {
      const { from, to } = this.getRangeYMD();
      new Setting(contentEl)
        .setName('周期')
        .setDesc(`${this.year}年${this.month}月（${from} ~ ${to}）`);
    }

    // 加载草稿
    this.draft = await this.loadDraft();

    // 内容来源
    new Setting(contentEl)
      .setName('内容来源')
      .addDropdown((dd) => {
        dd.addOption('draft', '📝 从日志提取草稿');
        dd.addOption('skeleton', '🧱 空骨架（手填）');
        dd.setValue(this.mode);
        dd.onChange((v) => {
          this.mode = (v as 'draft' | 'skeleton');
          this.renderPreview();
          this.refreshSubmitLabel();
        });
      });

    // 预览区
    const preview = contentEl.createDiv({ cls: 'setting-item-description mswb-modal-preview' });
    this.previewEl = preview;
    this.renderPreview();

    // 按钮
    const btnRow = contentEl.createDiv({ cls: 'mswb-modal-actions' });
    btnRow.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
    this.submitBtn = btnRow.createEl('button', {
      text: '',
      cls: 'mswb-modal-submit',
    });
    this.submitBtn.addEventListener('click', () => this.submit());
    this.refreshSubmitLabel();
  }

  private refreshSubmitLabel(): void {
    if (!this.submitBtn) return;
    const kindName = this.kind === 'weekly' ? '周报' : '月报';
    this.submitBtn.setText(this.mode === 'draft' ? `创建${kindName}（草稿）` : `创建${kindName}骨架`);
  }

  private async submit(): Promise<void> {
    const rootPath = this.kind === 'weekly'
      ? `工作周报/${this.year}年Q${quarterOf(this.month)}`
      : `工作月报/${this.year}年`;
    const folderPath = rootPath;
    const filePath = `${rootPath}/${this.getFileName()}`;

    // 已存在则拦截
    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
      new Notice(`⚠️ 已存在：${this.getFileName()}`);
      return;
    }

    try {
      // 确保目录存在（自动创建缺失的年/季目录）
      const folder = this.app.vault.getAbstractFileByPath(folderPath);
      if (!(folder instanceof TFolder)) {
        await this.app.vault.createFolder(folderPath);
      }
      await this.app.vault.create(filePath, this.buildContent());
      new Notice(`✅ ${this.getFileName()} 已创建`);
      this.onCreated?.(filePath);
      this.close();

      // 创建成功后打开文件，方便直接编辑
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        this.app.workspace.getLeaf(false).openFile(file);
      }
    } catch (e) {
      new Notice(`❌ 创建失败：${e}`);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}