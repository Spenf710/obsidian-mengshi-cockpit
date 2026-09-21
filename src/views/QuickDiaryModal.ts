import { App, Modal, Setting, TFile, Notice } from 'obsidian';
import { getConfig } from '../data/settings';
import { centerModalInWorkbench } from './modalHelpers';

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 匹配「搞定了什么」段落正文。捕获组1=标题首行, 捕获组2=正文全部内容 */
const DONE_SECTION_RE = /(##\s+✅\s*搞定了什么[\s\S]*?\n)((?:.*\n)*?)(?=\n##\s|\n---|\n\*\*相关笔记|$)/;

export const STATUS_OPTIONS = {
  '🟢 在线': '🟢 在线',
  '🟡 有点忙': '🟡 有点忙',
  '🔴 忙炸了': '🔴 忙炸了',
};

export function getDatePath(dateStr: string): string {
  const [, m] = dateStr.split('-');
  return `${getConfig().workLogPath}/${parseInt(m)}月/${dateStr}.md`;
}

async function readDiaryFields(app: App, filePath: string): Promise<{ status: string; summary: string; done: string } | null> {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) return null;
  const content = await app.vault.cachedRead(file);

  let status = '🟢 在线';
  let summary = '';
  let done = '';

  const statusMatch = content.match(/\*\*今日状态\*\*[：:](.+)/);
  if (statusMatch) status = statusMatch[1].trim();

  const summaryMatch = content.match(/\*\*一句话\*\*[：:](.+)/);
  if (summaryMatch) summary = summaryMatch[1].trim();

  // 提取「搞定了什么」段落原始文本（保留缩进子项）
  const doneMatch = content.match(DONE_SECTION_RE);
  if (doneMatch) {
    done = doneMatch[2].replace(/\n+$/, '');
  }

  return { status, summary, done };
}

export class QuickDiaryModal extends Modal {
  private date: string;
  private status: string;
  private summary: string;
  private done: string;
  private exists = false;
  private filePath = '';
  private doneDirty = false;

  /** 弹窗关闭后的回调，用于外部刷新数据 */
  onAfterClose?: () => void;

  constructor(initialApp: App, initialDate?: string) {
    super(initialApp);
    const now = new Date();
    if (initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate)) {
      this.date = initialDate;
    } else {
      this.date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }
    this.status = '🟢 在线';
    this.summary = '';
    this.done = '';
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mswb-modal');

    // 初始加载
    await this.loadDiary(this.date);

    contentEl.createEl('h3', { text: this.exists ? '✏️ 编辑日记' : '✏️ 创建日记' });
    centerModalInWorkbench(this);

    // 日期（切换时重新加载）
    new Setting(contentEl)
      .setName('日期')
      .addText((text) => {
        text.setValue(this.date);
        text.inputEl.type = 'date';
        text.onChange(async (v) => {
          this.date = v;
          await this.loadDiary(v);
          this.refreshForm();
        });
      });

    // 状态
    new Setting(contentEl)
      .setName('状态')
      .addDropdown((dropdown) => {
        dropdown.addOptions(STATUS_OPTIONS).setValue(this.status).onChange((v) => (this.status = v));
      });

    // 一句话
    new Setting(contentEl)
      .setName('一句话')
      .setDesc('简短摘要，建议 ≤18 字')
      .addText((text) => {
        text.setValue(this.summary).onChange((v) => (this.summary = v));
        text.inputEl.setCssProps({ width: '100%' });
      });

    // 搞定了什么（日记已存在时显示，支持渲染/编辑切换）
    if (this.exists) {
      const doneSection = contentEl.createDiv({ cls: 'mswb-modal-section' });
      doneSection.createEl('div', { text: '搞定了什么', cls: 'setting-item-name' });
      doneSection.createEl('div', { text: '点击切换编辑 / 预览', cls: 'setting-item-description' });

      const doneView = doneSection.createDiv({ cls: 'mswb-modal-md' });
      const doneEdit = doneSection.createDiv({ cls: 'mswb-modal-md-edit mswb-modal-md-edit-hidden' });
      const ta = doneEdit.createEl('textarea');
      let editing = false;

      const renderDone = () => {
        doneView.empty();
        if (!this.done.trim()) {
          doneView.createEl('span', { text: '（空）', cls: 'mswb-modal-warn' });
        } else {
          const list = doneView.createEl('ul');
          const allLines = this.done.split('\n');
          for (let i = 0; i < allLines.length; i++) {
            const raw = allLines[i];
            const isTodo = /^\s*- \[.?\]/.test(raw);
            if (!isTodo) continue;
            const isChecked = /^\s*- \[x\]/i.test(raw);
            const text = raw.replace(/^\s*- \[.?\]\s*/, '').trim();
            if (!text) continue;

            const li = list.createEl('li', { cls: 'mswb-todo-check-row', attr: { 'data-index': String(i) } });
            li.classList.toggle('mswb-todo-check-done', isChecked);
            const cb = li.createEl('input', { type: 'checkbox' });
            cb.checked = isChecked;
            const textDiv = li.createEl('div', { cls: 'mswb-todo-check-text' });
            textDiv.textContent = text;

            cb.addEventListener('change', async () => {
              const index = parseInt(li.getAttribute('data-index') ?? '-1');
              if (index < 0) return;
              const arr = this.done.split('\n');
              arr[index] = arr[index].replace(/\[.?\]/, cb.checked ? '[x]' : '[ ]');
              this.done = arr.join('\n');
              li.classList.toggle('mswb-todo-check-done', cb.checked);
              await this.saveDone();
            });
          }
        }
        doneView.classList.toggle('mswb-modal-md-hidden', editing);
        doneEdit.classList.toggle('mswb-modal-md-edit-hidden', !editing);
        ta.value = this.done;
      };

      doneView.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('input[type="checkbox"]')) return;
        editing = true; renderDone(); ta.focus();
      });
      ta.addEventListener('input', () => { this.done = ta.value; this.doneDirty = true; });
      ta.addEventListener('blur', () => { editing = false; renderDone(); });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { editing = false; renderDone(); }
      });

      renderDone();
    }

    // 按钮
    const btnRow = contentEl.createDiv({ cls: 'mswb-modal-actions' });
    btnRow.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
    const submitBtn = btnRow.createEl('button', {
      text: this.exists ? '保存修改' : '创建日记',
      cls: 'mswb-modal-submit',
    });
    submitBtn.addEventListener('click', () => this.submit());
  }

  private async loadDiary(dateStr: string): Promise<void> {
    this.filePath = getDatePath(dateStr);
    const fields = await readDiaryFields(this.app, this.filePath);
    if (fields) {
      this.exists = true;
      this.status = fields.status;
      this.summary = fields.summary;
      this.done = fields.done;
    } else {
      this.exists = false;
      this.status = '🟢 在线';
      this.summary = '';
      this.done = '';
      this.doneDirty = false;
    }
  }

  private async saveDone(): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.filePath);
    if (!(file instanceof TFile)) return;
    try {
      await this.app.vault.process(file, (content) => {
        return content.replace(DONE_SECTION_RE, `$1${this.done}\n`);
      });
    } catch { /* 静默 */ }
  }

  private refreshForm(): void {
    this.onOpen();
  }

  private async submit(): Promise<void> {
    const match = this.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) { new Notice('日期格式错误'); return; }

    const year = match[1]; const month = match[2]; const day = match[3];
    const date = `${year}-${month}-${day}`;
    const d = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    const weekday = WEEKDAY_NAMES[d.getDay()];
    const monthDay = `${parseInt(month)}月${parseInt(day)}日`;

    const folderPath = `${getConfig().workLogPath}/${parseInt(month)}月`;
    const filePath = getDatePath(this.date);

    // 已存在 → 更新状态、一句话、搞定了什么
    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
      try {
        await this.app.vault.process(existing, (content) => {
          content = content.replace(/\*\*今日状态\*\*[：:].*/, `**今日状态**：${this.status}`);
          content = content.replace(/\*\*一句话\*\*[：:].*/, `**一句话**：${this.summary || ' '}`);
          if (this.doneDirty) {
            content = content.replace(DONE_SECTION_RE, `$1${this.done}\n`);
          }
          return content;
        });
        new Notice('✅ 日记已更新');
        this.close();
      } catch (e) {
        new Notice(`❌ 更新失败：${e}`);
      }
      return;
    }

    // 不存在 → 从模板创建
    const yesterday = new Date(d); yesterday.setDate(yesterday.getDate() - 1);
    const tomorrow = new Date(d); tomorrow.setDate(tomorrow.getDate() + 1);
    const fmt = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
    const weekdayCN = ['日', '一', '二', '三', '四', '五', '六'];
    const dddd = `周${weekdayCN[d.getDay()]}`;
    const MDdd = `${parseInt(month)}月${parseInt(day)}日 周${weekdayCN[d.getDay()]}`;

    // 读取模板文件并替换 Templater 变量
    let tmpl = '';
    const tmplFile = this.app.vault.getAbstractFileByPath(getConfig().diaryTemplate);
    if (tmplFile instanceof TFile) {
      tmpl = await this.app.vault.read(tmplFile);
    }
    if (!tmpl) {
      // 兜底：用内置精简模板
      tmpl = [
        '---', `title: ${date}`, `date: ${date}`, 'tags:', '  - 工作日志', '---',
        `# 📅 ${monthDay} ${weekday} · 工作日志`,
        '', `**今日状态**：${this.status}`, `**一句话**：${this.summary || ' '}`,
        '', '---', '',
        '## ✅ 搞定了什么', '', '- ', '',
        '## ⏭ 明天要做', '- ', '',
      ].join('\n');
      // 保持状态和摘要替换
      tmpl = tmpl
        .replace(/\*\*今日状态\*\*：.*/, `**今日状态**：${this.status}`)
        .replace(/\*\*一句话\*\*：.*/, `**一句话**：${this.summary || ' '}`);
    }
    tmpl = tmpl
      .replace(/<% tp\.date\.now\("YYYY-MM-DD"\) %>/g, date)
      .replace(/<% tp\.date\.now\("dddd"\) %>/g, dddd)
      .replace(/<% tp\.date\.now\("M月D日 ddd"\) %>/g, MDdd)
      .replace(/<% tp\.date\.yesterday\("YYYY-MM-DD"\) %>/g, fmt(yesterday))
      .replace(/<% tp\.date\.tomorrow\("YYYY-MM-DD"\) %>/g, fmt(tomorrow));
    // 填入用户选择的状态和摘要
    tmpl = tmpl
      .replace(/\*\*今日状态\*\*：.*/, `**今日状态**：${this.status}`)
      .replace(/\*\*一句话\*\*：.*/, `**一句话**：${this.summary || ' '}`);

    try {
      const folder = this.app.vault.getAbstractFileByPath(folderPath);
      if (!folder) await this.app.vault.createFolder(folderPath);
      await this.app.vault.create(filePath, tmpl);
      new Notice(`✅ ${date}.md 创建成功`);
      this.close();
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) this.app.workspace.getLeaf(false).openFile(file);
    } catch (e) {
      new Notice(`❌ 创建失败：${e}`);
    }
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.onAfterClose) this.onAfterClose();
  }
}
