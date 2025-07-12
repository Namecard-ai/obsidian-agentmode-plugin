import React, { useState, useEffect } from 'react';
import { Auth0Service, DeviceAuthState, TokenResponse, Auth0UserInfo } from './main';

interface LoginComponentProps {
	auth0Service: Auth0Service;
	onLoginSuccess: (userInfo: Auth0UserInfo) => void;
	onLoginError: (error: string) => void;
	onCancel: () => void;
}

interface LoginState {
	step: 'loading' | 'device-code' | 'polling' | 'timeout' | 'error' | 'success';
	deviceAuth?: DeviceAuthState;
	errorMessage?: string;
	timeRemaining?: number;
}

export const LoginComponent: React.FC<LoginComponentProps> = ({
	auth0Service,
	onLoginSuccess,
	onLoginError,
	onCancel
}) => {
	const [state, setState] = useState<LoginState>({ step: 'loading' });
	const [countdownTimer, setCountdownTimer] = useState<NodeJS.Timeout | null>(null);

	useEffect(() => {
		startDeviceAuth();
		return () => {
			// 清理定時器
			if (countdownTimer) {
				clearInterval(countdownTimer);
			}
			// 停止輪詢
			auth0Service.stopPolling();
		};
	}, []);

	const startDeviceAuth = async () => {
		try {
			setState({ step: 'loading' });
			
			// 啟動 Device Authorization Flow
			const deviceAuth = await auth0Service.startDeviceAuth();
			
			setState({ 
				step: 'device-code', 
				deviceAuth,
				timeRemaining: deviceAuth.expires_in
			});

			// 開始倒數計時
			startCountdown(deviceAuth.expires_in);
			
			// 開始輪詢
			startPolling(deviceAuth);
			
		} catch (error: any) {
			console.error('Device auth failed:', error);
			setState({ 
				step: 'error', 
				errorMessage: error.message || 'Failed to start login process' 
			});
			onLoginError(error.message || 'Failed to start login process');
		}
	};

	const startCountdown = (seconds: number) => {
		if (countdownTimer) {
			clearInterval(countdownTimer);
		}

		let remaining = seconds;
		setState(prev => ({ ...prev, timeRemaining: remaining }));

		const timer = setInterval(() => {
			remaining -= 1;
			setState(prev => ({ ...prev, timeRemaining: remaining }));

			if (remaining <= 0) {
				clearInterval(timer);
				setState(prev => ({ ...prev, step: 'timeout' }));
				auth0Service.stopPolling();
			}
		}, 1000);

		setCountdownTimer(timer);
	};

	const startPolling = async (deviceAuth: DeviceAuthState) => {
		try {
			// 不要立即切換到 polling 狀態，讓用戶先看到 device-code 狀態
			// 開始輪詢 token
			const tokenResponse = await auth0Service.pollForToken(
				deviceAuth.device_code, 
				deviceAuth.interval
			);

			// 獲取用戶資訊
			await handleLoginSuccess(tokenResponse);

		} catch (error: any) {
			console.error('Polling failed:', error);
			
			// 確保停止 polling 操作
			auth0Service.stopPolling();
			
			if (error.message.includes('timeout')) {
				setState({ step: 'timeout' });
			} else {
				setState({ 
					step: 'error', 
					errorMessage: error.message || 'Authorization failed' 
				});
				onLoginError(error.message || 'Authorization failed');
			}
		}
	};

	const handleLoginSuccess = async (tokenResponse: TokenResponse) => {
		try {
			// 停止倒數計時
			if (countdownTimer) {
				clearInterval(countdownTimer);
			}

			// 停止 polling 操作
			auth0Service.stopPolling();

			setState({ step: 'success' });

			// 保存 token 到 plugin settings（通過 auth0Service）
			const plugin = (auth0Service as any).plugin;
			plugin.settings.isLoggedIn = true;
			plugin.settings.accessToken = tokenResponse.access_token;
			plugin.settings.refreshToken = tokenResponse.refresh_token;
			plugin.settings.tokenExpiry = Math.floor(Date.now() / 1000) + tokenResponse.expires_in;

			// 獲取用戶資訊
			const userInfo = await auth0Service.getUserInfo();
			plugin.settings.userInfo = {
				email: userInfo.email,
				name: userInfo.name,
				sub: userInfo.sub
			};

			// 保存設定
			await plugin.saveSettings();

			// 設置 token 刷新定時器
			auth0Service.setupTokenRefreshTimer();

			console.log('登入成功:', userInfo);
			onLoginSuccess(userInfo);

		} catch (error: any) {
			console.error('保存登入狀態失敗:', error);
			
			// 確保停止 polling 操作
			auth0Service.stopPolling();
			
			setState({ 
				step: 'error', 
				errorMessage: 'Failed to save login state: ' + error.message 
			});
			onLoginError('Failed to save login state: ' + error.message);
		}
	};

	const handleRetry = () => {
		// 確保停止之前的 polling 操作
		auth0Service.stopPolling();
		
		// 清理倒數計時器
		if (countdownTimer) {
			clearInterval(countdownTimer);
			setCountdownTimer(null);
		}
		
		startDeviceAuth();
	};

	const formatTime = (seconds: number): string => {
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins}:${secs.toString().padStart(2, '0')}`;
	};

	const copyToClipboard = async (text: string) => {
		try {
			await navigator.clipboard.writeText(text);
		} catch (err) {
			console.error('複製失敗:', err);
		}
	};

	return (
		<div className="login-component">
			<div className="login-header">
				<h2>Log in to NameCard AI</h2>
			</div>

			<div className="login-content">
				{state.step === 'loading' && (
					<div className="loading-state">
						<div className="spinner"></div>
						<p>Initializing login process...</p>
					</div>
				)}

				{state.step === 'device-code' && state.deviceAuth && (
					<div className="device-code-state">
						<div className="instruction">
							<p>Please visit the following URL in your browser and enter the device code to complete login:</p>
						</div>

						<div className="verification-info">
							<div className="url-section">
								<label>Verification URL:</label>
								<div className="copy-field">
									<code>{state.deviceAuth.verification_uri}</code>
									<button 
										className="copy-btn"
										onClick={() => copyToClipboard(state.deviceAuth!.verification_uri)}
									>
										Copy
									</button>
								</div>
							</div>

							<div className="code-section">
								<label>Device Code:</label>
								<div className="copy-field">
									<code className="device-code">{state.deviceAuth.user_code}</code>
									<button 
										className="copy-btn"
										onClick={() => copyToClipboard(state.deviceAuth!.user_code)}
									>
										Copy
									</button>
								</div>
							</div>
						</div>

						<div className="direct-link">
							<p>Or click the following link (device code will be filled automatically):</p>
							<a 
								href={state.deviceAuth.verification_uri_complete}
								target="_blank"
								rel="noopener noreferrer"
								className="verification-link"
							>
								Open login page in browser
							</a>
						</div>

						{state.timeRemaining && (
							<div className="countdown">
								<p>Time remaining: {formatTime(state.timeRemaining)}</p>
							</div>
						)}
					</div>
				)}

			

				{state.step === 'polling' && (
					<div className="polling-state">
						<div className="spinner"></div>
						<p>Waiting for authorization...</p>
						<p>Please complete login in your browser</p>
						{state.timeRemaining && (
							<div className="countdown">
								<p>Time remaining: {formatTime(state.timeRemaining)}</p>
							</div>
						)}
					</div>
				)}

				{state.step === 'timeout' && (
					<div className="timeout-state">
						<div className="error-icon">⏰</div>
						<h3>Login Timeout</h3>
						<p>Login process has timed out, please try again.</p>
						<div className="timeout-actions">
							<button className="retry-btn" onClick={handleRetry}>
								Retry Login
							</button>
							<button className="cancel-btn" onClick={onCancel}>
								Cancel
							</button>
						</div>
					</div>
				)}

				{state.step === 'error' && (
					<div className="error-state">
						<div className="error-icon">❌</div>
						<h3>Login Failed</h3>
						<p>{state.errorMessage}</p>
						<div className="error-actions">
							<button className="retry-btn" onClick={handleRetry}>
								Retry
							</button>
							<button className="cancel-btn" onClick={onCancel}>
								Cancel
							</button>
						</div>
					</div>
				)}

				{state.step === 'success' && (
					<div className="success-state">
						<div className="success-icon">✅</div>
						<h3>Login Successful</h3>
						<p>Completing setup...</p>
					</div>
				)}
			</div>
		</div>
	);
}; 