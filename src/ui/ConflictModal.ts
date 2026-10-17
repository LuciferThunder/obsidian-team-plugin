import { App, Modal, Setting } from 'obsidian';
import type TeamPlugin from '../main';
import { ConflictInfo } from '../core/Collaboration';

/**
 * Modal showing side-by-side diff when a file version conflict occurs.
 * User can choose: keep local, keep server, or cancel.
 */
export class ConflictModal extends Modal {
    private plugin: TeamPlugin;
    private conflict: ConflictInfo;
    private filePath: string;
    private onResolve: (choice: 'local' | 'server' | 'cancel') => void;

    constructor(
        app: App,
        plugin: TeamPlugin,
        filePath: string,
        conflict: ConflictInfo,
        onResolve: (choice: 'local' | 'server' | 'cancel') => void
    ) {
        super(app);
        this.plugin = plugin;
        this.filePath = filePath;
        this.conflict = conflict;
        this.onResolve = onResolve;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('team-conflict-modal');

        contentEl.createEl('h2', { text: '版本冲突' });
        contentEl.createEl('p', {
            text: `文件「${this.filePath}」存在版本冲突。服务器上的文件已被 ${this.conflict.serverFile.lastEditorName} 修改。`,
            cls: 'conflict-desc'
        });

        const infoDiv = contentEl.createDiv('conflict-info');

        const localInfo = infoDiv.createDiv();
        localInfo.createEl('strong', { text: '本地版本' });
        localInfo.createEl('p', { text: `${this.conflict.localContent.length} 字符` });

        const serverInfo = infoDiv.createDiv();
        serverInfo.createEl('strong', { text: '服务器版本' });
        serverInfo.createEl('p', {
            text: `${this.conflict.serverFile.content.length} 字符 (v${this.conflict.serverFile.version}, 编辑者: ${this.conflict.serverFile.lastEditorName})`
        });

        const diffContainer = contentEl.createDiv('conflict-diff');

        const localDiv = diffContainer.createDiv('conflict-diff-panel');
        localDiv.createEl('h4', { text: '本地内容' });
        const localTextarea = localDiv.createEl('textarea', { cls: 'conflict-content' });
        localTextarea.value = this.conflict.localContent;
        localTextarea.readOnly = true;

        const serverDiv = diffContainer.createDiv('conflict-diff-panel');
        serverDiv.createEl('h4', { text: '服务器内容' });
        const serverTextarea = serverDiv.createEl('textarea', { cls: 'conflict-content' });
        serverTextarea.value = this.conflict.serverFile.content;
        serverTextarea.readOnly = true;

        new Setting(contentEl)
            .addButton(button => button
                .setButtonText('保留本地版本')
                .setCta()
                .onClick(() => {
                    this.onResolve('local');
                    this.close();
                })
            )
            .addButton(button => button
                .setButtonText('使用服务器版本')
                .onClick(() => {
                    this.onResolve('server');
                    this.close();
                })
            )
            .addButton(button => button
                .setButtonText('取消')
                .onClick(() => {
                    this.onResolve('cancel');
                    this.close();
                })
            );
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
