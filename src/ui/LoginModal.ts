import { App, Modal, Setting, Notice, requestUrl } from 'obsidian';
import type TeamPlugin from '../main';
import { AuthResponse, CaptchaResponse, readResponseJson } from '../utils/api';

export class LoginModal extends Modal {
    private plugin: TeamPlugin;
    private isRegisterMode = false;

    // Login fields
    private account = '';
    private password = '';
    private rememberAccount = false;
    private rememberPassword = false;
    private captchaInput = '';
    private captchaId = '';

    // Register fields
    private regUsername = '';
    private regEmail = '';
    private regPassword = '';
    private regConfirmPassword = '';
    private regCaptchaInput = '';

    // Reset password fields
    private resetEmail = '';
    private resetCode = '';
    private resetPassword = '';
    private resetConfirmPassword = '';

    // Captcha
    private captchaSvg = '';

    // Callback to refresh TeamView after login
    private onLoginSuccess?: () => void;

    constructor(app: App, plugin: TeamPlugin, onLoginSuccess?: () => void) {
        super(app);
        this.plugin = plugin;
        this.onLoginSuccess = onLoginSuccess;
    }

    async onOpen() {
        this.modalEl.addClass('team-auth-modal');
        this.rememberAccount = this.plugin.settings.rememberAccount;
        this.rememberPassword = this.plugin.settings.rememberPassword;
        if (this.rememberAccount) this.account = this.plugin.settings.savedAccount;
        if (this.rememberPassword) this.password = this.plugin.settings.savedPassword;
        await this.loadCaptcha();
        this.renderLogin();
    }

    private async loadCaptcha() {
        if (!this.plugin.settings.serverUrl) {
            new Notice('请先在设置中配置服务器地址');
            return;
        }

        try {
            const url = `${this.plugin.settings.serverUrl}/api/auth/captcha`;
            const response = await requestUrl({ url, method: 'GET' });
            const data = readResponseJson<CaptchaResponse>(response);
            this.captchaId = data.captchaId;
            this.captchaSvg = data.captchaSvg;
        } catch (e) {
            console.error('Failed to load captcha:', e);
            new Notice('获取验证码失败，请检查服务器地址');
        }
    }

    private renderLogin() {
        this.isRegisterMode = false;
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('team-login-modal');

        contentEl.createEl('h2', { text: '登录' });

        new Setting(contentEl)
            .setName('账号')
            .addText(text => text
                .setPlaceholder('用户名或邮箱')
                .setValue(this.account)
                .onChange(value => { this.account = value; })
            );

        new Setting(contentEl)
            .setName('密码')
            .addText(text => {
                text.setPlaceholder('密码')
                    .setValue(this.password)
                    .onChange(value => { this.password = value; });
                text.inputEl.type = 'password';
            });

        const rememberRow = contentEl.createDiv('team-remember-row');
        this.addRememberToggle(rememberRow, '记住账号', this.rememberAccount, (on) => {
            this.rememberAccount = on;
            this.plugin.settings.rememberAccount = on;
            if (!on) this.plugin.settings.savedAccount = '';
            void this.plugin.saveSettings();
        });
        this.addRememberToggle(rememberRow, '记住密码', this.rememberPassword, (on) => {
            this.rememberPassword = on;
            this.plugin.settings.rememberPassword = on;
            if (!on) this.plugin.settings.savedPassword = '';
            void this.plugin.saveSettings();
        });

        // Captcha
        this.renderCaptchaSection(contentEl, false);

        // Buttons
        new Setting(contentEl)
            .setClass('team-auth-actions')
            .addButton(button => button
                .setButtonText('登录')
                .setCta()
                .onClick(() => {
                    void this.handleLogin();
                })
            )
            .addButton(button => button
                .setButtonText('去注册')
                .onClick(() => {
                    void (async () => {
                        await this.loadCaptcha();
                        this.renderRegister();
                    })();
                })
            )
            .addButton(button => button
                .setButtonText('忘记密码')
                .onClick(() => {
                    this.renderReset();
                })
            );
    }

    private renderReset() {
        this.isRegisterMode = false;
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('team-login-modal');

        contentEl.createEl('h2', { text: '重置密码' });
        contentEl.createEl('p', { text: '输入注册邮箱，我们会发送 6 位验证码。', cls: 'team-auth-hint' });

        new Setting(contentEl)
            .setName('邮箱')
            .addText(text => text
                .setPlaceholder('注册时使用的邮箱')
                .setValue(this.resetEmail)
                .onChange(value => { this.resetEmail = value; })
            )
            .addButton(button => button
                .setButtonText('发送验证码')
                .onClick(() => {
                    void this.handleSendResetCode(button);
                })
            );

        new Setting(contentEl)
            .setName('验证码')
            .addText(text => text
                .setPlaceholder('6 位数字')
                .setValue(this.resetCode)
                .onChange(value => { this.resetCode = value; })
            );

        new Setting(contentEl)
            .setName('新密码')
            .addText(text => {
                text.setPlaceholder('至少 6 位')
                    .setValue(this.resetPassword)
                    .onChange(value => { this.resetPassword = value; });
                text.inputEl.type = 'password';
            });

        new Setting(contentEl)
            .setName('确认新密码')
            .addText(text => {
                text.setPlaceholder('再次输入新密码')
                    .setValue(this.resetConfirmPassword)
                    .onChange(value => { this.resetConfirmPassword = value; });
                text.inputEl.type = 'password';
            });

        new Setting(contentEl)
            .setClass('team-auth-actions')
            .addButton(button => button
                .setButtonText('重置密码')
                .setCta()
                .onClick(() => {
                    void this.handleResetPassword();
                })
            )
            .addButton(button => button
                .setButtonText('返回登录')
                .onClick(() => {
                    void (async () => {
                        await this.loadCaptcha();
                        this.renderLogin();
                    })();
                })
            );
    }

    private async handleSendResetCode(button: { setDisabled: (disabled: boolean) => void; setButtonText: (text: string) => void }) {
        const email = this.resetEmail.trim();
        if (!email) {
            new Notice('请输入邮箱');
            return;
        }
        if (!this.plugin.settings.serverUrl) {
            new Notice('请先在设置中配置服务器地址');
            return;
        }

        button.setDisabled(true);
        button.setButtonText('发送中...');
        try {
            const response = await requestUrl({
                url: `${this.plugin.settings.serverUrl}/api/auth/forgot-password`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }),
            });
            const data = readResponseJson<{ success: boolean; message?: string; error?: string }>(response);
            if (!data.success) {
                new Notice(data.error || '发送失败');
                return;
            }
            new Notice(data.message || '验证码已发送');
        } catch (e: unknown) {
            console.error('Send reset code error:', e);
            new Notice('发送失败，请检查网络和服务器地址');
        } finally {
            button.setDisabled(false);
            button.setButtonText('发送验证码');
        }
    }

    private async handleResetPassword() {
        if (!this.resetEmail.trim() || !this.resetCode.trim() || !this.resetPassword) {
            new Notice('请填写邮箱、验证码和新密码');
            return;
        }
        if (this.resetPassword !== this.resetConfirmPassword) {
            new Notice('两次输入的密码不一致');
            return;
        }
        if (this.resetPassword.length < 6) {
            new Notice('密码至少 6 个字符');
            return;
        }

        try {
            const response = await requestUrl({
                url: `${this.plugin.settings.serverUrl}/api/auth/reset-password`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: this.resetEmail.trim(),
                    code: this.resetCode.trim(),
                    newPassword: this.resetPassword,
                }),
            });
            const data = readResponseJson<{ success: boolean; message?: string; error?: string }>(response);
            if (!data.success) {
                new Notice(data.error || '重置失败');
                return;
            }
            const newPassword = this.resetPassword;
            this.account = this.resetEmail.trim();
            this.password = this.rememberPassword ? newPassword : '';
            if (this.rememberAccount) this.plugin.settings.savedAccount = this.account;
            this.plugin.settings.savedPassword = this.rememberPassword ? newPassword : '';
            this.resetCode = '';
            this.resetPassword = '';
            this.resetConfirmPassword = '';
            await this.plugin.saveSettings();
            new Notice(data.message || '密码已重置，请登录');
            await this.loadCaptcha();
            this.renderLogin();
        } catch (e: unknown) {
            console.error('Reset password error:', e);
            new Notice('重置失败，请检查网络和服务器地址');
        }
    }

    private renderRegister() {
        this.isRegisterMode = true;
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('team-login-modal');

        contentEl.createEl('h2', { text: '注册' });

        new Setting(contentEl)
            .setName('用户名')
            .addText(text => text
                .setPlaceholder('3-20个字符')
                .setValue(this.regUsername)
                .onChange(value => { this.regUsername = value; })
            );

        new Setting(contentEl)
            .setName('邮箱')
            .addText(text => text
                .setPlaceholder('user@example.com')
                .setValue(this.regEmail)
                .onChange(value => { this.regEmail = value; })
            );

        new Setting(contentEl)
            .setName('密码')
            .addText(text => {
                text.setPlaceholder('至少6个字符')
                    .setValue(this.regPassword)
                    .onChange(value => { this.regPassword = value; });
                text.inputEl.type = 'password';
            });

        new Setting(contentEl)
            .setName('确认密码')
            .addText(text => {
                text.setPlaceholder('再次输入密码')
                    .setValue(this.regConfirmPassword)
                    .onChange(value => { this.regConfirmPassword = value; });
                text.inputEl.type = 'password';
            });

        // Captcha
        this.renderCaptchaSection(contentEl, true);

        // Buttons
        new Setting(contentEl)
            .setClass('team-auth-actions')
            .addButton(button => button
                .setButtonText('注册')
                .setCta()
                .onClick(() => {
                    void this.handleRegister();
                })
            )
            .addButton(button => button
                .setButtonText('返回登录')
                .onClick(() => {
                    void (async () => {
                        await this.loadCaptcha();
                        this.renderLogin();
                    })();
                })
            );
    }

    private setCaptchaSvg(containerEl: HTMLElement, svg: string): void {
        containerEl.empty();
        const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
        const root = parsed.documentElement;
        if (root.tagName.toLowerCase() === 'parsererror') {
            containerEl.textContent = '加载失败，点击重试';
            containerEl.addClass('captcha-image-empty');
            return;
        }
        containerEl.removeClass('captcha-image-empty');
        containerEl.appendChild(root);
    }

    private renderCaptchaSection(containerEl: HTMLElement, isRegister: boolean) {
        const setting = new Setting(containerEl).setName('验证码');
        const captchaDiv = setting.controlEl.createDiv('captcha-section');

        const captchaImg = captchaDiv.createDiv('captcha-image');
        if (this.captchaSvg) {
            this.setCaptchaSvg(captchaImg, this.captchaSvg);
        } else {
            captchaImg.textContent = '点击加载';
            captchaImg.addClass('captcha-image-empty');
        }
        captchaImg.setAttribute('title', '点击刷新验证码');
        captchaImg.addEventListener('click', () => {
            void (async () => {
                captchaImg.empty();
                captchaImg.textContent = '加载中...';
                await this.loadCaptcha();
                if (this.captchaSvg) {
                    this.setCaptchaSvg(captchaImg, this.captchaSvg);
                } else {
                    captchaImg.textContent = '加载失败，点击重试';
                    captchaImg.addClass('captcha-image-empty');
                }
            })();
        });

        // Text input
        const input = captchaDiv.createEl('input', {
            cls: 'captcha-input',
            attr: { type: 'text', placeholder: '输入验证码' }
        });

        if (isRegister && this.regCaptchaInput) {
            input.value = this.regCaptchaInput;
        } else if (!isRegister && this.captchaInput) {
            input.value = this.captchaInput;
        }

        input.addEventListener('input', (e: Event) => {
            const value = (e.target as HTMLInputElement).value;
            if (isRegister) {
                this.regCaptchaInput = value;
            } else {
                this.captchaInput = value;
            }
        });
    }

    private async handleLogin() {
        if (!this.account.trim() || !this.password) {
            new Notice('请输入账号和密码');
            return;
        }
        if (!this.captchaInput.trim()) {
            new Notice('请输入验证码');
            return;
        }
        if (!this.captchaId) {
            new Notice('验证码未加载，请点击验证码图片刷新');
            return;
        }

        try {
            const response = await requestUrl({
                url: `${this.plugin.settings.serverUrl}/api/auth/login`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    account: this.account.trim(),
                    password: this.password,
                    captchaId: this.captchaId,
                    captchaText: this.captchaInput.trim(),
                }),
            });

            const data = readResponseJson<AuthResponse>(response);

            if (!data.success || !data.token || !data.user) {
                new Notice(`登录失败: ${data.error || '未知错误'}`);
                this.captchaInput = '';
                await this.loadCaptcha();
                this.renderLogin();
                return;
            }

            // Login success
            this.plugin.settings.apiKey = data.token;
            this.plugin.settings.userId = data.user.id;
            this.plugin.settings.username = data.user.username;
            this.storeRememberedLogin();
            await this.plugin.saveSettings();

            new Notice(`欢迎回来，${data.user.username}！`);
            this.close();

            // Trigger TeamView refresh
            if (this.onLoginSuccess) {
                this.onLoginSuccess();
            }
        } catch (e: unknown) {
            console.error('Login error:', e);
            new Notice('登录请求失败，请检查网络和服务器地址');
        }
    }

    private addRememberToggle(
        row: HTMLElement,
        label: string,
        checked: boolean,
        onChange: (on: boolean) => void,
    ): void {
        const item = row.createEl('label', { cls: 'team-remember-item' });
        const input = item.createEl('input', { type: 'checkbox' });
        input.checked = checked;
        item.createSpan({ text: label });
        input.addEventListener('change', () => {
            onChange(input.checked);
        });
    }

    /** 勾选才写入；取消勾选时对应字段保持为空。退出登录不会清掉这里。 */
    private storeRememberedLogin(): void {
        const settings = this.plugin.settings;
        settings.rememberAccount = this.rememberAccount;
        settings.rememberPassword = this.rememberPassword;
        settings.savedAccount = this.rememberAccount ? this.account.trim() : '';
        settings.savedPassword = this.rememberPassword ? this.password : '';
    }

    private async handleRegister() {
        if (!this.regUsername.trim() || !this.regEmail.trim() || !this.regPassword) {
            new Notice('请填写所有必填字段');
            return;
        }
        if (this.regPassword !== this.regConfirmPassword) {
            new Notice('两次输入的密码不一致');
            return;
        }
        if (this.regPassword.length < 6) {
            new Notice('密码至少6个字符');
            return;
        }
        if (!this.regCaptchaInput.trim()) {
            new Notice('请输入验证码');
            return;
        }
        if (!this.captchaId) {
            new Notice('验证码未加载，请点击验证码图片刷新');
            return;
        }

        try {
            const response = await requestUrl({
                url: `${this.plugin.settings.serverUrl}/api/auth/register`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: this.regUsername.trim(),
                    email: this.regEmail.trim(),
                    password: this.regPassword,
                    captchaId: this.captchaId,
                    captchaText: this.regCaptchaInput.trim(),
                }),
            });

            const data = readResponseJson<AuthResponse>(response);

            if (!data.success || !data.token || !data.user) {
                // Show error, reload captcha, STAY on register view
                new Notice(`注册失败: ${data.error || '未知错误'}`);
                this.regCaptchaInput = '';
                await this.loadCaptcha();
                this.renderRegister();  // <-- stays on register, not login
                return;
            }

            // Register success
            this.plugin.settings.apiKey = data.token;
            this.plugin.settings.userId = data.user.id;
            this.plugin.settings.username = data.user.username;
            await this.plugin.saveSettings();

            new Notice(`注册成功！欢迎，${data.user.username}！`);
            this.close();

            // Trigger TeamView refresh
            if (this.onLoginSuccess) {
                this.onLoginSuccess();
            }
        } catch (e: unknown) {
            console.error('Register error:', e);
            new Notice('注册请求失败，请检查网络和服务器地址');
            // Stay on register view on network error too
            this.regCaptchaInput = '';
            await this.loadCaptcha();
            this.renderRegister();
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
