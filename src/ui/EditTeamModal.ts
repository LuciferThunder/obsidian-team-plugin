import { App, Modal, Notice, Setting } from 'obsidian';
import type TeamPlugin from '../main';
import { Team } from '../types/team';
import { getErrorMessage } from '../utils/api';

export class EditTeamModal extends Modal {
    private readonly plugin: TeamPlugin;
    private readonly team: Team;
    private readonly onSaved: () => void;
    private name: string;
    private description: string;

    constructor(app: App, plugin: TeamPlugin, team: Team, onSaved: () => void) {
        super(app);
        this.plugin = plugin;
        this.team = team;
        this.onSaved = onSaved;
        this.name = team.name;
        this.description = team.description || '';
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: '编辑团队' });

        new Setting(contentEl)
            .setName('团队名称')
            .setDesc('修改名称后，云盘目录会一起改名')
            .addText(text => text
                .setValue(this.name)
                .onChange(value => {
                    this.name = value;
                }));

        new Setting(contentEl)
            .setName('团队简介')
            .addTextArea(text => text
                .setValue(this.description)
                .setPlaceholder('这个团队用来做什么')
                .onChange(value => {
                    this.description = value;
                }));

        new Setting(contentEl)
            .addButton(button => button
                .setButtonText('保存')
                .setCta()
                .onClick(() => {
                    void this.save();
                }))
            .addButton(button => button
                .setButtonText('取消')
                .onClick(() => {
                    this.close();
                }));
    }

    private async save(): Promise<void> {
        const name = this.name.trim();
        if (!name) {
            new Notice('请输入团队名称');
            return;
        }
        try {
            const updated = await this.plugin.teamManager.updateTeamProfile(this.team.id, {
                name,
                description: this.description.trim(),
            });
            new Notice(updated.name === this.team.name ? '团队资料已更新' : '团队已重命名，文档目录会跟着更新');
            this.close();
            this.onSaved();
        } catch (error: unknown) {
            new Notice(getErrorMessage(error) || '保存失败');
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
