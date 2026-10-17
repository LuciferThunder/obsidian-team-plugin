import { App, Modal, Notice, Setting } from 'obsidian';
import * as Y from 'yjs';
import TeamPlugin from '../main';
import { DocumentHistoryEntry } from '../types/document';
import { getErrorMessage } from '../utils/api';

class ConfirmRestoreModal extends Modal {
    private readonly message: string;
    private readonly onConfirm: () => void;

    constructor(app: App, message: string, onConfirm: () => void) {
        super(app);
        this.message = message;
        this.onConfirm = onConfirm;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('p', { text: this.message });
        new Setting(contentEl)
            .addButton(button => button
                .setButtonText('确定还原')
                .setDestructive()
                .setCta()
                .onClick(() => {
                    this.onConfirm();
                    this.close();
                })
            )
            .addButton(button => button
                .setButtonText('取消')
                .onClick(() => {
                    this.close();
                })
            );
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

export class HistoryModal extends Modal {
    plugin: TeamPlugin;
    teamId: string;
    docId: string;
    docPath: string;
    histories: DocumentHistoryEntry[] = [];

    constructor(app: App, plugin: TeamPlugin, teamId: string, docId: string, docPath: string) {
        super(app);
        this.plugin = plugin;
        this.teamId = teamId;
        this.docId = docId;
        this.docPath = docPath;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: `文档历史：${this.docPath.split('/').pop() || this.docPath}` });
        const loadingEl = contentEl.createDiv({ text: '正在加载历史版本清单...' });

        try {
            this.histories = await this.plugin.teamManager.getTeamDocumentHistories(this.teamId, this.docId);
            loadingEl.remove();

            if (this.histories.length === 0) {
                contentEl.createDiv({ text: '暂无记录。历史快照将在大家持续协同编辑时由服务器自动定期生成。' });
                return;
            }

            const listEl = contentEl.createDiv({ cls: 'history-list' });

            this.histories.forEach(h => {
                const row = listEl.createDiv({ cls: 'history-item' });

                const info = row.createDiv();
                info.createDiv({ text: `版本 ${h.version} — 由 ${h.savedByName} 保存` });
                const dateText = new Date(h.createdAt).toLocaleString();
                info.createEl('small', { text: dateText, cls: 'text-muted' });

                const btnGroup = row.createDiv();

                const restoreBtn = btnGroup.createEl('button', { text: '还原到此' });
                restoreBtn.onclick = () => {
                    new ConfirmRestoreModal(
                        this.app,
                        '确定要用该版本覆盖当前的云端文档吗？此操作不可逆！(正在协同的人将自动同步到此版本)',
                        () => {
                            void this.restoreHistory(h.id);
                        }
                    ).open();
                };
            });
        } catch (e: unknown) {
            loadingEl.innerText = `加载失败: ${getErrorMessage(e)}`;
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }

    async restoreHistory(historyId: string) {
        try {
            const snapshot = await this.plugin.teamManager.getTeamDocumentHistorySnapshot(this.teamId, this.docId, historyId);
            if (!snapshot.ydoc) throw new Error("返回快照数据为空");

            const binaryString = atob(snapshot.ydoc);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            const tempDoc = new Y.Doc();
            Y.applyUpdate(tempDoc, bytes);
            const restoredText = tempDoc.getText('codemirror').toString();

            await this.plugin.teamManager.createTeamDocument(this.teamId, this.docPath, restoredText);

            new Notice(`已恢复到版本 v${snapshot.version}`);
            this.close();
        } catch (e: unknown) {
            new Notice(`还原失败: ${getErrorMessage(e)}`);
        }
    }
}
