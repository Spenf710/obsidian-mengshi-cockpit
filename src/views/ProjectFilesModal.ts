import { App, Modal } from 'obsidian';

export class ProjectFilesModal extends Modal {
  constructor(
    app: App,
    private folderPath: string,
    private projectName: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mswb-modal');

    contentEl.createEl('h3', { text: `📁 ${this.projectName}` });

    // 列出来源文件夹中所有 .md 文件
    const allFiles = this.app.vault.getFiles();
    const mdFiles = allFiles
      .filter(
        (f) => f.path.startsWith(this.folderPath + '/') && f.name.endsWith('.md'),
      )
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));

    if (mdFiles.length === 0) {
      contentEl.createEl('p', {
        text: '该目录暂无文件',
        cls: 'mswb-modal-empty',
      });
      return;
    }

    const list = contentEl.createEl('ul', { cls: 'mswb-file-list' });

    for (const file of mdFiles) {
      const item = list.createEl('li');
      const link = item.createEl('a', {
        text: file.name.replace(/\.md$/, ''),
        cls: 'mswb-file-link',
      });
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this.app.workspace.getLeaf(false).openFile(file);
        this.close();
      });
    }

    // 关闭按钮
    const btnRow = contentEl.createDiv({ cls: 'mswb-modal-actions' });
    const closeBtn = btnRow.createEl('button', { text: '关闭' });
    closeBtn.addEventListener('click', () => this.close());
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
